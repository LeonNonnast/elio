import { describe, expect, it } from "vitest";
import type { Cost, Ctx, ModelService, SessionContract } from "@elio/core";
import { VelaAgentEngine } from "./vela-engine";
import { ELIO_MODEL_DELEGATE } from "./vela-bridge";
import { makeVelaDouble } from "./vela-double";

/** A scripted model: nth call returns replies[n], with a fixed per-call cost. */
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

describe("VelaAgentEngine — identity + transparency (Inv. 12/17/18)", () => {
  it('identifies as engine id "vela" with transparent governance', () => {
    const eng = new VelaAgentEngine({ velaLoader: false });
    expect(eng.id).toBe("vela");
    expect(eng.governance).toBe("transparent");
  });

  it("REAL Vela path: routes the model call through ctx.model and resolves with the captured reply", async () => {
    // This exercises the genuinely real-API-faithful v0.1 surface: a single RESOLVED turn whose reply is
    // captured out of run.stateData.text via the delegate seam. (velaRunId/resumed are intentionally NOT
    // surfaced — they were dead output; cross-turn resume is v0.2, see vela-bridge RESUME/BLOCK CAVEAT.)
    const { module, registry } = makeVelaDouble();
    const s = scriptedModel(["the answer"]);
    let path: string | undefined;
    const eng = new VelaAgentEngine({
      velaLoader: () => Promise.resolve(module),
      onPath: (p) => (path = p),
    });
    const contract: SessionContract = {
      input: { prompt: "what is the answer?" },
      budget: 100,
      depth: 1,
      maxDepth: 5,
    };
    const sr = await eng.run(contract, ctxWith({ model: s.model }));

    expect(path).toBe("vela"); // the REAL Vela path ran (not the fallback)
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    const out = sr.result.output as { text: string };
    expect(out.text).toBe("the answer"); // captured out of Velas run.stateData.text
    expect(out).toEqual({ text: "the answer" }); // ONLY the reply is surfaced (no inert run id / flag)
    expect(s.calls()).toBe(1); // EXACTLY one model call — routed through ctx.model (Inv. 18)
    // The delegate seam was registered in Velas (global) registry.
    expect(registry.resolve(ELIO_MODEL_DELEGATE)).toBeTypeOf("function");
  });

  it("suspend/resume: a paused turn re-finds its run by ctx.correlation identity and completes with the answer (Inv. 11/12)", async () => {
    // The genuine identity↔correlation resume roundtrip THROUGH the engine (no manual startOrResume): the
    // engine owns ONE persistent store, so the parked (blocked, still-ACTIVE) run survives until the resume
    // turn re-finds it by its resume-stable identity key (run::branch::step). `awaitHuman:true` opts the turn
    // into the HITL gate shape; contract.resume on the second turn writes the answer + advances to RESOLVE.
    const { module, stores } = makeVelaDouble();
    const s = scriptedModel(["resumed reply"]);
    const eng = new VelaAgentEngine({ velaLoader: () => Promise.resolve(module) });
    const ctx = ctxWith({ model: s.model });

    // Turn 1: gate blocks BEFORE the model -> Suspended (Inv. 11). No model call yet; run parked in the store.
    const sr1 = await eng.run(
      { input: { prompt: "go", awaitHuman: true }, budget: 100, depth: 1, maxDepth: 5 },
      ctx,
    );
    expect("elicitation" in sr1).toBe(true);
    expect(s.calls()).toBe(0); // gate-first: no model on the blocking turn (budget-correct)
    const store = stores[0]!;
    // The run is parked (blocked) but still ACTIVE (real depends_on block does not set PAUSED) and re-findable.
    expect([...store.runs.values()].length).toBe(1);
    expect([...store.runs.values()][0]!.status).not.toBe("completed");

    // Turn 2 (resume): SAME ctx.correlation + contract.resume -> re-finds the run, injects the answer, runs
    // the model through ctx.model (Inv. 18), and RESOLVES.
    const sr2 = await eng.run(
      { input: { prompt: "go", awaitHuman: true }, budget: 100, depth: 1, maxDepth: 5, resume: { answer: "proceed" } },
      ctx,
    );
    if (!("result" in sr2) || sr2.result.status !== "resolved") throw new Error("expected resolved");
    expect((sr2.result.output as { text: string }).text).toBe("resumed reply");
    expect(s.calls()).toBe(1); // the model call happened ONLY on the resume turn
    expect([...store.runs.values()].length).toBe(1); // re-found the SAME run (no fresh create)
    expect([...store.runs.values()][0]!.status).toBe("completed"); // resumed to completion
  });

  it("propagates a Vela block UP as an ELIO Suspended/elicitation on a HITL (awaitHuman) turn (Inv. 11)", async () => {
    // The block->Suspended wiring: the freeform gate's depends_on parks the run until a human answers.
    const { module } = makeVelaDouble();
    const s = scriptedModel(["unused"]);
    const eng = new VelaAgentEngine({ velaLoader: () => Promise.resolve(module) });
    const sr = await eng.run(
      { input: { prompt: "go", awaitHuman: true }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    expect("elicitation" in sr).toBe(true);
    if (!("elicitation" in sr)) throw new Error("expected elicitation");
    expect(sr.elicitation.what).toMatch(/blockiert|elioHumanAnswer/i);
    expect(sr.elicitation.mode).toBe("blocking");
  });
});
