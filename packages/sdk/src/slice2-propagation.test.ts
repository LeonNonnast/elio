// ───────────────────────────── Slice 2 part A: elicitation propagation + approval + policy folding ─────────────────────────────
// Covers skeleton §6 (propagation path) + the 4-suspend-modes table (blocking + optional here):
//  (a) approval step suspends BLOCKING -> resume continues to completed; checkpoint round-trips state.
//  (b) a Policy.intercept auto-resolves inline (by:"policy") -> the run NEVER suspends.
//  (c) parent-state holds the answer -> auto-resolve (by:"parent") -> never suspends.
//  (d) resolveRoot folds a declared policy id; the ResolvedPolicy a node sees is tightened.

import { describe, expect, it } from "vitest";
import { createRuntime, collectEvents } from "./runtime";
import type {
  CapabilityRequest,
  Ctx,
  Elicitation,
  FeaturePack,
  NodeDefinition,
  Policy,
  ResolvedPolicy,
  RunEvent,
} from "@elio/core";

function runIdOf(events: RunEvent[]): string {
  const started = events.find((e) => e.type === "run-started");
  if (started === undefined) throw new Error("no run-started event");
  return started.correlation.run;
}

function last(events: RunEvent[]): RunEvent {
  const e = events[events.length - 1];
  if (e === undefined) throw new Error("no events emitted");
  return e;
}

/** An always-passing gate (registered under "always-pass"). */
function registerAlwaysPass(rt: ReturnType<typeof createRuntime>): void {
  rt.registry.register({
    type: "always-pass",
    klass: "orchestration",
    handler: () =>
      Promise.resolve({
        status: "resolved" as const,
        output: { passed: true, failures: [] },
        confidence: 1,
        cost: { usd: 0 },
      }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) approval suspends BLOCKING -> resume -> completed; checkpoint round-trips state.
// ─────────────────────────────────────────────────────────────────────────────
describe("(a) approval step suspends blocking, resume continues, checkpoint round-trips state", () => {
  /**
   * seed (transform) -> commit (approval, suspend:blocking) -> finalize (transform writes
   * artifact.content.committed=true). The gate "has-committed" only passes once `committed` is
   * set — so the first run MUST suspend at the approval and can only complete after resume.
   */
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.approval-blocking", version: "1", owner: "t" },
    contentHash: "t.approval-blocking@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "has-committed" },
      io: { input: {}, output: {} },
      graph: {
        state: { seeded: false },
        steps: [
          // seed populates branchState so the checkpoint carries non-trivial state.
          { id: "seed", type: "transform", with: { set: true, as: "seeded" }, outputs: { seeded: "state.seeded" } },
          // built-in approval; suspend mode comes from stepRef.suspend.
          { id: "commit", type: "approval", suspend: "blocking", with: { reason: "Commit ins Prod-Ziel" } },
          // finalize flat-merges { committed: true } into the artifact -> gate then passes.
          { id: "finalize", type: "transform", with: { set: true, as: "committed" } },
        ],
        edges: [
          { from: "seed", to: "commit" },
          { from: "commit", to: "finalize" },
        ],
      },
    },
  };

  /** Gate that passes only once artifact.content.committed === true. */
  function registerHasCommitted(rt: ReturnType<typeof createRuntime>): void {
    rt.registry.register({
      type: "has-committed",
      klass: "orchestration",
      handler: (input) => {
        const content = (input as { artifact?: { content?: Record<string, unknown> } })?.artifact
          ?.content;
        const passed = content?.["committed"] === true;
        return Promise.resolve({
          status: "resolved" as const,
          output: { passed, failures: passed ? [] : ["not committed"] },
          confidence: 1,
          cost: { usd: 0 },
        });
      },
    });
  }

  it("emits node-suspended (blocking), NO run-completed, then resume runs to completed{passed}", async () => {
    const rt = createRuntime();
    registerHasCommitted(rt);

    const first = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 10 }));

    // suspended on the approval step, mode blocking
    const suspended = first.find((e) => e.type === "node-suspended");
    expect(suspended).toBeDefined();
    if (suspended?.type !== "node-suspended") throw new Error("not suspended");
    expect(suspended.mode).toBe("blocking");
    expect(suspended.correlation.step).toBe("commit");
    expect(suspended.elicitation.what).toBe("Commit ins Prod-Ziel");
    expect(suspended.elicitation.whoCanAnswer).toEqual({ users: ["operator"] });

    // NOT completed yet (the human must answer)
    expect(first.some((e) => e.type === "run-completed")).toBe(false);
    // finalize did NOT run yet
    expect(first.some((e) => e.type === "step-started" && e.correlation.step === "finalize")).toBe(
      false,
    );

    // checkpoint addressable + round-trips the branchState EXACTLY (seed ran before commit).
    // `input` is the run payload, which the runner now seeds into branchState (state.input) so nodes can
    // read run-specific input via {{state.input...}}; it round-trips through the checkpoint like any state.
    const cp = await rt.store.loadCheckpoint(suspended.correlation);
    expect(cp).not.toBeNull();
    const cpState = cp!.state as { branchState: Record<string, unknown>; lastStepId?: string };
    expect(cpState.branchState).toEqual({ seeded: true, input: {} });
    expect(cpState.lastStepId).toBe("seed"); // last resolved step before the suspend
    expect(cp!.pendingElicitation?.what).toBe("Commit ins Prod-Ziel");

    // resume with the human answer -> continues to completed{passed}
    const resumed = await collectEvents(rt.resume(suspended.correlation, { approved: true }));
    // resume opens with elicitation-resolved{by:"human"}
    expect(resumed[0]?.type).toBe("elicitation-resolved");
    if (resumed[0]?.type === "elicitation-resolved") expect(resumed[0].by).toBe("human");
    // finalize ran on resume
    expect(
      resumed.some((e) => e.type === "step-started" && e.correlation.step === "finalize"),
    ).toBe(true);
    const end = last(resumed);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");

    // artifact actually carries the committed marker after resume
    const artifact = rt.runner.getArtifact(suspended.correlation.run);
    expect((artifact!.content as Record<string, unknown>)["committed"]).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) a Policy.intercept auto-resolves inline -> elicitation-resolved{by:"policy"},
//     the run NEVER suspends.
// ─────────────────────────────────────────────────────────────────────────────
describe("(b) a policy intercept auto-resolves the elicitation (by:'policy'), run never suspends", () => {
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.policy-intercept", version: "1", owner: "t" },
    contentHash: "t.policy-intercept@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "always-pass" },
      io: { input: {}, output: {} },
      policies: ["auto-approve-commits"],
      graph: {
        state: {},
        steps: [{ id: "commit", type: "approval", suspend: "blocking", with: { reason: "auto me" } }],
        edges: [],
      },
    },
  };

  it("emits elicitation-resolved{by:'policy'} and completes without any node-suspended", async () => {
    const rt = createRuntime();
    registerAlwaysPass(rt);

    let interceptSawState: unknown;
    const autoApprove: Policy = {
      id: "auto-approve-commits",
      scope: (_req, p): ResolvedPolicy => p, // no tightening here; just an interceptor
      intercept: (e: Elicitation, ctxState: unknown) => {
        interceptSawState = ctxState;
        if (e.what === "auto me") return { resolved: true, answer: { approved: "by-policy" } };
        return { resolved: false };
      },
    };
    rt.policyRegistry.register(autoApprove);

    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 10 }));

    // never suspended
    expect(events.some((e) => e.type === "node-suspended")).toBe(false);
    // resolved by the policy interceptor
    const resolvedBy = events.find((e) => e.type === "elicitation-resolved");
    expect(resolvedBy).toBeDefined();
    if (resolvedBy?.type === "elicitation-resolved") expect(resolvedBy.by).toBe("policy");
    // intercept received the branch state (object)
    expect(typeof interceptSawState).toBe("object");
    // and completed passed
    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) parent-state already holds the answer -> auto-resolve (by:"parent"),
//     never suspends.
// ─────────────────────────────────────────────────────────────────────────────
describe("(c) parent-state holds the answer -> auto-resolve (by:'parent'), never suspends", () => {
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.parent-answer", version: "1", owner: "t" },
    contentHash: "t.parent-answer@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "always-pass" },
      io: { input: {}, output: {} },
      graph: {
        // parent-state pre-supplies the answer keyed by the elicitation's `what`.
        state: { _answers: { "approval required": { approved: "pre-supplied" } } },
        steps: [{ id: "commit", type: "approval", suspend: "blocking" }],
        edges: [],
      },
    },
  };

  it("emits elicitation-resolved{by:'parent'} and completes without any node-suspended", async () => {
    const rt = createRuntime();
    registerAlwaysPass(rt);

    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 10 }));

    expect(events.some((e) => e.type === "node-suspended")).toBe(false);
    const resolvedBy = events.find((e) => e.type === "elicitation-resolved");
    expect(resolvedBy).toBeDefined();
    if (resolvedBy?.type === "elicitation-resolved") expect(resolvedBy.by).toBe("parent");
    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) resolveRoot folds a declared policy id; the ResolvedPolicy a node sees is
//     tightened (observable through ctx.policy).
// ─────────────────────────────────────────────────────────────────────────────
describe("(d) resolveRoot folds a declared policy id -> the node's ResolvedPolicy is tightened", () => {
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.policy-folds", version: "1", owner: "t" },
    contentHash: "t.policy-folds@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "always-pass" },
      io: { input: {}, output: {} },
      policies: ["tighten-classification-and-oversight"],
      graph: {
        state: {},
        steps: [{ id: "probe", type: "capture-policy" }],
        edges: [],
      },
    },
  };

  it("a node downstream of the folded policy sees raised dataClassification + suspendMode", async () => {
    // root grants cloud + a model; the declared policy must only be able to TIGHTEN.
    const rt = createRuntime({
      rootPolicy: {
        allowedModels: ["ollama"],
        allowCloud: true,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
      },
    });
    registerAlwaysPass(rt);

    // tightening policy: raise classification internal->confidential, oversight optional->blocking,
    // and drop cloud. (Author proposes, policy disposes — tighten-only, Inv. 13.)
    const tightener: Policy = {
      id: "tighten-classification-and-oversight",
      scope: (_req, p): ResolvedPolicy => ({
        ...p,
        dataClassification: "confidential",
        suspendMode: "blocking",
        allowCloud: false,
      }),
    };
    rt.policyRegistry.register(tightener);

    let seen: ResolvedPolicy | undefined;
    const capture: NodeDefinition = {
      type: "capture-policy",
      klass: "orchestration",
      // request a model so we can also observe set-intersection survives the fold.
      requests: { models: ["ollama"] } as CapabilityRequest,
      handler: (_input, ctx: Ctx) => {
        seen = ctx.policy;
        return Promise.resolve({
          status: "resolved" as const,
          output: { ok: true },
          confidence: 1,
          cost: { usd: 0 },
        });
      },
    };
    rt.registry.register(capture);

    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 10 }));
    const end = last(events);
    expect(end.type).toBe("run-completed"); // the policy was resolvable (not rejected)

    expect(seen).toBeDefined();
    // tightened: classification RAISED, oversight RAISED, cloud DROPPED (observable fold effect)
    expect(seen!.dataClassification).toBe("confidential");
    expect(seen!.suspendMode).toBe("blocking");
    expect(seen!.allowCloud).toBe(false);
    // the requested model survived the fold + per-node tighten (intersection with parent)
    expect(seen!.allowedModels).toEqual(["ollama"]);

    void runIdOf(events);
  });
});
