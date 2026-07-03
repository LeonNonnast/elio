// ───────────────────────────── @elio/migrate — commit denied without db scope (security by absence, Inv. 14) ─────────────────────────────
// Pins the governance claim specific to this dogfood: "no prod write without the db scope". Every other
// migrate test runs with the default policy that DOES grant dbScopes:[table], so the deny path is never
// exercised at the vertical level. Here the run uses a root policy with EMPTY dbScopes: the injector never
// wires ctx.db, migrate.commit throws (security by absence) on the batch write, and the run surfaces the
// failure as a dead-letter / stopped gate — proving the prod write is gated by the policy scope, not
// merely by reaching the commit_write step.

import { describe, it, expect } from "vitest";
import { collectEvents } from "@elio/sdk";
import type { CorrelationId, ResolvedPolicy, RunEvent, TapeFrame } from "@elio/core";
import { setupMigrate } from "./setup";

const SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
`;

/** Root policy that grants the mapping model but NO db scope (the deny case). */
function noDbScopePolicy(): ResolvedPolicy {
  return {
    allowedModels: ["mock"],
    allowCloud: false,
    dataClassification: "internal",
    suspendMode: "optional",
    toolPermissions: [],
    dbScopes: [], // <- the point: no db scope -> injector wires no ctx.db
  };
}

describe("migrate.csv-to-db — commit is denied ctx.db without a db scope (Inv. 14)", () => {
  it("fails the batch write at commit_write when the policy grants no dbScope", async () => {
    const { runtime, pack, target } = setupMigrate({
      source: { content: SAMPLE_CSV },
      rootPolicy: noDbScopePolicy(),
    });

    // Drive to the blocking commit approval (read_source uses content, so it needs no fs).
    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const runId = ev1.find((e) => e.type === "run-started")!.correlation.run;
    const susp = ev1.find((e) => e.type === "node-suspended");
    if (!susp || susp.type !== "node-suspended") throw new Error("expected commit approval suspend");
    expect(susp.correlation.step).toBe("commit");

    // Approve -> commit_write (migrate.commit) runs WITHOUT ctx.db -> throws -> Failed -> dead-letter.
    const ev2 = await collectEvents(runtime.resume(susp.correlation as CorrelationId, { approved: true }));
    const events: RunEvent[] = [...ev1, ...ev2];

    const completed = events.find((e) => e.type === "run-completed");
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("stopped");

    const tape: TapeFrame[] = runtime.store.getTape(runId);
    const commitFrame = tape.find((f) => f.nodeType === "migrate.commit");
    expect(commitFrame?.result.status).toBe("failed");
    if (commitFrame !== undefined && commitFrame.result.status === "failed") {
      expect(commitFrame.result.error.message).toMatch(/security by absence|ctx\.db ist nicht injiziert/i);
    }

    // Nothing was written to the target (the prod write was gated, not merely skipped).
    expect(target.rows()).toHaveLength(0);
  });
});
