import { describe, expect, it } from "vitest";
import {
  hashValue,
  InMemoryFeatureStore,
  InMemoryRunStore,
  makeCandidate,
  NodeRegistry,
  OuterLoopRunner,
  PolicyInjector,
  promoteCandidatePack,
  registerBuiltins,
  rootPolicy,
  synthesizeScriptPack,
  WorkerScriptRunner,
} from "@elio/core";
import type {
  FeaturePack,
  ModelService,
  NodeDefinition,
  PromotionCandidate,
  RunEvent,
} from "@elio/core";

// Eine generierte Funktion, die generalisiert UND auf einem Sentinel ans LLM zurückgibt (undefined → MISS).
const GENERATED =
  "function transform(input) { if (input.prompt === 'SKIP') return undefined; return { text: input.prompt }; }";

function fakeModel(source: string): ModelService {
  return { complete: () => Promise.resolve({ text: source, cost: { usd: 0.002 }, confidence: 0.9 }) };
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** Ein zählender LLM-Stand-in (vermeidet ctx.model-Verdrahtung); zählt Aufrufe = der Fallback-Pfad. */
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
    const passed = typeof (ctx.artifact.content as Record<string, unknown>)["text"] === "string";
    return Promise.resolve({ status: "resolved", output: { passed, failures: passed ? [] : ["no text"] }, confidence: 1, cost: {} });
  },
};

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

/** Seedet das Tape: 2 Mining-Frames (Synthese-Beispiele) + 1 held-out Frame, alle an demo.svc/draft. */
async function seededStore(): Promise<{ store: InMemoryRunStore; mineRun: string }> {
  const store = new InMemoryRunStore();
  const mineRun = (await store.createRun({ payload: {}, budget: 1, maxDepth: 1 })).id;
  const heldRun = (await store.createRun({ payload: {}, budget: 1, maxDepth: 1 })).id;
  const f = (run: string, prompt: string) => ({
    correlation: { run, branch: "b", step: "draft", checkpoint: "cp" },
    feature: "demo.svc",
    nodeType: "count-llm",
    input: { prompt },
    result: { status: "resolved" as const, output: { text: prompt }, confidence: 1, cost: {} },
    injected: [],
    ts: "2026-01-01T00:00:00.000Z",
  });
  await store.appendTape(mineRun, f(mineRun, "V1"));
  await store.appendTape(mineRun, f(mineRun, "V2"));
  await store.appendTape(heldRun, f(heldRun, "V3")); // held-out: run ∉ evidence.runs
  return { store, mineRun };
}

function tier0Candidate(mineRun: string): PromotionCandidate {
  const h1 = hashValue({ prompt: "V1" });
  const h2 = hashValue({ prompt: "V2" });
  return makeCandidate({
    source: "determinism-miner",
    kind: "node-replacement",
    callSite: { feature: "demo.svc", step: "draft", nodeType: "count-llm" },
    support: 25,
    evidence: { runs: [mineRun] },
    proposal: {
      tier: 0,
      domain: [h1, h2],
      lookup: [
        { inputHash: h1, output: { text: "V1" } },
        { inputHash: h2, output: { text: "V2" } },
      ],
    },
    summary: "draft is deterministic",
  });
}

describe("Tier-2 closed loop — mine → synthesize → promote → run generated code", () => {
  it("synthesize-script generates a function, held-out-validates it, and emits a Tier-2 candidate", async () => {
    const { store, mineRun } = await seededStore();
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({
      store,
      model: fakeModel(GENERATED),
      scriptRunner: new WorkerScriptRunner({ defaultTimeoutMs: 200 }),
    });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ allowedModels: ["*"], toolPermissions: ["traces:read", "scripts:execute"] }),
    });

    const events = await collect(runner.run(synthesizeScriptPack, { payload: tier0Candidate(mineRun), budget: 100, maxDepth: 10 }));
    expect(events[events.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });

    const runId = events.find((e) => e.type === "run-started")?.correlation.run ?? "";
    const content = runner.getArtifact(runId)?.content as Record<string, unknown>;
    expect(content["synthesized"]).toBe(true);
    const cand = content["candidate"] as PromotionCandidate;
    expect((cand.proposal as { tier: number }).tier).toBe(2);
    expect((cand.proposal as { source: string }).source).toContain("input.prompt");
    expect((content["verdict"] as { heldOut: boolean; covered: number }).heldOut).toBe(true);
    expect((content["verdict"] as { covered: number }).covered).toBeGreaterThanOrEqual(1);
  });

  it("promotes the Tier-2 candidate (approval) into a script-eval rewrite, then the promoted pack runs the generated code", async () => {
    const { store, mineRun } = await seededStore();
    // A Tier-2 candidate as synthesis would emit it (independent of the synth run, for a focused promote test).
    const tier2: PromotionCandidate = makeCandidate({
      source: "synthesize-script",
      kind: "node-replacement",
      callSite: { feature: "demo.svc", step: "draft", nodeType: "count-llm" },
      support: 25,
      evidence: { runs: [mineRun] }, // mining runs excluded from held-out shadow-eval
      proposal: { tier: 2, source: GENERATED, domain: [hashValue({ prompt: "V3" })] },
      summary: "tier-2 candidate",
    });

    const featureStore = new InMemoryFeatureStore([basePack]);
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const { node: countNode, calls } = countLlm();
    registry.register(countNode);
    registry.register(hasTextGate);
    const scriptRunner = new WorkerScriptRunner({ defaultTimeoutMs: 200 });
    const injector = new PolicyInjector({ store, featureStore, scriptRunner });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["featurestore:write", "traces:read", "scripts:execute"] }),
    });

    // Promote: approval suspends, resume(approved) re-validates via shadowEvalScript (real worker) + writes v2.
    const first = await collect(runner.run(promoteCandidatePack, { payload: tier2, budget: 100, maxDepth: 20 }));
    const suspended = first.find((e) => e.type === "node-suspended");
    if (suspended?.type !== "node-suspended") throw new Error("did not suspend at approval");
    const resumed = await collect(runner.resume(suspended.correlation, { approved: true }));
    expect(resumed[resumed.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.0", "1.0.1"]);

    const v2 = await featureStore.get("demo.svc");
    expect(v2?.feature.graph?.steps.some((s) => s.id === "draft__script" && s.type === "script-eval")).toBe(true);

    // Run the promoted pack. The script-eval node needs scripts:execute at runtime (honest Tier-2 limit:
    // unlike Tier-0 memo, a promoted Tier-2 pack requires the grant — else it fails closed, see below).
    const runner2 = new OuterLoopRunner({
      registry,
      store: new InMemoryRunStore(),
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["scripts:execute"] }),
    });
    // HIT: the generated function serves the answer; the LLM (count-llm) is skipped.
    const hit = await collect(runner2.run(v2 as FeaturePack, { payload: { q: "HELLO" }, budget: 100, maxDepth: 10 }));
    const hitRun = hit.find((e) => e.type === "run-started")?.correlation.run ?? "";
    expect(calls()).toBe(0); // LLM skipped — the generated code answered
    expect((runner2.getArtifact(hitRun)?.content as Record<string, unknown>)["text"]).toBe("HELLO");
    expect(hit[hit.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });

    // MISS: the generated function defers (returns undefined for 'SKIP') → falls back to the LLM.
    const miss = await collect(runner2.run(v2 as FeaturePack, { payload: { q: "SKIP" }, budget: 100, maxDepth: 10 }));
    const missRun = miss.find((e) => e.type === "run-started")?.correlation.run ?? "";
    expect(calls()).toBe(1); // fallback ran
    expect((runner2.getArtifact(missRun)?.content as Record<string, unknown>)["text"]).toBe("OUT:SKIP");
    // the internal hit flag must not leak into the durable artifact:
    expect((runner2.getArtifact(missRun)?.content as Record<string, unknown>)["__script_draft"]).toBeUndefined();

    // Honest Tier-2 limit (Doc §9.x): WITHOUT a scripts:execute grant the promoted pack fails closed —
    // script-eval throws (security by absence), the LLM is NOT silently reached. Run stops, no text served.
    const runner3 = new OuterLoopRunner({ registry, store: new InMemoryRunStore(), injector }); // default policy: no grant
    const denied = await collect(runner3.run(v2 as FeaturePack, { payload: { q: "HELLO" }, budget: 100, maxDepth: 10 }));
    const deniedRun = denied.find((e) => e.type === "run-started")?.correlation.run ?? "";
    expect(denied[denied.length - 1]).toMatchObject({ type: "run-completed", gate: "stopped" });
    expect((runner3.getArtifact(deniedRun)?.content as Record<string, unknown>)["text"]).toBeUndefined();
  });

  it("promote-apply of a Tier-2 candidate WITHOUT a scripts:execute grant fails closed (nothing written)", async () => {
    const { store, mineRun } = await seededStore();
    const tier2: PromotionCandidate = makeCandidate({
      source: "synthesize-script",
      kind: "node-replacement",
      callSite: { feature: "demo.svc", step: "draft", nodeType: "count-llm" },
      support: 25,
      evidence: { runs: [mineRun] },
      proposal: { tier: 2, source: GENERATED, domain: [hashValue({ prompt: "V3" })] },
      summary: "tier-2 candidate",
    });
    const featureStore = new InMemoryFeatureStore([basePack]);
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    // scriptRunner wired, but the root policy grants featurestore:write + traces:read and NOT scripts:execute
    // → ctx.scripts is not injected → the Tier-2 shadow-eval branch in promote-apply throws (security by absence).
    const injector = new PolicyInjector({ store, featureStore, scriptRunner: new WorkerScriptRunner({ defaultTimeoutMs: 200 }) });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["featurestore:write", "traces:read"] }),
    });
    const first = await collect(runner.run(promoteCandidatePack, { payload: tier2, budget: 100, maxDepth: 20 }));
    const suspended = first.find((e) => e.type === "node-suspended");
    if (suspended?.type !== "node-suspended") throw new Error("did not suspend at approval");
    const resumed = await collect(runner.resume(suspended.correlation, { approved: true }));
    // promote-apply throws (no ctx.scripts) → nothing promoted, run stops, featureStore unchanged.
    expect(resumed[resumed.length - 1]).toMatchObject({ type: "run-completed", gate: "stopped" });
    expect(await featureStore.versions("demo.svc")).toEqual(["1.0.0"]);
  });
});
