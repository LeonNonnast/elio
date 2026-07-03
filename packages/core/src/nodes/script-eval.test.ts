import { describe, expect, it } from "vitest";
import { scriptEvalHandler, WorkerScriptRunner } from "@elio/core";
import type { Ctx, NodeResult, ScriptEvalWith, ScriptRunnerService, ScriptRunResult } from "@elio/core";

function out(r: NodeResult): Record<string, unknown> {
  if (r.status !== "resolved") throw new Error(`expected resolved, got ${r.status}`);
  return r.output as Record<string, unknown>;
}

/** Konfigurierbarer Fake-Runner für schnelle, deterministische Node-Tests (der echte Worker: sandbox.test.ts). */
function fakeRunner(impl: (source: string, input: unknown) => ScriptRunResult): {
  scripts: ScriptRunnerService;
  calls: { source: string; input: unknown; timeoutMs?: number }[];
} {
  const calls: { source: string; input: unknown; timeoutMs?: number }[] = [];
  const scripts: ScriptRunnerService = {
    run: (source, input, opts) => {
      const rec: { source: string; input: unknown; timeoutMs?: number } = { source, input };
      if (opts?.timeoutMs !== undefined) rec.timeoutMs = opts.timeoutMs;
      calls.push(rec);
      return Promise.resolve(impl(source, input));
    },
  };
  return { scripts, calls };
}

describe("nodes/script-eval — Tier-2 ausgeführter generierter Code", () => {
  it("on a script HIT, spreads the output onto state fields + sets hitFlag true", async () => {
    const { scripts } = fakeRunner(() => ({ ok: true, output: { text: "SCRIPTED" } }));
    const ctx = { scripts } as unknown as Ctx;
    const cfg: ScriptEvalWith = { source: "function(i){return {text:'SCRIPTED'}}", probe: { a: 1 }, hitFlag: "__h" };
    const o = out(await scriptEvalHandler(cfg, ctx));
    expect(o["text"]).toBe("SCRIPTED");
    expect(o["__h"]).toBe(true);
  });

  it("on a script MISS (ok:false), emits only hitFlag false → LLM fallback", async () => {
    const { scripts } = fakeRunner(() => ({ ok: false, error: "out of domain" }));
    const ctx = { scripts } as unknown as Ctx;
    const o = out(await scriptEvalHandler({ source: "x", probe: { a: 1 }, hitFlag: "__h" }, ctx));
    expect(o["__h"]).toBe(false);
    expect(Object.keys(o)).toEqual(["__h"]);
  });

  it("defaults hitFlag to __scriptHit and wraps a non-object output under {value}", async () => {
    const { scripts } = fakeRunner(() => ({ ok: true, output: 42 }));
    const ctx = { scripts } as unknown as Ctx;
    const o = out(await scriptEvalHandler({ source: "x", probe: 7 }, ctx));
    expect(o["__scriptHit"]).toBe(true);
    expect(o["value"]).toBe(42);
  });

  it("decodes sourceB64 (rewrite path) and forwards the probe + timeout to ctx.scripts", async () => {
    const { scripts, calls } = fakeRunner(() => ({ ok: true, output: { ok: true } }));
    const ctx = { scripts } as unknown as Ctx;
    const realSource = "function (input) { return { y: input.x }; }";
    const sourceB64 = Buffer.from(realSource, "utf8").toString("base64");
    await scriptEvalHandler({ sourceB64, probe: { x: 9 }, timeoutMs: 123, hitFlag: "__h" }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.source).toBe(realSource); // decoded verbatim
    expect(calls[0]?.input).toEqual({ x: 9 });
    expect(calls[0]?.timeoutMs).toBe(123);
  });

  it("throws when ctx.scripts is absent (security by absence, Inv. 14)", async () => {
    const ctx = {} as unknown as Ctx;
    await expect(scriptEvalHandler({ source: "x", probe: {} }, ctx)).rejects.toThrow(/ctx\.scripts nicht injiziert/);
  });

  it("throws when no source is configured", async () => {
    const { scripts } = fakeRunner(() => ({ ok: true, output: {} }));
    const ctx = { scripts } as unknown as Ctx;
    await expect(scriptEvalHandler({ probe: {} }, ctx)).rejects.toThrow(/kein Skript-Source/);
  });

  it("end-to-end with the REAL WorkerScriptRunner: generated function runs isolated and hits", async () => {
    const ctx = { scripts: new WorkerScriptRunner({ defaultTimeoutMs: 150 }) } as unknown as Ctx;
    const o = out(
      await scriptEvalHandler(
        { source: "function (input) { return { sum: input.a + input.b }; }", probe: { a: 2, b: 5 }, hitFlag: "__h" },
        ctx,
      ),
    );
    expect(o["sum"]).toBe(7);
    expect(o["__h"]).toBe(true);
  });

  it("end-to-end: a generated function that throws becomes a MISS (fallback)", async () => {
    const ctx = { scripts: new WorkerScriptRunner({ defaultTimeoutMs: 150 }) } as unknown as Ctx;
    const o = out(
      await scriptEvalHandler({ source: "function (i) { throw new Error('nope'); }", probe: {}, hitFlag: "__h" }, ctx),
    );
    expect(o["__h"]).toBe(false);
  });

  it("end-to-end: a malformed sourceB64 decodes to garbage → SyntaxError in the vm → MISS (no hard fail)", async () => {
    const ctx = { scripts: new WorkerScriptRunner({ defaultTimeoutMs: 150 }) } as unknown as Ctx;
    const o = out(await scriptEvalHandler({ sourceB64: "@@@not-valid-base64-source@@@", probe: {}, hitFlag: "__h" }, ctx));
    expect(o["__h"]).toBe(false); // degrades to MISS → LLM fallback, does not throw
  });
});
