import { describe, expect, it } from "vitest";
import { rootPolicy } from "@elio/core";
import type { FeaturePack, GateVerdict, NodeDefinition, Resolved } from "@elio/core";
import { createRuntime, collectEvents } from "../runtime";
import { LlmWorker } from "./worker";
import { MockModel } from "./mock";

// Verifies the runtime builds an LlmWorker by default and that a node which REQUESTS models AND is
// policy-allowed gets ctx.model = that worker (Inv. 14/17). ctx.model is the worker, never an adapter.
describe("createRuntime — ctx.model wiring", () => {
  it("defaults to an LlmWorker over { mock: MockModel } and exposes it as runtime.model", () => {
    const rt = createRuntime();
    expect(rt.model).toBeInstanceOf(LlmWorker);
  });

  it("a policy-allowed, model-requesting node receives the worker at ctx.model and routes to mock", async () => {
    let captured: unknown;
    let completionText = "";

    // A custom intelligence node that requests the "mock" model and calls ctx.model.complete().
    const llmish: NodeDefinition<unknown, { text: string }> = {
      type: "llmish",
      klass: "intelligence",
      requests: { models: ["mock"] },
      handler: async (_input, ctx) => {
        captured = ctx.model;
        const out = await ctx.model!.complete({ messages: [{ role: "user", content: "ping" }] });
        completionText = out.text;
        const res: Resolved<{ text: string }> = {
          status: "resolved",
          output: { text: out.text },
          confidence: out.confidence,
          cost: out.cost,
        };
        return res;
      },
    };

    const gate: NodeDefinition<unknown, GateVerdict> = {
      type: "pass-gate",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved",
          output: { passed: true, score: 1, failures: [] },
          confidence: 1,
          cost: { usd: 0 },
        } satisfies Resolved<GateVerdict>),
    };

    // Root policy must allow the "mock" model, otherwise the injector withholds ctx.model (security by absence).
    const rt = createRuntime({ rootPolicy: rootPolicy({ allowedModels: ["mock"] }) });
    rt.registry.register(llmish as unknown as NodeDefinition);
    rt.registry.register(gate as unknown as NodeDefinition);

    const pack: FeaturePack = {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "demo.model-wiring", version: "0.1.0" },
      contentHash: "demo.model-wiring@0.1.0",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: { state: {}, steps: [{ id: "think", type: "llmish" }], edges: [] },
      },
    };

    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 5 }));

    // ctx.model is the policy-scoped wrapper around the worker the runtime built (Inv. 14: every call is
    // re-checked against resolved.allowedModels/allowCloud) — NOT the bare worker, and never a raw
    // MockModel adapter. The wrapper delegates THROUGH the worker to the mock provider.
    expect(captured).toBeDefined();
    expect(captured).not.toBe(rt.model); // scoped wrapper, not the bare worker
    expect(captured).not.toBeInstanceOf(LlmWorker);
    expect(captured).not.toBeInstanceOf(MockModel);
    // Routed through the wrapper -> worker -> mock provider.
    expect(completionText).toBe("echo: ping");
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });

  it("accepts a custom provider map and builds the worker around it", async () => {
    const rt = createRuntime({
      models: { mock: new MockModel({ transform: (s) => `M:${s}` }) },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
    });
    expect(rt.model).toBeInstanceOf(LlmWorker);
    const out = await rt.model.complete({ messages: [{ role: "user", content: "z" }] });
    expect(out.text).toBe("M:z");
  });
});

// ───────────────────────────── Security by absence on the model + cloud axes (Inv. 13/14) ─────────────────────────────
describe("createRuntime — scoped ctx.model rejects out-of-scope / cloud models end-to-end", () => {
  // A claude provider IS registered in the worker, but the node is granted ONLY the local "mock" model.
  // Calling complete({model:"claude"}) from inside the node must be rejected by the scoped wrapper —
  // the node cannot reach the cloud provider it was never granted (the leak this fix closes).
  function pack(): FeaturePack {
    return {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.model-scope", version: "1", owner: "t" },
      contentHash: "t.model-scope@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: { state: {}, steps: [{ id: "think", type: "reach-cloud" }], edges: [] },
      },
    };
  }

  function passGate(): NodeDefinition {
    return {
      type: "pass-gate",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved" as const,
          output: { passed: true, score: 1, failures: [] },
          confidence: 1,
          cost: { usd: 0 },
        }) as ReturnType<NodeDefinition["handler"]>,
    };
  }

  it("a node granted only the local model cannot reach a registered cloud (claude) provider", async () => {
    let rejection: unknown;
    const reachCloud: NodeDefinition = {
      type: "reach-cloud",
      klass: "intelligence",
      requests: { models: ["*"] }, // resolves to allowedModels = ["mock"]
      handler: async (_input, ctx) => {
        try {
          // explicit cross-model request to the registered claude provider — must be denied
          await ctx.model!.complete({ model: "claude", messages: [{ role: "user", content: "hi" }] });
        } catch (e) {
          rejection = e;
        }
        // the granted local model still works
        const ok = await ctx.model!.complete({ model: "mock", messages: [{ role: "user", content: "hi" }] });
        return {
          status: "resolved" as const,
          output: { text: ok.text },
          confidence: ok.confidence,
          cost: ok.cost,
        };
      },
    };

    const rt = createRuntime({
      // BOTH providers registered behind the worker; allowCloud true so model-axis (not cloud-axis) is tested.
      models: { mock: new MockModel(), claude: new MockModel({ transform: (s) => `CLOUD:${s}` }) },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"], allowCloud: true }),
    });
    rt.registry.register(reachCloud);
    rt.registry.register(passGate());

    const events = await collectEvents(rt.run(pack(), { payload: {}, budget: 100, maxDepth: 5 }));
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/denied|not in policy-allowed/i);
  });

  it("a node granted a cloud model still cannot use it when allowCloud is false (cloud-axis)", async () => {
    let rejection: unknown;
    const reachCloud: NodeDefinition = {
      type: "reach-cloud",
      klass: "intelligence",
      requests: { models: ["*"], cloud: true }, // asks for cloud; parent denies -> allowCloud stays false
      handler: async (_input, ctx) => {
        try {
          await ctx.model!.complete({ model: "claude", messages: [{ role: "user", content: "hi" }] });
        } catch (e) {
          rejection = e;
        }
        return {
          status: "resolved" as const,
          output: { text: "done" },
          confidence: 1,
          cost: { usd: 0 },
        };
      },
    };

    const rt = createRuntime({
      models: { claude: new MockModel({ transform: (s) => `CLOUD:${s}` }) },
      defaultModel: "claude",
      // claude granted on the MODEL axis, but allowCloud=false -> the cloud-axis must still reject it.
      rootPolicy: rootPolicy({ allowedModels: ["claude"], allowCloud: false }),
    });
    rt.registry.register(reachCloud);
    rt.registry.register(passGate());

    const events = await collectEvents(rt.run(pack(), { payload: {}, budget: 100, maxDepth: 5 }));
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/cloud usage not granted|allowCloud/i);
  });
});
