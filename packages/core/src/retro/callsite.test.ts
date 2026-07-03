import { describe, expect, it } from "vitest";
import { callSiteKey, callSiteKeyString, groupByCallSite } from "@elio/core";
import type { NodeResult, TapeFrame } from "@elio/core";

const RESOLVED: NodeResult = { status: "resolved", output: {}, confidence: 1, cost: {} };

function frame(over: { run?: string; step?: string; nodeType?: string } = {}): TapeFrame {
  return {
    correlation: {
      run: over.run ?? "run_1",
      branch: "b",
      step: over.step ?? "s1",
      checkpoint: "cp",
    },
    nodeType: over.nodeType ?? "llm",
    input: {},
    result: RESOLVED,
    injected: ["policy"],
    ts: "2026-01-01T00:00:00.000Z",
  };
}

describe("retro/callsite", () => {
  it("callSiteKeyString uses a fixed order/separator", () => {
    expect(callSiteKeyString({ feature: "f", step: "a", nodeType: "llm" })).toBe("f::a::llm");
    expect(callSiteKeyString(callSiteKey(frame({ step: "a", nodeType: "llm" })))).toBe("::a::llm");
  });

  it("groups frames by (feature, step, nodeType) preserving frame order", () => {
    const frames = [
      frame({ step: "a", nodeType: "llm" }),
      frame({ step: "a", nodeType: "llm" }),
      frame({ step: "b", nodeType: "transform" }),
    ];
    const groups = groupByCallSite(frames);
    expect(groups.size).toBe(2);
    expect(groups.get("::a::llm")?.frames).toHaveLength(2);
    expect(groups.get("::b::transform")?.frames).toHaveLength(1);
  });

  it("featureOf splits the same step across features", () => {
    const frames = [frame({ run: "run_x", step: "a" }), frame({ run: "run_y", step: "a" })];
    const featureOf = (f: TapeFrame): string => (f.correlation.run === "run_x" ? "feat.X" : "feat.Y");
    const groups = groupByCallSite(frames, featureOf);
    expect(groups.size).toBe(2);
    expect(groups.has("feat.X::a::llm")).toBe(true);
    expect(groups.has("feat.Y::a::llm")).toBe(true);
  });
});
