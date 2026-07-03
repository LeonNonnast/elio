// ───────────────────────────── Tests: FileRunStore (Durability + cross-process resume) ─────────────────────────────
// Simuliert "neuer Prozess" durch eine FRISCHE FileRunStore-Instanz über demselben Verzeichnis: sie
// hydratisiert den persistierten Stand (runs/tape/checkpoints/status). So werden `elio runs`/`elio resume`
// prozessübergreifend nachgewiesen — ohne echten zweiten Prozess.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeaturePack, RunEvent } from "@elio/core";
import { FileRunStore } from "@elio/core";
import { createRuntime, collectEvents } from "./runtime";
import { alwaysPassGate, NOTE_TYPE } from "./demo/retry-then-pass";

/** Minimales Feature: ein blocking approval-Gate, danach ein immer bestehendes Eval-Gate. */
const approvePack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "t.approve", version: "0.0.0" },
  contentHash: "t.approve@0.0.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "note", evalGate: "always-pass" },
    io: { input: {}, output: {} },
    graph: {
      state: {},
      steps: [{ id: "approve", type: "approval", with: { reason: "Proceed?" }, suspend: "blocking" }],
      edges: [],
    },
  },
} as FeaturePack;

function freshRuntime(dir: string) {
  const runtime = createRuntime({ store: new FileRunStore(dir), artifactTypes: { note: NOTE_TYPE } });
  runtime.registry.register(alwaysPassGate as never);
  return runtime;
}

describe("FileRunStore", () => {
  it("persistiert Runs/Tape/Checkpoints; eine frische Instanz (neuer Prozess) hydratisiert sie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elio-store-"));
    const a = freshRuntime(dir);
    const events = await collectEvents(a.run(approvePack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const suspended = events.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> => e.type === "node-suspended",
    );
    expect(suspended).toBeDefined();
    const corr = suspended!.correlation;

    // "Neuer Prozess": frischer Store über demselben Verzeichnis.
    const reader = new FileRunStore(dir);
    expect(await reader.runIds()).toContain(corr.run);
    const status = await reader.liveStatus();
    expect(status.some((s) => s.correlation.run === corr.run && s.phase === "suspended" && s.waitingOn)).toBe(true);
    expect(reader.getTape(corr.run).length).toBeGreaterThan(0);
    expect(await reader.loadCheckpoint(corr)).not.toBeNull();
  });

  it("cross-process resume: eine frische Runtime resumt einen suspendierten Run bis gate=passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elio-store-"));
    const a = freshRuntime(dir);
    const events = await collectEvents(a.run(approvePack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const corr = events.find((e) => e.type === "node-suspended")!.correlation;

    // Frische Runtime + frischer Store (= neuer Prozess, leerer runContexts) -> Rekonstruktion via opts.pack.
    const b = freshRuntime(dir);
    const resumed = await collectEvents(b.resume(corr, { approved: true }, { pack: approvePack }));
    const completed = resumed.find(
      (e): e is Extract<RunEvent, { type: "run-completed" }> => e.type === "run-completed",
    );
    expect(completed).toBeDefined();
    expect(completed?.gate).toBe("passed");
  });

  it("cross-process resume ohne opts.pack scheitert mit klarer Meldung (kein stiller Lauf)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elio-store-"));
    const a = freshRuntime(dir);
    const events = await collectEvents(a.run(approvePack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const corr = events.find((e) => e.type === "node-suspended")!.correlation;

    const b = freshRuntime(dir);
    await expect(collectEvents(b.resume(corr, { approved: true }))).rejects.toThrow(/cross-process Resume braucht opts\.pack/);
  });
});
