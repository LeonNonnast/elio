import { describe, expect, it } from "vitest";
import {
  createDemoRuntime,
  draftUntilGoodPack,
  MIN_LENGTH,
  retryThenPassPack,
  setupDraftUntilGood,
} from "./index";
import { collectEvents, createRuntime } from "./runtime";
import { reDerive, serializeArtifact } from "@elio/core";
import type { FeaturePack, NodeDefinition, RunEvent } from "@elio/core";

/** Bequemer Sammler: führt einen Run zu Ende und liefert alle Events. */
async function runAll(
  rt: ReturnType<typeof createDemoRuntime>,
  pack: typeof draftUntilGoodPack,
  budget: number,
  maxDepth = 5,
): Promise<RunEvent[]> {
  return collectEvents(rt.run(pack, { payload: {}, budget, maxDepth }));
}

function last(events: RunEvent[]): RunEvent {
  const e = events[events.length - 1];
  if (e === undefined) throw new Error("no events emitted");
  return e;
}

function runIdOf(events: RunEvent[]): string {
  const started = events.find((e) => e.type === "run-started");
  if (started === undefined) throw new Error("no run-started event");
  return started.correlation.run;
}

describe("(a) draft-until-good — Outer-Loop-Konvergenz + Budget-Dekrement + Gate-Exit", () => {
  it("reaches run-completed{gate:'passed'}, grows the artifact, decrements the budget", async () => {
    const rt = createDemoRuntime();
    const budget = 100;
    const events = await runAll(rt, draftUntilGoodPack, budget);

    // converges via the gate (not via "steps done")
    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");

    // artifact grew to >= MIN_LENGTH chars
    const runId = runIdOf(events);
    const artifact = rt.runner.getArtifact(runId);
    expect(artifact).toBeDefined();
    const content = artifact!.content as Record<string, unknown>;
    expect(typeof content["progress"]).toBe("string");
    expect((content["progress"] as string).length).toBeGreaterThanOrEqual(MIN_LENGTH);

    // budget decremented: cost-delta totals are strictly increasing and end > 0
    const costDeltas = events.filter((e) => e.type === "cost-delta");
    expect(costDeltas.length).toBeGreaterThan(0);
    const lastCd = costDeltas[costDeltas.length - 1];
    const lastTotal = lastCd !== undefined && lastCd.type === "cost-delta" ? (lastCd.total.usd ?? 0) : 0;
    expect(lastTotal).toBeGreaterThan(0);
    expect(lastTotal).toBeLessThan(budget);

    // artifact-updated emitted at least once per resolved step
    expect(events.some((e) => e.type === "artifact-updated")).toBe(true);

    // eval-state recorded on the artifact
    expect(artifact!.evalState?.passed).toBe(true);
    expect(artifact!.evalState?.gate).toBe("min-length");
  });

  it("needs exactly ceil(MIN_LENGTH/chunk) appends (gate fail -> ... -> pass)", async () => {
    const rt = createDemoRuntime();
    const events = await runAll(rt, draftUntilGoodPack, 100);
    // chunk is 10 chars, MIN_LENGTH 30 -> 3 resolved appends
    const resolved = events.filter((e) => e.type === "node-resolved");
    expect(resolved.length).toBe(3);
  });
});

describe("(b) retry-then-pass — Failed -> Retry -> Resolved", () => {
  it("recovers on the second attempt and completes passed", async () => {
    const rt = createDemoRuntime();
    const events = await collectEvents(
      rt.run(retryThenPassPack, { payload: {}, budget: 10, maxDepth: 5 }),
    );

    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");

    // the flaky node resolved (after one retry) -> exactly one node-resolved for do-work
    const resolved = events.filter((e) => e.type === "node-resolved");
    expect(resolved.length).toBe(1);

    // The do-work frame is the *recovered* attempt: tryWithRetry returns the bare Resolved on
    // success, so the frame carries no attempt count. The retry is proven indirectly: it reached
    // gate:'passed' with NO dead-letter frame (a broken retry would dead-letter instead).
    const runId = runIdOf(events);
    const tape = rt.store.getTape(runId);
    const work = tape.find((f) => f.nodeType === "flaky-once");
    expect(work).toBeDefined();
    expect(work!.result.status).toBe("resolved");
    // no dead-letter frame (it recovered)
    expect(tape.some((f) => f.nodeType === "dead-letter")).toBe(false);
  });

  it("the retry is observable: a flaky node is invoked exactly twice before resolving", async () => {
    const rt = createRuntime();
    let calls = 0;
    // direct assertion of the retry (vs. only inferring it from the absence of a dead-letter)
    rt.registry.register({
      type: "count-flaky",
      klass: "orchestration",
      retry: { maxAttempts: 2, backoff: "none", onExhausted: "fail" },
      handler: () => {
        calls += 1;
        if (calls < 2) throw new Error("transient");
        return Promise.resolve({
          status: "resolved" as const,
          output: { ok: true },
          confidence: 1,
          cost: { usd: 0 },
        });
      },
    });
    rt.registry.register({
      type: "pass-gate",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved" as const,
          output: { passed: true, failures: [] },
          confidence: 1,
          cost: { usd: 0 },
        }),
    });
    const pack: FeaturePack = {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.count-flaky", version: "1", owner: "t" },
      contentHash: "t.count-flaky@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: { state: {}, steps: [{ id: "w", type: "count-flaky" }], edges: [] },
      },
    };
    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 10, maxDepth: 5 }));
    expect(calls).toBe(2); // invoked exactly twice: 1 throw + 1 success
    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");
  });

  it("a node that exhausts retries with onExhausted='fail' dead-letters and stops", async () => {
    const rt = createRuntime();
    // custom always-throwing node, maxAttempts 2, onExhausted fail
    rt.registry.register({
      type: "always-throw",
      klass: "orchestration",
      retry: { maxAttempts: 2, onExhausted: "fail" },
      handler: () => {
        throw new Error("boom");
      },
    });
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
    const pack = {
      apiVersion: "elio/v1" as const,
      kind: "Feature" as const,
      metadata: { id: "t.always-throw", version: "1", owner: "t" },
      contentHash: "t.always-throw@1",
      feature: {
        autonomy: "static" as const,
        artifact: { kind: "note", evalGate: "always-pass" },
        io: { input: {}, output: {} },
        graph: { state: {}, steps: [{ id: "x", type: "always-throw" }], edges: [] },
      },
    };
    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 10, maxDepth: 5 }));
    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("stopped");

    const runId = runIdOf(events);
    const tape = rt.store.getTape(runId);
    expect(tape.some((f) => f.nodeType === "dead-letter")).toBe(true);
    const failed = tape.find((f) => f.nodeType === "always-throw");
    expect(failed?.result.status).toBe("failed");
    if (failed?.result.status === "failed") expect(failed.result.attempts).toBe(2);
  });
});

describe("(c) gate-fail-then-pass", () => {
  it("the gate fails on early iterations and only passes once the artifact is good enough", async () => {
    const rt = createDemoRuntime();
    const events = await runAll(rt, draftUntilGoodPack, 100);
    const runId = runIdOf(events);
    const tape = rt.store.getTape(runId);

    // gate frames are recorded per resolved orchestration step
    const gateFrames = tape.filter((f) => f.nodeType === "min-length");
    expect(gateFrames.length).toBeGreaterThanOrEqual(3);

    // read each gate verdict in order: false, false, ..., true (last)
    const verdicts = gateFrames.map((f) =>
      f.result.status === "resolved"
        ? (f.result.output as { passed: boolean }).passed
        : false,
    );
    expect(verdicts[0]).toBe(false);
    expect(verdicts[verdicts.length - 1]).toBe(true);
    // at least one false before the final true
    expect(verdicts.slice(0, -1).every((v) => v === false)).toBe(true);
  });
});

describe("(d) budget/depth exhaustion — escalates as node-suspended (Inv. 21, no infinite loop)", () => {
  it("escalates (suspend) when the budget runs out before the gate passes", async () => {
    const rt = createDemoRuntime();
    // each append costs 0.5; need 3 to pass (length 30). budget 1.0 -> only 2 appends -> exhausted.
    // Slice 4 (Inv. 21, §4 4a): exhaustion is NOT a hard stop — it escalates as an Elicitation
    // ("mehr Budget/Tiefe freigeben?") via node-suspended, resumable with more budget.
    const events = await runAll(rt, draftUntilGoodPack, 1.0);
    const end = last(events);
    expect(end.type).toBe("node-suspended");
    if (end.type === "node-suspended") {
      expect(end.correlation.step).toBe("__budget__");
      expect(end.elicitation.what).toMatch(/Budget/);
    }

    // it did NOT loop forever: a bounded number of resolved steps before exhaustion.
    const resolved = events.filter((e) => e.type === "node-resolved");
    expect(resolved.length).toBe(2);

    // artifact did not reach the gate
    const runId = runIdOf(events);
    const artifact = rt.runner.getArtifact(runId);
    const content = artifact!.content as Record<string, unknown>;
    expect((content["progress"] as string).length).toBeLessThan(MIN_LENGTH);
  });

  it("maxDepth=0 escalates immediately without running any step", async () => {
    const rt = createDemoRuntime();
    const events = await collectEvents(
      rt.run(draftUntilGoodPack, { payload: {}, budget: 100, maxDepth: 0 }),
    );
    const end = last(events);
    // maxDepth=0 -> the Outer Loop is at its bound before the first step -> escalate (suspend).
    expect(end.type).toBe("node-suspended");
    if (end.type === "node-suspended") expect(end.correlation.step).toBe("__budget__");
    expect(events.some((e) => e.type === "node-resolved")).toBe(false);
  });
});

describe("(e) re-derive round-trip on the produced artifact (Inv. 22)", () => {
  it("serialize -> reDerive yields identical content for the converged artifact", async () => {
    const rt = createDemoRuntime();
    const events = await runAll(rt, draftUntilGoodPack, 100);
    const runId = runIdOf(events);
    const artifact = rt.runner.getArtifact(runId);
    expect(artifact).toBeDefined();

    // round-trip: re-derive reads state back out of the holders
    const before = await serializeArtifact(artifact!);
    const rederived = await reDerive(artifact!);
    const after = await serializeArtifact(rederived);

    // the produced artifact actually carries non-trivial state (guards against an empty round-trip)
    const beforeProgress = (before.content as Record<string, unknown>)["progress"];
    expect(typeof beforeProgress).toBe("string");
    expect((beforeProgress as string).length).toBeGreaterThanOrEqual(MIN_LENGTH);

    // content survives the round trip (progress holder reconstructs content.progress)
    expect((after.content as Record<string, unknown>)["progress"]).toBe(beforeProgress);
    // holders' serialized state is identical
    expect(after.holders).toEqual(before.holders);
  });
});

describe("suspend -> resume via correlation-id (Inv. 12)", () => {
  it("a suspending node checkpoints; resume feeds the answer and runs to completion", async () => {
    const rt = createRuntime();
    // gate that passes once state/answer present
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
    // node that suspends on first visit, resolves once the answer is in state
    rt.registry.register({
      type: "needs-approval",
      klass: "orchestration",
      handler: (input, ctx) => {
        const state = input as { answer?: unknown };
        if (state.answer === undefined) {
          // raise a BLOCKING elicitation -> Suspended (Inv. 11). blocking (vs. the root "optional"
          // floor) ensures the branch actually halts at a checkpoint (rather than auto-applying an
          // optional default) so resume() via correlation-id can feed the answer (Inv. 12).
          return Promise.resolve(
            ctx.elicit!.raise({
              what: "approve to continue",
              whoCanAnswer: { machine: false },
              mode: "blocking",
            }),
          );
        }
        return Promise.resolve({
          status: "resolved" as const,
          output: { approved: state.answer },
          confidence: 1,
          cost: { usd: 0 },
        });
      },
    });
    const pack = {
      apiVersion: "elio/v1" as const,
      kind: "Feature" as const,
      metadata: { id: "t.approval", version: "1", owner: "t" },
      contentHash: "t.approval@1",
      feature: {
        autonomy: "guided" as const,
        artifact: { kind: "note", evalGate: "always-pass" },
        io: { input: {}, output: {} },
        graph: {
          state: {},
          // step reads {{state.answer}} so resume's injected answer flows into the input
          steps: [{ id: "gate-step", type: "needs-approval", with: { answer: "{{state.answer}}" } }],
          edges: [],
        },
      },
    };

    const first = await collectEvents(rt.run(pack, { payload: {}, budget: 10, maxDepth: 5 }));
    const suspended = first.find((e) => e.type === "node-suspended");
    expect(suspended).toBeDefined();
    if (suspended?.type !== "node-suspended") throw new Error("not suspended");

    // checkpoint was saved + addressable
    const cp = await rt.store.loadCheckpoint(suspended.correlation);
    expect(cp).not.toBeNull();

    // resume with the answer
    const resumed = await collectEvents(rt.resume(suspended.correlation, "yes"));
    const end = resumed[resumed.length - 1];
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("passed");
    // resume resolved the suspended step
    expect(resumed.some((e) => e.type === "node-resolved")).toBe(true);
  });
});

describe("top-level run/resume facade + setup helpers", () => {
  it("setupDraftUntilGood registers the gate on an arbitrary runtime", () => {
    const rt = createRuntime();
    expect(rt.registry.has("min-length")).toBe(false);
    const pack = setupDraftUntilGood(rt);
    expect(rt.registry.has("min-length")).toBe(true);
    expect(pack.metadata.id).toBe("demo.draft-until-good");
    // transform built-in is present by default
    expect(rt.registry.has("transform")).toBe(true);
    expect(rt.registry.has("validate")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MANDATORY core test (blueprint §8 / §4): a real MULTI-NODE graph runs to DONE
// end-to-end through the OuterLoopRunner — distinct nodes A->B connected by an edge,
// no further edge => nextEdge returns DONE. Locks down drive()'s lastStepId advance,
// the mergeOutput -> resolveInput chaining (A's output feeds B's {{state.x}} input),
// and the termination path. This is what nextEdge() unit tests alone do NOT cover.
// ─────────────────────────────────────────────────────────────────────────────
describe("2-node graph runs to DONE (mandatory end-to-end, §4/§8)", () => {
  /** Gate that only passes once BOTH steps ran (artifact.content has x AND y). */
  const bothPresentGate: NodeDefinition = {
    type: "both-present",
    klass: "orchestration",
    handler: (input) => {
      const content = (input as { artifact?: { content?: Record<string, unknown> } })?.artifact
        ?.content;
      const passed =
        typeof content?.["x"] === "string" && typeof content?.["y"] === "string";
      return Promise.resolve({
        status: "resolved" as const,
        output: { passed, failures: passed ? [] : ["missing x or y"] },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  const twoNodePack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.two-node", version: "1", owner: "t" },
    contentHash: "t.two-node@1",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "both-present" },
      io: { input: {}, output: {} },
      graph: {
        state: { x: "", y: "" },
        steps: [
          // a: writes state.x = "AA"
          { id: "a", type: "transform", with: { set: "AA", as: "x" }, outputs: { x: "state.x" } },
          // b: reads {{state.x}} ("AA") and appends "BB" -> "AABB" into a DIFFERENT field y
          {
            id: "b",
            type: "transform",
            with: { append: "BB", to: "{{state.x}}", as: "y" },
            outputs: { y: "state.y" },
          },
        ],
        // a -> b only; after b there is no outgoing edge -> DONE
        edges: [{ from: "a", to: "b" }],
      },
    },
  };

  it("threads state A->B across distinct steps, terminates at DONE, passes the gate", async () => {
    const rt = createRuntime();
    rt.registry.register(bothPresentGate);
    const events = await collectEvents(
      rt.run(twoNodePack, { payload: {}, budget: 100, maxDepth: 10 }),
    );

    // event order: started(a) -> resolved(a) -> started(b) -> resolved(b) -> completed{passed}
    const seq = events
      .filter(
        (e) =>
          e.type === "step-started" || e.type === "node-resolved" || e.type === "run-completed",
      )
      .map((e) =>
        e.type === "step-started"
          ? `start:${e.correlation.step}`
          : e.type === "node-resolved"
            ? `resolved:${e.correlation.step}`
            : `completed`,
      );
    expect(seq).toEqual([
      "start:a",
      "resolved:a",
      "start:b",
      "resolved:b",
      "completed",
    ]);

    // exactly two node-resolved (proves DONE termination, NOT an infinite self-loop)
    const resolved = events.filter((e) => e.type === "node-resolved");
    expect(resolved.length).toBe(2);

    // terminated via the gate, passed
    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");

    // b's input was derived from a's merged output: y = "AABB" (state threading across steps)
    const runId = runIdOf(events);
    const tape = rt.store.getTape(runId);
    const bFrame = tape.find((f) => f.correlation.step === "b");
    expect(bFrame).toBeDefined();
    // the resolved {{state.x}} flowed into b's input as the `to` base
    expect((bFrame!.input as { to?: unknown }).to).toBe("AA");
    expect(bFrame!.result.status).toBe("resolved");
    if (bFrame!.result.status === "resolved") {
      expect((bFrame!.result.output as { y?: unknown }).y).toBe("AABB");
    }

    // artifact carries both fields
    const artifact = rt.runner.getArtifact(runId);
    const content = artifact!.content as Record<string, unknown>;
    expect(content["x"]).toBe("AA");
    expect(content["y"]).toBe("AABB");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Outer-Loop bound is REAL (Inv. 21, §4 4a): zero-cost / token-only nodes still
// terminate, and maxDepth actually bounds the loop (not just maxDepth=0).
// ─────────────────────────────────────────────────────────────────────────────
describe("Outer-Loop bound: zero-cost + maxDepth (Inv. 21)", () => {
  function neverPassPack(): FeaturePack {
    return {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.never-pass", version: "1", owner: "t" },
      contentHash: "t.never-pass@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "never-pass-gate" },
        io: { input: {}, output: {} },
        graph: {
          state: {},
          // zero-cost self-edge transform (cost:{}), gate never passes
          steps: [{ id: "noop", type: "transform", with: { set: "x", as: "v" } }],
          edges: [{ from: "noop", to: "noop" }],
        },
      },
    };
  }

  function withNeverPass(): ReturnType<typeof createRuntime> {
    const rt = createRuntime();
    rt.registry.register({
      type: "never-pass-gate",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved" as const,
          output: { passed: false, failures: ["nope"] },
          confidence: 1,
          cost: {}, // zero-cost gate
        }),
    });
    return rt;
  }

  it("a zero-cost self-loop with a never-passing gate stops at maxDepth (NOT HARD_CAP)", async () => {
    const rt = withNeverPass();
    // huge budget so cost.usd can never be the stopping reason; iteration bound must fire.
    const events = await collectEvents(
      rt.run(neverPassPack(), { payload: {}, budget: 1e9, maxDepth: 7 }),
    );
    const resolved = events.filter((e) => e.type === "node-resolved");
    expect(resolved.length).toBe(7); // bounded by maxDepth, not 10_000
    // Slice 4 (Inv. 21): hitting the maxDepth bound escalates as a node-suspended Elicitation
    // ("mehr Budget/Tiefe freigeben?") rather than a hard run-completed{stopped}.
    const end = last(events);
    expect(end.type).toBe("node-suspended");
    if (end.type === "node-suspended") expect(end.correlation.step).toBe("__budget__");
  });

  it("maxDepth=1 bounds the loop to a single resolved step", async () => {
    const rt = withNeverPass();
    const events = await collectEvents(
      rt.run(neverPassPack(), { payload: {}, budget: 1e9, maxDepth: 1 }),
    );
    expect(events.filter((e) => e.type === "node-resolved").length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate runs after EVERY resolved step, regardless of node klass (Inv. 1, §4 12).
// A self-looping INTELLIGENCE node must exit at the gate, not spin to the bound.
// ─────────────────────────────────────────────────────────────────────────────
describe("eval-gate after every resolved step incl. intelligence nodes (§4 12)", () => {
  it("a self-looping intelligence node exits at the gate (not at maxDepth)", async () => {
    const rt = createRuntime();
    // an "intelligence"-class node on a self-edge that grows the artifact each pass
    rt.registry.register({
      type: "fake-llm",
      klass: "intelligence",
      handler: (input) => {
        const cur = (input as { cur?: unknown }).cur;
        const next = `${typeof cur === "string" ? cur : ""}ab`;
        return Promise.resolve({
          status: "resolved" as const,
          output: { progress: next },
          confidence: 1,
          // token-only cost (no usd) — also exercises the token-only budget hole
          cost: { tokensIn: 5, tokensOut: 5 },
        });
      },
    });
    // gate passes once content.progress reaches length 6 (3 passes of "ab")
    rt.registry.register({
      type: "len6-gate",
      klass: "orchestration",
      handler: (input) => {
        const content = (input as { artifact?: { content?: Record<string, unknown> } })?.artifact
          ?.content;
        const p = typeof content?.["progress"] === "string" ? (content["progress"] as string) : "";
        const passed = p.length >= 6;
        return Promise.resolve({
          status: "resolved" as const,
          output: { passed, failures: passed ? [] : ["too short"] },
          confidence: 1,
          cost: { usd: 0 },
        });
      },
    });
    const pack: FeaturePack = {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.intel-loop", version: "1", owner: "t" },
      contentHash: "t.intel-loop@1",
      feature: {
        autonomy: "guided",
        artifact: { kind: "text-doc", evalGate: "len6-gate" },
        io: { input: {}, output: {} },
        graph: {
          state: { progress: "" },
          steps: [
            {
              id: "draft",
              type: "fake-llm",
              with: { cur: "{{state.progress}}" },
              outputs: { progress: "state.progress" },
            },
          ],
          edges: [{ from: "draft", to: "draft" }],
        },
      },
    };

    // maxDepth=100 is far above the 3 passes needed; if the gate were skipped for
    // intelligence nodes the loop would run all the way to the bound instead of 3.
    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 1e9, maxDepth: 100 }));
    const end = last(events);
    expect(end.type).toBe("run-completed");
    if (end.type === "run-completed") expect(end.gate).toBe("passed");
    // exactly 3 resolved drafts -> exited at the gate, not at maxDepth
    expect(events.filter((e) => e.type === "node-resolved").length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// complete() reports feature id + accumulated cost in the final RunStatus.
// ─────────────────────────────────────────────────────────────────────────────
describe("completed RunStatus carries feature id + cost (Inv. 15)", () => {
  it("liveStatus() shows the done run with its feature id and total cost", async () => {
    const rt = createDemoRuntime();
    const events = await runAll(rt, draftUntilGoodPack, 100);
    const runId = runIdOf(events);
    const statuses = await rt.store.liveStatus();
    const done = statuses.find((s) => s.phase === "done" && s.correlation.run === runId);
    expect(done).toBeDefined();
    expect(done!.feature).toBe("demo.draft-until-good");
    // accumulated cost is reported (3 appends @ 0.5 = 1.5), not the old empty {}
    expect(done!.cost.usd).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A feature that declares policies must not run silently ungoverned (§4 step 2).
// ─────────────────────────────────────────────────────────────────────────────
describe("declared feature policies are not silently ignored (§4 step 2)", () => {
  it("rejects a feature with non-empty policies (no Policy registry until Slice 4)", async () => {
    const rt = createDemoRuntime();
    const pack: FeaturePack = {
      ...draftUntilGoodPack,
      feature: { ...draftUntilGoodPack.feature, policies: ["no_cloud_for_private_data"] },
    };
    // createDemoRuntime hat eine (leere) PolicyRegistry; eine deklarierte, nicht registrierte Policy
    // wird abgelehnt (PolicyRegistry.resolve wirft) — ein Feature läuft NIE silently ungoverned (§4 2).
    await expect(collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 10 }))).rejects.toThrow(
      /PolicyRegistry|Policy-Registry|keine Policy/,
    );
  });
});
