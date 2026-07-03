// pm.discover end-to-end (Doc §3.3, Slice 3a): seedet eine InMemoryCaptureStore mit ein paar Sessions, baut
// die Runtime über setupProcessMining({ captureStore }) (TableTapeSource hinter ctx.traces, traces:read-Grant)
// und fährt pmDiscoverPack. Drei Belege: (1) Discovery emittiert process-variant/dfg-Kandidaten ins Artefakt;
// (2) fail-closed ohne traces:read-Grant (mine/route failen, Gate stopped — security by absence, Inv. 14);
// (3) Route: leerer Katalog ⇒ classification "unknown" ⇒ mine läuft.

import { describe, expect, it } from "vitest";
import { InMemoryCaptureStore, pmDiscoverPack, rootPolicy, TableTapeSource } from "@elio/core";
import type { CaptureStore, RunEvent } from "@elio/core";
import { collectEvents, createRuntime } from "./runtime";
import { registerProcessMining, setupProcessMining } from "./setup-process-mining";

/** Seedet ein paar Sessions identischer Aktivitätsfolge (→ eine Variante mit support N, ein DFG-Kandidat). */
async function seededCaptureStore(): Promise<InMemoryCaptureStore> {
  const store = new InMemoryCaptureStore();
  const activities = ["read", "transform", "write"];
  for (const session of ["s1", "s2", "s3"]) {
    let seq = 0;
    for (const activity of activities) {
      await store.append({
        session,
        seq,
        ts: `2026-01-01T00:00:0${String(seq)}.000Z`,
        source: "claude-code",
        activity,
      });
      seq += 1;
    }
  }
  return store;
}

async function drive(rt: ReturnType<typeof createRuntime>): Promise<RunEvent[]> {
  return collectEvents(rt.run(pmDiscoverPack, { payload: {}, budget: 100, maxDepth: 10 }));
}

function runIdOf(events: RunEvent[]): string {
  return events.find((e) => e.type === "run-started")?.correlation.run ?? "";
}

describe("pm.discover — end-to-end over a seeded CaptureStore", () => {
  it("routes then mines, landing process-variant/dfg candidates in the artifact", async () => {
    const captureStore = await seededCaptureStore();
    const { runtime } = setupProcessMining({ captureStore });

    const events = await drive(runtime);

    const last = events[events.length - 1];
    expect(last?.type).toBe("run-completed");
    if (last?.type === "run-completed") expect(last.gate).toBe("passed");

    const content = runtime.runner.getArtifact(runIdOf(events))?.content as Record<string, unknown>;
    const candidates = content["candidates"] as {
      kind: string;
      proposal: { kind: string };
    }[];
    expect(Array.isArray(candidates)).toBe(true);
    // Alle drei Sessions teilen dieselbe Variante ⇒ EIN variant-Kandidat (support 3) + EIN dfg-Kandidat.
    const proposalKinds = candidates.map((c) => c.proposal.kind).sort();
    expect(proposalKinds).toEqual(["dfg", "variant"]);
    expect(candidates.every((c) => c.kind === "process-variant")).toBe(true);
    expect(content["candidateCount"]).toBe(2);
  });

  it("fails closed (gate stopped, no node-resolved) when the root policy denies traces:read", async () => {
    const captureStore = await seededCaptureStore();
    // Eigene Runtime mit der TapeSource verdrahtet, aber default rootPolicy() (KEIN traces:read) → ctx.traces
    // wird nicht injiziert → die route-Node wirft → dead-letter, mine läuft nie.
    const runtime = createRuntime({
      tracesSource: new TableTapeSource(captureStore),
      rootPolicy: rootPolicy(),
    });
    registerProcessMining(runtime);

    const events = await drive(runtime);
    const last = events[events.length - 1];
    expect(last?.type).toBe("run-completed");
    if (last?.type === "run-completed") expect(last.gate).toBe("stopped"); // security by absence (Inv. 14)
    expect(events.some((e) => e.type === "node-resolved")).toBe(false);
  });

  it("route: empty catalog ⇒ every session unknown ⇒ the mine edge fires", async () => {
    const captureStore = await seededCaptureStore();
    const { runtime } = setupProcessMining({ captureStore }); // default: empty catalog

    const events = await drive(runtime);

    // route runs, then the "state.classification == 'unknown'" edge fires the mine step (both executed).
    const startedTypes = events
      .filter((e): e is Extract<RunEvent, { type: "step-started" }> => e.type === "step-started")
      .map((e) => e.nodeType);
    expect(startedTypes).toContain("process-route");
    expect(startedTypes).toContain("retro-miner");

    const content = runtime.runner.getArtifact(runIdOf(events))?.content as Record<string, unknown>;
    const sessions = content["sessionClassifications"] as { run: string; classification: string }[];
    expect(sessions.map((s) => s.run).sort()).toEqual(["s1", "s2", "s3"]);
    expect(sessions.every((s) => s.classification === "unknown")).toBe(true);
  });
});

// type-only assertion that the CaptureStore contract is satisfied (compile-time only).
const _typecheck: (s: CaptureStore) => void = () => undefined;
void _typecheck;
