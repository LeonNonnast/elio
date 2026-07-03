import { describe, expect, it } from "vitest";
import {
  FeatureRegistry,
  InMemoryRunStore,
  NodeRegistry,
  OuterLoopRunner,
  registerBuiltins,
} from "@elio/core";
import type { FeaturePack, NodeDefinition, NodeResult, RunEvent } from "@elio/core";

const alwaysPass: NodeDefinition = {
  type: "always-pass",
  klass: "orchestration",
  handler: () => Promise.resolve({ status: "resolved", output: { passed: true, failures: [] }, confidence: 1, cost: {} } as NodeResult),
};

function subFeature(id: string): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id, version: "1.0.0" },
    contentHash: `${id}@1`,
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "none" },
      io: { input: {}, output: {} },
      graph: { steps: [{ id: "work", type: "transform", with: { set: true, as: "done" }, outputs: { done: "state.done" } }], edges: [] },
    },
  };
}

function parentPack(featureIds: string[]): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "fanout.parent", version: "1.0.0" },
    contentHash: "fanout.parent@1",
    feature: {
      autonomy: "static",
      artifact: { kind: "fan-out", evalGate: "always-pass" },
      io: { input: {}, output: {} },
      graph: {
        steps: [{ id: "fan", type: "feature-ref", with: { featureIds }, outputs: { completed: "state.completed", missing: "state.missing" } }],
        edges: [],
      },
    },
  };
}

async function drive(runner: OuterLoopRunner, pack: FeaturePack): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of runner.run(pack, { payload: {}, budget: 100, maxDepth: 20 })) out.push(ev);
  return out;
}
function contentOf(runner: OuterLoopRunner, events: RunEvent[]): Record<string, unknown> {
  const runId = events.find((e) => e.type === "run-started")?.correlation.run ?? "";
  return runner.getArtifact(runId)?.content as Record<string, unknown>;
}

describe("nodes/feature-ref — registry-driven fan-out (§3)", () => {
  function runtime(features: FeaturePack[]): OuterLoopRunner {
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    registry.register(alwaysPass);
    return new OuterLoopRunner({
      registry,
      store: new InMemoryRunStore(),
      featureRegistry: new FeatureRegistry(features),
    });
  }

  it("runs each registered sub-feature as its own child branch", async () => {
    const runner = runtime([subFeature("sub.a"), subFeature("sub.b")]);
    const events = await drive(runner, parentPack(["sub.a", "sub.b"]));
    const content = contentOf(runner, events);
    expect((content["completed"] as string[]).sort()).toEqual(["sub.a", "sub.b"]);
    expect(events[events.length - 1]).toMatchObject({ type: "run-completed", gate: "passed" });
  });

  it("reports unknown feature ids as missing (no hard error)", async () => {
    const runner = runtime([subFeature("sub.a")]);
    const content = contentOf(runner, await drive(runner, parentPack(["sub.a", "sub.missing"])));
    expect(content["completed"]).toEqual(["sub.a"]);
    expect(content["missing"]).toEqual(["sub.missing"]);
  });

  it("fails closed when no FeatureRegistry is wired", async () => {
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    registry.register(alwaysPass);
    const runner = new OuterLoopRunner({ registry, store: new InMemoryRunStore() }); // no featureRegistry
    const events = await drive(runner, parentPack(["sub.a"]));
    expect(events[events.length - 1]).toMatchObject({ type: "run-completed", gate: "stopped" });
    expect(events.some((e) => e.type === "node-resolved" && e.correlation.step === "fan")).toBe(false);
  });

  it("de-duplicates featureIds (a repeated id runs once)", async () => {
    const runner = runtime([subFeature("sub.a")]);
    const content = contentOf(runner, await drive(runner, parentPack(["sub.a", "sub.a"])));
    expect(content["completed"]).toEqual(["sub.a"]);
  });

  it("stamps child frames with the SUB-feature id, parent frames with the parent id (6b)", async () => {
    const store = new InMemoryRunStore();
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    registry.register(alwaysPass);
    const runner = new OuterLoopRunner({ registry, store, featureRegistry: new FeatureRegistry([subFeature("sub.a")]) });
    const events = await drive(runner, parentPack(["sub.a"]));
    const runId = events.find((e) => e.type === "run-started")?.correlation.run ?? "";
    const frames = store.getTape(runId);
    expect(frames.find((f) => f.correlation.step === "fan")?.feature).toBe("fanout.parent");
    expect(frames.find((f) => f.correlation.step === "work")?.feature).toBe("sub.a"); // NOT the parent id
  });

  it("reports a parked sub-feature child without blocking siblings", async () => {
    const gated: FeaturePack = {
      ...subFeature("sub.gate"),
      feature: {
        ...subFeature("sub.gate").feature,
        graph: { steps: [{ id: "approve", type: "approval", suspend: "blocking", with: { reason: "ok?" } }], edges: [] },
      },
    };
    const runner = runtime([gated, subFeature("sub.b")]);
    const events = await drive(runner, parentPack(["sub.gate", "sub.b"]));
    const content = contentOf(runner, events);
    expect(content["completed"]).toEqual(["sub.b"]); // sibling still completed (not blocked by the parked child)
    expect((content["parked"] as unknown[]).length).toBe(1); // gated child parked, surfaced in the output
    // a parked child leaves the run suspended (resumable via correlation-id), so it does NOT run-complete:
    expect(events.some((e) => e.type === "run-completed")).toBe(false);
  });
});
