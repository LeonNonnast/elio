import { describe, expect, it } from "vitest";
import {
  allowedTraceScopes,
  InMemoryRunStore,
  PolicyInjector,
  RunStoreTracesService,
  rootPolicy,
  traceScope,
} from "@elio/core";
import type { Artifact, CorrelationId, NodeDefinition, NodeResult, TapeFrame } from "@elio/core";

const RESOLVED: NodeResult = { status: "resolved", output: {}, confidence: 1, cost: {} };

function frame(over: { step?: string; nodeType?: string; ts?: string } = {}): TapeFrame {
  return {
    correlation: { run: "run_1", branch: "b", step: over.step ?? "s1", checkpoint: "cp" },
    nodeType: over.nodeType ?? "llm",
    input: {},
    result: RESOLVED,
    injected: ["policy"],
    ts: over.ts ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("traces — allowedTraceScopes", () => {
  it("extracts traces:* scopes, drops empty and non-traces tool permissions", () => {
    expect(allowedTraceScopes(["traces:read", "secret:X", "traces:feature.y"])).toEqual([
      "read",
      "feature.y",
    ]);
    expect(allowedTraceScopes(["traces:"])).toEqual([]);
    expect(allowedTraceScopes([])).toEqual([]);
  });
});

describe("traces — RunStoreTracesService.collect", () => {
  async function populated(): Promise<{ store: InMemoryRunStore; run: string }> {
    const store = new InMemoryRunStore();
    const run = (await store.createRun({ payload: {}, budget: 1, maxDepth: 4 })).id;
    await store.appendTape(run, frame({ step: "s1", nodeType: "llm" }));
    await store.appendTape(run, frame({ step: "s2", nodeType: "transform", ts: "2026-02-01T00:00:00.000Z" }));
    return { store, run };
  }

  it("collects all frames across enumerated runs by default", async () => {
    const { store } = await populated();
    expect(await new RunStoreTracesService(store).collect()).toHaveLength(2);
  });

  it("filters by nodeType and by ts window (inclusive, lexicographic ISO)", async () => {
    const { store } = await populated();
    const svc = new RunStoreTracesService(store);
    expect(await svc.collect({ nodeType: "llm" })).toHaveLength(1);
    const since = await svc.collect({ since: "2026-01-15T00:00:00.000Z" });
    expect(since.map((f) => f.nodeType)).toEqual(["transform"]);
  });

  it("treats since/until as inclusive on both boundaries (review #7)", async () => {
    const { store } = await populated();
    const svc = new RunStoreTracesService(store);
    // until == s1.ts → s1 kept (equal, not >), s2 dropped:
    expect((await svc.collect({ until: "2026-01-01T00:00:00.000Z" })).map((f) => f.nodeType)).toEqual([
      "llm",
    ]);
    // since == s2.ts → s2 kept (equal, not <), s1 dropped:
    expect((await svc.collect({ since: "2026-02-01T00:00:00.000Z" })).map((f) => f.nodeType)).toEqual([
      "transform",
    ]);
  });

  it("filters by explicit run set; unknown run yields nothing", async () => {
    const { store, run } = await populated();
    const svc = new RunStoreTracesService(store);
    expect(await svc.collect({ runs: [run] })).toHaveLength(2);
    expect(await svc.collect({ runs: ["nope"] })).toHaveLength(0);
  });

  it("enforces a feature scope (traces:<feature>) and filters by query.feature (6b)", async () => {
    const store = new InMemoryRunStore();
    const run = (await store.createRun({ payload: {}, budget: 1, maxDepth: 1 })).id;
    await store.appendTape(run, { ...frame({ step: "a" }), feature: "feat.X" });
    await store.appendTape(run, { ...frame({ step: "b" }), feature: "feat.Y" });
    // readAll → both visible:
    expect(await new RunStoreTracesService(store).collect()).toHaveLength(2);
    // scoped to feat.X → only X (feat.Y excluded by policy scope):
    const scoped = new RunStoreTracesService(store, traceScope(["feat.X"]));
    expect((await scoped.collect()).map((f) => f.feature)).toEqual(["feat.X"]);
    // query.feature narrows within scope:
    expect(await new RunStoreTracesService(store).collect({ feature: "feat.Y" })).toHaveLength(1);
  });

  it("enforces the feature scope on tape() too, not only collect() (no scope bypass)", async () => {
    const store = new InMemoryRunStore();
    const run = (await store.createRun({ payload: {}, budget: 1, maxDepth: 1 })).id;
    await store.appendTape(run, { ...frame({ step: "a" }), feature: "feat.X" });
    await store.appendTape(run, { ...frame({ step: "b" }), feature: "feat.Y" });
    const scoped = new RunStoreTracesService(store, traceScope(["feat.X"]));
    const seen: (string | undefined)[] = [];
    for await (const f of scoped.tape(run)) seen.push(f.feature);
    expect(seen).toEqual(["feat.X"]); // feat.Y filtered out via tape() as well
  });
});

describe("traces — injector gating (security by absence, Inv. 14)", () => {
  const artifact: Artifact = {
    ref: { id: "a", version: 0, kind: "k" },
    type: { kind: "k", holders: [] },
    content: {},
    holders: {},
  };
  const corr: CorrelationId = { run: "run_1", branch: "b", step: "s1", checkpoint: "cp" };
  const node = (tools?: string[]): NodeDefinition => ({
    type: "miner",
    klass: "orchestration",
    handler: () => Promise.resolve(RESOLVED),
    ...(tools !== undefined ? { requests: { tools } } : {}),
  });

  it("injects ctx.traces when policy grants traces:read and a store is wired", () => {
    const injector = new PolicyInjector({ store: new InMemoryRunStore() });
    const parent = rootPolicy({ toolPermissions: ["traces:read"] });
    const ctx = injector.buildCtx(node(["traces:read"]), parent, corr, artifact);
    expect(ctx.traces).toBeDefined();
  });

  it("omits ctx.traces when the node does not request it", () => {
    const injector = new PolicyInjector({ store: new InMemoryRunStore() });
    const parent = rootPolicy({ toolPermissions: ["traces:read"] });
    expect(injector.buildCtx(node(), parent, corr, artifact).traces).toBeUndefined();
  });

  it("omits ctx.traces when the parent policy does not allow it (tighten intersect empty)", () => {
    const injector = new PolicyInjector({ store: new InMemoryRunStore() });
    const parent = rootPolicy({ toolPermissions: [] });
    expect(injector.buildCtx(node(["traces:read"]), parent, corr, artifact).traces).toBeUndefined();
  });

  it("omits ctx.traces when no source is wired even if granted", () => {
    const injector = new PolicyInjector({});
    const parent = rootPolicy({ toolPermissions: ["traces:read"] });
    expect(injector.buildCtx(node(["traces:read"]), parent, corr, artifact).traces).toBeUndefined();
  });
});
