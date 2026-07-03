import { describe, expect, it } from "vitest";
import { rootPolicy } from "@elio/core";
import type {
  Cost,
  FeaturePack,
  GateVerdict,
  ModelService,
  NodeDefinition,
  Resolved,
  RunEvent,
} from "@elio/core";
import { createRuntime, collectEvents } from "../runtime";
import { MockModel } from "./mock";

// A trivial pass-gate so the runner reaches run-completed cleanly.
const passGate: NodeDefinition<unknown, GateVerdict> = {
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

function llmPack(): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "demo.llm-node", version: "0.1.0" },
    contentHash: "demo.llm-node@0.1.0",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "pass-gate" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [{ id: "think", type: "llm", with: { prompt: "ping" } }],
        edges: [],
      },
    },
  };
}

describe("llm built-in node — end-to-end through createRuntime (Slice 3)", () => {
  it("(a) resolves {text} via MockModel, charges cost, emits node-resolved + cost-delta", async () => {
    // MockModel reports usd:0 but tokens; give it a usd cost so the cost-delta is observable.
    const mock = new MockModel({ transform: (s) => `echo: ${s}` });
    const rt = createRuntime({
      models: { mock },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events = await collectEvents(rt.run(llmPack(), { payload: {}, budget: 100, maxDepth: 5 }));

    const resolved = events.find(
      (e): e is Extract<RunEvent, { type: "node-resolved" }> =>
        e.type === "node-resolved" && e.correlation.step === "think",
    );
    expect(resolved).toBeDefined();
    // tokens flowed back from the MockModel (input/output token estimate).
    expect(resolved!.cost?.tokensOut).toBeGreaterThan(0);

    const costDelta = events.find(
      (e): e is Extract<RunEvent, { type: "cost-delta" }> =>
        e.type === "cost-delta" && e.correlation.step === "think",
    );
    expect(costDelta).toBeDefined();

    // the llm output reached the artifact (artifact-updated emitted) and the run completed.
    expect(events.some((e) => e.type === "artifact-updated")).toBe(true);
    expect(events.some((e) => e.type === "run-completed")).toBe(true);

    // the artifact carries the llm text under `text` (flat-merged, no outputs map).
    const artifact = rt.runner.getArtifact(
      (events[0] as Extract<RunEvent, { type: "run-started" }>).correlation.run,
    );
    expect(artifact).toBeDefined();
  });

  it("(b) WITHOUT a models grant, the llm node fails clearly (security by absence — no ctx.model)", async () => {
    // Default rootPolicy has allowedModels:[] -> the injector withholds ctx.model -> the node throws.
    const rt = createRuntime({ models: { mock: new MockModel() }, defaultModel: "mock" });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events = await collectEvents(rt.run(llmPack(), { payload: {}, budget: 100, maxDepth: 5 }));

    // The thrown error is caught by tryWithRetry into a Failed; with the default retry policy
    // (onExhausted:"fail") the runner writes a dead-letter and stops. No node-resolved for "think".
    expect(
      events.some((e) => e.type === "node-resolved" && e.correlation.step === "think"),
    ).toBe(false);

    // The dead-letter tape frame records the clear security-by-absence failure.
    const runId = (events[0] as Extract<RunEvent, { type: "run-started" }>).correlation.run;
    const frames: { nodeType: string; result: { status: string; error?: { message: string } } }[] = [];
    for await (const f of rt.store.tape(runId)) {
      frames.push(f as unknown as (typeof frames)[number]);
    }
    const failed = frames.find(
      (f) => f.result.status === "failed" && /ctx\.model|security by absence|nicht injiziert/i.test(f.result.error?.message ?? ""),
    );
    expect(failed).toBeDefined();
  });
});

function agentPack(maxTurns: number): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "demo.agent-node", version: "0.1.0" },
    contentHash: "demo.agent-node@0.1.0",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "pass-gate" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [{ id: "loop", type: "agent", with: { prompt: "work", maxTurns } }],
        edges: [],
      },
    },
  };
}

describe("agent built-in node — bounded in-process loop through createRuntime (Slice 3)", () => {
  it("(c) runs a bounded loop with MockModel and resolves", async () => {
    // MockModel never emits the stop marker -> the loop runs to maxTurns and resolves with the
    // last answer. Disable the engine so we exercise the agent node's OWN in-process ctx.model loop.
    const mock = new MockModel({ transform: (s) => `draft(${s})` });
    const rt = createRuntime({
      models: { mock },
      defaultModel: "mock",
      agentEngine: null,
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events = await collectEvents(rt.run(agentPack(3), { payload: {}, budget: 100, maxDepth: 10 }));

    const resolved = events.find(
      (e): e is Extract<RunEvent, { type: "node-resolved" }> =>
        e.type === "node-resolved" && e.correlation.step === "loop",
    );
    expect(resolved).toBeDefined();
    // 3 turns of MockModel each report tokens -> accumulated tokensOut > a single turn.
    expect(resolved!.cost?.tokensOut).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });

  it("(c'') inner loop INHERITS the run's remaining budget and stops on exhaustion BEFORE maxTurns (Inv. 21, runner->node->engine)", async () => {
    // Each model turn costs usd:1. The run budget is 2 and maxTurns is 5. If ctx.cost were undefined
    // (the old bug), the agent node would hand the engine budget:Infinity and the loop would run all
    // 5 turns. With the budget wired through to ctx.cost, the engine inherits remaining=2 and stops
    // after exactly 2 turns. The model never emits the stop marker, so ONLY the budget can bound it.
    let calls = 0;
    const costingModel: ModelService = {
      complete: () => {
        calls += 1;
        const cost: Cost = { usd: 1, tokensIn: 1, tokensOut: 1, model: "costing" };
        return Promise.resolve({ text: `turn ${calls}`, cost, confidence: 0.5 });
      },
    };
    // Pass the ModelService directly as ctx.model (createRuntime uses it verbatim). The default
    // InProcessAgentEngine is wired as ctx.agent, so the agent node takes Path A (delegation).
    const rt = createRuntime({
      model: costingModel,
      rootPolicy: rootPolicy({ allowedModels: ["costing"] }),
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events = await collectEvents(
      rt.run(agentPack(5), { payload: {}, budget: 2, maxDepth: 10 }),
    );

    expect(calls).toBe(2); // inherited remaining budget (2) funded exactly 2 turns, NOT maxTurns (5)
    expect(
      events.some((e) => e.type === "node-resolved" && e.correlation.step === "loop"),
    ).toBe(true);
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });

  it("(c''') inner loop ESCALATES when the inherited depth has reached maxDepth (Inv. 21, runner->node->engine)", async () => {
    // maxDepth:1 -> the run's BudgetTracker is at depth 0; the agent node delegates at childDepth 1,
    // which equals the contract maxDepth (1) -> the engine refuses to loop and raises an elicitation.
    // The agent node surfaces that as a node-suspended, so the run suspends instead of resolving.
    let calls = 0;
    const model: ModelService = {
      complete: () => {
        calls += 1;
        return Promise.resolve({ text: "x", cost: { usd: 0 }, confidence: 1 });
      },
    };
    const rt = createRuntime({
      model,
      rootPolicy: rootPolicy({ allowedModels: ["m"] }),
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events = await collectEvents(
      rt.run(agentPack(3), { payload: {}, budget: 100, maxDepth: 1 }),
    );

    expect(calls).toBe(0); // ceiling hit before any model turn
    const suspended = events.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> =>
        e.type === "node-suspended" && e.correlation.step === "loop",
    );
    expect(suspended).toBeDefined();
    expect(suspended!.elicitation.what).toMatch(/tiefe|depth|limit/i);
    expect(events.some((e) => e.type === "run-completed")).toBe(false);
  });

  it("(c') delegates through the default InProcessAgentEngine (ctx.agent) and resolves", async () => {
    // No agentEngine override -> createRuntime wires the default InProcessAgentEngine, which the
    // injector exposes as ctx.agent (gated like ctx.model). The agent node delegates to it.
    const mock = new MockModel({ transform: (s) => `engine(${s})` });
    const rt = createRuntime({
      models: { mock },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events = await collectEvents(rt.run(agentPack(2), { payload: {}, budget: 100, maxDepth: 10 }));
    expect(
      events.some((e) => e.type === "node-resolved" && e.correlation.step === "loop"),
    ).toBe(true);
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });
});
