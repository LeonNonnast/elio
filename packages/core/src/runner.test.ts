import { describe, expect, it } from "vitest";
import {
  mergeOutput,
  nextEdge,
  resolveInput,
  resolveTemplates,
  tryWithRetry,
} from "./runner";
import { OuterLoopRunner } from "./runner";
import { NodeRegistry } from "./registry";
import { InMemoryRunStore } from "./runstore";
import { registerBuiltins } from "./nodes";
import type { FeaturePack, GraphDefinition, StepRef } from "./feature";
import type { Ctx } from "./ctx";
import type { NodeDefinition } from "./node";
import type { RunEvent } from "./run";

const ctx = {} as Ctx;

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("resolveTemplates / resolveInput ({{state.x}})", () => {
  it("exact {{state.x}} returns the raw (type-preserving) value", () => {
    const state = { n: 5, arr: [1, 2], obj: { a: 1 } };
    expect(resolveTemplates("{{state.n}}", state)).toBe(5);
    expect(resolveTemplates("{{state.arr}}", state)).toEqual([1, 2]);
    expect(resolveTemplates("{{state.obj}}", state)).toEqual({ a: 1 });
  });

  it("nested path a.b.c", () => {
    expect(resolveTemplates("{{state.a.b.c}}", { a: { b: { c: "deep" } } })).toBe("deep");
  });

  it("inline interpolation in a longer string", () => {
    expect(resolveTemplates("hi {{state.name}}!", { name: "leon" })).toBe("hi leon!");
  });

  it("recurses through objects/arrays", () => {
    const out = resolveTemplates({ x: "{{state.n}}", y: ["{{state.n}}"] }, { n: 7 });
    expect(out).toEqual({ x: 7, y: [7] });
  });

  it("resolveInput resolves step.with", () => {
    const step: StepRef = { id: "s", type: "transform", with: { v: "{{state.x}}" } };
    expect(resolveInput(step, { x: "ok" })).toEqual({ v: "ok" });
  });
});

describe("mergeOutput", () => {
  it("with outputs map writes output[field] -> state.path (strips state. prefix)", () => {
    const state: Record<string, unknown> = {};
    const step: StepRef = { id: "s", type: "t", outputs: { rows: "state.sampleRows" } };
    mergeOutput(state, step, { rows: [1, 2, 3] });
    expect(state).toEqual({ sampleRows: [1, 2, 3] });
  });

  it("without outputs flat-merges a plain-object output", () => {
    const state: Record<string, unknown> = { keep: 1 };
    const step: StepRef = { id: "s", type: "t" };
    mergeOutput(state, step, { added: 2 });
    expect(state).toEqual({ keep: 1, added: 2 });
  });

  it("writes nested output paths", () => {
    const state: Record<string, unknown> = {};
    const step: StepRef = { id: "s", type: "t", outputs: { v: "state.a.b" } };
    mergeOutput(state, step, { v: 9 });
    expect(state).toEqual({ a: { b: 9 } });
  });
});

describe("nextEdge (static graph navigation)", () => {
  const graph: GraphDefinition = {
    steps: [
      { id: "a", type: "transform" },
      { id: "b", type: "transform" },
      { id: "c", type: "transform" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c", when: "state.go" },
      { from: "b", to: "a", when: "!state.go" },
    ],
  };

  it("first step = the step with no incoming edge", () => {
    const first = nextEdge(graph, undefined, {});
    expect(first === "DONE" ? "DONE" : first.id).toBe("a");
  });

  it("follows a plain edge", () => {
    const n = nextEdge(graph, "a", {});
    expect(n === "DONE" ? "DONE" : n.id).toBe("b");
  });

  it("honors a truthy `when`", () => {
    const n = nextEdge(graph, "b", { go: true });
    expect(n === "DONE" ? "DONE" : n.id).toBe("c");
  });

  it("honors a negated `when` (picks the back-edge to a)", () => {
    const n = nextEdge(graph, "b", { go: false });
    expect(n === "DONE" ? "DONE" : n.id).toBe("a");
  });

  it("no matching outgoing edge -> DONE", () => {
    expect(nextEdge(graph, "c", {})).toBe("DONE");
  });

  it("equality comparison in `when`", () => {
    const g: GraphDefinition = {
      steps: [{ id: "a", type: "t" }, { id: "b", type: "t" }],
      edges: [{ from: "a", to: "b", when: "state.mode == 'commit'" }],
    };
    expect(nextEdge(g, "a", { mode: "commit" })).not.toBe("DONE");
    expect(nextEdge(g, "a", { mode: "dry" })).toBe("DONE");
  });

  it("falls back to steps[0] when every step has an incoming edge (cycle)", () => {
    const g: GraphDefinition = {
      steps: [{ id: "a", type: "t" }],
      edges: [{ from: "a", to: "a" }],
    };
    const first = nextEdge(g, undefined, {});
    expect(first === "DONE" ? "DONE" : first.id).toBe("a");
  });
});

describe("tryWithRetry (§11/#7)", () => {
  function node(over: Partial<NodeDefinition>): NodeDefinition {
    return {
      type: "t",
      klass: "orchestration",
      handler: () => Promise.resolve({ status: "resolved", output: {}, confidence: 1, cost: {} }),
      ...over,
    };
  }

  it("default policy = single attempt; a throw becomes Failed (no retry)", async () => {
    let calls = 0;
    const n = node({
      handler: () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const res = await tryWithRetry(n, {}, ctx);
    expect(res.status).toBe("failed");
    expect(calls).toBe(1);
    if (res.status === "failed") expect(res.attempts).toBe(1);
  });

  it("retries on throw up to maxAttempts and recovers", async () => {
    let calls = 0;
    const n = node({
      retry: { maxAttempts: 3, backoff: "none", onExhausted: "fail" },
      handler: () => {
        calls += 1;
        if (calls < 2) throw new Error("transient");
        return Promise.resolve({ status: "resolved", output: { ok: true }, confidence: 1, cost: {} });
      },
    });
    const res = await tryWithRetry(n, {}, ctx);
    expect(res.status).toBe("resolved");
    expect(calls).toBe(2);
  });

  it("exhausts retries and returns Failed with attempts = maxAttempts", async () => {
    let calls = 0;
    const n = node({
      retry: { maxAttempts: 2, backoff: "none", onExhausted: "fail" },
      handler: () => {
        calls += 1;
        throw new Error("always");
      },
    });
    const res = await tryWithRetry(n, {}, ctx);
    expect(res.status).toBe("failed");
    expect(calls).toBe(2);
    if (res.status === "failed") expect(res.attempts).toBe(2);
  });

  it("a returned Failed{retryable:false} is NOT retried", async () => {
    let calls = 0;
    const n = node({
      retry: { maxAttempts: 5, onExhausted: "fail" },
      handler: () => {
        calls += 1;
        return Promise.resolve({
          status: "failed" as const,
          error: { message: "permanent" },
          retryable: false,
          attempts: 0,
        });
      },
    });
    const res = await tryWithRetry(n, {}, ctx);
    expect(res.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("a Suspended short-circuits the loop", async () => {
    let calls = 0;
    const n = node({
      retry: { maxAttempts: 5, onExhausted: "fail" },
      handler: () => {
        calls += 1;
        return Promise.resolve({
          status: "suspended" as const,
          elicitation: { what: "x", whoCanAnswer: {}, mode: "blocking" as const },
        });
      },
    });
    const res = await tryWithRetry(n, {}, ctx);
    expect(res.status).toBe("suspended");
    expect(calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Core-level end-to-end: a real 2-node graph driven through OuterLoopRunner to DONE.
// Locks down drive()'s sequencing (lastStepId advance, mergeOutput->resolveInput
// chaining, nextEdge==DONE -> runGate -> complete) — which the pure nextEdge() unit
// tests above do NOT exercise (they never build a ctx, thread state, or hit drive()).
// ─────────────────────────────────────────────────────────────────────────────
describe("OuterLoopRunner — 2-node graph end-to-end to DONE (§4/§8)", () => {
  function runtime(): { runner: OuterLoopRunner; store: InMemoryRunStore; registry: NodeRegistry } {
    const registry = new NodeRegistry();
    registerBuiltins(registry); // transform + validate
    // gate passes once BOTH a and b have run (artifact.content has x AND y)
    registry.register({
      type: "both-present",
      klass: "orchestration",
      handler: (input) => {
        const c = (input as { artifact?: { content?: Record<string, unknown> } })?.artifact?.content;
        const passed = typeof c?.["x"] === "string" && typeof c?.["y"] === "string";
        return Promise.resolve({
          status: "resolved" as const,
          output: { passed, failures: passed ? [] : ["missing"] },
          confidence: 1,
          cost: { usd: 0 },
        });
      },
    });
    const store = new InMemoryRunStore();
    const runner = new OuterLoopRunner({ registry, store });
    return { runner, store, registry };
  }

  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "core.two-node", version: "1", owner: "t" },
    contentHash: "core.two-node@1",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "both-present" },
      io: { input: {}, output: {} },
      graph: {
        state: { x: "", y: "" },
        steps: [
          { id: "a", type: "transform", with: { set: "AA", as: "x" }, outputs: { x: "state.x" } },
          {
            id: "b",
            type: "transform",
            with: { append: "BB", to: "{{state.x}}", as: "y" },
            outputs: { y: "state.y" },
          },
        ],
        edges: [{ from: "a", to: "b" }],
      },
    },
  };

  it("runs A->B, threads state, and terminates (exactly two resolved steps)", async () => {
    const { runner } = runtime();
    const events = await collect(runner.run(pack, { payload: {}, budget: 100, maxDepth: 10 }));

    const resolved = events.filter((e) => e.type === "node-resolved");
    expect(resolved.length).toBe(2); // DONE termination, not an infinite loop

    const end = events[events.length - 1];
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("passed");

    const runId =
      events.find((e) => e.type === "run-started")?.correlation.run ?? "";
    const artifact = runner.getArtifact(runId);
    const content = artifact!.content as Record<string, unknown>;
    expect(content["x"]).toBe("AA");
    expect(content["y"]).toBe("AABB"); // b derived its input from a's merged output
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maxCostUsd — hard USD spend cap (§v0.2). Like budget/depth, it is checked at the
// top of the outer loop, so it bounds how many further $-charging iterations run.
// Unlike budget exhaustion (Inv. 21, which escalates as an elicitation "grant more?"),
// an exceeded cost cap STOPS the run hard — no grant dialog.
// ─────────────────────────────────────────────────────────────────────────────
describe("OuterLoopRunner — maxCostUsd hard cap (§v0.2)", () => {
  // A self-looping node that charges $6/step, behind a gate that never passes — so the
  // outer loop keeps iterating until a bound (cost cap here) stops it.
  function runtime(): { runner: OuterLoopRunner } {
    const registry = new NodeRegistry();
    registry.register({
      type: "spend",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved" as const,
          output: { tick: 1 },
          confidence: 1,
          cost: { usd: 6 }, // each iteration costs $6
        }),
    });
    registry.register({
      type: "never", // gate that never passes -> forces another outer-loop iteration
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved" as const,
          output: { passed: false, failures: ["never"] },
          confidence: 1,
          cost: { usd: 0 },
        }),
    });
    return { runner: new OuterLoopRunner({ registry, store: new InMemoryRunStore() }) };
  }

  const pack: FeaturePack = {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "core.spend", version: "1", owner: "t" },
    contentHash: "core.spend@1",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "never" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [{ id: "a", type: "spend" }],
        edges: [{ from: "a", to: "a" }], // self-loop
      },
    },
  };

  function spendSteps(events: RunEvent[]): number {
    return events.filter((e) => e.type === "step-started" && e.nodeType === "spend").length;
  }

  it("stops hard (gate:stopped) once charged USD reaches the cap — no grant elicitation", async () => {
    const { runner } = runtime();
    // cap $5: iter1 spends $6, iter2's top-of-loop check trips (6 >= 5) -> exactly ONE spend step.
    const events = await collect(runner.run(pack, { payload: {}, budget: 1e9, maxDepth: 100, maxCostUsd: 5 }));

    const end = events[events.length - 1];
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("stopped");
    expect(spendSteps(events)).toBe(1);
    // A cost cap must NOT surface a "grant more budget" elicitation (that is budget/depth only).
    expect(events.find((e) => e.type === "node-suspended")).toBeUndefined();
  });

  it("a higher cap allows proportionally more $-charging iterations", async () => {
    const { runner } = runtime();
    // cap $13: runs while spent-before-iteration < 13 -> $0,$6,$12 -> three spend steps, then stops.
    const events = await collect(runner.run(pack, { payload: {}, budget: 1e9, maxDepth: 100, maxCostUsd: 13 }));
    const end = events[events.length - 1];
    if (end?.type === "run-completed") expect(end.gate).toBe("stopped");
    expect(spendSteps(events)).toBe(3);
  });
});
