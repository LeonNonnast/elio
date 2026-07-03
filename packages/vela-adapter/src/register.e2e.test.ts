// End-to-end: an `agent` node with routing.agentEngine="vela" runs on the VelaAgentEngine through the
// real ELIO runtime + Outer Loop. The RESOLVED happy path mirrors the real-Vela v0.1 surface. The block
// -> node-suspended propagation test is a DOUBLE-ONLY v0.2 behavioural spec (the real single-step engine
// cannot block — see vela-bridge.ts RESUME/BLOCK CAVEAT). Deterministic doubles only (MockModel + the
// Vela double) — NO network, NO real Vela server.

import { describe, expect, it } from "vitest";
import { rootPolicy } from "@elio/core";
import type {
  FeaturePack,
  GateVerdict,
  NodeDefinition,
  Resolved,
  RunEvent,
} from "@elio/core";
import { MockModel } from "@elio/sdk";
import { createVelaRuntime, registerVelaAdapter } from "./register";
import { makeVelaDouble } from "./vela-double";

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

/** A feature with one `agent` step routed to the "vela" engine. `awaitHuman` opts into the HITL gate. */
function velaAgentPack(awaitHuman = false): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "demo.vela-agent", version: "0.1.0" },
    contentHash: "demo.vela-agent@0.1.0",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "pass-gate" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [
          {
            id: "delegate",
            type: "agent",
            // routing.agentEngine="vela" — the injector binds the wired Vela engine behind ctx.agent.
            with: { prompt: "draft the note", ...(awaitHuman ? { awaitHuman: true } : {}) },
            outputs: { reply: "state.reply" },
          },
        ],
        edges: [],
      },
    },
  };
}

describe("registerVelaAdapter / createVelaRuntime — agent node routes to the Vela engine (Inv. 17)", () => {
  it("an agent node runs on the REAL Vela path end-to-end through the runtime", async () => {
    const { module, registry } = makeVelaDouble();
    let path: string | undefined;
    const rt = createVelaRuntime({
      models: { mock: new MockModel({ transform: (s) => `drafted: ${s}` }) },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      vela: { velaLoader: () => Promise.resolve(module), onPath: (p) => (path = p) },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events: RunEvent[] = [];
    for await (const ev of rt.run(velaAgentPack(), { payload: {}, budget: 100, maxDepth: 5 })) {
      events.push(ev);
    }

    expect(path).toBe("vela"); // the agent node dispatched to the Vela engine's real path
    expect(events.some((e) => e.type === "node-resolved" && e.correlation.step === "delegate")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
    // The Vela delegate registered the ELIO model seam in the (global) registry.
    expect(registry.resolve("elio-model")).toBeTypeOf("function");
  });

  it("a HITL (awaitHuman) Vela block propagates UP through ELIOs stack as a node-suspended event (Inv. 11)", async () => {
    // The block->node-suspended propagation seam: the agent step opts into the gate (awaitHuman), the gate's
    // depends_on parks the run, and the block surfaces as a node-suspended event through the whole ELIO stack.
    const { module } = makeVelaDouble();
    const rt = createVelaRuntime({
      models: { mock: new MockModel() },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      vela: { velaLoader: () => Promise.resolve(module) },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events: RunEvent[] = [];
    for await (const ev of rt.run(velaAgentPack(true), { payload: {}, budget: 100, maxDepth: 5 })) {
      events.push(ev);
    }

    const suspended = events.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> =>
        e.type === "node-suspended" && e.correlation.step === "delegate",
    );
    expect(suspended).toBeDefined();
    expect(suspended!.elicitation.what).toMatch(/blockiert|elioHumanAnswer/i);
  });

  it("suspend -> resume roundtrip through the runtime: a blocked Vela turn resumes to completion (Inv. 11/12)", async () => {
    // Full stack: the agent node suspends on the Vela block, the runner checkpoints it, and rt.resume(corr,
    // answer) re-drives the SAME step. The runner sets ctx.resume ONLY on that step; the agent node forwards
    // it as contract.resume; the SAME (persistent-store-backed) Vela engine re-finds its paused run by the
    // resume-stable identity key, unblocks it, routes the model call through ctx.model, and RESOLVES.
    const { module } = makeVelaDouble();
    const rt = createVelaRuntime({
      models: { mock: new MockModel({ transform: (str) => `drafted: ${str}` }) },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      vela: { velaLoader: () => Promise.resolve(module) },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    // Turn 1: run until it suspends on the Vela HITL gate.
    const first: RunEvent[] = [];
    for await (const ev of rt.run(velaAgentPack(true), { payload: {}, budget: 100, maxDepth: 5 })) {
      first.push(ev);
    }
    const suspended = first.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> =>
        e.type === "node-suspended" && e.correlation.step === "delegate",
    );
    expect(suspended).toBeDefined();
    expect(first.some((e) => e.type === "run-completed")).toBe(false); // it really suspended

    // Turn 2: resume with the human answer -> the delegate resolves, the gate passes, the run completes.
    const resumed: RunEvent[] = [];
    for await (const ev of rt.resume(suspended!.correlation, "yes, proceed")) {
      resumed.push(ev);
    }
    expect(
      resumed.some((e) => e.type === "node-resolved" && e.correlation.step === "delegate"),
    ).toBe(true);
    const done = resumed.find((e) => e.type === "run-completed");
    expect(done).toBeDefined();
    if (done?.type === "run-completed") expect(done.gate).toBe("passed");
    // The resumed delegate's reply was produced by routing through ctx.model (Inv. 18) — and the HUMAN
    // ANSWER was folded into the model input (last user turn), so the reply reflects it. Read it off the
    // resumed delegate's tape frame.
    const runId = first.find((e) => e.type === "run-started")!.correlation.run;
    const delegateFrame = rt.store
      .getTape(runId)
      .filter((f) => f.nodeType === "agent")
      .at(-1);
    expect(delegateFrame?.result.status).toBe("resolved");
    if (delegateFrame?.result.status === "resolved") {
      // raw node output is { output: <engine reply> }; the Vela engine's reply is { text }. The mock
      // transform ran on the LAST message = the human answer -> proves resume fed the answer to the model.
      const out = (delegateFrame.result.output as { output?: { text?: string } }).output;
      expect(out?.text).toBe("drafted: yes, proceed");
    }
  });

  it("registerVelaAdapter adapts an existing runtime, reusing its store + registry", async () => {
    const { module } = makeVelaDouble();
    // A plain runtime first (in-process agent engine), then adapt it to Vela.
    const base = createVelaRuntime({
      models: { mock: new MockModel({ transform: (s) => `x: ${s}` }) },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      vela: { velaLoader: false }, // base uses fallback
    });
    base.registry.register(passGate as unknown as NodeDefinition);

    let path: string | undefined;
    const adapted = registerVelaAdapter(
      base,
      { velaLoader: () => Promise.resolve(module), onPath: (p) => (path = p) },
      { rootPolicy: rootPolicy({ allowedModels: ["mock"] }) },
    );
    expect(adapted.store).toBe(base.store); // shared store -> continuous run state
    expect(adapted.registry).toBe(base.registry); // shared registry -> pass-gate carries over

    const events: RunEvent[] = [];
    for await (const ev of adapted.run(velaAgentPack(), { payload: {}, budget: 100, maxDepth: 5 })) {
      events.push(ev);
    }
    expect(path).toBe("vela");
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });
});
