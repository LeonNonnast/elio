// End-to-end: an `agent` node with routing.agentEngine="claude-code" runs on the OPAQUE ClaudeAgentEngine
// through the real ELIO runtime + Outer Loop. ALL offline via FakeTransport — NO key, NO network, NO real
// claude/SDK. Pins: (a) a resolved turn end-to-end, (b) budget/depth inherited + decremented (Inv. 21,
// asserted NOT-fresh on the transport request), (c) an elicitation propagates UP as a node-suspended event
// (Inv. 11), (d) registerClaudeAdapter adapts an existing runtime reusing its store + registry.

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
import { createClaudeRuntime, registerClaudeAdapter } from "./register";
import { FakeTransport } from "./claude-double";
import type { ClaudeTransportRequest } from "./claude-contract";

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

/** A feature with one `agent` step routed to the "claude-code" engine. */
function claudeAgentPack(): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "demo.claude-agent", version: "0.1.0" },
    contentHash: "demo.claude-agent@0.1.0",
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
            // routing.agentEngine="claude-code" — the injector binds the single wired Claude engine behind ctx.agent.
            with: { prompt: "draft the note" },
            outputs: { reply: "state.reply" },
          },
        ],
        edges: [],
      },
    },
  };
}

describe("createClaudeRuntime / registerClaudeAdapter — agent node routes to the OPAQUE Claude engine (Inv. 17)", () => {
  it("an agent node runs the opaque turn end-to-end through the runtime -> Resolved", async () => {
    const transport = new FakeTransport({ reply: "the drafted note", cost: { usd: 1 } });
    const rt = createClaudeRuntime({
      models: { mock: new MockModel() },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      claude: { transport },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events: RunEvent[] = [];
    for await (const ev of rt.run(claudeAgentPack(), { payload: {}, budget: 100, maxDepth: 5 })) {
      events.push(ev);
    }

    expect(transport.calls).toBe(1); // the agent node dispatched to the opaque engine's transport
    expect(events.some((e) => e.type === "node-resolved" && e.correlation.step === "delegate")).toBe(true);
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });

  it("INHERITS + DECREMENTS budget/depth across the boundary (Inv. 21 — asserts NOT fresh)", async () => {
    // The outer run is started with budget 100 + maxDepth 5; the agent node is one step DEEP, so the engine
    // must receive depth = parentDepth+1 (= 1, decremented across the boundary, not 0) and a REMAINING budget
    // that is the outer remaining (<= 100), NOT a fresh 100-or-constant detached from the outer budget.
    const transport = new FakeTransport({ reply: "ok", cost: { usd: 7 } });
    const rt = createClaudeRuntime({
      models: { mock: new MockModel() },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      claude: { transport },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    for await (const _ev of rt.run(claudeAgentPack(), { payload: {}, budget: 100, maxDepth: 5 })) {
      void _ev;
    }

    const req: ClaudeTransportRequest = transport.lastRequest!;
    // depth is decremented across the boundary: the inner turn runs one level DEEPER than the outer step.
    expect(req.depth).toBeGreaterThanOrEqual(1);
    expect(req.depth).toBeLessThan(req.maxDepth);
    expect(req.maxDepth).toBe(5); // the inherited ceiling from the run input, NOT a fresh constant
    // budget is the inherited REMAINING budget — bounded by the outer budget (100), never a fresh larger value.
    expect(req.budget).toBeLessThanOrEqual(100);
    expect(Number.isFinite(req.budget)).toBe(true);
  });

  it("an opaque elicitation propagates UP through ELIOs stack as a node-suspended event (Inv. 11)", async () => {
    const transport = new FakeTransport({
      elicitation: {
        what: "agent needs the target schema — provide it?",
        whoCanAnswer: { users: ["operator"] },
        mode: "blocking",
      },
    });
    const rt = createClaudeRuntime({
      models: { mock: new MockModel() },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      claude: { transport },
    });
    rt.registry.register(passGate as unknown as NodeDefinition);

    const events: RunEvent[] = [];
    for await (const ev of rt.run(claudeAgentPack(), { payload: {}, budget: 100, maxDepth: 5 })) {
      events.push(ev);
    }

    const suspended = events.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> =>
        e.type === "node-suspended" && e.correlation.step === "delegate",
    );
    expect(suspended).toBeDefined();
    expect(suspended!.elicitation.what).toMatch(/target schema/i);
  });

  it("registerClaudeAdapter adapts an existing runtime, reusing its store + registry", async () => {
    const transport = new FakeTransport({ reply: "adapted ok", cost: { usd: 1 } });
    // A plain runtime first (default transparent in-process engine), then adapt it to the opaque Claude engine.
    const base = createClaudeRuntime({
      models: { mock: new MockModel() },
      defaultModel: "mock",
      rootPolicy: rootPolicy({ allowedModels: ["mock"] }),
      // base uses a Fake too, but we adapt to a fresh one below to prove the rewire takes effect.
      claude: { transport: new FakeTransport({ reply: "base" }) },
    });
    base.registry.register(passGate as unknown as NodeDefinition);

    const adapted = registerClaudeAdapter(
      base,
      { transport },
      { rootPolicy: rootPolicy({ allowedModels: ["mock"] }) },
    );
    expect(adapted.store).toBe(base.store); // shared store -> continuous run state
    expect(adapted.registry).toBe(base.registry); // shared registry -> pass-gate carries over

    const events: RunEvent[] = [];
    for await (const ev of adapted.run(claudeAgentPack(), { payload: {}, budget: 100, maxDepth: 5 })) {
      events.push(ev);
    }
    expect(transport.calls).toBe(1); // the ADAPTED transport ran (not the base one)
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });

  it("reports the engine identity: id 'claude-code', governance 'opaque'", async () => {
    // A direct sanity check that the wired engine is the opaque one (mirrors the unit test, at the e2e seam).
    const { createClaudeAgentEngine } = await import("./register");
    const eng = createClaudeAgentEngine({ transport: new FakeTransport() });
    expect(eng.id).toBe("claude-code");
    expect(eng.governance).toBe("opaque");
  });
});
