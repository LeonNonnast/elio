import { describe, expect, it } from "vitest";
import {
  mineDeterminism,
  mineDfg,
  mineDrift,
  mineElicitations,
  mineFailFast,
  mineFlakyRetry,
  mineLoopBound,
  mineModelRightSizing,
  mineRedactionLeaks,
  mineVariants,
} from "@elio/core";
import type {
  Cost,
  DeterminismProposal,
  DriftProposal,
  ElicitationProposal,
  FailFastProposal,
  FailureAlertProposal,
  LoopBoundProposal,
  ModelRightSizingProposal,
  NodeResult,
  ProcessDfgProposal,
  ProcessVariantProposal,
  RedactionLeakProposal,
  RetryTuneProposal,
  TapeFrame,
} from "@elio/core";

function resolved(output: unknown, cost: Cost = {}): NodeResult {
  return { status: "resolved", output, confidence: 1, cost };
}

function failed(retryable: boolean, attempts: number, code?: string): NodeResult {
  const error = code === undefined ? { message: "boom" } : { message: "boom", code };
  return { status: "failed", error, retryable, attempts };
}

function frame(over: {
  run?: string;
  step?: string;
  nodeType?: string;
  input?: unknown;
  result?: NodeResult;
}): TapeFrame {
  return {
    correlation: { run: over.run ?? "run_1", branch: "b", step: over.step ?? "s1", checkpoint: "cp" },
    nodeType: over.nodeType ?? "llm",
    input: over.input ?? {},
    result: over.result ?? resolved({}),
    injected: ["policy"],
    ts: "2026-01-01T00:00:00.000Z",
  };
}

function repeat(n: number, make: (i: number) => TapeFrame): TapeFrame[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

describe("retro/miners — mineDeterminism", () => {
  it("proposes a node-replacement for a deterministic intelligence call-site", () => {
    const frames = [
      ...repeat(25, () => frame({ step: "draft", nodeType: "llm", input: { q: "x" }, result: resolved("OUT") })),
      // a deterministic transform must be ignored (replacing orchestration is pointless):
      ...repeat(25, () => frame({ step: "calc", nodeType: "transform", input: { a: 1 }, result: resolved(2) })),
    ];
    const cands = mineDeterminism(frames);
    expect(cands).toHaveLength(1);
    const c = cands[0];
    expect(c?.kind).toBe("node-replacement");
    expect(c?.callSite?.step).toBe("draft");
    expect(c?.support).toBe(25);
    const proposal = c?.proposal as DeterminismProposal;
    expect(proposal.tier).toBe(0);
    expect(proposal.lookup).toHaveLength(1); // one unique input → one memo entry
  });

  it("skips call-sites below the determinism threshold", () => {
    // same input, two distinct outputs → that input is nondeterministic → determinism 0
    const noisy = [
      ...repeat(13, () => frame({ step: "f", nodeType: "llm", input: { q: "x" }, result: resolved("A") })),
      ...repeat(12, () => frame({ step: "f", nodeType: "llm", input: { q: "x" }, result: resolved("B") })),
    ];
    expect(mineDeterminism(noisy)).toHaveLength(0);
  });

  it("skips call-sites below minSupport", () => {
    const few = repeat(5, () => frame({ step: "d", nodeType: "llm", input: { q: "x" }, result: resolved("O") }));
    expect(mineDeterminism(few)).toHaveLength(0);
    expect(mineDeterminism(few, { minSupport: 3 })).toHaveLength(1);
  });

  it("estimates impact as the aggregated usd cost of the memoizable call-site frames", () => {
    const frames = repeat(20, () =>
      frame({ step: "d", nodeType: "llm", input: { q: "x" }, result: resolved("O", { usd: 0.01 }) }),
    );
    expect(mineDeterminism(frames)[0]?.estImpact?.usd).toBeCloseTo(0.2);
  });

  it("excludes non-memoizable (noisy) frames from estImpact (review #2)", () => {
    // 49 distinct deterministic inputs (memoizable) + 1 noisy input seen twice (NOT memoizable).
    // determinism = 49/50 = 0.98 → passes the gate, but the two $1 noisy frames must NOT count.
    const deterministic = Array.from({ length: 49 }, (_, i) =>
      frame({ step: "d", nodeType: "llm", input: { q: i }, result: resolved("O", { usd: 0.01 }) }),
    );
    const noisy = [
      frame({ step: "d", nodeType: "llm", input: { q: "noisy" }, result: resolved("A", { usd: 1 }) }),
      frame({ step: "d", nodeType: "llm", input: { q: "noisy" }, result: resolved("B", { usd: 1 }) }),
    ];
    const cands = mineDeterminism([...deterministic, ...noisy]);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.estImpact?.usd).toBeCloseTo(0.49); // 49 × 0.01; the two $1 noisy frames excluded
  });

  it("treats 'agent' as intelligence by default and honours intelligenceNodeTypes override", () => {
    const agentFrames = repeat(20, () =>
      frame({ step: "act", nodeType: "agent", input: { q: "x" }, result: resolved("O") }),
    );
    expect(mineDeterminism(agentFrames)).toHaveLength(1); // agent is intelligence by default
    expect(mineDeterminism(agentFrames, { intelligenceNodeTypes: ["llm"] })).toHaveLength(0);
    const tf = repeat(20, () =>
      frame({ step: "calc", nodeType: "transform", input: { a: 1 }, result: resolved(2) }),
    );
    expect(mineDeterminism(tf, { intelligenceNodeTypes: ["transform"] })).toHaveLength(1);
  });

  it("attributes candidates per feature via featureOf (determinism computed per-feature)", () => {
    // Same step + same input across two features but with DIFFERENT outputs. If merged, the input would
    // look nondeterministic (0 candidates); per-feature it is two clean deterministic call-sites.
    const frames = [
      ...repeat(20, () => frame({ run: "rX", step: "draft", nodeType: "llm", input: { q: "x" }, result: resolved("OX") })),
      ...repeat(20, () => frame({ run: "rY", step: "draft", nodeType: "llm", input: { q: "x" }, result: resolved("OY") })),
    ];
    const featureOf = (f: TapeFrame): string => (f.correlation.run === "rX" ? "feat.X" : "feat.Y");
    const cands = mineDeterminism(frames, { featureOf });
    expect(cands).toHaveLength(2);
    expect(cands.map((c) => c.callSite?.feature).sort()).toEqual(["feat.X", "feat.Y"]);
  });

  it("produces a stable candidate id regardless of frame order (idempotent re-mining, review #1)", () => {
    const frames = [
      ...repeat(20, () => frame({ step: "draft", nodeType: "llm", input: { q: "a" }, result: resolved("A") })),
      ...repeat(20, () => frame({ step: "draft", nodeType: "llm", input: { q: "b" }, result: resolved("B") })),
    ];
    const id1 = mineDeterminism(frames)[0]?.id;
    const id2 = mineDeterminism([...frames].reverse())[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });

  it("annotates a Tier-1 constant rule when every input maps to the same output (Punkt 4)", () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      frame({ step: "k", nodeType: "llm", input: { q: i }, result: resolved("SAME") }),
    );
    const p = mineDeterminism(frames)[0]?.proposal as DeterminismProposal;
    expect(p.rule).toEqual({ kind: "constant", value: "SAME" });
  });

  it("annotates a Tier-1 passthrough rule when output equals input", () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      frame({ step: "k", nodeType: "llm", input: { v: i }, result: resolved({ v: i }) }),
    );
    const p = mineDeterminism(frames)[0]?.proposal as DeterminismProposal;
    expect(p.rule).toEqual({ kind: "passthrough" });
  });

  it("emits no Tier-1 rule for a varied (non-constant, non-passthrough) deterministic mapping", () => {
    const frames = Array.from({ length: 20 }, (_, i) =>
      frame({ step: "k", nodeType: "llm", input: { q: i }, result: resolved({ r: i }) }),
    );
    const p = mineDeterminism(frames)[0]?.proposal as DeterminismProposal;
    expect(p.rule).toBeUndefined();
  });
});

describe("retro/miners — mineFlakyRetry", () => {
  it("proposes a node-config retry bump for predominantly retryable failures", () => {
    const transient = [
      frame({ step: "fetch", nodeType: "http-call", result: failed(true, 2) }),
      frame({ step: "fetch", nodeType: "http-call", result: failed(true, 2) }),
      frame({ step: "fetch", nodeType: "http-call", result: failed(true, 3) }),
    ];
    const cands = mineFlakyRetry(transient);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.kind).toBe("node-config");
    const proposal = cands[0]?.proposal as RetryTuneProposal;
    expect(proposal.retry.maxAttempts).toBe(4); // max observed attempts (3) + 1
    expect(proposal.retry.backoff).toBe("exponential");
  });

  it("raises an alert (histogram) for predominantly non-retryable failures", () => {
    const systematic = [
      frame({ step: "q", nodeType: "db", result: failed(false, 1, "E_SCHEMA") }),
      frame({ step: "q", nodeType: "db", result: failed(false, 1, "E_SCHEMA") }),
      frame({ step: "q", nodeType: "db", result: failed(false, 1, "E_AUTH") }),
    ];
    const cands = mineFlakyRetry(systematic);
    expect(cands[0]?.kind).toBe("alert");
    const proposal = cands[0]?.proposal as FailureAlertProposal;
    expect(proposal.errorCodes[0]?.code).toBe("E_SCHEMA"); // most frequent first
    expect(proposal.errorCodes[0]?.count).toBe(2);
  });

  it("ignores call-sites below minFailures and resolved-only call-sites", () => {
    expect(mineFlakyRetry([frame({ step: "q", result: failed(true, 1) })])).toHaveLength(0);
    expect(mineFlakyRetry(repeat(10, () => frame({ step: "ok", result: resolved("x") })))).toHaveLength(0);
  });

  it("sends ties at exactly retryableThreshold to node-config (>=, review #3)", () => {
    const tied = [
      frame({ step: "f", nodeType: "http-call", result: failed(true, 1) }),
      frame({ step: "f", nodeType: "http-call", result: failed(true, 1) }),
      frame({ step: "f", nodeType: "http-call", result: failed(false, 1) }),
      frame({ step: "f", nodeType: "http-call", result: failed(false, 1) }),
    ]; // 2/4 = 0.5 == default threshold → tie goes to node-config
    expect(mineFlakyRetry(tied)[0]?.kind).toBe("node-config");
  });

  it("honours a custom retryableThreshold", () => {
    const frames = [
      frame({ step: "f", nodeType: "http-call", result: failed(true, 1) }),
      frame({ step: "f", nodeType: "http-call", result: failed(false, 1) }),
      frame({ step: "f", nodeType: "http-call", result: failed(false, 1) }),
    ]; // 1/3 ≈ 0.33
    expect(mineFlakyRetry(frames)[0]?.kind).toBe("alert"); // default 0.5 → alert
    expect(mineFlakyRetry(frames, { retryableThreshold: 0.3 })[0]?.kind).toBe("node-config"); // 0.33 ≥ 0.3
  });

  it("buckets code-less failures under \"(none)\" (review #5)", () => {
    const frames = repeat(3, () => frame({ step: "q", nodeType: "db", result: failed(false, 1) }));
    const cands = mineFlakyRetry(frames);
    expect(cands[0]?.kind).toBe("alert");
    const proposal = cands[0]?.proposal as FailureAlertProposal;
    expect(proposal.errorCodes[0]?.code).toBe("(none)");
    expect(cands[0]?.summary).toContain("(none)");
  });

  it("records call-site, support and run provenance on flaky candidates (review #6)", () => {
    const frames = [
      frame({ run: "rA", step: "fetch", nodeType: "http-call", result: failed(true, 2) }),
      frame({ run: "rA", step: "fetch", nodeType: "http-call", result: failed(true, 2) }),
      frame({ run: "rB", step: "fetch", nodeType: "http-call", result: failed(true, 2) }),
    ];
    const c = mineFlakyRetry(frames)[0];
    expect(c?.callSite).toEqual({ feature: "", step: "fetch", nodeType: "http-call" });
    expect(c?.support).toBe(3);
    expect([...(c?.evidence.runs ?? [])].sort()).toEqual(["rA", "rB"]); // dedupes over failed frames
  });
});

function suspended(what: string): NodeResult {
  return { status: "suspended", elicitation: { what, whoCanAnswer: { users: ["op"] }, mode: "blocking" } };
}

describe("retro/miners — mineLoopBound", () => {
  it("flags a self-looping step from its per-run iteration distribution", () => {
    const frames: TapeFrame[] = [];
    for (let r = 0; r < 6; r += 1) {
      for (let i = 0; i < 4; i += 1) {
        frames.push(frame({ run: `run_${r}`, step: "draft", nodeType: "transform", result: resolved("x") }));
      }
    }
    const c = mineLoopBound(frames);
    expect(c).toHaveLength(1);
    expect(c[0]?.kind).toBe("node-config");
    const p = c[0]?.proposal as LoopBoundProposal;
    expect(p.observed.max).toBe(4);
    expect(p.observed.branches).toBe(6);
    expect(p.suggestedIterationCap).toBe(5); // per-call-site cap = max + 1 (NOT a global maxDepth)
  });

  it("ignores non-looping steps and too-few runs", () => {
    expect(mineLoopBound([frame({ run: "r1", step: "s", result: resolved("x") })])).toHaveLength(0);
  });
});

describe("retro/miners — mineElicitations", () => {
  it("flags a frequently-suspended call-site (frequency signal → policy-tighten)", () => {
    const c = mineElicitations(repeat(3, () => frame({ step: "gate", nodeType: "approval", result: suspended("commit?") })));
    expect(c).toHaveLength(1);
    expect(c[0]?.kind).toBe("policy-tighten");
    const p = c[0]?.proposal as ElicitationProposal;
    expect(p.what).toBe("commit?");
    expect(p.count).toBe(3);
  });

  it("needs minSuspends before flagging", () => {
    expect(mineElicitations([frame({ step: "g", nodeType: "approval", result: suspended("x") })])).toHaveLength(0);
  });
});

describe("retro/miners — mineModelRightSizing", () => {
  function llmFrame(step: string, confidence: number, cost: Cost): TapeFrame {
    return frame({ step, nodeType: "llm", input: { q: "x" }, result: { status: "resolved", output: { text: "o" }, confidence, cost } });
  }

  it("flags an expensive, high-confidence intelligence call-site as worth shadow-testing", () => {
    const c = mineModelRightSizing(repeat(5, () => llmFrame("draft", 0.95, { usd: 0.1, model: "big-model" })));
    expect(c).toHaveLength(1);
    expect(c[0]?.kind).toBe("node-config");
    expect((c[0]?.proposal as ModelRightSizingProposal).currentModel).toBe("big-model");
    expect(c[0]?.estImpact?.usd).toBeCloseTo(0.5);
  });

  it("skips low-confidence or model-less call-sites", () => {
    expect(mineModelRightSizing(repeat(5, () => llmFrame("d", 0.5, { usd: 0.1, model: "m" })))).toHaveLength(0);
    expect(mineModelRightSizing(repeat(5, () => llmFrame("d2", 0.95, { usd: 0.1 })))).toHaveLength(0);
  });

  it("produces a stable candidate id regardless of frame order (quantized floats, review)", () => {
    // Differently-valued usd amounts accumulated in frame order: IEEE-754 sums are non-associative, so the
    // raw float depends on order. The proposal quantizes meanConfidence/totalUsd, so the id must NOT move.
    const frames = [
      llmFrame("draft", 0.9, { usd: 0.1, model: "big" }),
      llmFrame("draft", 0.95, { usd: 0.2, model: "big" }),
      llmFrame("draft", 0.85, { usd: 0.3, model: "big" }),
    ];
    const id1 = mineModelRightSizing(frames)[0]?.id;
    const id2 = mineModelRightSizing([...frames].reverse())[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });
});

describe("retro/miners — mineRedactionLeaks", () => {
  it("flags PII-looking content present unredacted in the raw tape", () => {
    const c = mineRedactionLeaks([
      frame({ step: "draft", nodeType: "llm", input: { q: "reach me at john@example.com" }, result: resolved("ok") }),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]?.kind).toBe("alert");
    expect((c[0]?.proposal as RedactionLeakProposal).patterns).toContain("email");
  });

  it("finds nothing in clean content", () => {
    expect(mineRedactionLeaks([frame({ step: "s", result: resolved("nothing to see") })])).toHaveLength(0);
  });
});

describe("retro/miners — mineFailFast", () => {
  function expensive(run: string): TapeFrame {
    return frame({ run, step: "draft", nodeType: "llm", result: { status: "resolved", output: { text: "o" }, confidence: 1, cost: { usd: 0.2 } } });
  }
  function rejectingGate(run: string): TapeFrame {
    return frame({ run, step: "check", nodeType: "validate", result: resolved({ passed: false, failures: ["nope"] }) });
  }

  it("flags a cheap gate that rejects AFTER an expensive step (graph-edit, estimates waste)", () => {
    const frames: TapeFrame[] = [];
    for (let r = 0; r < 3; r += 1) frames.push(expensive(`run_${r}`), rejectingGate(`run_${r}`));
    const c = mineFailFast(frames);
    expect(c).toHaveLength(1);
    expect(c[0]?.kind).toBe("graph-edit");
    const p = c[0]?.proposal as FailFastProposal;
    expect(p.gateStep).toBe("check");
    expect(p.expensiveStep).toBe("draft");
    expect(p.rejections).toBe(3);
    expect(c[0]?.estImpact?.usd).toBeCloseTo(0.6);
  });

  it("ignores a gate that runs BEFORE the expensive step (no waste to save)", () => {
    const frames = [rejectingGate("r1"), expensive("r1")];
    expect(mineFailFast(frames)).toHaveLength(0);
  });

  it("produces a stable candidate id regardless of run order (waste kept out of id, review)", () => {
    // The accumulated waste-usd is no longer in the id-hashed proposal (it lives in estImpact). Reordering
    // the RUNS (each run's expensive→gate order intact, so the pattern still fires) and thus the
    // float-summation order must not move the id.
    const runOf = (r: number): TapeFrame[] => [expensive(`run_${r}`), rejectingGate(`run_${r}`)];
    const id1 = mineFailFast([...runOf(0), ...runOf(1), ...runOf(2)])[0]?.id;
    const id2 = mineFailFast([...runOf(2), ...runOf(1), ...runOf(0)])[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });
});

describe("retro/miners — mineDrift", () => {
  function memoFrame(hit: boolean, run: string): TapeFrame {
    return frame({
      run,
      step: "draft",
      nodeType: "memo-lookup",
      result: { status: "resolved", output: { text: "x", __memo_draft: hit }, confidence: 1, cost: {} },
    });
  }

  it("flags a high memo miss-rate as drift (domain stale)", () => {
    const frames: TapeFrame[] = [];
    for (let i = 0; i < 8; i += 1) frames.push(memoFrame(false, `miss_${i}`));
    for (let i = 0; i < 4; i += 1) frames.push(memoFrame(true, `hit_${i}`));
    const c = mineDrift(frames); // missRate 8/12 ≈ 0.67 ≥ 0.5, obs 12 ≥ 10
    expect(c).toHaveLength(1);
    expect(c[0]?.kind).toBe("alert");
    expect((c[0]?.proposal as DriftProposal).missRate).toBeCloseTo(8 / 12);
  });

  it("does not flag a healthy (low-miss) memo, and needs minObservations", () => {
    const healthy: TapeFrame[] = [];
    for (let i = 0; i < 12; i += 1) healthy.push(memoFrame(true, `r${i}`));
    expect(mineDrift(healthy)).toHaveLength(0);
    expect(mineDrift([memoFrame(false, "r1")])).toHaveLength(0); // 1 < minObservations
  });

  it("flags at exactly the miss-rate threshold (>= boundary)", () => {
    const frames: TapeFrame[] = [];
    for (let i = 0; i < 5; i += 1) frames.push(memoFrame(false, `m${i}`));
    for (let i = 0; i < 5; i += 1) frames.push(memoFrame(true, `h${i}`));
    expect(mineDrift(frames)).toHaveLength(1); // 5/10 == 0.5 default → inclusive
  });
});

// A session = the ordered nodeType sequence of a run. Build runs by listing their activity sequence.
function session(run: string, activities: readonly string[], cost: Cost = {}): TapeFrame[] {
  return activities.map((nodeType, i) =>
    frame({ run, step: `s${i}`, nodeType, result: resolved("o", cost) }),
  );
}

// A branch-tagged session: same run, explicit branch. Lets a single run carry sibling fan-out branches.
function branchSession(run: string, branch: string, activities: readonly string[]): TapeFrame[] {
  return activities.map((nodeType, i) => ({
    correlation: { run, branch, step: `s${i}`, checkpoint: "cp" },
    nodeType,
    input: {},
    result: resolved("o"),
    injected: [],
    ts: "2026-01-01T00:00:00.000Z",
  }));
}

describe("retro/miners — mineVariants", () => {
  it("groups runs by identical variant and emits one process-variant candidate per distinct variant", () => {
    const frames = [
      ...session("r1", ["Read", "Edit", "Bash"]),
      ...session("r2", ["Read", "Edit", "Bash"]),
      ...session("r3", ["Read", "Grep"]),
    ];
    const cands = mineVariants(frames);
    expect(cands).toHaveLength(2); // two distinct variants
    expect(cands.every((c) => c.kind === "process-variant")).toBe(true);
    const big = cands.find((c) => (c.proposal as ProcessVariantProposal).support === 2);
    const p = big?.proposal as ProcessVariantProposal;
    expect(p.kind).toBe("variant");
    expect(p.trace).toEqual(["Read", "Edit", "Bash"]);
    expect(p.support).toBe(2);
    expect(p.frequency).toBeCloseTo(2 / 3); // 2 of 3 runs
    expect([...(big?.evidence.runs ?? [])].sort()).toEqual(["r1", "r2"]); // evidence = the runs
  });

  it("respects minSupport (negative/threshold)", () => {
    const frames = [
      ...session("r1", ["A", "B"]),
      ...session("r2", ["A", "B"]),
      ...session("r3", ["C"]),
    ];
    // default minSupport 1 → both variants
    expect(mineVariants(frames)).toHaveLength(2);
    // minSupport 2 → only the repeated variant survives
    const c = mineVariants(frames, { minSupport: 2 });
    expect(c).toHaveLength(1);
    expect((c[0]?.proposal as ProcessVariantProposal).trace).toEqual(["A", "B"]);
  });

  it("reports avgCost averaged over the runs of the variant", () => {
    const frames = [
      ...session("r1", ["A", "B"], { usd: 0.1 }), // run cost = 0.2 (two frames)
      ...session("r2", ["A", "B"], { usd: 0.2 }), // run cost = 0.4
    ];
    const p = mineVariants(frames)[0]?.proposal as ProcessVariantProposal;
    expect(p.avgCost?.usd).toBeCloseTo(0.3); // (0.2 + 0.4) / 2
  });

  it("produces a stable candidate id AND output order regardless of run order (idempotent re-mining)", () => {
    const r1 = session("r1", ["Read", "Edit"]);
    const r2 = session("r2", ["Read", "Grep"]);
    // Reorder the SESSIONS (keeping each run's activity sequence intact) — the candidate id AND the
    // output-array ORDER must not move. NO trailing .sort(): this pins the production `.sort()` on the
    // variant fingerprints (miners.ts) — without it, the array order would follow run/insertion order.
    expect(mineVariants([...r1, ...r2]).map((c) => c.id)).toEqual(
      mineVariants([...r2, ...r1]).map((c) => c.id),
    );
  });

  it("returns nothing for empty input", () => {
    expect(mineVariants([])).toHaveLength(0);
  });

  it("isolates sibling fan-out branches sharing a runId (no fabricated mixed variant)", () => {
    // One run r1, two sibling branches each truly [file, llm], taped interleaved in completion order:
    // file(b1), file(b2), llm(b1), llm(b2). Grouping per-run would mis-read this as ONE variant
    // [file, file, llm, llm] that NO branch ran. Per (run, branch) it is the variant [file, llm] ×2.
    const b1 = branchSession("r1", "b1", ["file", "llm"]);
    const b2 = branchSession("r1", "b2", ["file", "llm"]);
    const interleaved = [b1[0]!, b2[0]!, b1[1]!, b2[1]!];
    const cands = mineVariants(interleaved);
    expect(cands).toHaveLength(1); // ONE distinct variant, not a fabricated mixed one
    const p = cands[0]?.proposal as ProcessVariantProposal;
    expect(p.trace).toEqual(["file", "llm"]); // the real per-branch sequence
    expect(p.support).toBe(2); // two branch-sessions
    expect([...(cands[0]?.evidence.runs ?? [])]).toEqual(["r1"]); // evidence = distinct runs
  });
});

describe("retro/miners — mineDfg", () => {
  function tsFrame(run: string, step: string, nodeType: string, ts: string, cost: Cost = {}): TapeFrame {
    return {
      correlation: { run, branch: "b", step, checkpoint: "cp" },
      nodeType,
      input: {},
      result: resolved("o", cost),
      injected: [],
      ts,
    };
  }

  it("emits exactly one process-variant candidate with the directly-follows graph", () => {
    const frames = [
      ...session("r1", ["Read", "Edit", "Bash"]),
      ...session("r2", ["Read", "Edit", "Test"]),
    ];
    const cands = mineDfg(frames);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.kind).toBe("process-variant");
    const p = cands[0]?.proposal as ProcessDfgProposal;
    expect(p.kind).toBe("dfg");
    // edges: Read→Edit (×2), Edit→Bash (×1), Edit→Test (×1)
    const readEdit = p.edges.find((e) => e.from === "Read" && e.to === "Edit");
    expect(readEdit?.freq).toBe(2);
    expect(p.start).toEqual(["Read"]);
    expect(p.end.sort()).toEqual(["Bash", "Test"]);
  });

  it("computes median latency from ts deltas of consecutive frames", () => {
    const frames = [
      tsFrame("r1", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r1", "s1", "B", "2026-01-01T00:00:00.100Z"), // A→B = 100ms
      tsFrame("r2", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r2", "s1", "B", "2026-01-01T00:00:00.300Z"), // A→B = 300ms
    ];
    const p = mineDfg(frames)[0]?.proposal as ProcessDfgProposal;
    const ab = p.edges.find((e) => e.from === "A" && e.to === "B");
    expect(ab?.medianLatencyMs).toBe(200); // median(100, 300)
  });

  it("computes median cost from the target frame costs", () => {
    const frames = [
      tsFrame("r1", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r1", "s1", "B", "2026-01-01T00:00:01.000Z", { usd: 0.2 }),
      tsFrame("r2", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r2", "s1", "B", "2026-01-01T00:00:01.000Z", { usd: 0.4 }),
    ];
    const p = mineDfg(frames)[0]?.proposal as ProcessDfgProposal;
    const ab = p.edges.find((e) => e.from === "A" && e.to === "B");
    expect(ab?.medianCost?.usd).toBeCloseTo(0.3); // median(0.2, 0.4)
  });

  it("returns nothing for empty input", () => {
    expect(mineDfg([])).toHaveLength(0);
  });

  it("produces a stable candidate id regardless of run order (idempotent re-mining)", () => {
    const r1 = session("r1", ["A", "B", "C"]);
    const r2 = session("r2", ["A", "C"]);
    // Reorder the SESSIONS (each run's activity sequence intact) — the DFG (and thus the id) is unchanged.
    const id1 = mineDfg([...r1, ...r2])[0]?.id;
    const id2 = mineDfg([...r2, ...r1])[0]?.id;
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });

  it("records all runs as evidence", () => {
    const frames = [...session("rA", ["A", "B"]), ...session("rB", ["A", "B"])];
    expect([...(mineDfg(frames)[0]?.evidence.runs ?? [])].sort()).toEqual(["rA", "rB"]);
  });

  it("does not fabricate edges across sibling fan-out branches sharing a runId", () => {
    // One run, two sibling branches each truly [file → llm], taped interleaved in completion order:
    // file(b1), file(b2), llm(b1), llm(b2). Per-run pairing would mint bogus file→file and llm→llm edges
    // (which the dt>=0 latency filter then silently masks). Per (run, branch) only file→llm is real.
    const b1 = branchSession("r1", "b1", ["file", "llm"]);
    const b2 = branchSession("r1", "b2", ["file", "llm"]);
    const interleaved = [b1[0]!, b2[0]!, b1[1]!, b2[1]!];
    const p = mineDfg(interleaved)[0]?.proposal as ProcessDfgProposal;
    expect(p.edges.map((e) => [e.from, e.to])).toEqual([["file", "llm"]]); // ONLY the real edge
    expect(p.edges.find((e) => e.from === "file" && e.to === "llm")?.freq).toBe(2);
    expect(p.start).toEqual(["file"]);
    expect(p.end).toEqual(["llm"]);
  });

  it("drops out-of-order (negative dt) pairs from latency but still counts the edge (dt>=0 guard)", () => {
    // Both runs have the same A→B edge, but r2's B timestamp PRECEDES its A (negative delta). The edge
    // frequency must still count both transitions; only r2's negative latency is dropped, leaving r1's.
    const frames = [
      tsFrame("r1", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r1", "s1", "B", "2026-01-01T00:00:00.500Z"), // +500ms (kept)
      tsFrame("r2", "s0", "A", "2026-01-01T00:00:05.000Z"),
      tsFrame("r2", "s1", "B", "2026-01-01T00:00:04.000Z"), // -1000ms (dropped from latency)
    ];
    const p = mineDfg(frames)[0]?.proposal as ProcessDfgProposal;
    const ab = p.edges.find((e) => e.from === "A" && e.to === "B");
    expect(ab?.freq).toBe(2); // both transitions counted
    expect(ab?.medianLatencyMs).toBe(500); // only the non-negative delta survives → median of [500]
  });

  it("computes median latency/cost over an ODD number of samples (middle element)", () => {
    // Three A→B transitions with latencies 100/200/9000 → odd-length median = 200 (the middle, not avg).
    const frames = [
      tsFrame("r1", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r1", "s1", "B", "2026-01-01T00:00:00.100Z", { usd: 0.1 }),
      tsFrame("r2", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r2", "s1", "B", "2026-01-01T00:00:00.200Z", { usd: 0.2 }),
      tsFrame("r3", "s0", "A", "2026-01-01T00:00:00.000Z"),
      tsFrame("r3", "s1", "B", "2026-01-01T00:00:09.000Z", { usd: 0.9 }),
    ];
    const p = mineDfg(frames)[0]?.proposal as ProcessDfgProposal;
    const ab = p.edges.find((e) => e.from === "A" && e.to === "B");
    expect(ab?.medianLatencyMs).toBe(200); // median(100, 200, 9000) = 200 (odd-length middle)
    expect(ab?.medianCost?.usd).toBeCloseTo(0.2); // median(0.1, 0.2, 0.9) = 0.2
  });

  it("omits medianCost when no qualifying (usd-bearing) samples exist", () => {
    const p = mineDfg([...session("r1", ["A", "B"])])[0]?.proposal as ProcessDfgProposal;
    const ab = p.edges.find((e) => e.from === "A" && e.to === "B");
    expect(ab?.medianCost).toBeUndefined(); // session() frames carry no usd → field omitted
  });
});
