import { describe, expect, it } from "vitest";
import { retroCompleteHandler, retroMinerHandler } from "@elio/core";
import type {
  Ctx,
  GateVerdict,
  NodeResult,
  PromotionCandidate,
  TapeFrame,
  TraceQuery,
  TracesService,
} from "@elio/core";

function resolved(output: unknown): NodeResult {
  return { status: "resolved", output, confidence: 1, cost: {} };
}
function failed(retryable: boolean, attempts: number): NodeResult {
  return { status: "failed", error: { message: "boom" }, retryable, attempts };
}
function frame(over: {
  step?: string;
  nodeType?: string;
  input?: unknown;
  result?: NodeResult;
}): TapeFrame {
  return {
    correlation: { run: "run_1", branch: "b", step: over.step ?? "s1", checkpoint: "cp" },
    nodeType: over.nodeType ?? "llm",
    input: over.input ?? {},
    result: over.result ?? resolved({}),
    injected: ["policy"],
    ts: "2026-01-01T00:00:00.000Z",
  };
}
function repeat(n: number, make: () => TapeFrame): TapeFrame[] {
  return Array.from({ length: n }, make);
}

/** Fake-ctx, das nur ctx.traces.collect bedient (das einzige, was der Handler nutzt). */
function ctxWithTraces(frames: TapeFrame[]): Ctx {
  const traces: TracesService = {
    collect: () => Promise.resolve(frames),
    tape: () => {
      throw new Error("tape() not used by retro-miner");
    },
  };
  return { traces } as unknown as Ctx;
}

function expectResolved(r: NodeResult): Record<string, unknown> {
  if (r.status !== "resolved") throw new Error(`expected resolved, got ${r.status}`);
  return r.output as Record<string, unknown>;
}

const detFrames = repeat(20, () =>
  frame({ step: "draft", nodeType: "llm", input: { q: "x" }, result: resolved("OUT") }),
);
const flakyFrames = repeat(3, () =>
  frame({ step: "fetch", nodeType: "http-call", result: failed(true, 2) }),
);

describe("nodes/retro — retro-miner handler", () => {
  it("runs the full suite by default and returns combined, counted candidates", async () => {
    const out = expectResolved(await retroMinerHandler({}, ctxWithTraces([...detFrames, ...flakyFrames])));
    const candidates = out["candidates"] as { kind: string }[];
    // ALL_MINERS umfasst jetzt die Discovery-Miner (variants + dfg): über den einen (run_1, b)-Branch liefert
    // mineVariants EINEN und mineDfg EINEN process-variant-Kandidaten — zusätzlich zu node-config/node-replacement.
    expect(candidates).toHaveLength(4);
    expect(out["candidateCount"]).toBe(4);
    expect(candidates.map((c) => c.kind).sort()).toEqual([
      "node-config",
      "node-replacement",
      "process-variant",
      "process-variant",
    ]);
  });

  it("honours the miners selection", async () => {
    const out = expectResolved(
      await retroMinerHandler({ miners: ["determinism"] }, ctxWithTraces([...detFrames, ...flakyFrames])),
    );
    const candidates = out["candidates"] as { kind: string }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe("node-replacement");
  });

  it("accumulates prior candidates and dedupes by id (idempotent re-mining)", async () => {
    const ctx = ctxWithTraces(detFrames);
    const first = expectResolved(await retroMinerHandler({ miners: ["determinism"] }, ctx));
    const prior = first["candidates"] as PromotionCandidate[];
    expect(prior).toHaveLength(1);
    const second = expectResolved(await retroMinerHandler({ miners: ["determinism"], prior }, ctx));
    expect(second["candidates"]).toHaveLength(1); // same finding → deduped, not doubled
  });

  it("forwards the runs filter to ctx.traces.collect", async () => {
    let captured: TraceQuery | undefined;
    const traces: TracesService = {
      collect: (q?: TraceQuery) => {
        captured = q;
        return Promise.resolve(detFrames);
      },
      tape: () => {
        throw new Error("unused");
      },
    };
    const ctx = { traces } as unknown as Ctx;
    await retroMinerHandler({ miners: ["determinism"], runs: ["run_a", "run_b"], minSupport: 3 }, ctx);
    expect(captured).toEqual({ runs: ["run_a", "run_b"] });
  });

  it("attributes candidates to the feature label via featureOf", async () => {
    const out = expectResolved(
      await retroMinerHandler(
        { miners: ["determinism"], feature: "my.feature", minSupport: 3 },
        ctxWithTraces(detFrames),
      ),
    );
    const candidates = out["candidates"] as { callSite?: { feature: string } }[];
    expect(candidates[0]?.callSite?.feature).toBe("my.feature");
  });

  it("excludes its own retro-infra frames from mining (no self-mining, review B)", async () => {
    // 3 failed retro-miner frames (as a fail-closed run would leave) + a real flaky http-call call-site.
    const infraFailures = repeat(3, () =>
      frame({ step: "mine", nodeType: "retro-miner", result: failed(true, 1) }),
    );
    const out = expectResolved(
      await retroMinerHandler({ miners: ["flaky-retry"] }, ctxWithTraces([...infraFailures, ...flakyFrames])),
    );
    const candidates = out["candidates"] as { callSite?: { nodeType: string } }[];
    expect(candidates).toHaveLength(1); // only the http-call call-site; retro-miner@mine is excluded
    expect(candidates[0]?.callSite?.nodeType).toBe("http-call");
  });

  it("throws when ctx.traces is absent (security by absence, Inv. 14)", async () => {
    await expect(retroMinerHandler({}, {} as unknown as Ctx)).rejects.toThrow(/ctx\.traces/);
  });
});

describe("nodes/retro — retro-complete gate", () => {
  it("passes once a candidate-set is present in the artifact", async () => {
    const ctx = { artifact: { content: { candidates: [] } } } as unknown as Ctx;
    const out = expectResolved(await retroCompleteHandler({}, ctx));
    expect((out as unknown as GateVerdict).passed).toBe(true);
  });

  it("does not pass before mining has produced a candidate-set", async () => {
    const ctx = { artifact: { content: {} } } as unknown as Ctx;
    const out = expectResolved(await retroCompleteHandler({}, ctx));
    expect((out as unknown as GateVerdict).passed).toBe(false);
  });
});
