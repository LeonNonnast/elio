import { describe, expect, it } from "vitest";
import {
  allowedFeatureStoreScopes,
  InMemoryFeatureStore,
  InMemoryRunStore,
  PolicyInjector,
  rootPolicy,
} from "@elio/core";
import type { Artifact, CorrelationId, FeaturePack, NodeDefinition, NodeResult } from "@elio/core";

const RESOLVED: NodeResult = { status: "resolved", output: {}, confidence: 1, cost: {} };

function pack(id: string, version: string): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id, version },
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "g" },
      io: { input: {}, output: {} },
      graph: { steps: [], edges: [] },
    },
  };
}

describe("featurestore — allowedFeatureStoreScopes", () => {
  it("extracts featurestore:* scopes, drops empty and unrelated permissions", () => {
    expect(allowedFeatureStoreScopes(["featurestore:write", "traces:read"])).toEqual(["write"]);
    expect(allowedFeatureStoreScopes(["featurestore:"])).toEqual([]);
    expect(allowedFeatureStoreScopes([])).toEqual([]);
  });
});

describe("featurestore — InMemoryFeatureStore", () => {
  it("seeds, gets latest, lists versions, upserts by version", async () => {
    const store = new InMemoryFeatureStore([pack("demo.svc", "1.0.0")]);
    expect((await store.get("demo.svc"))?.metadata.version).toBe("1.0.0");
    await store.put(pack("demo.svc", "1.0.1"));
    expect((await store.get("demo.svc"))?.metadata.version).toBe("1.0.1"); // latest
    expect(await store.versions("demo.svc")).toEqual(["1.0.0", "1.0.1"]);
    await store.put(pack("demo.svc", "1.0.1")); // upsert same version → no duplicate
    expect(await store.versions("demo.svc")).toEqual(["1.0.0", "1.0.1"]);
  });

  it("returns null for unknown id", async () => {
    expect(await new InMemoryFeatureStore().get("nope")).toBeNull();
  });
});

describe("featurestore — injector gating (security by absence, Inv. 14)", () => {
  const artifact: Artifact = {
    ref: { id: "a", version: 0, kind: "k" },
    type: { kind: "k", holders: [] },
    content: {},
    holders: {},
  };
  const corr: CorrelationId = { run: "r", branch: "b", step: "s", checkpoint: "cp" };
  const node = (tools?: string[]): NodeDefinition => ({
    type: "n",
    klass: "orchestration",
    handler: () => Promise.resolve(RESOLVED),
    ...(tools !== undefined ? { requests: { tools } } : {}),
  });

  it("injects ctx.featureStore only when granted featurestore:write and a store is wired", () => {
    const featureStore = new InMemoryFeatureStore();
    const injector = new PolicyInjector({ store: new InMemoryRunStore(), featureStore });
    const parent = rootPolicy({ toolPermissions: ["featurestore:write"] });
    expect(injector.buildCtx(node(["featurestore:write"]), parent, corr, artifact).featureStore).toBeDefined();
    // not requested:
    expect(injector.buildCtx(node(), parent, corr, artifact).featureStore).toBeUndefined();
    // parent does not grant:
    const denied = rootPolicy({ toolPermissions: [] });
    expect(injector.buildCtx(node(["featurestore:write"]), denied, corr, artifact).featureStore).toBeUndefined();
  });

  it("omits ctx.featureStore when no store is wired even if granted", () => {
    const injector = new PolicyInjector({ store: new InMemoryRunStore() });
    const parent = rootPolicy({ toolPermissions: ["featurestore:write"] });
    expect(injector.buildCtx(node(["featurestore:write"]), parent, corr, artifact).featureStore).toBeUndefined();
  });
});
