// ───────────────────────────── ScopedFsService + InMemoryDbService + node wiring (Inv. 14, §11/#1/#11) ─────────────────────────────

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScopedFsService } from "./fs";
import { InMemoryDbService } from "./db";
import { collectEvents, createRuntime } from "../runtime";
import type { FeaturePack, RunEvent, TapeFrame } from "@elio/core";

// ───────────────────────────── ScopedFsService: real fs, confined to roots ─────────────────────────────

describe("ScopedFsService — real node:fs confined to allowed prefixes; escape rejected", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "elio-fs-"));
    await writeFile(join(dir, "in.txt"), "hello-from-disk", "utf8");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads + writes a file within the root", async () => {
    const fs = new ScopedFsService({ roots: [dir] });
    expect(await fs.read(join(dir, "in.txt"))).toBe("hello-from-disk");
    await fs.write(join(dir, "sub", "out.txt"), "written");
    expect(await readFile(join(dir, "sub", "out.txt"), "utf8")).toBe("written");
  });

  it("rejects a path-traversal escape ('../../etc/passwd')", async () => {
    const fs = new ScopedFsService({ roots: [dir] });
    await expect(fs.read(join(dir, "..", "..", "etc", "passwd"))).rejects.toThrow(/escape/i);
    // an absolute path outside the root is rejected too
    await expect(fs.read("/etc/passwd")).rejects.toThrow(/escape/i);
  });

  it("does not treat a sibling directory with a shared prefix as in-scope", async () => {
    const fs = new ScopedFsService({ roots: [join(dir, "data")] });
    // "<dir>/data2/x" must NOT be considered under "<dir>/data"
    await expect(fs.read(join(dir, "data2", "x"))).rejects.toThrow(/escape/i);
  });
});

// ───────────────────────────── InMemoryDbService: scope-gated ─────────────────────────────

describe("InMemoryDbService — map-backed, scope-gated", () => {
  it("INSERT then SELECT round-trips through the mini-SQL", async () => {
    const db = new InMemoryDbService();
    await db.query("INSERT INTO users (id, name) VALUES ('u1', 'Ann')");
    await db.query("INSERT INTO users (id, name) VALUES ('u2', 'Bob')");
    const all = await db.query("SELECT * FROM users");
    expect(all).toHaveLength(2);
    const filtered = await db.query("SELECT * FROM users WHERE id = 'u2'");
    expect(filtered).toEqual([{ id: "u2", name: "Bob" }]);
  });

  it("rejects a table outside the allowed scopes", async () => {
    const db = new InMemoryDbService({ scopes: ["sales"] });
    await expect(db.query("SELECT * FROM hr_secrets")).rejects.toThrow(/scope/i);
    await expect(db.query("SELECT * FROM sales")).resolves.toEqual([]); // in scope, empty
  });

  it("supports parameterized values", async () => {
    const db = new InMemoryDbService();
    await db.query("INSERT INTO t (id, v) VALUES (?, ?)", ["k", 7]);
    expect(await db.query("SELECT * FROM t WHERE id = 'k'")).toEqual([{ id: "k", v: 7 }]);
  });
});

// ───────────────────────────── End-to-end: fs node confined; db scoped; batch no-checkpoint ─────────────────────────────

function fsPack(): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.fs-write", version: "1", owner: "t" },
    contentHash: "t.fs-write@1",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "pass-gate" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [{ id: "w", type: "file", with: { op: "write", path: "{{state.path}}", content: "ok" } }],
        edges: [],
      },
    },
  };
}

function passGate() {
  return {
    type: "pass-gate",
    klass: "orchestration" as const,
    handler: () =>
      Promise.resolve({
        status: "resolved" as const,
        output: { passed: true, failures: [] },
        confidence: 1,
        cost: {},
      }),
  };
}

describe("end-to-end: built-in I/O nodes through the runtime with scoped services", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "elio-e2e-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("file node REJECTS a '..' traversal that escapes the policy-granted prefix (Inv. 14/20, §11/#1)", async () => {
    // Backend rooted broadly at `dir`; policy grants ONLY `dir/data`. A literal "../secret.txt" passes
    // a naive startsWith('dir/data/') but resolves OUTSIDE the policy scope — the injector's ScopedFsService
    // must normalize and deny it (this is the path-traversal leak the fix closes).
    await writeFile(join(dir, "secret.txt"), "TOP SECRET", "utf8");
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "data", "ok.txt"), "in-scope", "utf8");

    const rt = createRuntime({
      fs: new ScopedFsService({ roots: [dir] }), // backend root is broad
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
        fsPaths: { read: [join(dir, "data")], write: [join(dir, "data")] }, // policy granted ONLY data/
      },
    });
    rt.registry.register(passGate());

    const escapePack: FeaturePack = {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.fs-escape", version: "1", owner: "t" },
      contentHash: "t.fs-escape@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: {
          state: { path: join(dir, "data", "..", "secret.txt") }, // -> dir/secret.txt, OUT of scope
          steps: [{ id: "r", type: "file", with: { op: "read", path: "{{state.path}}" } }],
          edges: [],
        },
      },
    };

    const events = await collectEvents(rt.run(escapePack, { payload: {}, budget: 100, maxDepth: 5 }));
    const runId = events.find((e) => e.type === "run-started")!.correlation.run;
    const tape: TapeFrame[] = rt.store.getTape(runId);
    const fileFrame = tape.find((f) => f.nodeType === "file");
    // The read must have FAILED (denied) — the secret never reached the node.
    expect(fileFrame?.result.status).toBe("failed");
    const serialized = JSON.stringify(tape);
    expect(serialized).not.toContain("TOP SECRET");

    // Sanity: an in-scope read of the SAME backend still works (the confinement is the boundary, not fs).
    const okPack: FeaturePack = {
      ...escapePack,
      metadata: { id: "t.fs-inscope", version: "1", owner: "t" },
      contentHash: "t.fs-inscope@1",
      feature: {
        ...escapePack.feature,
        graph: {
          state: { path: join(dir, "data", "ok.txt") },
          steps: [{ id: "r", type: "file", with: { op: "read", path: "{{state.path}}" } }],
          edges: [],
        },
      },
    };
    const okEvents = await collectEvents(rt.run(okPack, { payload: {}, budget: 100, maxDepth: 5 }));
    const okRunId = okEvents.find((e) => e.type === "run-started")!.correlation.run;
    const okFile = rt.store.getTape(okRunId).find((f) => f.nodeType === "file");
    expect(okFile?.result.status).toBe("resolved");
  });

  it("file node writes only within the policy-granted prefix", async () => {
    const rt = createRuntime({
      fs: new ScopedFsService({ roots: [dir] }),
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
        fsPaths: { read: [dir], write: [dir] },
      },
    });
    rt.registry.register(passGate());

    const pack = fsPack();
    pack.feature.graph!.state = { path: join(dir, "result.txt") };
    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 5 }));
    expect(events.some((e: RunEvent) => e.type === "run-completed")).toBe(true);
    expect(await readFile(join(dir, "result.txt"), "utf8")).toBe("ok");
  });

  it("db node is scope-gated; batch processes all items without per-record checkpoints", async () => {
    const db = new InMemoryDbService({ scopes: ["records"] });
    const rt = createRuntime({
      db,
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
        dbScopes: ["records"],
      },
    });
    rt.registry.register(passGate());

    const pack: FeaturePack = {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.batch-commit", version: "1", owner: "t" },
      contentHash: "t.batch-commit@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: {
          state: { items: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] },
          steps: [
            {
              id: "commit",
              type: "batch",
              with: {
                items: "{{state.items}}",
                op: "db",
                sql: "INSERT INTO records (id) VALUES ('{{item.id}}')",
              },
              outputs: { processed: "state.processed" },
            },
          ],
          edges: [],
        },
      },
    };

    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 5 }));
    // ONE batch node frame committed ALL records (no per-record branch -> no node-suspended / sub frames)
    expect(events.some((e: RunEvent) => e.type === "run-completed")).toBe(true);
    expect(db.rows("records")).toHaveLength(3);

    const started = events.find((e) => e.type === "run-started");
    const runId = started!.correlation.run;
    const tape: TapeFrame[] = rt.store.getTape(runId);
    const batchFrames = tape.filter((f) => f.nodeType === "batch");
    expect(batchFrames).toHaveLength(1); // exactly ONE node call for the whole batch (§11/#11)
  });
});

// ───────────────────────────── End-to-end: data-class tape redaction (§11/#9) ─────────────────────────────

describe("end-to-end: a confidential field is redacted in the tape while a public field stays raw", () => {
  it("runs a node emitting both classes; tape hashes confidential, keeps public raw", async () => {
    const rt = createRuntime({
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "internal", // tape may store raw up to internal
        suspendMode: "optional",
        toolPermissions: [],
      },
    });
    rt.registry.register({
      type: "emit",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved" as const,
          output: { publicNote: "everyone-can-see", confidentialDetail: "TOP-SECRET-PAYLOAD" },
          confidence: 1,
          cost: {},
        }),
    });
    rt.registry.register(passGate());

    const pack: FeaturePack = {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.dataclass", version: "1", owner: "t" },
      contentHash: "t.dataclass@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: { state: {}, steps: [{ id: "e", type: "emit" }], edges: [] },
      },
    };

    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 5 }));
    const runId = events.find((e) => e.type === "run-started")!.correlation.run;
    const tape = rt.store.getTape(runId);
    const serialized = JSON.stringify(tape);

    // confidential payload is hashed/redacted; public payload stays raw
    expect(serialized).not.toContain("TOP-SECRET-PAYLOAD");
    expect(serialized).toContain("everyone-can-see");

    const emitFrame = tape.find((f) => f.nodeType === "emit");
    expect(emitFrame?.redaction?.level).toBe("internal");
    expect(emitFrame?.redaction?.redactedFields).toContain("result.output.confidentialDetail");
  });
});
