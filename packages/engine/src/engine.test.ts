import type { CorrelationId, RunEvent } from "@elio/core";
import { collectEvents } from "@elio/sdk";
import { describe, expect, it } from "vitest";
import { LocalEngine } from "./engine";

const RUN_INPUT = { payload: {}, budget: 1000, maxDepth: 200 };

function lastCompleted(events: RunEvent[]): Extract<RunEvent, { type: "run-completed" }> | undefined {
  const e = events.at(-1);
  return e?.type === "run-completed" ? e : undefined;
}

describe("LocalEngine (Phase 2 — EIN Service, geteilter Store, zentrale Governance)", () => {
  it("listet alle Features mit Capabilities + (built-in: ohne) sourcePath", async () => {
    const engine = new LocalEngine();
    const features = await engine.listFeatures();
    const ids = features.map((f) => f.id);
    expect(ids).toContain("migrate.csv-to-db");
    expect(ids).toContain("demo.draft-until-good");
    const migrate = features.find((f) => f.id === "migrate.csv-to-db")!;
    expect(migrate.capabilities.db).toBe(true);
    expect(migrate.artifact.kind).toBeDefined();
  });

  it("startRun treibt einen Demo-Loop bis run-completed{passed}", async () => {
    const engine = new LocalEngine();
    const events = await collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));
    expect(lastCompleted(events)?.gate).toBe("passed");
  });

  it("ALLE Features schreiben in den GETEILTEN Store — Cross-Feature-Sicht via liveStatus", async () => {
    const engine = new LocalEngine();
    await collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));
    await collectEvents(engine.startRun("demo.retry-then-pass", RUN_INPUT));
    const status = await engine.liveStatus();
    const features = new Set(status.map((s) => s.feature));
    expect(features.has("demo.draft-until-good")).toBe(true);
    expect(features.has("demo.retry-then-pass")).toBe(true);
  });

  it("Suspend→Resume über EINEN Service: startRun bis Approval, resumeRun bis completed", async () => {
    const engine = new LocalEngine();
    const ev1 = await collectEvents(engine.startRun("migrate.csv-to-db", RUN_INPUT));
    const suspended = ev1.find((e) => e.type === "node-suspended");
    expect(suspended?.type).toBe("node-suspended");
    const correlation = (suspended as Extract<RunEvent, { type: "node-suspended" }>)
      .correlation as CorrelationId;

    // Resume nutzt den Active-Run-Cache (dieselbe verdrahtete Runtime → DB-/Adapter-Zustand erhalten).
    const ev2 = await collectEvents(engine.resumeRun(correlation, { approved: true }));
    expect(lastCompleted(ev2)?.gate).toBe("passed");
  });

  it("tape(runId) liefert die Frames eines Runs aus dem geteilten Store", async () => {
    const engine = new LocalEngine();
    const ev = await collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));
    const started = ev.find((e) => e.type === "run-started");
    const runId = (started as Extract<RunEvent, { type: "run-started" }>).correlation.run;
    const frames = await collectEvents(engine.tape(runId) as AsyncIterable<RunEvent>);
    expect(frames.length).toBeGreaterThan(0);
  });
});
