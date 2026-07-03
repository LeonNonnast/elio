import { describe, expect, it } from "vitest";
import {
  BudgetTracker,
  createArtifact,
  InProcessSandbox,
  PolicyInjector,
  rootPolicy,
} from "@elio/core";
import type {
  Artifact,
  ArtifactType,
  CorrelationId,
  DbService,
  FsService,
  ModelService,
  NodeDefinition,
} from "@elio/core";

const type: ArtifactType = { kind: "demo", holders: ["memory"] };
const artifact: Artifact = createArtifact(type, {});
const corr: CorrelationId = { run: "r", branch: "b", step: "s", checkpoint: "c" };

const model: ModelService = {
  complete: () => Promise.resolve({ text: "hi", cost: {}, confidence: 1 }),
};
const fs: FsService = {
  read: () => Promise.resolve("file-contents"),
  write: () => Promise.resolve(),
};
const db: DbService = { query: () => Promise.resolve([{ ok: true }]) };

function node(over: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    type: "test",
    klass: "orchestration",
    handler: () => Promise.resolve({ status: "resolved", output: {}, confidence: 1, cost: {} }),
    ...over,
  };
}

describe("PolicyInjector — security by absence (Inv. 14)", () => {
  it("a node requesting nothing has NO ctx.fs/db/model — even when backends exist", () => {
    const injector = new PolicyInjector({ model, fs, db, budget: new BudgetTracker(10, 4) });
    const ctx = injector.buildCtx(node(), rootPolicy(), corr, artifact);

    expect(ctx.fs).toBeUndefined();
    expect(ctx.db).toBeUndefined();
    expect(ctx.model).toBeUndefined();
    // always-present invariants:
    expect(ctx.correlation).toBe(corr);
    expect(ctx.artifact).toBe(artifact);
    expect(ctx.policy).toBeDefined();
    expect(ctx.cost).toBeDefined(); // budget provided -> cost service present
    expect(ctx.elicit).toBeDefined(); // suspend/resume path always available
  });

  it("a node requesting a model NOT in the parent grant gets no ctx.model", () => {
    // parent allows only "ollama"; node requests "azure" -> intersection empty -> no model
    const parent = rootPolicy({ allowedModels: ["ollama"] });
    const injector = new PolicyInjector({ model });
    const ctx = injector.buildCtx(
      node({ requests: { models: ["azure"] } }),
      parent,
      corr,
      artifact,
    );
    expect(ctx.model).toBeUndefined();
  });

  it("a node requesting a granted model with a ModelService provided gets ctx.model", () => {
    const parent = rootPolicy({ allowedModels: ["ollama", "claude"] });
    const injector = new PolicyInjector({ model });
    const ctx = injector.buildCtx(
      node({ requests: { models: ["claude"] } }),
      parent,
      corr,
      artifact,
    );
    // Der Injector wrappt das Backend in einen policy-gescopten ScopedModelService (defense in depth,
    // Inv. 13/14) — ctx.model ist also DEFINED, aber nicht identitäts-gleich dem bare backend.
    expect(ctx.model).toBeDefined();
    expect(typeof ctx.model?.complete).toBe("function");
  });

  it("a granted model but NO ModelService provided still yields no ctx.model", () => {
    const parent = rootPolicy({ allowedModels: ["claude"] });
    const injector = new PolicyInjector({}); // no model dep
    const ctx = injector.buildCtx(
      node({ requests: { models: ["claude"] } }),
      parent,
      corr,
      artifact,
    );
    expect(ctx.model).toBeUndefined();
  });

  it("fs is injected (scoped) only when resolved.fsPaths is non-empty", async () => {
    const parent = rootPolicy({ fsPaths: { read: ["/data"], write: ["/data/out"] } });
    const injector = new PolicyInjector({ fs });
    const ctx = injector.buildCtx(
      node({ requests: { fs: { read: ["/data/in.csv"], write: ["/data/out/x"] } } }),
      parent,
      corr,
      artifact,
    );
    expect(ctx.fs).toBeDefined();
    // scoped wrapper allows in-scope, rejects out-of-scope
    await expect(ctx.fs!.read("/data/in.csv")).resolves.toBe("file-contents");
    await expect(ctx.fs!.read("/etc/passwd")).rejects.toThrow(/denied|out of scope/i);
  });

  it("db is injected only when resolved.dbScopes is non-empty", () => {
    const parent = rootPolicy({ dbScopes: ["sales"] });
    const injector = new PolicyInjector({ db });
    const withScope = injector.buildCtx(
      node({ requests: { db: ["sales"] } }),
      parent,
      corr,
      artifact,
    );
    expect(withScope.db).toBeDefined();

    const noScope = injector.buildCtx(
      node({ requests: { db: ["hr"] } }), // hr not in parent -> empty intersection
      parent,
      corr,
      artifact,
    );
    expect(noScope.db).toBeUndefined();
  });

  it("serviceKeys reports exactly the injected capabilities (audit = what was possible)", () => {
    const injector = new PolicyInjector({ model, budget: new BudgetTracker(10, 4) });
    const ctx = injector.buildCtx(
      node({ requests: { models: ["claude"] } }),
      rootPolicy({ allowedModels: ["claude"] }),
      corr,
      artifact,
    );
    const keys = PolicyInjector.serviceKeys(ctx);
    expect(keys).toContain("model");
    expect(keys).toContain("cost");
    expect(keys).toContain("elicit");
    expect(keys).not.toContain("fs");
    expect(keys).not.toContain("db");
  });
});

describe("InProcessSandbox", () => {
  it("runs the node handler with the given input + ctx", async () => {
    const injector = new PolicyInjector({});
    const ctx = injector.buildCtx(node(), rootPolicy(), corr, artifact);
    const sandbox = new InProcessSandbox();
    const echo = node({
      handler: (input) =>
        Promise.resolve({ status: "resolved", output: input, confidence: 1, cost: {} }),
    });
    const res = await sandbox.run(echo, { hello: "world" }, ctx);
    expect(res.status).toBe("resolved");
    if (res.status === "resolved") expect(res.output).toEqual({ hello: "world" });
  });
});

describe("BudgetTracker (Inv. 21)", () => {
  it("charges, reports remaining, and derives child depth/budget", () => {
    const t = new BudgetTracker(10, 3);
    expect(t.remaining()).toBe(10);
    expect(t.depth).toBe(0);
    t.charge({ usd: 4 });
    expect(t.remaining()).toBe(6);
    const child = t.child();
    expect(child.depth).toBe(1);
    expect(child.remaining()).toBe(6); // inherits remaining, never fresh
    expect(t.childDepth()).toBe(1);
    expect(new BudgetTracker(10, 1).isAtMaxDepth()).toBe(false);
    expect(new BudgetTracker(10, 0).isAtMaxDepth()).toBe(true);
  });
});
