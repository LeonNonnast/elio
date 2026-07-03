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

/** A feature with one `agent` step routed to the "vela" engine. */
function velaAgentPack(): FeaturePack {
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
            with: { prompt: "draft the note" },
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

  it("[DOUBLE-ONLY, v0.2 spec] a Vela block propagates UP through ELIOs stack as a node-suspended event", async () => {
    // SCOPE: behavioural spec via the double, NOT real-Vela v0.1 conformance. The real single-delegate-step
    // engine cannot return blocked:true (vela-bridge.ts RESUME/BLOCK CAVEAT); the double's synthetic blockOn
    // stands in for the v0.2 multi-step shape so we can verify the block->node-suspended propagation seam.
    const { module } = makeVelaDouble({ blockOn: ["target_schema"] });
    const rt = createVelaRuntime({
      models: { mock: new MockModel() },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      vela: { velaLoader: () => Promise.resolve(module) },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events: RunEvent[] = [];
    for await (const ev of rt.run(velaAgentPack(), { payload: {}, budget: 100, maxDepth: 5 })) {
      events.push(ev);
    }

    const suspended = events.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> =>
        e.type === "node-suspended" && e.correlation.step === "delegate",
    );
    expect(suspended).toBeDefined();
    expect(suspended!.elicitation.what).toMatch(/blockiert|target_schema/i);
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
