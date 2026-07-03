// ───────────────────────────── GUARDED real vela-sdk suspend/resume (opt-in) ─────────────────────────────
//
// Proves the suspend/resume machinery against the ACTUAL built DefaultWorkflowEngine — NOT the double.
// It is OFF by default (vela-sdk is not a dependency of this standalone package, Inv. 2) and runs only when
// the operator opts in with BOTH env vars:
//   ELIO_RUN_REAL_VELA=1
//   ELIO_VELA_SDK_PATH=/abs/path/to/vela-sdk/dist/index.js   (the built module)
// The model itself is a deterministic MockModel — no network. What is REAL here is the Vela engine: the
// freeform-gate -> delegate(depends_on) workflow, findByIdentity re-find, and the updateStep-hop resume.

import { describe, expect, it } from "vitest";
import { rootPolicy } from "@elio/core";
import type { FeaturePack, GateVerdict, NodeDefinition, Resolved, RunEvent } from "@elio/core";
import { MockModel } from "@elio/sdk";
import { createVelaRuntime } from "./register";
import { adaptVelaModule } from "./loader";
import type { VelaModule } from "./vela-contract";

const RUN_REAL = process.env["ELIO_RUN_REAL_VELA"] === "1" && typeof process.env["ELIO_VELA_SDK_PATH"] === "string";

/** Loads the REAL vela-sdk from the built dist path in $ELIO_VELA_SDK_PATH and adapts it to VelaModule. */
async function realVelaLoader(): Promise<VelaModule | null> {
  const path = process.env["ELIO_VELA_SDK_PATH"];
  if (typeof path !== "string") return null;
  const mod: unknown = await import(path);
  return adaptVelaModule(mod);
}

const passGate: NodeDefinition<unknown, GateVerdict> = {
  type: "pass-gate",
  klass: "orchestration",
  handler: () =>
    Promise.resolve({
      status: "resolved",
      output: { passed: true, score: 1, failures: [] },
      confidence: 1,
      cost: { usd: 0 },
    } satisfies Resolved<GateVerdict>),
};

function velaHitlPack(): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "demo.vela-real", version: "0.1.0" },
    contentHash: "demo.vela-real@0.1.0",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "pass-gate" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [
          { id: "delegate", type: "agent", with: { prompt: "draft the note", awaitHuman: true }, outputs: { reply: "state.reply" } },
        ],
        edges: [],
      },
    },
  };
}

describe("GUARDED: real vela-sdk suspend/resume roundtrip (ELIO_RUN_REAL_VELA=1 + ELIO_VELA_SDK_PATH)", () => {
  it.runIf(RUN_REAL)("suspends on the real engine's depends_on gate, then resumes to completion", async () => {
    let path: string | undefined;
    const rt = createVelaRuntime({
      models: { mock: new MockModel({ transform: (s) => `drafted: ${s}` }) },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      vela: { velaLoader: realVelaLoader, onPath: (p) => (path = p) },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    // Turn 1: the real engine parks on the gate's depends_on -> node-suspended.
    const first: RunEvent[] = [];
    for await (const ev of rt.run(velaHitlPack(), { payload: {}, budget: 100, maxDepth: 5 })) first.push(ev);
    expect(path).toBe("vela"); // the REAL Vela path ran (not the in-process fallback)
    const suspended = first.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> =>
        e.type === "node-suspended" && e.correlation.step === "delegate",
    );
    expect(suspended).toBeDefined();
    expect(first.some((e) => e.type === "run-completed")).toBe(false);

    // Turn 2: resume -> the real engine re-finds the run by identity, unblocks, and completes.
    const resumed: RunEvent[] = [];
    for await (const ev of rt.resume(suspended!.correlation, "yes, proceed")) resumed.push(ev);
    expect(resumed.some((e) => e.type === "node-resolved" && e.correlation.step === "delegate")).toBe(true);
    const done = resumed.find((e) => e.type === "run-completed");
    expect(done).toBeDefined();
    if (done?.type === "run-completed") expect(done.gate).toBe("passed");
  }, 30_000);
});
