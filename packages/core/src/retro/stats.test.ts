import { describe, expect, it } from "vitest";
import {
  aggregateCost,
  determinismStats,
  failedFrames,
  resolvedFrames,
  uniqueRuns,
} from "@elio/core";
import type { NodeResult, TapeFrame } from "@elio/core";

function resolved(output: unknown): NodeResult {
  return { status: "resolved", output, confidence: 1, cost: {} };
}

function frame(over: { run?: string; input?: unknown; result?: NodeResult } = {}): TapeFrame {
  return {
    correlation: { run: over.run ?? "run_1", branch: "b", step: "s1", checkpoint: "cp" },
    nodeType: "llm",
    input: over.input ?? {},
    result: over.result ?? resolved({}),
    injected: ["policy"],
    ts: "2026-01-01T00:00:00.000Z",
  };
}

describe("retro/stats — determinismStats", () => {
  it("computes support, distinct inputs, domain and determinism ratio", () => {
    const frames = [
      frame({ input: { q: "x" }, result: resolved("A") }),
      frame({ input: { q: "x" }, result: resolved("A") }), // x → A always (deterministic)
      frame({ input: { q: "y" }, result: resolved("B") }), // y → B (deterministic)
      frame({ input: { q: "z" }, result: resolved("C1") }),
      frame({ input: { q: "z" }, result: resolved("C2") }), // z → two outputs (nondeterministic)
    ];
    const stats = determinismStats(frames);
    expect(stats.support).toBe(5);
    expect(stats.distinctInputs).toBe(3);
    expect(stats.domain).toHaveLength(2); // x, y
    expect(stats.determinism).toBeCloseTo(2 / 3);
  });

  it("is stable under input key reordering (canonicalization)", () => {
    const frames = [
      frame({ input: { a: 1, b: 2 }, result: resolved("OUT") }),
      frame({ input: { b: 2, a: 1 }, result: resolved("OUT") }),
    ];
    const stats = determinismStats(frames);
    expect(stats.distinctInputs).toBe(1);
    expect(stats.determinism).toBe(1);
  });

  it("ignores non-resolved frames and returns 0 determinism when empty", () => {
    const failed: NodeResult = { status: "failed", error: { message: "x" }, retryable: true, attempts: 1 };
    const stats = determinismStats([frame({ result: failed })]);
    expect(stats.support).toBe(0);
    expect(stats.distinctInputs).toBe(0);
    expect(stats.determinism).toBe(0);
  });
});

describe("retro/stats — helpers", () => {
  it("aggregateCost sums set fields only; empty → {}", () => {
    expect(aggregateCost([])).toEqual({});
    expect(aggregateCost([{ usd: 1 }, { usd: 2, tokensIn: 10 }])).toEqual({ usd: 3, tokensIn: 10 });
    expect(aggregateCost([{ tokensOut: 5 }, { tokensOut: 5 }])).toEqual({ tokensOut: 10 });
    expect(aggregateCost([{ model: "a" }, { model: "b" }]).model).toBe("b");
    expect(aggregateCost([{ usd: 1 }]).tokensIn).toBeUndefined();
  });

  it("resolvedFrames / failedFrames partition by status", () => {
    const failed: NodeResult = { status: "failed", error: { message: "x" }, retryable: true, attempts: 1 };
    const frames = [frame(), frame({ result: failed })];
    expect(resolvedFrames(frames)).toHaveLength(1);
    expect(failedFrames(frames)).toHaveLength(1);
  });

  it("uniqueRuns dedupes by correlation.run", () => {
    expect(uniqueRuns([frame({ run: "a" }), frame({ run: "a" }), frame({ run: "b" })])).toEqual([
      "a",
      "b",
    ]);
  });
});
