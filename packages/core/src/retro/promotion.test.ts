import { describe, expect, it } from "vitest";
import {
  applyCandidate,
  applyDemotion,
  bumpVersion,
  hashValue,
  isScriptProposal,
  makeCandidate,
  packContentHash,
  shadowEval,
  shadowEvalScript,
} from "@elio/core";
import type {
  CandidateSpec,
  FeaturePack,
  NodeResult,
  ScriptRunResult,
  StepRef,
  TapeFrame,
} from "@elio/core";

function basePack(draftEdges: { from: string; to: string; when?: string }[] = []): FeaturePack {
  const steps: StepRef[] = [
    { id: "pre", type: "transform", with: { set: 1, as: "a" }, outputs: { a: "state.a" } },
    { id: "draft", type: "llm", with: { prompt: "{{state.a}}" }, outputs: { text: "state.draft" } },
  ];
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "demo.svc", version: "1.0.0" },
    contentHash: "sha256:original",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "g" },
      io: { input: {}, output: {} },
      graph: { steps, edges: [{ from: "pre", to: "draft" }, ...draftEdges] },
    },
  };
}

const ih = hashValue({ prompt: "x" });
function candidate(over: Partial<CandidateSpec> = {}) {
  return makeCandidate({
    source: "determinism-miner",
    kind: "node-replacement",
    callSite: { feature: "demo.svc", step: "draft", nodeType: "llm" },
    support: 25,
    evidence: { runs: ["r1"] },
    proposal: { tier: 0, domain: [ih], lookup: [{ inputHash: ih, output: { text: "MEMOIZED" } }] },
    summary: "test",
    ...over,
  });
}

describe("retro/promotion — bumpVersion & packContentHash", () => {
  it("bumps a semver patch, else appends", () => {
    expect(bumpVersion("1.0.0")).toBe("1.0.1");
    expect(bumpVersion("0.2.9")).toBe("0.2.10");
    expect(bumpVersion("weird")).toBe("weird+promoted");
  });

  it("hashes the pack deterministically (ignoring the old contentHash) and changes on edits", () => {
    const p = basePack();
    expect(packContentHash(p)).toBe(packContentHash({ ...p, contentHash: "sha256:different" }));
    expect(packContentHash(p)).toMatch(/^sha256:/);
    const edited = { ...p, metadata: { ...p.metadata, version: "9.9.9" } };
    expect(packContentHash(edited)).not.toBe(packContentHash(p));
  });
});

describe("retro/promotion — applyCandidate (graph rewrite)", () => {
  it("inserts a memo step + fallback edges and bumps the version, leaving the original intact", () => {
    const base = basePack();
    const v2 = applyCandidate(base, candidate());
    expect(v2.metadata.version).toBe("1.0.1");
    expect(v2.contentHash).toMatch(/^sha256:/);
    expect(v2.contentHash).not.toBe(base.contentHash);
    // original untouched:
    expect(base.metadata.version).toBe("1.0.0");
    expect(base.feature.graph?.steps.some((s) => s.id === "draft__memo")).toBe(false);

    const steps = v2.feature.graph?.steps ?? [];
    const memo = steps.find((s) => s.id === "draft__memo");
    expect(memo?.type).toBe("memo-lookup");
    // pre now points at the memo, not the llm:
    const edges = v2.feature.graph?.edges ?? [];
    expect(edges.some((e) => e.from === "pre" && e.to === "draft__memo")).toBe(true);
    expect(edges.some((e) => e.from === "pre" && e.to === "draft")).toBe(false);
    // miss edge memo → llm:
    expect(edges.some((e) => e.from === "draft__memo" && e.to === "draft" && e.when === "!state.__memo_draft")).toBe(true);
  });

  it("rejects non-node-replacement candidates", () => {
    expect(() => applyCandidate(basePack(), candidate({ kind: "alert", proposal: {} }))).toThrow(/node-replacement/);
  });

  it("rejects a target step with conditional outgoing edges (v0.1 limit)", () => {
    const base = basePack([{ from: "draft", to: "pre", when: "state.x == true" }]);
    expect(() => applyCandidate(base, candidate())).toThrow(/bedingte ausgehende Edges/);
  });

  it("creates a HIT edge to the target's successor for a non-terminal target (skips the LLM, keeps going)", () => {
    // 3-step graph pre -> draft -> post; draft (the LLM) is non-terminal.
    const base: FeaturePack = {
      ...basePack(),
      feature: {
        ...basePack().feature,
        graph: {
          steps: [
            { id: "pre", type: "transform", with: { set: 1, as: "a" }, outputs: { a: "state.a" } },
            { id: "draft", type: "llm", with: { prompt: "{{state.a}}" }, outputs: { text: "state.draft" } },
            { id: "post", type: "transform", with: { set: 2, as: "b" }, outputs: { b: "state.b" } },
          ],
          edges: [{ from: "pre", to: "draft" }, { from: "draft", to: "post" }],
        },
      },
    };
    const edges = applyCandidate(base, candidate()).feature.graph?.edges ?? [];
    expect(edges.some((e) => e.from === "draft__memo" && e.to === "post" && e.when === "state.__memo_draft")).toBe(true);
    expect(edges.some((e) => e.from === "draft__memo" && e.to === "draft" && e.when === "!state.__memo_draft")).toBe(true);
    expect(edges.some((e) => e.from === "draft" && e.to === "post" && e.when === undefined)).toBe(true); // miss path kept
  });

  it("refuses to promote an already-promoted step (no compounding rewrite)", () => {
    const v2 = applyCandidate(basePack(), candidate());
    expect(() => applyCandidate(v2, candidate())).toThrow(/bereits promotet/);
  });
});

describe("retro/promotion — applyDemotion (inverse)", () => {
  it("removes the memo step and restores the direct edge to the LLM step", () => {
    const v2 = applyCandidate(basePack(), candidate());
    const v3 = applyDemotion(v2, "draft");
    const steps = v3.feature.graph?.steps ?? [];
    expect(steps.some((s) => s.id === "draft__memo")).toBe(false);
    expect(steps.some((s) => s.id === "draft")).toBe(true);
    const edges = v3.feature.graph?.edges ?? [];
    expect(edges.some((e) => e.from === "pre" && e.to === "draft")).toBe(true); // restored
    expect(edges.some((e) => e.from === "draft__memo" || e.to === "draft__memo")).toBe(false);
    expect(v3.metadata.version).toBe("1.0.2"); // bumped on promote then demote
  });

  it("throws when the step is not promoted", () => {
    expect(() => applyDemotion(basePack(), "draft")).toThrow(/nicht promotet/);
  });

  it("demotes a NON-terminal target: drops both memo edges, restores pre→draft, keeps draft→post", () => {
    const base: FeaturePack = {
      ...basePack(),
      feature: {
        ...basePack().feature,
        graph: {
          steps: [
            { id: "pre", type: "transform", with: { set: 1, as: "a" }, outputs: { a: "state.a" } },
            { id: "draft", type: "llm", with: { prompt: "{{state.a}}" }, outputs: { text: "state.draft" } },
            { id: "post", type: "transform", with: { set: 2, as: "b" }, outputs: { b: "state.b" } },
          ],
          edges: [{ from: "pre", to: "draft" }, { from: "draft", to: "post" }],
        },
      },
    };
    const v3 = applyDemotion(applyCandidate(base, candidate()), "draft");
    const edges = v3.feature.graph?.edges ?? [];
    expect(v3.feature.graph?.steps.some((s) => s.id === "draft__memo")).toBe(false);
    expect(edges.some((e) => e.from === "draft__memo" || e.to === "draft__memo")).toBe(false);
    expect(edges.some((e) => e.from === "pre" && e.to === "draft")).toBe(true); // restored
    expect(edges.some((e) => e.from === "draft" && e.to === "post")).toBe(true); // original kept
  });
});

describe("retro/promotion — shadowEval", () => {
  function frame(input: unknown, output: unknown, step = "draft", nodeType = "llm"): TapeFrame {
    const result: NodeResult = { status: "resolved", output, confidence: 1, cost: {} };
    return {
      correlation: { run: "r", branch: "b", step, checkpoint: "cp" },
      feature: "demo.svc", // matches candidate().callSite.feature (6b feature-scoped shadow-eval)
      nodeType,
      input,
      result,
      injected: [],
      ts: "2026-01-01T00:00:00.000Z",
    };
  }

  it("passes when memoized output matches actual output on covered held-out frames", () => {
    // frame is in run "r"; the candidate's mining runs are ["r1"], so this frame is genuinely held-out.
    const v = shadowEval(candidate(), [frame({ prompt: "x" }, { text: "MEMOIZED" })]);
    expect(v.passed).toBe(true);
    expect(v.covered).toBe(1);
    expect(v.agreed).toBe(1);
    expect(v.score).toBe(1);
    expect(v.heldOut).toBe(true);
  });

  it("excludes mining runs (held-in) — a frame from candidate.evidence.runs does not count", () => {
    const inMiningRun: TapeFrame = {
      ...frame({ prompt: "x" }, { text: "MEMOIZED" }),
      correlation: { run: "r1", branch: "b", step: "draft", checkpoint: "cp" }, // r1 ∈ evidence.runs
    };
    const v = shadowEval(candidate(), [inMiningRun]);
    expect(v.covered).toBe(0); // held-in → excluded → no independent validation
    expect(v.passed).toBe(false);
    expect(v.heldOut).toBe(false);
  });

  it("fails when the actual output disagrees with the memo", () => {
    const v = shadowEval(candidate(), [frame({ prompt: "x" }, { text: "DIFFERENT" })]);
    expect(v.passed).toBe(false);
    expect(v.covered).toBe(1);
    expect(v.agreed).toBe(0);
  });

  it("does not pass when no covered (in-domain) frames exist", () => {
    const v = shadowEval(candidate(), [frame({ prompt: "out-of-domain" }, { text: "?" })]);
    expect(v.covered).toBe(0);
    expect(v.passed).toBe(false);
  });

  it("ignores frames from other call-sites", () => {
    const v = shadowEval(candidate(), [frame({ prompt: "x" }, { text: "MEMOIZED" }, "other", "llm")]);
    expect(v.covered).toBe(0);
  });
});

// ───────────────────────────── Tier-2: generierte Skripte (script-eval) ─────────────────────────────

const SCRIPT_SRC = "function (input) { return { text: input.a }; }";
function scriptCandidate(over: Partial<CandidateSpec> = {}) {
  return makeCandidate({
    source: "synthesize-script",
    kind: "node-replacement",
    callSite: { feature: "demo.svc", step: "draft", nodeType: "llm" },
    support: 25,
    evidence: { runs: ["r1"] },
    proposal: { tier: 2, source: SCRIPT_SRC, domain: [ih] },
    summary: "tier-2 test",
    ...over,
  });
}

describe("retro/promotion — applyCandidate dispatch to Tier-2 (script-eval rewrite)", () => {
  it("inserts a script-eval step with base64 source + fallback edges (HIT skips LLM, MISS falls back)", () => {
    const v2 = applyCandidate(basePack(), scriptCandidate());
    const steps = v2.feature.graph?.steps ?? [];
    const script = steps.find((s) => s.id === "draft__script");
    expect(script?.type).toBe("script-eval");
    // source is base64-encoded (dodges template resolution) and decodes verbatim:
    const b64 = (script?.with as { sourceB64?: string }).sourceB64;
    expect(typeof b64).toBe("string");
    expect(Buffer.from(b64 as string, "base64").toString("utf8")).toBe(SCRIPT_SRC);

    const edges = v2.feature.graph?.edges ?? [];
    expect(edges.some((e) => e.from === "pre" && e.to === "draft__script")).toBe(true);
    expect(edges.some((e) => e.from === "draft__script" && e.to === "draft" && e.when === "!state.__script_draft")).toBe(true);
    expect(v2.metadata.version).toBe("1.0.1");
  });

  it("refuses a second rewrite across tiers (Tier-0 then Tier-2 on the same step)", () => {
    const memoV2 = applyCandidate(basePack(), candidate()); // Tier-0 first
    expect(() => applyCandidate(memoV2, scriptCandidate())).toThrow(/bereits promotet/);
    const scriptV2 = applyCandidate(basePack(), scriptCandidate()); // Tier-2 first
    expect(() => applyCandidate(scriptV2, candidate())).toThrow(/bereits promotet/);
  });

  it("rejects a node-replacement candidate whose proposal is neither lookup nor script", () => {
    expect(() => applyCandidate(basePack(), candidate({ proposal: { tier: 9 } }))).toThrow(/malformed proposal/);
  });

  it("applyDemotion removes a script-eval step too and restores the direct edge", () => {
    const v3 = applyDemotion(applyCandidate(basePack(), scriptCandidate()), "draft");
    const steps = v3.feature.graph?.steps ?? [];
    expect(steps.some((s) => s.id === "draft__script")).toBe(false);
    const edges = v3.feature.graph?.edges ?? [];
    expect(edges.some((e) => e.from === "pre" && e.to === "draft")).toBe(true);
    expect(edges.some((e) => e.from === "draft__script" || e.to === "draft__script")).toBe(false);
  });
});

describe("retro/promotion — isScriptProposal + shadowEvalScript", () => {
  it("isScriptProposal discriminates tier-2 from tier-0 proposals", () => {
    expect(isScriptProposal({ tier: 2, source: "x", domain: [] })).toBe(true);
    expect(isScriptProposal({ tier: 0, lookup: [] })).toBe(false);
    expect(isScriptProposal({ tier: 2 })).toBe(false); // no source
  });

  function frame(input: unknown, output: unknown, run = "r", step = "draft", nodeType = "llm"): TapeFrame {
    const result: NodeResult = { status: "resolved", output, confidence: 1, cost: {} };
    return {
      correlation: { run, branch: "b", step, checkpoint: "cp" },
      feature: "demo.svc",
      nodeType,
      input,
      result,
      injected: [],
      ts: "2026-01-01T00:00:00.000Z",
    };
  }

  // Fake-Runner, der die SCRIPT_SRC-Semantik nachbildet: {a} → {text:a}; sonst OOD (ok:false).
  const runScript = (_src: string, input: unknown): Promise<ScriptRunResult> => {
    const i = (input ?? {}) as { a?: unknown };
    if (i.a !== undefined) return Promise.resolve({ ok: true, output: { text: i.a } });
    return Promise.resolve({ ok: false, error: "ood" });
  };

  it("passes when the executed script agrees with the actual output on held-out frames", async () => {
    const v = await shadowEvalScript(scriptCandidate(), [frame({ a: "V" }, { text: "V" })], runScript);
    expect(v.passed).toBe(true);
    expect(v.covered).toBe(1);
    expect(v.agreed).toBe(1);
    expect(v.heldOut).toBe(true);
  });

  it("fails when the executed script disagrees with the actual output", async () => {
    const v = await shadowEvalScript(scriptCandidate(), [frame({ a: "V" }, { text: "DIFFERENT" })], runScript);
    expect(v.passed).toBe(false);
    expect(v.covered).toBe(1);
    expect(v.agreed).toBe(0);
  });

  it("does not count frames where the script defers (ok:false → OOD, not covered)", async () => {
    const v = await shadowEvalScript(scriptCandidate(), [frame({ b: "no-a" }, { text: "?" })], runScript);
    expect(v.covered).toBe(0);
    expect(v.passed).toBe(false);
  });

  it("excludes mining/synthesis runs (held-in does not count)", async () => {
    const v = await shadowEvalScript(scriptCandidate(), [frame({ a: "V" }, { text: "V" }, "r1")], runScript);
    expect(v.covered).toBe(0); // run r1 ∈ evidence.runs → excluded
    expect(v.heldOut).toBe(false);
  });
});
