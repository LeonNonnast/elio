import { describe, expect, it } from "vitest";
import {
  applyCandidate,
  demoteCandidatePack,
  hashValue,
  InMemoryFeatureStore,
  InMemoryRunStore,
  makeCandidate,
  memoLookupNode,
  NodeRegistry,
  OuterLoopRunner,
  PolicyInjector,
  promoteCandidatePack,
  registerBuiltins,
  rootPolicy,
} from "@elio/core";
import type {
  FeaturePack,
  NodeDefinition,
  NodeResult,
  PromotionCandidate,
  RunEvent,
  TapeFrame,
} from "@elio/core";

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const basePack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "demo.svc", version: "1.0.0" },
  contentHash: "sha256:base",
  feature: {
    autonomy: "static",
    artifact: { kind: "note", evalGate: "has-text" },
    io: { input: {}, output: {} },
    graph: {
      steps: [{ id: "draft", type: "count-llm", with: { prompt: "{{state.input.q}}" }, outputs: { text: "state.draft" } }],
      edges: [],
    },
  },
};

const inDomainHash = hashValue({ prompt: "x" });
const candidate: PromotionCandidate = makeCandidate({
  source: "determinism-miner",
  kind: "node-replacement",
  callSite: { feature: "demo.svc", step: "draft", nodeType: "count-llm" },
  support: 25,
  evidence: { runs: ["r1"] },
  proposal: { tier: 0, domain: [inDomainHash], lookup: [{ inputHash: inDomainHash, output: { text: "MEMOIZED" } }] },
  summary: "draft is deterministic",
});

/** A counting stand-in for an LLM node (avoids ctx.model wiring); records how often it ran. */
function countLlm(): { node: NodeDefinition; calls: () => number } {
  let calls = 0;
  const node: NodeDefinition = {
    type: "count-llm",
    klass: "intelligence",
    handler: (input) => {
      calls += 1;
      const prompt = (input as { prompt?: unknown }).prompt;
      return Promise.resolve({ status: "resolved", output: { text: `OUT:${String(prompt)}` }, confidence: 1, cost: {} });
    },
  };
  return { node, calls: () => calls };
}

const hasTextGate: NodeDefinition = {
  type: "has-text",
  klass: "orchestration",
  handler: (_input, ctx) => {
    const content = ctx.artifact.content as Record<string, unknown>;
    const passed = typeof content["text"] === "string";
    return Promise.resolve({ status: "resolved", output: { passed, failures: passed ? [] : ["no text"] }, confidence: 1, cost: {} });
  },
};

describe("promotion end-to-end — the loop closes", () => {
  it("rewritten pack: a memo HIT serves the answer (LLM skipped); a MISS falls back to the LLM", async () => {
    const v2 = applyCandidate(basePack, candidate);
    const { node: countNode, calls } = countLlm();
    const registry = new NodeRegistry();
    registry.register(memoLookupNode as unknown as NodeDefinition);
    registry.register(countNode);
    registry.register(hasTextGate);
    const runner = new OuterLoopRunner({ registry, store: new InMemoryRunStore() });

    // HIT — in-domain input { q: "x" } → memo serves "MEMOIZED", count-llm is NOT called.
    const hit = await collect(runner.run(v2, { payload: { q: "x" }, budget: 100, maxDepth: 10 }));
    const hitRun = hit.find((e) => e.type === "run-started")?.correlation.run ?? "";
    expect(calls()).toBe(0);
    expect((runner.getArtifact(hitRun)?.content as Record<string, unknown>)["text"]).toBe("MEMOIZED");
    expect(hit[hit.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });

    // MISS — out-of-domain input { q: "z" } → memo miss → count-llm runs (the fallback).
    const miss = await collect(runner.run(v2, { payload: { q: "z" }, budget: 100, maxDepth: 10 }));
    const missRun = miss.find((e) => e.type === "run-started")?.correlation.run ?? "";
    expect(calls()).toBe(1);
    expect((runner.getArtifact(missRun)?.content as Record<string, unknown>)["text"]).toBe("OUT:z");
    // F2: the internal hit flag must NOT leak into the durable artifact content.
    expect((runner.getArtifact(missRun)?.content as Record<string, unknown>)["__memo_draft"]).toBeUndefined();
  });

  it("non-terminal target: a HIT skips the LLM but the graph continues to the next step", async () => {
    const nonTerminalPack: FeaturePack = {
      ...basePack,
      feature: {
        ...basePack.feature,
        artifact: { kind: "note", evalGate: "has-done" },
        graph: {
          steps: [
            { id: "draft", type: "count-llm", with: { prompt: "{{state.input.q}}" }, outputs: { text: "state.draft" } },
            { id: "post", type: "transform", with: { set: true, as: "done" }, outputs: { done: "state.done" } },
          ],
          edges: [{ from: "draft", to: "post" }],
        },
      },
    };
    const v2 = applyCandidate(nonTerminalPack, candidate);
    const { node: countNode, calls } = countLlm();
    const hasDoneGate: NodeDefinition = {
      type: "has-done",
      klass: "orchestration",
      handler: (_i, ctx) => {
        const passed = (ctx.artifact.content as Record<string, unknown>)["done"] === true;
        return Promise.resolve({ status: "resolved", output: { passed, failures: passed ? [] : ["no done"] }, confidence: 1, cost: {} });
      },
    };
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    registry.register(countNode);
    registry.register(hasDoneGate);
    const runner = new OuterLoopRunner({ registry, store: new InMemoryRunStore() });

    // HIT — memo serves draft, the LLM is skipped, but `post` STILL runs (graph continues).
    const hit = await collect(runner.run(v2, { payload: { q: "x" }, budget: 100, maxDepth: 10 }));
    const hitRun = hit.find((e) => e.type === "run-started")?.correlation.run ?? "";
    const hitContent = runner.getArtifact(hitRun)?.content as Record<string, unknown>;
    expect(calls()).toBe(0); // LLM skipped
    expect(hitContent["text"]).toBe("MEMOIZED");
    expect(hitContent["done"]).toBe(true); // downstream step ran
    expect(hit[hit.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });

    // MISS — falls back through the LLM, then `post`.
    const miss = await collect(runner.run(v2, { payload: { q: "z" }, budget: 100, maxDepth: 10 }));
    expect(calls()).toBe(1);
    const missContent = runner.getArtifact(miss.find((e) => e.type === "run-started")?.correlation.run ?? "")?.content as Record<string, unknown>;
    expect(missContent["text"]).toBe("OUT:z");
    expect(missContent["done"]).toBe(true);
  });
});

describe("retro.promote-candidate — human-gated mutation", () => {
  function frame(input: unknown, output: unknown): TapeFrame {
    const result: NodeResult = { status: "resolved", output, confidence: 1, cost: {} };
    return {
      correlation: { run: "hist", branch: "b", step: "draft", checkpoint: "cp" },
      feature: "demo.svc", // stamped like the runner would — promote scopes shadow-eval by feature (6b)
      nodeType: "count-llm",
      input,
      result,
      injected: [],
      ts: "2026-01-01T00:00:00.000Z",
    };
  }

  async function setup(): Promise<{ runner: OuterLoopRunner; featureStore: InMemoryFeatureStore }> {
    const store = new InMemoryRunStore();
    const hist = (await store.createRun({ payload: {}, budget: 1, maxDepth: 1 })).id;
    // a held-in frame matching the candidate's lookup so shadow-eval passes:
    await store.appendTape(hist, frame({ prompt: "x" }, { text: "MEMOIZED" }));
    const featureStore = new InMemoryFeatureStore([basePack]);
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({ store, featureStore });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["featurestore:write", "traces:read"] }),
    });
    return { runner, featureStore };
  }

  it("on approval: shadow-eval passes, applies the rewrite, mints v_{n+1} in the featureStore", async () => {
    const { runner, featureStore } = await setup();
    const first = await collect(runner.run(promoteCandidatePack, { payload: candidate, budget: 100, maxDepth: 20 }));
    const suspended = first.find((e) => e.type === "node-suspended");
    expect(suspended?.type).toBe("node-suspended");
    if (suspended?.type !== "node-suspended") throw new Error("did not suspend at approval");

    const resumed = await collect(runner.resume(suspended.correlation, { approved: true }));
    expect(resumed[resumed.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.0", "1.0.1"]); // v2 minted
  });

  it("on denial: nothing is written (safe-by-default), run stops", async () => {
    const { runner, featureStore } = await setup();
    const first = await collect(runner.run(promoteCandidatePack, { payload: candidate, budget: 100, maxDepth: 20 }));
    const suspended = first.find((e) => e.type === "node-suspended");
    if (suspended?.type !== "node-suspended") throw new Error("did not suspend at approval");

    const resumed = await collect(runner.resume(suspended.correlation, { approved: false }));
    expect(resumed[resumed.length - 1]).toMatchObject({ type: "run-completed", gate: "stopped" });
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.0"]); // unchanged
    expect(resumed.some((e) => e.type === "step-started" && e.correlation.step === "apply")).toBe(false);
  });

  it("approved but shadow-eval FAILS: nothing written, run stops (shadow-gate is not optional)", async () => {
    const store = new InMemoryRunStore();
    const hist = (await store.createRun({ payload: {}, budget: 1, maxDepth: 1 })).id;
    // held-out frame whose output DISAGREES with the candidate's memo → shadow-eval rejects.
    await store.appendTape(hist, frame({ prompt: "x" }, { text: "DIFFERENT" }));
    const featureStore = new InMemoryFeatureStore([basePack]);
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({ store, featureStore });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["featurestore:write", "traces:read"] }),
    });

    const first = await collect(runner.run(promoteCandidatePack, { payload: candidate, budget: 100, maxDepth: 20 }));
    const suspended = first.find((e) => e.type === "node-suspended");
    if (suspended?.type !== "node-suspended") throw new Error("did not suspend at approval");
    const resumed = await collect(runner.resume(suspended.correlation, { approved: true }));
    // approved, but the gate must report stopped (not passed) because shadow-eval rejected — and nothing written.
    expect(resumed[resumed.length - 1]).toMatchObject({ type: "run-completed", gate: "stopped" });
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.0"]);
  });

  it("re-promoting an already-promoted feature does not compound (second approve writes nothing new)", async () => {
    const { runner, featureStore } = await setup();
    const f1 = await collect(runner.run(promoteCandidatePack, { payload: candidate, budget: 100, maxDepth: 20 }));
    const s1 = f1.find((e) => e.type === "node-suspended");
    if (s1?.type !== "node-suspended") throw new Error("no suspend (1)");
    await collect(runner.resume(s1.correlation, { approved: true }));
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.0", "1.0.1"]);

    // second approved promotion of the same candidate → applyCandidate sees the memo step already exists.
    const f2 = await collect(runner.run(promoteCandidatePack, { payload: candidate, budget: 100, maxDepth: 20 }));
    const s2 = f2.find((e) => e.type === "node-suspended");
    if (s2?.type !== "node-suspended") throw new Error("no suspend (2)");
    const r2 = await collect(runner.resume(s2.correlation, { approved: true }));
    expect(r2[r2.length - 1]).toMatchObject({ type: "run-completed", gate: "stopped" });
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.0", "1.0.1"]); // unchanged
  });

  it("demote-candidate removes a promoted memo on approval (drift recovery)", async () => {
    const promoted = applyCandidate(basePack, candidate); // 1.0.1 with the memo step
    const featureStore = new InMemoryFeatureStore([promoted]);
    const store = new InMemoryRunStore();
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({ store, featureStore });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["featurestore:write"] }),
    });

    const first = await collect(
      runner.run(demoteCandidatePack, { payload: { feature: "demo.svc", step: "draft" }, budget: 100, maxDepth: 20 }),
    );
    const s = first.find((e) => e.type === "node-suspended");
    if (s?.type !== "node-suspended") throw new Error("did not suspend at approval");
    const r = await collect(runner.resume(s.correlation, { approved: true }));
    expect(r[r.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });

    const latest = await featureStore.get("demo.svc");
    expect(latest?.metadata.version).toBe("1.0.2"); // promote (1.0.1) → demote (1.0.2)
    expect(latest?.feature.graph?.steps.some((st) => st.id === "draft__memo")).toBe(false); // memo gone
  });

  it("demote-candidate is deny-safe (resume false → nothing written, run stops)", async () => {
    const promoted = applyCandidate(basePack, candidate);
    const featureStore = new InMemoryFeatureStore([promoted]);
    const store = new InMemoryRunStore();
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({ store, featureStore });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["featurestore:write"] }),
    });
    const first = await collect(
      runner.run(demoteCandidatePack, { payload: { feature: "demo.svc", step: "draft" }, budget: 100, maxDepth: 20 }),
    );
    const s = first.find((e) => e.type === "node-suspended");
    if (s?.type !== "node-suspended") throw new Error("did not suspend");
    const r = await collect(runner.resume(s.correlation, { approved: false }));
    expect(r[r.length - 1]).toMatchObject({ type: "run-completed", gate: "stopped" });
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.1"]); // still the promoted version (no demote)
    expect(r.some((e) => e.type === "step-started" && e.correlation.step === "apply")).toBe(false);
  });
});
