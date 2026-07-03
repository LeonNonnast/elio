// ───────────────────────────── Slice 2 fixes: elicitation scoping, tighten-only, executor, completion ─────────────────────────────
// Regression tests for the confirmed Slice-2 findings. Each test pins ONE fixed root cause and would
// FAIL against the pre-fix runner/injector/branch code:
//  (A) cross-elicitation contamination on RESUME: a second distinct blocking approval in the same
//      branch must NOT be auto-resolved by the first answer — it must suspend on its own.
//  (B) cross-elicitation contamination IN-BRANCH (no resume): a policy/optional auto-resolve must not
//      leak its answer into a later blocking approval.
//  (C) tighten-only for suspend mode: a node proposing `optional` under a policy floor of `blocking`
//      must be RAISED to blocking and suspend (Inv. 13 / §6 final paragraph).
//  (D) per-run ChildBranchExecutor survives CONCURRENT resumes (ref-counted): siblings resumed via
//      Promise.all all complete, even if a post-resume step looks up the executor after a delay.
//  (E) run goes DONE after the last parked child + the feature eval-gate is RE-RUN on final resume:
//      no phantom "suspended" lingers in liveStatus(), and run-completed{gate:"passed"} is emitted.
//  (F) pack-version pinning: resuming a checkpoint against a DIFFERENT expected pack version is rejected.

import { describe, expect, it } from "vitest";
import {
  InMemoryRunStore,
  NodeRegistry,
  OuterLoopRunner,
  PolicyRegistry,
  getChildExecutor,
  registerBuiltins,
} from "./index";
import type {
  ArtifactType,
  FeaturePack,
  Policy,
  ResolvedPolicy,
  RunEvent,
} from "./index";

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function runtime(opts?: {
  rootPolicy?: ResolvedPolicy;
  artifactTypes?: Record<string, ArtifactType>;
  extra?: (r: NodeRegistry) => void;
}): { runner: OuterLoopRunner; store: InMemoryRunStore; registry: NodeRegistry; policyRegistry: PolicyRegistry } {
  const registry = new NodeRegistry();
  registerBuiltins(registry);
  opts?.extra?.(registry);
  const store = new InMemoryRunStore();
  const policyRegistry = new PolicyRegistry();
  const runner = new OuterLoopRunner({
    registry,
    store,
    policyRegistry,
    ...(opts?.rootPolicy !== undefined ? { rootPolicy: opts.rootPolicy } : {}),
    ...(opts?.artifactTypes !== undefined ? { artifactTypes: opts.artifactTypes } : {}),
  });
  return { runner, store, registry, policyRegistry };
}

/** Gate that passes only once artifact.content.mark2 === true (set by the step AFTER the 2nd approval). */
function registerMark2Gate(registry: NodeRegistry): void {
  registry.register({
    type: "has-mark2",
    klass: "orchestration",
    handler: (input) => {
      const content = (input as { artifact?: { content?: Record<string, unknown> } })?.artifact?.content;
      const passed = content?.["mark2"] === true;
      return Promise.resolve({
        status: "resolved" as const,
        output: { passed, failures: passed ? [] : ["no mark2"] },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) Two sequential blocking approvals — the second must suspend on its own.
// ─────────────────────────────────────────────────────────────────────────────
describe("(A) two sequential blocking approvals: the human answer to the first must NOT auto-resolve the second", () => {
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.two-approvals", version: "1", owner: "t" },
    contentHash: "t.two-approvals@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "has-mark2" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [
          { id: "commit1", type: "approval", suspend: "blocking", with: { reason: "approve step 1" } },
          { id: "commit2", type: "approval", suspend: "blocking", with: { reason: "approve step 2" } },
          { id: "mark2", type: "transform", with: { set: true, as: "mark2" } },
        ],
        edges: [
          { from: "commit1", to: "commit2" },
          { from: "commit2", to: "mark2" },
        ],
      },
    },
  };

  it("first resume stops at commit2 (its own node-suspended); only a second resume completes the run", async () => {
    const { runner } = runtime({ extra: registerMark2Gate });

    // First pass: suspends at commit1.
    const first = await collect(runner.run(pack, { payload: {}, budget: 100, maxDepth: 20 }));
    const s1 = first.find((e) => e.type === "node-suspended");
    expect(s1?.type).toBe("node-suspended");
    if (s1?.type !== "node-suspended") throw new Error("not suspended");
    expect(s1.correlation.step).toBe("commit1");
    expect(first.some((e) => e.type === "run-completed")).toBe(false);

    // Resume commit1 with a human answer. This MUST NOT silently auto-resolve commit2.
    const r1 = await collect(runner.resume(s1.correlation, { approved: "FIRST" }));

    // commit2 raised its OWN node-suspended — the run did NOT complete after one answer.
    const s2 = r1.find((e) => e.type === "node-suspended");
    expect(s2?.type).toBe("node-suspended");
    if (s2?.type !== "node-suspended") throw new Error("commit2 did not suspend — answer leaked!");
    expect(s2.correlation.step).toBe("commit2");
    expect(s2.elicitation.what).toBe("approve step 2");
    expect(r1.some((e) => e.type === "run-completed")).toBe(false);
    // commit2 must NOT have been resolved by:"parent" with commit1's answer.
    expect(
      r1.some(
        (e) =>
          e.type === "elicitation-resolved" &&
          e.by === "parent" &&
          e.correlation.step === "commit2",
      ),
    ).toBe(false);

    // mark2 has not run yet.
    expect(r1.some((e) => e.type === "step-started" && e.correlation.step === "mark2")).toBe(false);

    // Resume commit2 with its OWN answer -> now mark2 runs and the run completes passed.
    const r2 = await collect(runner.resume(s2.correlation, { approved: "SECOND" }));
    expect(r2.some((e) => e.type === "step-started" && e.correlation.step === "mark2")).toBe(true);
    const end = r2[r2.length - 1];
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("passed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) In-branch auto-resolve (policy intercept) does not leak into a later blocking approval.
// ─────────────────────────────────────────────────────────────────────────────
describe("(B) a policy-resolved first elicitation does not auto-resolve a later blocking approval (single run, no resume)", () => {
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.policy-then-approval", version: "1", owner: "t" },
    contentHash: "t.policy-then-approval@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "has-mark2" },
      io: { input: {}, output: {} },
      policies: ["auto-approve-first"],
      graph: {
        state: {},
        steps: [
          // first approval is auto-resolved inline by the policy interceptor.
          { id: "first", type: "approval", suspend: "blocking", with: { reason: "auto first" } },
          // second approval is a DISTINCT elicitation; it must STILL suspend.
          { id: "second", type: "approval", suspend: "blocking", with: { reason: "needs a human" } },
          { id: "mark2", type: "transform", with: { set: true, as: "mark2" } },
        ],
        edges: [
          { from: "first", to: "second" },
          { from: "second", to: "mark2" },
        ],
      },
    },
  };

  it("the policy auto-resolves only 'auto first'; 'needs a human' raises node-suspended", async () => {
    const { runner, policyRegistry } = runtime({ extra: registerMark2Gate });
    const autoApproveFirst: Policy = {
      id: "auto-approve-first",
      scope: (_req, p): ResolvedPolicy => p,
      intercept: (e) =>
        e.what === "auto first" ? { resolved: true, answer: { ok: "policy" } } : { resolved: false },
    };
    policyRegistry.register(autoApproveFirst);

    const events = await collect(runner.run(pack, { payload: {}, budget: 100, maxDepth: 20 }));

    // first resolved by policy
    expect(
      events.some(
        (e) => e.type === "elicitation-resolved" && e.by === "policy" && e.correlation.step === "first",
      ),
    ).toBe(true);
    // second still suspended (NOT leaked the policy answer)
    const s = events.find((e) => e.type === "node-suspended");
    expect(s?.type).toBe("node-suspended");
    if (s?.type === "node-suspended") expect(s.correlation.step).toBe("second");
    // run did NOT complete (the human must answer 'second')
    expect(events.some((e) => e.type === "run-completed")).toBe(false);
    expect(events.some((e) => e.type === "step-started" && e.correlation.step === "mark2")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) tighten-only for suspend mode: a node proposing `optional` under a `blocking` floor suspends.
// ─────────────────────────────────────────────────────────────────────────────
describe("(C) a node proposing suspend:'optional' under a policy floor 'blocking' is tightened to blocking and suspends", () => {
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.tighten-suspend", version: "1", owner: "t" },
    contentHash: "t.tighten-suspend@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "has-mark2" },
      io: { input: {}, output: {} },
      policies: ["floor-blocking"],
      graph: {
        state: {},
        steps: [
          // author proposes the LOOSEST mode; the policy floor must override it to blocking.
          { id: "gate", type: "approval", suspend: "optional", with: { reason: "loose proposal", default: { ok: true } } },
          { id: "mark2", type: "transform", with: { set: true, as: "mark2" } },
        ],
        edges: [{ from: "gate", to: "mark2" }],
      },
    },
  };

  it("the optional proposal is raised to blocking; the run suspends instead of applying the default", async () => {
    // root suspendMode is the loosest ("optional"); the declared policy raises the floor to blocking.
    const { runner, policyRegistry } = runtime({
      extra: registerMark2Gate,
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
      },
    });
    const floorBlocking: Policy = {
      id: "floor-blocking",
      scope: (_req, p): ResolvedPolicy => ({ ...p, suspendMode: "blocking" }),
    };
    policyRegistry.register(floorBlocking);

    const events = await collect(runner.run(pack, { payload: {}, budget: 100, maxDepth: 20 }));

    // suspended at the gate, mode RAISED to blocking (not the proposed optional)
    const s = events.find((e) => e.type === "node-suspended");
    expect(s?.type).toBe("node-suspended");
    if (s?.type !== "node-suspended") throw new Error("did not suspend — optional default was applied!");
    expect(s.correlation.step).toBe("gate");
    expect(s.mode).toBe("blocking");
    expect(s.elicitation.mode).toBe("blocking");
    // the run did NOT auto-complete by applying the optional default.
    expect(events.some((e) => e.type === "run-completed")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) per-run ChildBranchExecutor survives CONCURRENT resumes (ref-counted register/unregister).
// ─────────────────────────────────────────────────────────────────────────────
describe("(D) concurrent resumes of parked siblings of the same run do not delete the executor out from under each other", () => {
  const ARTIFACT_TYPES: Record<string, ArtifactType> = {
    "race-artifact": { kind: "race-artifact", holders: ["db-state", "memory"] },
  };

  /** A child step that, AFTER a small delay, asserts the run's ChildBranchExecutor is still registered. */
  function registerExecutorProbe(registry: NodeRegistry): void {
    registry.register({
      type: "executor-probe",
      klass: "orchestration",
      handler: async (_input, ctx) => {
        await new Promise((r) => setTimeout(r, 15));
        const exec = getChildExecutor(ctx.correlation.run);
        if (exec === undefined) {
          return {
            status: "failed" as const,
            error: { message: "executor missing mid-resume (deleted by a sibling)" },
            retryable: false,
            attempts: 1,
          };
        }
        return { status: "resolved" as const, output: { probed: true }, confidence: 1, cost: { usd: 0 } };
      },
    });
  }

  function registerCountGate(registry: NodeRegistry, expected: number): void {
    registry.register({
      type: "all-present",
      klass: "orchestration",
      handler: async (input) => {
        const artifact = (input as { artifact?: { holders?: Record<string, unknown> } })?.artifact;
        let count = 0;
        for (const h of Object.values(artifact?.holders ?? {})) {
          const holder = h as { kind?: string; read?: () => Promise<unknown[]> };
          if (holder.kind === "db-state" && typeof holder.read === "function") count = (await holder.read()).length;
        }
        const passed = count >= expected;
        return {
          status: "resolved" as const,
          output: { passed, failures: passed ? [] : [`${count}/${expected}`] },
          confidence: 1,
          cost: { usd: 0 },
        };
      },
    });
  }

  function makePack(): FeaturePack {
    const childSteps = [
      { id: "approve", type: "approval", suspend: "parked" as const, with: { reason: "hold" } },
      // after resume: a step that looks up the executor after a delay (would fail if it was deleted).
      { id: "probe", type: "executor-probe" },
      { id: "finalize", type: "transform", with: { set: true, as: "done" }, outputs: { done: "state.done" } },
    ];
    return {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.concurrent-resume", version: "1", owner: "t" },
      contentHash: "t.concurrent-resume@1",
      feature: {
        autonomy: "guided",
        artifact: { kind: "race-artifact", evalGate: "all-present" },
        io: { input: {}, output: {} },
        graph: {
          state: { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 3 }] },
          steps: [{ id: "fanout", type: "subworkflow", with: { forEach: "{{state.items}}", steps: childSteps } }],
          edges: [],
        },
      },
    };
  }

  it("3 parked children resumed via Promise.all all complete (the executor is not deleted early)", async () => {
    const { runner, store } = runtime({
      artifactTypes: ARTIFACT_TYPES,
      extra: (r) => {
        registerExecutorProbe(r);
        registerCountGate(r, 3);
      },
    });
    const pack = makePack();
    const first = await collect(runner.run(pack, { payload: {}, budget: 1000, maxDepth: 100 }));
    const runId = first.find((e) => e.type === "run-started")!.correlation.run;

    const parked = (await store.liveStatus())
      .filter((s) => s.phase === "suspended" && s.correlation.branch.includes("/"))
      .map((s) => s.correlation);
    expect(parked.length).toBe(3);

    // Resume ALL three concurrently — no serialization. The probe step (post-resume, after a delay)
    // must still find the executor; if the first finisher deletes it, the others' probe fails.
    const results = await Promise.all(parked.map((c) => collect(runner.resume(c, { approved: true }))));

    // every resume produced a probe node-resolved (none failed with "executor missing").
    for (const events of results) {
      expect(events.some((e) => e.type === "step-started" && e.correlation.step === "probe")).toBe(true);
      const probeFailed = store
        .getTape(runId)
        .some((f) => f.nodeType === "executor-probe" && f.result.status === "failed");
      expect(probeFailed).toBe(false);
    }

    // all three records landed.
    const artifact = runner.getArtifact(runId)!;
    let count = 0;
    for (const h of Object.values(artifact.holders)) {
      if (h.kind === "db-state") count = (await h.read() as unknown[]).length;
    }
    expect(count).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (E) run goes DONE after the last parked child + the eval-gate is re-run on the final resume.
// ─────────────────────────────────────────────────────────────────────────────
describe("(E) after all parked children resume, the run reports done (no phantom suspended) and emits run-completed{passed}", () => {
  const ARTIFACT_TYPES: Record<string, ArtifactType> = {
    "race-artifact": { kind: "race-artifact", holders: ["db-state", "memory"] },
  };

  function registerCountGate(registry: NodeRegistry, expected: number): void {
    registry.register({
      type: "all-present",
      klass: "orchestration",
      handler: async (input) => {
        const artifact = (input as { artifact?: { holders?: Record<string, unknown> } })?.artifact;
        let count = 0;
        for (const h of Object.values(artifact?.holders ?? {})) {
          const holder = h as { kind?: string; read?: () => Promise<unknown[]> };
          if (holder.kind === "db-state" && typeof holder.read === "function") count = (await holder.read()).length;
        }
        const passed = count >= expected;
        return {
          status: "resolved" as const,
          output: { passed, failures: passed ? [] : [`${count}/${expected}`] },
          confidence: 1,
          cost: { usd: 0 },
        };
      },
    });
  }

  function makePack(): FeaturePack {
    const childSteps = [
      { id: "approve", type: "approval", suspend: "parked" as const, with: { reason: "hold" } },
      { id: "finalize", type: "transform", with: { set: true, as: "done" }, outputs: { done: "state.done" } },
    ];
    return {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.parked-converge", version: "1", owner: "t" },
      contentHash: "t.parked-converge@1",
      feature: {
        autonomy: "guided",
        artifact: { kind: "race-artifact", evalGate: "all-present" },
        io: { input: {}, output: {} },
        graph: {
          state: { items: [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 3 }] },
          steps: [{ id: "fanout", type: "subworkflow", with: { forEach: "{{state.items}}", steps: childSteps } }],
          edges: [],
        },
      },
    };
  }

  it("the final parked-child resume re-runs the feature gate (passed) and clears all suspended statuses", async () => {
    const { runner, store } = runtime({
      artifactTypes: ARTIFACT_TYPES,
      extra: (r) => registerCountGate(r, 3),
    });
    const pack = makePack();
    const first = await collect(runner.run(pack, { payload: {}, budget: 1000, maxDepth: 100 }));
    const runId = first.find((e) => e.type === "run-started")!.correlation.run;

    const parked = (await store.liveStatus())
      .filter((s) => s.phase === "suspended" && s.correlation.branch.includes("/"))
      .map((s) => s.correlation)
      .sort((a, b) => a.branch.localeCompare(b.branch));
    expect(parked.length).toBe(3);

    // resume sequentially; only the LAST resume should complete the run.
    let lastEvents: RunEvent[] = [];
    for (const c of parked) {
      lastEvents = await collect(runner.resume(c, { approved: true }));
    }

    // the final resume emitted run-completed{gate:"passed"} (the feature gate was re-run + converged).
    const completed = lastEvents.find((e) => e.type === "run-completed");
    expect(completed?.type).toBe("run-completed");
    if (completed?.type === "run-completed") expect(completed.gate).toBe("passed");

    // liveStatus shows NO phantom suspended for this run; exactly one done entry.
    const statuses = await store.liveStatus();
    const forRun = statuses.filter((s) => s.correlation.run === runId);
    expect(forRun.some((s) => s.phase === "suspended")).toBe(false);
    expect(forRun.filter((s) => s.phase === "done").length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (F) pack-version pinning: resume against a DIFFERENT expected pack version is rejected.
// ─────────────────────────────────────────────────────────────────────────────
describe("(F) resuming a checkpoint whose packVersion differs from the supplied version is rejected (§11/#14)", () => {
  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.packpin", version: "1", owner: "t" },
    contentHash: "t.packpin@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "note", evalGate: "has-mark2" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [
          { id: "commit", type: "approval", suspend: "blocking", with: { reason: "approve" } },
          { id: "mark2", type: "transform", with: { set: true, as: "mark2" } },
        ],
        edges: [{ from: "commit", to: "mark2" }],
      },
    },
  };

  it("resume with a mismatching expectedPackVersion throws a distinct pack-version error", async () => {
    const { runner } = runtime({ extra: registerMark2Gate });
    const first = await collect(runner.run(pack, { payload: {}, budget: 100, maxDepth: 20 }));
    const s = first.find((e) => e.type === "node-suspended");
    if (s?.type !== "node-suspended") throw new Error("not suspended");

    // resume against a CHANGED pack hash -> rejected with the pack-version error (not "no run context").
    await expect(
      collect(runner.resume(s.correlation, { approved: true }, { expectedPackVersion: "t.packpin@2" })),
    ).rejects.toThrow(/Pack-Version geändert/);

    // resume against the SAME (pinned) version still works.
    const ok = await collect(
      runner.resume(s.correlation, { approved: true }, { expectedPackVersion: "t.packpin@1" }),
    );
    expect(ok[ok.length - 1]?.type).toBe("run-completed");
  });
});
