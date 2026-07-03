// ───────────────────────────── @elio/migrate — denying the commit approval writes nothing (Inv. 11/12) ─────────────────────────────
// Distinct from migrate.db-deny.test.ts (which removes the db SCOPE -> security by absence). Here the policy
// GRANTS db; the user simply answers the commit approval with {approved:false}. The commit -> commit_write
// edge guard (when: state.answer.approved == true) is then NOT taken, so commit_write (migrate.commit) never
// runs and the prod target stays empty. Pins the governance promise: a DENIED approval performs no
// irreversible action. Every other migrate test resumes with {approved:true}, so this path was untested.

import { describe, it, expect } from "vitest";
import { collectEvents } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { setupMigrate } from "./setup";

const SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
`;

describe("migrate.csv-to-db — denying the commit approval writes nothing", () => {
  it("does not run commit_write and writes no rows when the approval is denied", async () => {
    const { runtime, pack, target } = setupMigrate({ source: { content: SAMPLE_CSV } });

    // Drive to the blocking commit approval.
    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const susp = ev1.find((e) => e.type === "node-suspended");
    if (!susp || susp.type !== "node-suspended") throw new Error("expected commit approval suspend");
    expect(susp.correlation.step).toBe("commit");

    // Sanity: nothing committed before the approval is answered.
    expect(target.rows()).toHaveLength(0);

    // DENY the commit.
    const ev2 = await collectEvents(runtime.resume(susp.correlation as CorrelationId, { approved: false }));
    const events: RunEvent[] = [...ev1, ...ev2];

    // The commit_write step (migrate.commit) must NEVER have started (edge guard not taken).
    expect(events.some((e) => e.type === "step-started" && e.correlation.step === "commit_write")).toBe(false);
    // And the prod target stays empty — the denied approval performed no write.
    expect(target.rows()).toHaveLength(0);
  });

  it("approving the commit DOES write (the guard lets an approve through)", async () => {
    const { runtime, pack, target } = setupMigrate({ source: { content: SAMPLE_CSV } });

    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const susp = ev1.find((e) => e.type === "node-suspended");
    if (!susp || susp.type !== "node-suspended") throw new Error("expected commit approval suspend");

    await collectEvents(runtime.resume(susp.correlation as CorrelationId, { approved: true }));

    // The approve path takes the edge -> commit_write runs -> rows land.
    expect(target.rows().length).toBeGreaterThan(0);
  });
});
