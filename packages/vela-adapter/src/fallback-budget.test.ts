import { describe, expect, it } from "vitest";
import type { Cost, Ctx, ModelService, SessionContract } from "@elio/core";
import { VelaAgentEngine } from "./vela-engine";

function scriptedModel(
  replies: string[],
  usdPerCall = 1,
): { model: ModelService; calls: () => number } {
  let calls = 0;
  const model: ModelService = {
    complete: () => {
      const text = replies[calls] ?? replies[replies.length - 1] ?? "";
      calls += 1;
      const cost: Cost = { usd: usdPerCall, tokensIn: 1, tokensOut: 1, model: "mock" };
      return Promise.resolve({ text, cost, confidence: 0.5 });
    },
  };
  return { model, calls: () => calls };
}

const CORR = { run: "r1", branch: "b1", step: "s1", checkpoint: "c1" };
function ctxWith(over: Partial<Ctx>): Ctx {
  return { correlation: CORR, ...over } as unknown as Ctx;
}

describe("VelaAgentEngine — graceful fallback (impl-decisions §7)", () => {
  it("falls back to the in-process engine when Vela is unavailable (loader -> null)", async () => {
    const s = scriptedModel(["fallback answer"]);
    let path: string | undefined;
    let reason: string | undefined;
    const eng = new VelaAgentEngine({
      velaLoader: () => Promise.resolve(null),
      maxTurns: 1,
      onPath: (p, r) => {
        path = p;
        reason = r;
      },
    });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    expect(path).toBe("fallback");
    expect(reason).toMatch(/unavailable/);
    // Still transparent: the in-process loop routed the model call through ctx.model.
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "fallback answer" });
    expect(s.calls()).toBe(1);
  });

  it("FALLBACK resume round-trip through the adapter: in-process loop converges on the stop marker", async () => {
    // In fallback mode the adapter delegates to InProcessAgentEngine — its bounded multi-turn loop is
    // the in-process analogue of Velas resume: the same SessionContract drives turns until convergence.
    const s = scriptedModel(["still thinking", "DONE here", "should-not-run"]);
    const eng = new VelaAgentEngine({ velaLoader: false, maxTurns: 5 });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "DONE here" });
    expect(s.calls()).toBe(2); // stopped at the marker, before maxTurns
  });

  it("falls back (never breaks the node) when a real Vela turn throws", async () => {
    const s = scriptedModel(["recovered"]);
    let path: string | undefined;
    const eng = new VelaAgentEngine({
      velaLoader: () => Promise.reject(new Error("boom")),
      maxTurns: 1,
      onPath: (p) => (path = p),
    });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 50, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    // A rejected loader is treated as unavailable -> fallback (no crash).
    expect(path).toBe("fallback");
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "recovered" });
  });
});

describe("VelaAgentEngine — inherited budget + depth (Inv. 21, never fresh)", () => {
  it("INHERITS the depth ceiling: depth >= maxDepth escalates BEFORE any model call", async () => {
    // Enforced by THIS engine (Vela has no depth semantics): no Vela load, no model call, an
    // elicitation propagates up. Identical guard on both real + fallback configs.
    const s = scriptedModel(["should-not-run"]);
    let path: string | undefined;
    const eng = new VelaAgentEngine({ velaLoader: false, onPath: (p) => (path = p) });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 2, maxDepth: 2 },
      ctxWith({ model: s.model }),
    );
    expect("elicitation" in sr).toBe(true);
    if (!("elicitation" in sr)) throw new Error("expected elicitation");
    expect(sr.elicitation.what).toMatch(/tiefe|depth|limit/i);
    expect(s.calls()).toBe(0); // ceiling hit before any work
    expect(path).toBeUndefined(); // neither path ran — escalated before dispatch
  });

  it("INHERITS the remaining budget (not a fresh one) — the fallback loop stops when it is exhausted", async () => {
    // contract.budget = 2 (inherited remaining); each turn costs usd:1; maxTurns=5 would allow 5 turns,
    // but the inherited budget funds only 2 -> the loop stops after 2 (Inv. 21: never a fresh budget).
    const s = scriptedModel(["t1", "t2", "t3", "t4", "t5"], 1);
    const eng = new VelaAgentEngine({ velaLoader: false, maxTurns: 5 });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 2, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(s.calls()).toBe(2);
    expect(sr.result.cost.usd).toBe(2);
  });

  it("REAL Vela path charges the shared ctx.cost tracker (transparent cost, Inv. 18)", async () => {
    const { makeVelaDouble } = await import("./vela-double");
    const { module } = makeVelaDouble();
    let remaining = 10;
    const charges: number[] = [];
    const s = scriptedModel(["x"], 3);
    const eng = new VelaAgentEngine({ velaLoader: () => Promise.resolve(module) });
    const contract: SessionContract = {
      input: { prompt: "go" },
      budget: 10,
      depth: 1,
      maxDepth: 5,
    };
    const sr = await eng.run(
      contract,
      ctxWith({
        model: s.model,
        cost: {
          charge: (c) => {
            remaining -= c.usd ?? 0;
            charges.push(c.usd ?? 0);
          },
          remaining: () => remaining,
        },
      }),
    );
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(charges).toEqual([3]); // the single delegate model call charged the shared tracker
    expect(remaining).toBe(7);
    expect(sr.result.cost.usd).toBe(3); // and the turn cost rode up in the result
  });
});
