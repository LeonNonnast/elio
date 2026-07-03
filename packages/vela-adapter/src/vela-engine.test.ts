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

  it("[DOUBLE-ONLY, v0.2 spec] resume-mapping round-trip: ELIO correlation <-> Vela identity re-finds the SAME run", async () => {
    // SCOPE: this is a behavioural spec for the FUTURE v0.2 multi-step shape, exercised against the
    // deterministic double — NOT real-Vela v0.1 conformance. On the real engine the single-delegate-step
    // run always COMPLETEs (resolveNext -> null -> "No next step — complete"), so findByIdentity (which
    // only re-finds ACTIVE/PAUSED runs) never has a resume target and runVelaTurn never re-finds a run
    // across turns (see vela-bridge.ts RESUME/BLOCK CAVEAT). To keep a run alive as a resume target here
    // we build a double whose engine BLOCKS (paused) — a state the real one-step engine cannot produce —
    // and then drive startOrResume MANUALLY over the SAME store (the adapter itself uses a fresh store per
    // turn). This locks in the identity<->correlation mapping for when v0.2 makes it reachable.
    const { module, stores } = makeVelaDouble({ blockOn: ["needs_input"] });
    const s = scriptedModel(["unused"]);
    const eng = new VelaAgentEngine({ velaLoader: () => Promise.resolve(module) });

    // First turn: blocks -> the run is PAUSED and persisted under the correlation identity.
    const sr1 = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({ model: s.model }),
    );
    expect("elicitation" in sr1).toBe(true); // blocked -> Suspended/elicitation up (Inv. 11)

    // A single store backs the engine-built runs; find the paused run under the correlation key.
    const store = stores[0]!;
    const paused = [...store.runs.values()].filter((r) => r.status === "paused");
    expect(paused.length).toBe(1);
    const firstId = paused[0]!.id;
    const corrValue = paused[0]!.params["elioCorrelation"];
    expect(typeof corrValue).toBe("string");

    // Resume: a fresh startOrResume against the SAME store + SAME identity re-finds the same run.
    const Engine = module.DefaultWorkflowEngine;
    const engine = new Engine(store);
    const [reFound, created] = await engine.startOrResume(
      {
        id: "elio.inner-session",
        version: "1.0.0",
        name: "n",
        description: "",
        params: [
          {
            name: "elioCorrelation",
            required: false,
            identity: true,
            application: false,
            resolve: false,
          },
        ],
        context: null,
        lifecycle: null,
        tools: [],
        resources: [],
        steps: [],
      },
      { params: { elioCorrelation: corrValue } },
    );
    expect(created).toBe(false); // re-found, not created fresh (Inv. 12)
    expect(reFound.id).toBe(firstId); // SAME Vela run id — the correlation round-trips
  });

  it("[DOUBLE-ONLY, v0.2 spec] propagates a Vela block/pause UP as an ELIO Suspended/elicitation (Inv. 11)", async () => {
    // SCOPE: behavioural spec via the double, NOT real-Vela v0.1 conformance. The real engine returns
    // blocked:true ONLY inside `if(nextStepId)` after a failed validateDependsOn; the single delegate step
    // has no next step, so advance() can never block (vela-bridge.ts RESUME/BLOCK CAVEAT). This pins the
    // block->Suspended wiring for the v0.2 multi-step shape, driven by the double's synthetic blockOn.
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
