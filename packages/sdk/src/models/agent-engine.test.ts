import { describe, expect, it } from "vitest";
import type { Cost, Ctx, ModelService, SessionContract } from "@elio/core";
import { InProcessAgentEngine, boundAgentService } from "./agent-engine";

/** A scripted model: nth call returns replies[n], with a fixed per-call cost. */
function scriptedModel(replies: string[], usdPerCall = 1): { model: ModelService; calls: () => number } {
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

function ctxWith(over: Partial<Ctx>): Ctx {
  return over as unknown as Ctx;
}

describe("InProcessAgentEngine (Slice 3, Inv. 17/18/21)", () => {
  it("identifies as the transparent in-process engine", () => {
    const eng = new InProcessAgentEngine();
    expect(eng.id).toBe("in-process");
    expect(eng.governance).toBe("transparent");
  });

  it("runs a bounded loop via ctx.model and resolves with the last answer", async () => {
    const s = scriptedModel(["thinking", "more thinking", "almost"]);
    const eng = new InProcessAgentEngine({ maxTurns: 3 });
    const contract: SessionContract = {
      input: { prompt: "go" },
      budget: 100,
      depth: 1,
      maxDepth: 5,
    };
    const sr = await eng.run(contract, ctxWith({ model: s.model }));
    expect("result" in sr).toBe(true);
    if (!("result" in sr)) throw new Error("expected result");
    expect(sr.result.status).toBe("resolved");
    if (sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "almost" });
    expect(s.calls()).toBe(3);
  });

  it("stops at the convergence/role-stop marker before maxTurns", async () => {
    const s = scriptedModel(["not yet", "DONE now", "should-not-run"]);
    const eng = new InProcessAgentEngine({ maxTurns: 5 });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "DONE now" });
    expect(s.calls()).toBe(2);
  });

  it("(d) DECREMENTS THE INHERITED budget — never a fresh one (Inv. 21)", async () => {
    // contract.budget = 2 (inherited remaining). Each turn costs usd:1. maxTurns would allow 5 turns,
    // but the inherited budget only funds 2 -> the loop must stop after 2 turns, NOT run 5.
    const s = scriptedModel(["t1", "t2", "t3", "t4", "t5"], 1);
    const eng = new InProcessAgentEngine({ maxTurns: 5 });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 2, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(s.calls()).toBe(2); // inherited budget (2) funded exactly 2 turns, then exhausted
    expect(sr.result.cost.usd).toBe(2); // accumulated cost == the inherited budget consumed
  });

  it("also charges ctx.cost (the shared outer tracker) so the transparent path mirrors a direct call", async () => {
    let remaining = 10;
    const charges: number[] = [];
    const s = scriptedModel(["a", "b"], 2);
    const eng = new InProcessAgentEngine({ maxTurns: 2 });
    await eng.run(
      { input: { prompt: "go" }, budget: 10, depth: 1, maxDepth: 5 },
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
    expect(charges).toEqual([2, 2]); // both turns charged the shared tracker
    expect(remaining).toBe(6);
  });

  it("(depth) ESCALATES via elicitation when the inherited depth reaches maxDepth — never loops past the ceiling (Inv. 21)", async () => {
    // depth (2) >= maxDepth (2): the engine must NOT run a single turn; it raises an elicitation HOCH.
    const s = scriptedModel(["should-not-run"]);
    const eng = new InProcessAgentEngine({ maxTurns: 5 });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 2, maxDepth: 2 },
      ctxWith({ model: s.model }),
    );
    expect("elicitation" in sr).toBe(true);
    if (!("elicitation" in sr)) throw new Error("expected elicitation");
    expect(sr.elicitation.what).toMatch(/tiefe|depth|limit/i);
    expect(s.calls()).toBe(0); // ceiling hit BEFORE the loop — no model call at all
  });

  it("(depth) still runs when depth is below maxDepth", async () => {
    const s = scriptedModel(["DONE"]);
    const eng = new InProcessAgentEngine({ maxTurns: 5 });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 2 },
      ctxWith({ model: s.model }),
    );
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "DONE" });
    expect(s.calls()).toBe(1);
  });

  it("throws clearly when ctx.model is absent (security by absence, Inv. 14/18)", async () => {
    const eng = new InProcessAgentEngine();
    await expect(
      eng.run({ input: { prompt: "go" }, budget: 1, depth: 1, maxDepth: 5 }, ctxWith({})),
    ).rejects.toThrow(/ctx\.model|nicht injiziert/i);
  });

  it("boundAgentService binds the engine to a ctx and runs via session()", async () => {
    const s = scriptedModel(["DONE"]);
    const eng = new InProcessAgentEngine();
    const svc = boundAgentService(eng, ctxWith({ model: s.model }));
    const sr = await svc.session({ input: { prompt: "go" }, budget: 5, depth: 1, maxDepth: 5 });
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "DONE" });
  });
});
