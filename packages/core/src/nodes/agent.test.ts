import { describe, expect, it } from "vitest";
import { agentHandler, agentNode } from "./agent";
import { DefaultElicitService } from "../injector";
import type { AgentService, Ctx, CostService, ModelService } from "../ctx";

function ctxWith(over: Partial<Ctx> = {}): Ctx {
  return over as unknown as Ctx;
}

/** Ein Modell, das pro Aufruf die nächste Antwort aus `replies` liefert (deterministisch). */
function scriptedModel(replies: string[]): { model: ModelService; calls: number } {
  const box = { calls: 0 };
  const model: ModelService = {
    complete: () => {
      const text = replies[box.calls] ?? replies[replies.length - 1] ?? "";
      box.calls += 1;
      return Promise.resolve({
        text,
        cost: { usd: 1, tokensIn: 1, tokensOut: 1, model: "mock" },
        confidence: 0.5,
      });
    },
  };
  return { model, get calls() { return box.calls; } } as { model: ModelService; calls: number };
}

describe("agent node (Slice 3, Inv. 7/8/17/21)", () => {
  it("is registered as an intelligence node that requests models", () => {
    expect(agentNode.type).toBe("agent");
    expect(agentNode.klass).toBe("intelligence");
    expect(agentNode.requests).toEqual({ models: ["*"] });
  });

  it("runs a bounded in-process loop over ctx.model and resolves on convergence (stop marker)", async () => {
    // turn 1: "still thinking" -> refine; turn 2: "DONE here" -> converged, stop.
    const s = scriptedModel(["still thinking", "all DONE here"]);
    const res = await agentHandler(
      { prompt: "solve it", maxTurns: 5 },
      ctxWith({ model: s.model }),
    );
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") throw new Error("not resolved");
    expect(res.output).toEqual({ output: "all DONE here" });
    expect(s.calls).toBe(2); // stopped at convergence, NOT all 5 turns
    // accumulated cost over both turns
    expect(res.cost.usd).toBe(2);
  });

  it("caps at maxTurns when it never converges and resolves with the last answer", async () => {
    const s = scriptedModel(["nope", "still nope", "again nope", "yet again"]);
    const res = await agentHandler(
      { prompt: "p", maxTurns: 2, stopWhen: "FINISHED" },
      ctxWith({ model: s.model }),
    );
    if (res.status !== "resolved") throw new Error("not resolved");
    expect(s.calls).toBe(2);
    expect(res.output).toEqual({ output: "still nope" });
  });

  it("decrements the INHERITED budget (not a fresh one): stops when ctx.cost is exhausted", async () => {
    // ctx.cost starts with remaining=1 and each turn charges usd:1 -> after turn 1 it is exhausted.
    let remaining = 1;
    const cost: CostService = {
      charge: (c) => {
        remaining -= c.usd ?? 0;
      },
      remaining: () => remaining,
    };
    const s = scriptedModel(["turn-1 nope", "turn-2 nope", "turn-3 nope"]);
    const res = await agentHandler(
      { prompt: "p", maxTurns: 5 }, // would do 5 turns if budget were fresh
      ctxWith({ model: s.model, cost }),
    );
    if (res.status !== "resolved") throw new Error("not resolved");
    // exactly ONE turn ran: the inherited budget (1) was consumed, so the loop stopped before turn 2.
    expect(s.calls).toBe(1);
    expect(res.output).toEqual({ output: "turn-1 nope" });
    expect(remaining).toBe(0);
  });

  it("escalates via ctx.elicit when maxTurns is exhausted and onMaxTurns='escalate'", async () => {
    const s = scriptedModel(["no", "no", "no"]);
    const res = await agentHandler(
      { prompt: "p", maxTurns: 1, onMaxTurns: "escalate" },
      ctxWith({ model: s.model, elicit: new DefaultElicitService("blocking") }),
    );
    expect(res.status).toBe("suspended");
    if (res.status !== "suspended") throw new Error("not suspended");
    expect(res.elicitation.what).toMatch(/did not converge/i);
    expect(res.elicitation.mode).toBe("blocking");
  });

  it("delegates to ctx.agent when present (Inv. 17), normalizing the session result", async () => {
    let seenContract: unknown;
    const agent: AgentService = {
      session: (contract) => {
        seenContract = contract;
        return Promise.resolve({
          result: {
            status: "resolved",
            output: "engine-said-this",
            confidence: 0.9,
            cost: { usd: 3, model: "engine" },
          },
        });
      },
    };
    const res = await agentHandler(
      { prompt: "delegate me", model: "claude-opus-4-8" },
      ctxWith({ agent }),
    );
    if (res.status !== "resolved") throw new Error("not resolved");
    expect(res.output).toEqual({ output: "engine-said-this" });
    expect(res.confidence).toBe(0.9);
    expect(res.cost).toEqual({ usd: 3, model: "engine" });
    // routing carries the requested model down the session contract.
    expect((seenContract as { routing?: unknown }).routing).toEqual({ models: ["claude-opus-4-8"] });
  });

  it("propagates a Suspended from a delegated engine", async () => {
    const agent: AgentService = {
      session: () =>
        Promise.resolve({
          elicitation: {
            what: "engine needs input",
            whoCanAnswer: { machine: false },
            mode: "blocking",
          },
        }),
    };
    const res = await agentHandler({ prompt: "x" }, ctxWith({ agent }));
    expect(res.status).toBe("suspended");
    if (res.status !== "suspended") throw new Error("not suspended");
    expect(res.elicitation.what).toBe("engine needs input");
  });

  it("FAILS CLEARLY without ctx.agent AND without ctx.model — security by absence (Inv. 14)", async () => {
    await expect(agentHandler({ prompt: "x" }, ctxWith({}))).rejects.toThrow(
      /security by absence|not injected|nicht injiziert/i,
    );
  });
});
