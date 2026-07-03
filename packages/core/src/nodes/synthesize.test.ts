import { describe, expect, it } from "vitest";
import { extractSource, hashValue, makeCandidate, synthesizeScriptHandler, WorkerScriptRunner } from "@elio/core";
import type {
  Ctx,
  ModelService,
  NodeResult,
  PromotionCandidate,
  TapeFrame,
  TracesService,
} from "@elio/core";

const GOOD = "function transform(input) { return { text: input.prompt }; }";
const WRONG = "function transform(input) { return { text: 'WRONG' }; }";

function frame(run: string, input: unknown, output: unknown): TapeFrame {
  return {
    correlation: { run, branch: "b", step: "draft", checkpoint: "cp" },
    feature: "demo.svc",
    nodeType: "llm",
    input,
    result: { status: "resolved", output, confidence: 1, cost: {} },
    injected: [],
    ts: "2026-01-01T00:00:00.000Z",
  };
}

function tier0Candidate(): PromotionCandidate {
  const h1 = hashValue({ prompt: "V1" });
  return makeCandidate({
    source: "determinism-miner",
    kind: "node-replacement",
    callSite: { feature: "demo.svc", step: "draft", nodeType: "llm" },
    support: 25,
    evidence: { runs: ["m1"] },
    proposal: { tier: 0, domain: [h1], lookup: [{ inputHash: h1, output: { text: "V1" } }] },
    summary: "tier-0",
  });
}

function fakeModel(sources: string[]): { service: ModelService; calls: () => number } {
  let i = 0;
  const service: ModelService = {
    complete: () => {
      const text = sources[Math.min(i, sources.length - 1)] as string;
      i += 1;
      return Promise.resolve({ text, cost: { usd: 0.001 }, confidence: 0.9 });
    },
  };
  return { service, calls: () => i };
}

function fakeTraces(frames: TapeFrame[]): TracesService {
  return {
    collect: () => Promise.resolve(frames),
    tape: () => ({ async *[Symbol.asyncIterator](): AsyncIterator<TapeFrame> {} }),
  };
}

function ctxOf(model: ModelService | undefined, traces: TracesService | undefined, withScripts = true): Ctx {
  const c: Record<string, unknown> = {};
  if (model !== undefined) c["model"] = model;
  if (traces !== undefined) c["traces"] = traces;
  if (withScripts) c["scripts"] = new WorkerScriptRunner({ defaultTimeoutMs: 200 });
  return c as unknown as Ctx;
}

function out(r: NodeResult): Record<string, unknown> {
  if (r.status !== "resolved") throw new Error(`expected resolved, got ${r.status}`);
  return r.output as Record<string, unknown>;
}

const FRAMES = [
  frame("m1", { prompt: "V1" }, { text: "V1" }),
  frame("m1", { prompt: "V2" }, { text: "V2" }),
  frame("h1", { prompt: "V3" }, { text: "V3" }), // held-out (run not in evidence.runs)
];

describe("nodes/synthesize-script — Tier-2 Codegen + held-out-Validierung", () => {
  it("generates a function, validates it on held-out frames, and emits a Tier-2 candidate", async () => {
    const m = fakeModel([GOOD]);
    const o = out(await synthesizeScriptHandler({ candidate: tier0Candidate() }, ctxOf(m.service, fakeTraces(FRAMES))));
    expect(o["synthesized"]).toBe(true);
    expect(o["attempts"]).toBe(1);
    const cand = o["candidate"] as PromotionCandidate;
    expect((cand.proposal as { tier: number }).tier).toBe(2);
    expect((cand.proposal as { source: string }).source).toContain("input.prompt");
    expect((o["verdict"] as { passed: boolean; heldOut: boolean }).passed).toBe(true);
    expect((o["verdict"] as { heldOut: boolean }).heldOut).toBe(true);
  });

  it("retries with failure feedback when the first generated function is wrong", async () => {
    const m = fakeModel([WRONG, GOOD]); // first reproduces examples incorrectly -> retry -> good
    const o = out(await synthesizeScriptHandler({ candidate: tier0Candidate() }, ctxOf(m.service, fakeTraces(FRAMES))));
    expect(o["synthesized"]).toBe(true);
    expect(o["attempts"]).toBe(2);
    expect(m.calls()).toBe(2);
  });

  it("fails closed (synthesized:false) when there are no held-out frames to validate against", async () => {
    // Only mining-run frames -> shadowEvalScript excludes them all -> covered 0 -> not accepted.
    const onlyMining = [frame("m1", { prompt: "V1" }, { text: "V1" }), frame("m1", { prompt: "V2" }, { text: "V2" })];
    const m = fakeModel([GOOD]);
    const o = out(await synthesizeScriptHandler({ candidate: tier0Candidate(), maxAttempts: 2 }, ctxOf(m.service, fakeTraces(onlyMining))));
    expect(o["synthesized"]).toBe(false);
    expect(o["attempts"]).toBe(2);
    expect(Array.isArray(o["failures"])).toBe(true);
  });

  it("throws when ctx.model / ctx.scripts / ctx.traces are absent (security by absence, Inv. 14)", async () => {
    await expect(synthesizeScriptHandler({ candidate: tier0Candidate() }, ctxOf(undefined, fakeTraces(FRAMES)))).rejects.toThrow(
      /ctx\.model nicht injiziert/,
    );
    await expect(
      synthesizeScriptHandler({ candidate: tier0Candidate() }, ctxOf(fakeModel([GOOD]).service, fakeTraces(FRAMES), false)),
    ).rejects.toThrow(/ctx\.scripts nicht injiziert/);
    await expect(synthesizeScriptHandler({ candidate: tier0Candidate() }, ctxOf(fakeModel([GOOD]).service, undefined))).rejects.toThrow(
      /ctx\.traces nicht injiziert/,
    );
  });

  it("rejects a non-Tier-0 candidate input", async () => {
    const bad = makeCandidate({
      source: "x",
      kind: "alert",
      support: 1,
      evidence: { runs: [] },
      proposal: {},
      summary: "not tier-0",
    });
    await expect(synthesizeScriptHandler({ candidate: bad }, ctxOf(fakeModel([GOOD]).service, fakeTraces(FRAMES)))).rejects.toThrow(
      /Tier-0 node-replacement/,
    );
  });
});

describe("extractSource", () => {
  it("strips markdown code fences", () => {
    expect(extractSource("```js\nfunction f(){}\n```")).toBe("function f(){}");
    expect(extractSource("```\n(x)=>x\n```")).toBe("(x)=>x");
  });
  it("returns trimmed text when there is no fence", () => {
    expect(extractSource("  function f(){}  ")).toBe("function f(){}");
  });
});
