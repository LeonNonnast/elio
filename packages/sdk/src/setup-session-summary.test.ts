// pm.session-summary end-to-end (Doc §3.2/§5, Slice 3b): seedet eine CaptureStore mit den Events einer Session,
// treibt den Summarizer-Pack über setupSessionSummary (TableTapeSource hinter ctx.traces, MockModel offline)
// und belegt:
//   (1) ein Run produziert EINE wohlgeformte SessionSummary mit deterministischen stats (variant/fingerprint/
//       toolHistogram/cost/durationMs/steps), persistiert in der SummaryStore (idempotent über session);
//   (2) das intent-Label kommt vom (deterministischen MockModel-)LLM-label-Step (offline);
//   (3) fail-closed: ohne summaries:write-Grant wirft persist → gate stopped, keine Summary.

import { describe, expect, it } from "vitest";
import {
  InMemoryCaptureStore,
  InMemorySummaryStore,
  pmSessionSummaryPack,
  registerSessionSummary,
  rootPolicy,
  SUMMARIES_WRITE_PERMISSION,
  TableTapeSource,
  TRACES_READ_PERMISSION,
} from "@elio/core";
import type { RunEvent } from "@elio/core";
import { MockModel } from "./models/mock";
import { collectEvents, createRuntime } from "./runtime";
import { setupSessionSummary } from "./setup-pm-capture";

/** Seedet eine Session aus drei Events (read → transform → write) mit Kosten + Zeitfenster. */
async function seededCaptureStore(): Promise<InMemoryCaptureStore> {
  const store = new InMemoryCaptureStore();
  const steps: { activity: string; ts: string }[] = [
    { activity: "Read", ts: "2026-01-01T00:00:00.000Z" },
    { activity: "Edit", ts: "2026-01-01T00:00:01.000Z" },
    { activity: "Bash", ts: "2026-01-01T00:00:03.000Z" },
  ];
  let seq = 0;
  for (const s of steps) {
    await store.append({
      session: "sess-1",
      seq,
      ts: s.ts,
      source: "claude-code",
      activity: s.activity,
      cost: { usd: 0.01, tokensIn: 10, tokensOut: 5 },
    });
    seq += 1;
  }
  return store;
}

async function drive(rt: ReturnType<typeof createRuntime>, payload: unknown): Promise<RunEvent[]> {
  return collectEvents(rt.run(pmSessionSummaryPack, { payload, budget: 100, maxDepth: 10 }));
}

function gateOf(events: RunEvent[]): "passed" | "stopped" | undefined {
  const last = events[events.length - 1];
  return last?.type === "run-completed" ? last.gate : undefined;
}

describe("pm.session-summary — the summarizer produces a SessionSummary", () => {
  it("produces a well-formed SessionSummary with deterministic stats (offline MockModel)", async () => {
    const captureStore = await seededCaptureStore();
    const { runtime, summaryStore } = setupSessionSummary({ captureStore });

    const events = await drive(runtime, "sess-1");
    expect(gateOf(events)).toBe("passed");

    const summaries = await summaryStore.all();
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s?.session).toBe("sess-1");
    // Deterministische stats-Step-Ausgaben (Doc §5).
    expect(s?.variant).toEqual(["Read", "Edit", "Bash"]);
    expect(s?.stats.steps).toBe(3);
    expect(s?.stats.toolHistogram).toEqual({ Read: 1, Edit: 1, Bash: 1 });
    expect(s?.stats.cost).toEqual({ usd: 0.03, tokens: 45 });
    expect(s?.stats.durationMs).toBe(3000); // 00:00:03 − 00:00:00
    expect(typeof s?.fingerprint).toBe("string");
    expect((s?.fingerprint ?? "").length).toBeGreaterThan(0);
    // Das intent[] kommt vom (deterministischen) LLM-label-Step (MockModel echo).
    expect(Array.isArray(s?.intent)).toBe(true);
    expect((s?.intent ?? []).length).toBe(1);
    expect(s?.intent[0]).toContain("Read → Edit → Bash"); // der Prompt trägt die Aktivitätsfolge
  });

  it("is idempotent over session: re-running keeps exactly one summary row", async () => {
    const captureStore = await seededCaptureStore();
    const { runtime, summaryStore } = setupSessionSummary({ captureStore });

    await drive(runtime, "sess-1");
    await drive(runtime, "sess-1");

    expect(await summaryStore.all()).toHaveLength(1); // Upsert über session (Doc §3.2 persist).
  });

  it("passes the prompt to the model (capturing MockModel sees the activity sequence)", async () => {
    const captureStore = await seededCaptureStore();
    let seenPrompt = "";
    const model = new MockModel({
      transform: (lastUser) => {
        seenPrompt = lastUser;
        return "intent: edit-a-file";
      },
    });
    const { runtime } = setupSessionSummary({ captureStore, model });

    await drive(runtime, "sess-1");
    expect(seenPrompt).toContain("Read → Edit → Bash");
  });

  it("does not mint a phantom 'passed' summary for an unknown/empty (ghost) session", async () => {
    // A never-captured session id has zero frames. The summarizer must NOT fabricate a 'passed' SessionSummary
    // with an empty variant — that phantom row would mislead downstream clustering/router. The steps>0 gate
    // rejects it (gate stopped) and persist skips the upsert (no row).
    const captureStore = await seededCaptureStore();
    const { runtime, summaryStore } = setupSessionSummary({ captureStore });

    const events = await drive(runtime, "ghost-session"); // never captured
    expect(gateOf(events)).toBe("stopped");
    expect(await summaryStore.get("ghost-session")).toBeNull();
    expect(await summaryStore.all()).toHaveLength(0);
  });

  it("routes the label step via the worker's defaultModel (not a step-pinned 'mock') so real providers work", async () => {
    // The pack must NOT pin provider:'mock' on the label step — that would make a real ProviderMap (no 'mock'
    // key) throw `no provider registered for "mock"`. Here a single non-'mock' provider key is the defaultModel;
    // the run must still reach the model and pass (proving the label step inherits the worker default).
    const captureStore = await seededCaptureStore();
    const summaryStore = new InMemorySummaryStore();
    const runtime = createRuntime({
      models: { "claude": new MockModel({ transform: () => "intent: edit" }) },
      defaultModel: "claude:claude-haiku-4-5",
      tracesSource: new TableTapeSource(captureStore),
      rootPolicy: rootPolicy({
        allowedModels: ["claude:*"],
        toolPermissions: [TRACES_READ_PERMISSION, SUMMARIES_WRITE_PERMISSION],
      }),
    });
    registerSessionSummary(runtime.registry, { summaryStore });

    const events = await drive(runtime, "sess-1");
    expect(gateOf(events)).toBe("passed"); // would be 'stopped' if the step pinned a missing 'mock' provider
    expect((await summaryStore.get("sess-1"))?.intent).toEqual(["intent: edit"]);
  });

  it("fails closed (gate stopped, no summary) when summaries:write is not granted", async () => {
    const captureStore = await seededCaptureStore();
    const summaryStore = new InMemorySummaryStore();
    // Eigene Runtime: traces:read + mock-Modell, aber KEIN summaries:write → persist wirft (fail-closed).
    const runtime = createRuntime({
      models: { mock: new MockModel() },
      defaultModel: "mock",
      tracesSource: new TableTapeSource(captureStore),
      rootPolicy: rootPolicy({ allowedModels: ["mock"], toolPermissions: [TRACES_READ_PERMISSION] }),
    });
    registerSessionSummary(runtime.registry, { summaryStore });

    const events = await drive(runtime, "sess-1");
    expect(gateOf(events)).toBe("stopped"); // security by absence (Inv. 14)
    expect(await summaryStore.all()).toHaveLength(0);
  });
});
