import { describe, expect, it } from "vitest";
import {
  allowedScriptScopes,
  createArtifact,
  PolicyInjector,
  rootPolicy,
  WorkerScriptRunner,
} from "@elio/core";
import type {
  Artifact,
  ArtifactType,
  CorrelationId,
  NodeDefinition,
  ScriptRunnerService,
} from "@elio/core";

// Kurzes Default-Timeout hält die (echten) Worker-Tests snappy.
const runner = new WorkerScriptRunner({ defaultTimeoutMs: 150 });

describe("WorkerScriptRunner — isolierte Ausführung generierter reiner Funktionen (Tier-2, Inv. 20)", () => {
  it("executes a pure (input)=>output function and returns its JSON output", async () => {
    const r = await runner.run("function (i) { return { sum: i.a + i.b }; }", { a: 2, b: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toEqual({ sum: 5 });
  });

  it("supports arrow-function source too", async () => {
    const r = await runner.run("(i) => ({ doubled: i.n * 2 })", { n: 21 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toEqual({ doubled: 42 });
  });

  it("denies require() — no ambient authority in the sandbox (security by absence)", async () => {
    const r = await runner.run("function (i) { return require('node:fs').readFileSync('/etc/passwd','utf8'); }", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/require is not defined/);
  });

  it("denies process access — no host globals leak into the sandbox", async () => {
    const r = await runner.run("function (i) { return { pid: process.pid }; }", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/process is not defined/);
  });

  it("blocks the classic vm realm-escape via the input object's constructor chain", async () => {
    // Input crosses as a JSON string parsed by the vm's OWN JSON -> i.constructor is the vm's Object,
    // not the host's. A live host object here would leak the real process (verified out-of-band).
    const escape =
      "function (i) { return { pid: i.constructor.constructor('return process')().pid }; }";
    const r = await runner.run(escape, { n: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/process is not defined/);
  });

  it("a returned thenable/Promise is an honest MISS, not a confident HIT of {} (async fn + never-resolving)", async () => {
    const asyncFn = await runner.run("async function (i) { return { real: i.n }; }", { n: 1 });
    expect(asyncFn.ok).toBe(false);
    if (!asyncFn.ok) expect(asyncFn.error).toMatch(/thenable\/Promise/);
    // a never-resolving Promise must NOT hang and must NOT pass as a HIT:
    const hang = await runner.run("function (i) { return new Promise(function () {}); }", {}, { timeoutMs: 100 });
    expect(hang.ok).toBe(false);
    if (!hang.ok) expect(hang.error).toMatch(/thenable\/Promise/);
  });

  it("a falsy primitive output is a real HIT carrying that exact value (only undefined is a MISS)", async () => {
    for (const [src, expected] of [
      ["() => 0", 0],
      ["() => false", false],
      ['() => ""', ""],
      ["() => null", null],
    ] as const) {
      const r = await runner.run(src, {});
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.output).toBe(expected);
    }
  });

  it("preserves a falsy top-level input (0 is not coerced to null)", async () => {
    const r = await runner.run("(i) => ({ v: i })", 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toEqual({ v: 0 });
  });

  it("an output larger than the cap is a MISS (no huge payload reaches the host)", async () => {
    const small = new WorkerScriptRunner({ defaultTimeoutMs: 150, maxOutputBytes: 1024 });
    const r = await small.run("function (i) { return { big: 'x'.repeat(5000) }; }", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/);
  });

  it("a thrown error becomes ok:false (the MISS / out-of-domain signal -> LLM fallback)", async () => {
    const r = await runner.run("function (i) { throw new Error('out of domain'); }", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/out of domain/);
  });

  it("returning undefined is treated as out-of-domain (ok:false -> fallback)", async () => {
    const r = await runner.run("function (i) { return undefined; }", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/out-of-domain/);
  });

  it("a synchronous infinite loop is interrupted by the vm timeout (ok:false)", async () => {
    const r = await runner.run("function (i) { while (true) {} }", {}, { timeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timed out/);
  });

  it("recovers cleanly after a timeout — a fresh run still succeeds", async () => {
    await runner.run("function (i) { while (true) {} }", {}, { timeoutMs: 100 });
    const r = await runner.run("function (i) { return { ok: i.x }; }", { x: 99 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toEqual({ ok: 99 });
  });

  it("non-JSON-serializable input fails closed before spawning a worker", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const r = await runner.run("function (i) { return i; }", circular);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not JSON-serializable/);
  });
});

describe("allowedScriptScopes — toolPermission-Ableitung (analog featurestore/traces)", () => {
  it("extracts scopes behind the scripts: prefix and ignores others", () => {
    expect(allowedScriptScopes(["scripts:execute", "traces:read", "featurestore:write"])).toEqual([
      "execute",
    ]);
  });
  it("drops a bare prefix with no scope and yields [] when none granted", () => {
    expect(allowedScriptScopes(["scripts:"])).toEqual([]);
    expect(allowedScriptScopes(["traces:read"])).toEqual([]);
  });
});

describe("Injector-Gating: ctx.scripts (security by absence, Inv. 14)", () => {
  const type: ArtifactType = { kind: "demo", holders: ["memory"] };
  const artifact: Artifact = createArtifact(type, {});
  const corr: CorrelationId = { run: "r", branch: "b", step: "s", checkpoint: "c" };
  const fakeRunner: ScriptRunnerService = {
    run: () => Promise.resolve({ ok: true, output: { from: "fake" } }),
  };
  function node(over: Partial<NodeDefinition> = {}): NodeDefinition {
    return {
      type: "test",
      klass: "orchestration",
      handler: () => Promise.resolve({ status: "resolved", output: {}, confidence: 1, cost: {} }),
      ...over,
    };
  }

  it("injects ctx.scripts when scripts:execute is granted AND a runner is wired", () => {
    const injector = new PolicyInjector({ scriptRunner: fakeRunner });
    const ctx = injector.buildCtx(
      node({ requests: { tools: ["scripts:execute"] } }),
      rootPolicy({ toolPermissions: ["scripts:execute"] }),
      corr,
      artifact,
    );
    expect(ctx.scripts).toBe(fakeRunner);
    expect(PolicyInjector.serviceKeys(ctx)).toContain("scripts");
  });

  it("no ctx.scripts when the grant is present but NO runner is wired", () => {
    const injector = new PolicyInjector({});
    const ctx = injector.buildCtx(
      node({ requests: { tools: ["scripts:execute"] } }),
      rootPolicy({ toolPermissions: ["scripts:execute"] }),
      corr,
      artifact,
    );
    expect(ctx.scripts).toBeUndefined();
  });

  it("no ctx.scripts when a runner is wired but the node did not request scripts:execute", () => {
    const injector = new PolicyInjector({ scriptRunner: fakeRunner });
    const ctx = injector.buildCtx(node(), rootPolicy({ toolPermissions: ["scripts:execute"] }), corr, artifact);
    expect(ctx.scripts).toBeUndefined();
  });

  it("no ctx.scripts when the parent policy does not grant scripts:execute (tighten-only)", () => {
    const injector = new PolicyInjector({ scriptRunner: fakeRunner });
    const ctx = injector.buildCtx(
      node({ requests: { tools: ["scripts:execute"] } }),
      rootPolicy(), // parent grants nothing
      corr,
      artifact,
    );
    expect(ctx.scripts).toBeUndefined();
  });
});
