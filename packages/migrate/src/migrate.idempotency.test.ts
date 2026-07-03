// ───────────────────────────── @elio/migrate — Re-Run Idempotenz (§11/#11) ─────────────────────────────
// (c) Nach einem TEIL-Run, in dem einige Records fehlschlagen, verarbeitet ein Re-Run NUR die
//     fehlgeschlagenen/neuen Records (bereits angewandte ids werden über den Effect-Ledger übersprungen),
//     und der finale DB-Stand trägt jeden Record GENAU einmal.
//
// Der Effect-Ledger ist die durable Ziel-Tabelle (TargetDbAdapter), die über Run-Grenzen hinweg lebt
// (das per-Run frisch erzeugte Artefakt tut das NICHT). `failCommitIds` ist eine geteilte, mutierbare
// Menge: Run 1 lässt einen Record (simuliert transient) fehlschlagen; Run 2 leert sie -> genau dieser
// Record (+ etwaige neue) wird verarbeitet, die anderen idempotent übersprungen.

import { describe, it, expect } from "vitest";
import { collectEvents } from "@elio/sdk";
import type { CorrelationId, RunEvent, TapeFrame } from "@elio/core";
import { setupMigrate } from "./setup";
import { TargetDbAdapter } from "./adapters/target-db";

const SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
u3,Cara Cole,cara@example.com
`;

/** Treibt den Pack bis zum commit-Approval und approved -> commit_write läuft. Liefert run + events. */
async function runAndApprove(
  runtime: ReturnType<typeof setupMigrate>["runtime"],
  pack: ReturnType<typeof setupMigrate>["pack"],
): Promise<{ runId: string; events: RunEvent[] }> {
  const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
  const runId = ev1.find((e) => e.type === "run-started")!.correlation.run;
  const susp = ev1.find((e) => e.type === "node-suspended");
  if (!susp || susp.type !== "node-suspended") throw new Error("expected commit approval suspend");
  const ev2 = await collectEvents(runtime.resume(susp.correlation as CorrelationId, { approved: true }));
  return { runId, events: [...ev1, ...ev2] };
}

/** Findet den commit-Output (migrate.commit) im Loop Tape eines Runs. */
function commitOutput(
  runtime: ReturnType<typeof setupMigrate>["runtime"],
  runId: string,
): { committed: string[]; skipped: string[]; failed: string[] } {
  const tape: TapeFrame[] = runtime.store.getTape(runId);
  const frame = tape.find((f) => f.nodeType === "migrate.commit");
  if (frame === undefined || frame.result.status !== "resolved") {
    throw new Error("no resolved migrate.commit frame in tape");
  }
  return frame.result.output as { committed: string[]; skipped: string[]; failed: string[] };
}

describe("migrate.csv-to-db — re-run idempotency (c, §11/#11)", () => {
  it("a re-run processes ONLY failed/new records; applied ids are skipped; each record lands exactly once", async () => {
    // EIN durable Ziel-Adapter (Effect-Ledger) + EINE geteilte failCommitIds-Menge über beide Runs.
    const target = new TargetDbAdapter({ table: "target" });
    const failCommitIds = new Set<string>(["u2"]); // u2 schlägt in Run 1 (simuliert transient) fehl.
    const { runtime, pack } = setupMigrate({ source: { content: SAMPLE_CSV }, target, failCommitIds });

    // ── Run 1 (Teil-Run): u1 + u3 committed, u2 schlägt fehl. ──
    const run1 = await runAndApprove(runtime, pack);
    const commit1 = commitOutput(runtime, run1.runId);
    expect(commit1.committed.sort()).toEqual(["u1", "u3"]);
    expect(commit1.failed).toEqual(["u2"]);
    expect(commit1.skipped).toEqual([]);

    // Ziel trägt nach Run 1 GENAU u1 + u3 (u2 fehlt noch).
    expect(target.rows().map((r) => String(r["id"])).sort()).toEqual(["u1", "u3"]);

    // Run 1 ist NICHT "passed" (das Gate verlangt ALLE validen Records committed; u2 fehlt).
    const done1 = run1.events.find((e) => e.type === "run-completed");
    expect(done1 && done1.type === "run-completed" && done1.gate).toBe("stopped");

    // ── Re-Run: den transienten Fehler beheben (Menge leeren). ──
    failCommitIds.clear();

    const run2 = await runAndApprove(runtime, pack);
    const commit2 = commitOutput(runtime, run2.runId);
    // NUR der zuvor fehlgeschlagene Record wird verarbeitet; u1 + u3 sind bereits angewandt -> skipped.
    expect(commit2.committed).toEqual(["u2"]);
    expect(commit2.skipped.sort()).toEqual(["u1", "u3"]);
    expect(commit2.failed).toEqual([]);

    // Finaler DB-Stand: jeder Record GENAU einmal (keine Duplikate durch den Re-Run, §11/#11).
    const rows = target.rows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => String(r["id"])).sort()).toEqual(["u1", "u2", "u3"]);

    // Re-Run erreicht jetzt das Gate (alle validen Records committed).
    const done2 = run2.events.find((e) => e.type === "run-completed");
    expect(done2 && done2.type === "run-completed" && done2.gate).toBe("passed");
  });
});
