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
    // engine owns ONE persistent store, so a paused run survives until the resume turn re-finds it by its
    // resume-stable identity key (run::branch::step). The double's blockOn models the pause; supplying
    // contract.resume on the second turn unblocks it (mirrors real Vela advance(run,def,{stepOutput})).
    const { module, stores } = makeVelaDouble({ blockOn: ["needs_input"] });
    const s = scriptedModel(["resumed reply"]);
    const eng = new VelaAgentEngine({ velaLoader: () => Promise.resolve(module) });
    const ctx = ctxWith({ model: s.model });

    // Turn 1: blocks -> Suspended (Inv. 11). No model call yet; the run is PAUSED in the engine's store.
    const sr1 = await eng.run({ input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5 }, ctx);
    expect("elicitation" in sr1).toBe(true);
    expect(s.calls()).toBe(0);
    const store = stores[0]!;
    expect([...store.runs.values()].filter((r) => r.status === "paused").length).toBe(1);

    // Turn 2 (resume): SAME ctx.correlation + contract.resume -> re-finds the paused run, unblocks, routes
    // the model call through ctx.model (Inv. 18), and RESOLVES.
    const sr2 = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5, resume: { answer: "proceed" } },
      ctx,
    );
    if (!("result" in sr2) || sr2.result.status !== "resolved") throw new Error("expected resolved");
    expect((sr2.result.output as { text: string }).text).toBe("resumed reply");
    expect(s.calls()).toBe(1); // the model call happened ONLY on the resume turn
    // The paused run was resumed to completion, not left dangling nor duplicated.
    expect([...store.runs.values()].filter((r) => r.status === "paused").length).toBe(0);
    expect([...store.runs.values()].length).toBe(1); // re-found the SAME run (no fresh create)
  });

  it("propagates a Vela block/pause UP as an ELIO Suspended/elicitation (Inv. 11)", async () => {
    // The block->Suspended wiring, driven by the double's blockOn (which models an unsatisfied depends_on /
    // pause surface). The single-delegate-step shape does not pause on the REAL engine (empty depends_on);
    // a real multi-step/pause-surface workflow is the remaining real-path work (vela-bridge.ts HONESTY note).
    const { module } = makeVelaDouble({ blockOn: ["target_schema"] });
    const s = scriptedModel(["unused"]);
    const eng = new VelaAgentEngine({ velaLoader: () => Promise.resolve(module) });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    expect("elicitation" in sr).toBe(true);
    if (!("elicitation" in sr)) throw new Error("expected elicitation");
    expect(sr.elicitation.what).toMatch(/blockiert|target_schema/i);
    expect(sr.elicitation.mode).toBe("blocking");
  });
});
