// ───────────────────────────── @elio/migrate — path-basierte Quelle über ctx.fs (§7, Inv. 14) ─────────────────────────────
// Beweist die SYMMETRIE zum db-Pfad: die Quelle ist eine injizierte fs-CAPABILITY, nicht nur ein
// in-memory-Fixture. Eine echte CSV-DATEI wird über die policy-gescopte ctx.fs durch den GANZEN Runner
// gelesen (read_source-Node -> Injector wired ctx.fs -> SourceCsvAdapter.rows(ctx.fs)). Das schließt die
// Lücke, dass read_source kein fs anforderte und die Root-Policy keinen fsPath freigab — ctx.fs war damit
// immer undefined und der path-basierte Adapter unerreichbar.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { collectEvents } from "@elio/sdk";
import type { CorrelationId, RunEvent, TapeFrame } from "@elio/core";
import { setupMigrate } from "./setup";
import { migrateRootPolicy } from "./setup";

const SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
`;

function suspendStep(events: RunEvent[]): CorrelationId | undefined {
  const s = events.find((e) => e.type === "node-suspended");
  return s && s.type === "node-suspended" ? s.correlation : undefined;
}

describe("migrate.csv-to-db — path-based source reads through ctx.fs (§7, Inv. 14)", () => {
  let dir: string;
  let csvPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elio-migrate-fs-"));
    csvPath = join(dir, "source.csv");
    writeFileSync(csvPath, SAMPLE_CSV, "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a real CSV file via the policy-scoped fs and commits the records to the target", async () => {
    // source.path (NOT content): the only way the rows arrive is read_source -> ctx.fs -> file read.
    const { runtime, pack, target } = setupMigrate({ source: { path: csvPath } });

    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));

    // The run reached the blocking commit approval (so read_source actually produced rows from the file).
    const corr = suspendStep(ev1);
    expect(corr).toBeDefined();
    expect(corr?.step).toBe("commit");

    await collectEvents(runtime.resume(corr as CorrelationId, { approved: true }));

    const rows = target.rows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => String(r["id"])).sort()).toEqual(["u1", "u2"]);
    const byId = new Map(rows.map((r) => [String(r["id"]), r]));
    expect(byId.get("u1")).toMatchObject({ id: "u1", name: "Ann Acker", email: "ann@example.com" });
  });

  it("denies the file read (security by absence) when the policy grants no fs read scope", async () => {
    // Same path-based source, but an explicit root policy WITHOUT fsPaths -> the injector never wires
    // ctx.fs, so SourceCsvAdapter.rows(undefined) throws on a path-based source. The run must surface the
    // failure (read_source fails -> dead-letter, run stops) rather than silently producing no rows / a
    // half-built artifact. This locks the fs scope to the POLICY, not merely to reaching the step.
    const noFsPolicy = migrateRootPolicy("target"); // no fsReadRoots -> no fsPaths granted
    const { runtime, pack } = setupMigrate({ source: { path: csvPath }, rootPolicy: noFsPolicy });

    const ev = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const runId = ev.find((e) => e.type === "run-started")!.correlation.run;

    // read_source could not read the file -> Failed (onExhausted=fail) -> dead-letter + run stopped.
    const completed = ev.find((e) => e.type === "run-completed");
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("stopped");

    const tape: TapeFrame[] = runtime.store.getTape(runId);
    const readFrame = tape.find((f) => f.nodeType === "migrate.read_source");
    expect(readFrame?.result.status).toBe("failed");
    if (readFrame !== undefined && readFrame.result.status === "failed") {
      expect(readFrame.result.error.message).toMatch(/security by absence|FsReader|ctx\.fs/i);
    }
  });
});
