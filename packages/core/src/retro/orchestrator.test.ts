import { describe, expect, it } from "vitest";
import {
  InMemoryRunStore,
  NodeRegistry,
  OuterLoopRunner,
  PolicyInjector,
  registerBuiltins,
  retroOrchestratorPack,
  rootPolicy,
} from "@elio/core";
import type { NodeResult, RunEvent, TapeFrame } from "@elio/core";

function resolved(output: unknown): NodeResult {
  return { status: "resolved", output, confidence: 1, cost: {} };
}
function failed(retryable: boolean, attempts: number): NodeResult {
  return { status: "failed", error: { message: "boom" }, retryable, attempts };
}
function frame(run: string, step: string, nodeType: string, result: NodeResult, input: unknown = {}): TapeFrame {
  return {
    correlation: { run, branch: "b", step, checkpoint: "cp" },
    nodeType,
    input,
    result,
    injected: ["policy"],
    ts: "2026-01-01T00:00:00.000Z",
  };
}

/** Seedet einen Store mit historischen Frames: eine deterministische llm-Call-Site + flaky-Fehlschläge. */
async function seededStore(): Promise<InMemoryRunStore> {
  const store = new InMemoryRunStore();
  const hist = (await store.createRun({ payload: {}, budget: 1, maxDepth: 1 })).id;
  for (let i = 0; i < 25; i += 1) {
    await store.appendTape(hist, frame(hist, "draft", "llm", resolved("OUT"), { q: "x" }));
  }
  for (let i = 0; i < 4; i += 1) {
    await store.appendTape(hist, frame(hist, "fetch", "http-call", failed(true, 2)));
  }
  return store;
}

async function drive(runner: OuterLoopRunner): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of runner.run(retroOrchestratorPack, { payload: {}, budget: 100, maxDepth: 10 })) {
    events.push(ev);
  }
  return events;
}

describe("retro.orchestrator — end-to-end", () => {
  it("mines seeded tapes and writes candidates into the durable artifact", async () => {
    const store = await seededStore();
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({ store });
    const runner = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["traces:read"] }),
    });

    const events = await drive(runner);

    const last = events[events.length - 1];
    expect(last?.type).toBe("run-completed");
    if (last?.type === "run-completed") expect(last.gate).toBe("passed");

    const runId = events.find((e) => e.type === "run-started")?.correlation.run ?? "";
    const content = runner.getArtifact(runId)?.content as Record<string, unknown>;
    const candidates = content["candidates"] as { kind: string }[];
    expect(Array.isArray(candidates)).toBe(true);
    // ALL_MINERS umfasst jetzt auch die Discovery-Miner (variants + dfg): über den einen seeded Branch
    // (29 Frames) liefert mineVariants EINEN process-variant- und mineDfg EINEN weiteren process-variant-
    // Kandidaten — zusätzlich zum determinism-(node-config) und flaky-retry-(node-replacement)-Befund.
    expect(candidates.map((c) => c.kind).sort()).toEqual([
      "node-config",
      "node-replacement",
      "process-variant",
      "process-variant",
    ]);
    expect(content["candidateCount"]).toBe(4);
  });

  it("fails closed (no candidate-set) when the root policy does not grant traces:read", async () => {
    const store = await seededStore();
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({ store });
    // default rootPolicy() grants no toolPermissions → ctx.traces absent → mine node throws → dead-letter.
    const runner = new OuterLoopRunner({ registry, store, injector });

    const events = await drive(runner);
    const last = events[events.length - 1];
    expect(last?.type).toBe("run-completed");
    if (last?.type === "run-completed") expect(last.gate).toBe("stopped"); // security by absence (Inv. 14)
    // no node-resolved for the mine step (it failed):
    expect(events.some((e) => e.type === "node-resolved")).toBe(false);
  });

  it("does not mint candidates about its own miner after fail-closed runs (review B)", async () => {
    const store = await seededStore();
    const registry = new NodeRegistry();
    registerBuiltins(registry);
    const injector = new PolicyInjector({ store });
    // 3 fail-closed runs (no traces:read) leave Failed "retro-miner" + "dead-letter" frames at call-site
    // mine. Without the infra-exclusion filter, the next granted run would mint a flaky-retry candidate
    // ABOUT retro-miner@mine (3 retryable failures ≥ minFailures).
    const denied = new OuterLoopRunner({ registry, store, injector });
    for (let i = 0; i < 3; i += 1) await drive(denied);

    const granted = new OuterLoopRunner({
      registry,
      store,
      injector,
      rootPolicy: rootPolicy({ toolPermissions: ["traces:read"] }),
    });
    const events = await drive(granted);
    const runId = events.find((e) => e.type === "run-started")?.correlation.run ?? "";
    const candidates = (artifactContent(granted, runId))["candidates"] as {
      callSite?: { nodeType: string };
    }[];
    // Nur die call-site-gebundenen Befunde betrachten (determinism/flaky-retry/…): die Discovery-Miner
    // (variants/dfg, jetzt Teil von ALL_MINERS) erzeugen process-variant-Kandidaten OHNE callSite — die sind
    // hier irrelevant. Der Review-B-Schutz gilt den call-site-Minern.
    const nodeTypes = candidates
      .map((c) => c.callSite?.nodeType)
      .filter((t): t is string => t !== undefined)
      .sort();
    expect(nodeTypes).toEqual(["http-call", "llm"]); // only the real seeded call-sites
    expect(nodeTypes).not.toContain("retro-miner");
    expect(nodeTypes).not.toContain("dead-letter");
  });
});

function artifactContent(runner: OuterLoopRunner, runId: string): Record<string, unknown> {
  return runner.getArtifact(runId)?.content as Record<string, unknown>;
}
