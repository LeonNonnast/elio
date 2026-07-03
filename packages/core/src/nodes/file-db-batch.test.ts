// ───────────────────────────── file + db + batch built-ins (Inv. 6/7/14, Slice 4, §11/#11) ─────────────────────────────

import { describe, expect, it } from "vitest";
import {
  batchHandler,
  createArtifact,
  dbHandler,
  fileHandler,
  PolicyInjector,
  rootPolicy,
} from "@elio/core";
import type {
  Artifact,
  ArtifactType,
  CorrelationId,
  Ctx,
  DbService,
  FsService,
  NodeDefinition,
  NodeResult,
  Resolved,
} from "@elio/core";

const type: ArtifactType = { kind: "demo", holders: ["memory"] };
const artifact: Artifact = createArtifact(type, {});
const corr: CorrelationId = { run: "r", branch: "b", step: "s", checkpoint: "c" };

function node(over: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    type: "t",
    klass: "orchestration",
    handler: () => Promise.reject(new Error("unused")),
    ...over,
  };
}

function output(r: NodeResult): Record<string, unknown> {
  expect(r.status).toBe("resolved");
  return (r as Resolved).output as Record<string, unknown>;
}

// ───────────────────────────── file node ─────────────────────────────

describe("file node — read/write via ctx.fs (path-scoped, fails by absence)", () => {
  const fs: FsService = {
    read: (p) => Promise.resolve(`contents-of-${p}`),
    write: () => Promise.resolve(),
  };

  it("FAILS BY ABSENCE: no ctx.fs (policy granted no fsPaths) -> throws", async () => {
    // node requests fs but the parent grants NO fsPaths -> tighten yields empty -> no ctx.fs.
    const ctx: Ctx = new PolicyInjector({ fs }).buildCtx(
      node({ requests: { fs: { read: ["*"], write: ["*"] } } }),
      rootPolicy(), // no fsPaths
      corr,
      artifact,
    );
    expect(ctx.fs).toBeUndefined();
    await expect(fileHandler({ op: "read", path: "/data/x" }, ctx)).rejects.toThrow(
      /security by absence|not injiziert|nicht injiziert/i,
    );
  });

  it("reads within the allowed prefix; rejects an out-of-scope path", async () => {
    const parent = rootPolicy({ fsPaths: { read: ["/data"], write: ["/data"] } });
    const ctx: Ctx = new PolicyInjector({ fs }).buildCtx(
      node({ requests: { fs: { read: ["*"], write: ["*"] } } }),
      parent,
      corr,
      artifact,
    );
    expect(ctx.fs).toBeDefined();
    const r = await fileHandler({ op: "read", path: "/data/in.csv" }, ctx);
    expect(output(r)["content"]).toBe("contents-of-/data/in.csv");
    // out-of-scope path: the injector's ScopedFsService rejects -> handler rejects.
    await expect(fileHandler({ op: "read", path: "/etc/passwd" }, ctx)).rejects.toThrow(
      /denied|out of scope/i,
    );
  });

  it("writes within scope and reports bytes", async () => {
    const parent = rootPolicy({ fsPaths: { read: ["/data"], write: ["/data"] } });
    const ctx: Ctx = new PolicyInjector({ fs }).buildCtx(
      node({ requests: { fs: { read: ["*"], write: ["*"] } } }),
      parent,
      corr,
      artifact,
    );
    const r = await fileHandler({ op: "write", path: "/data/out.txt", content: "hello" }, ctx);
    expect(output(r)["bytes"]).toBe(5);
  });
});

// ───────────────────────────── db node ─────────────────────────────

describe("db node — query/write via ctx.db (scope-gated, fails by absence)", () => {
  const db: DbService = { query: () => Promise.resolve([{ id: "1" }, { id: "2" }]) };

  it("FAILS BY ABSENCE: no dbScope granted -> no ctx.db -> throws", async () => {
    const ctx: Ctx = new PolicyInjector({ db }).buildCtx(
      node({ requests: { db: ["*"] } }),
      rootPolicy(), // no dbScopes
      corr,
      artifact,
    );
    expect(ctx.db).toBeUndefined();
    await expect(dbHandler({ op: "query", sql: "SELECT * FROM t" }, ctx)).rejects.toThrow(
      /security by absence|nicht injiziert/i,
    );
  });

  it("query returns rows when a scope is granted", async () => {
    const parent = rootPolicy({ dbScopes: ["sales"] });
    const ctx: Ctx = new PolicyInjector({ db }).buildCtx(
      node({ requests: { db: ["sales"] } }),
      parent,
      corr,
      artifact,
    );
    expect(ctx.db).toBeDefined();
    const r = await dbHandler({ op: "query", sql: "SELECT * FROM sales" }, ctx);
    expect((output(r)["rows"] as unknown[]).length).toBe(2);
  });

  it("a scope the parent does NOT grant -> no ctx.db (security by absence)", () => {
    const parent = rootPolicy({ dbScopes: ["sales"] });
    const ctx: Ctx = new PolicyInjector({ db }).buildCtx(
      node({ requests: { db: ["hr"] } }), // hr not in parent -> empty intersection
      parent,
      corr,
      artifact,
    );
    expect(ctx.db).toBeUndefined();
  });
});

// ───────────────────────────── batch node (§11/#11) ─────────────────────────────

describe("batch node — mass I/O WITHOUT per-record checkpoint/sandbox (§11/#11)", () => {
  it("op=collect projects all items with no service needed", async () => {
    const ctx: Ctx = new PolicyInjector({}).buildCtx(node(), rootPolicy(), corr, artifact);
    const items = [{ v: 1 }, { v: 2 }, { v: 3 }];
    const r = await batchHandler({ items, op: "collect", pick: "v" }, ctx);
    const o = output(r);
    expect(o["results"]).toEqual([1, 2, 3]);
    expect(o["processed"]).toBe(3);
  });

  it("op=db processes ALL items in ONE node call (no per-record branch)", async () => {
    let queries = 0;
    const db: DbService = {
      query: () => {
        queries += 1;
        return Promise.resolve([{ id: String(queries) }]); // 1 affected per call
      },
    };
    const parent = rootPolicy({ dbScopes: ["t"] });
    const ctx: Ctx = new PolicyInjector({ db }).buildCtx(
      node({ requests: { db: ["t"] } }),
      parent,
      corr,
      artifact,
    );
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const r = await batchHandler(
      { items, op: "db", sql: "INSERT INTO t (id) VALUES ('{{item.id}}')" },
      ctx,
    );
    const o = output(r);
    expect(o["processed"]).toBe(3);
    expect(queries).toBe(3); // one db call per item, but a SINGLE node invocation / Resolved
    expect((o["results"] as { affected: number }[]).every((x) => x.affected === 1)).toBe(true);
  });

  it("op=db fails by absence when no db scope was granted", async () => {
    const ctx: Ctx = new PolicyInjector({}).buildCtx(node(), rootPolicy(), corr, artifact);
    await expect(
      batchHandler({ items: [{ id: "a" }], op: "db", sql: "INSERT INTO t (id) VALUES ('a')" }, ctx),
    ).rejects.toThrow(/security by absence/i);
  });
});
