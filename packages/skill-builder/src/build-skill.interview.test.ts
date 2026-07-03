// ───────────────────────────── @elio/skill-builder — Elicitation / Interview (b) ─────────────────────────────
// Ein Brief mit einem FEHLENDEN Pflichtfeld (purpose). collect_brief raised eine Elicitation, die nach
// genau diesem Feld fragt (node-suspended). runtime.resume(correlation, answer) füllt es -> der Lauf läuft
// weiter bis zum approve_write-Approval -> approved -> die SKILL.md wird geschrieben. Das beweist den
// Interview-Pfad (ctx.elicit.raise -> Checkpoint -> correlation-id-Resume, Inv. 11/12).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { collectEvents } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { setupSkillBuilder } from "./setup";

function suspend(events: RunEvent[]): Extract<RunEvent, { type: "node-suspended" }> | undefined {
  const s = events.find((e) => e.type === "node-suspended");
  return s && s.type === "node-suspended" ? s : undefined;
}

describe("build-skill — interview via elicitation on a missing required field (b)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elio-skill-interview-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("suspends asking for the missing field, then continues to written after the answer is supplied", async () => {
    const { runtime, pack, outDir } = setupSkillBuilder({
      outDir: dir,
      brief: {
        name: "doc-helper",
        description: "Helps draft docs; use when writing documentation.",
        // purpose intentionally MISSING -> collect_brief must interview for it.
      },
    });

    // Run 1: collect_brief detects the missing `purpose` -> raises an elicitation -> node-suspended.
    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const susp = suspend(ev1);
    expect(susp).toBeDefined();
    expect(susp?.correlation.step).toBe("collect_brief");
    // The elicitation asks for the purpose (the interview question).
    expect(susp?.elicitation.what).toMatch(/purpose/i);
    // Nothing drafted/written yet (we did not even reach draft_skill).
    expect(ev1.some((e) => e.type === "step-started" && e.nodeType === "skill.draft_skill")).toBe(false);

    // Answer the interview -> collect_brief resumes, brief now complete -> drives to approve_write.
    const ev2 = await collectEvents(
      runtime.resume(susp?.correlation as CorrelationId, "Help the author produce clear documentation."),
    );

    // Now draft_skill + validate_skill ran, and the run suspends at the approve_write approval.
    expect(ev2.some((e) => e.type === "step-started" && e.nodeType === "skill.draft_skill")).toBe(true);
    const approval = suspend(ev2);
    expect(approval?.correlation.step).toBe("approve_write");

    // Approve -> write_skill writes the file -> gate passes.
    const ev3 = await collectEvents(
      runtime.resume(approval?.correlation as CorrelationId, { approved: true }),
    );
    const completed = ev3.find((e) => e.type === "run-completed");
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("passed");

    expect(existsSync(join(outDir, "doc-helper", "SKILL.md"))).toBe(true);
  });
});
