// ───────────────────────────── @elio/studio — Demo-Seed über den EngineService (Inv. 2) ─────────────────────────────
// Studio ist ein reiner Client (Inv. 2): es baut KEINE Runtime/Registry/Governance mehr (das war
// createStudioRuntime — entfernt). Es treibt nur ein paar Runs über den GETEILTEN EngineService, damit
// das Dashboard beim Start etwas Echtes zeigt (Live-Status, Loop-Tape, Live-Updates, Approval-Inbox).
// Alle Runs landen im EINEN Engine-Store → gemeinsam sichtbar über liveStatus/tape/subscribe.

import { collectEvents } from "@elio/sdk";
import type { EngineService } from "@elio/engine";
import type { CorrelationId, RunEvent } from "@elio/core";
import type { SkillBrief } from "@elio/skill-builder";

const RUN_INPUT = { payload: {}, budget: 1000, maxDepth: 200 };

/** Vollständiger Default-Brief für die build-skill-Demo (kein Interview nötig -> suspendiert am Approval). */
export const STUDIO_SKILL_BRIEF: SkillBrief = {
  name: "hello-skill",
  description: "A sample generated skill; use it as a starting point for a real skill.",
  purpose: "Demonstrate the build-skill meta-vertical end-to-end in the Studio dashboard.",
  whenToUse: "When you want to see how build-skill produces a SKILL.md.",
  instructions: "1. Replace this body with real instructions.\n2. Keep the frontmatter name + description.",
};

function firstSuspended(events: RunEvent[]): CorrelationId | undefined {
  const s = events.find(
    (e): e is Extract<RunEvent, { type: "node-suspended" }> => e.type === "node-suspended",
  );
  return s?.correlation;
}

/** Treibt die beiden Demo-Packs bis run-completed{passed} (Outer-Loop-Konvergenz). */
export async function seedDemoRuns(engine: EngineService): Promise<void> {
  await collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));
  await collectEvents(engine.startRun("demo.retry-then-pass", RUN_INPUT));
}

/** Treibt migrate bis zum blocking Commit-Approval und liefert die wartende correlation-id (Approval-Inbox). */
export async function seedMigrateApproval(engine: EngineService): Promise<CorrelationId | undefined> {
  return firstSuspended(await collectEvents(engine.startRun("migrate.csv-to-db", RUN_INPUT)));
}

/** Treibt build-skill (vollständiger Brief, kein Interview) bis zum blocking approve_write-Approval. */
export async function seedSkillApproval(engine: EngineService): Promise<CorrelationId | undefined> {
  return firstSuspended(
    await collectEvents(engine.startRun("build-skill", RUN_INPUT, { brief: STUDIO_SKILL_BRIEF })),
  );
}

/** Seedet alle Demo-Runs (Demos + Migrate-Approval + Skill-Approval) in den geteilten Engine-Store. */
export async function seedStudioRuns(
  engine: EngineService,
): Promise<{ migrate?: CorrelationId; skill?: CorrelationId }> {
  await seedDemoRuns(engine);
  const migrate = await seedMigrateApproval(engine);
  const skill = await seedSkillApproval(engine);
  return {
    ...(migrate !== undefined ? { migrate } : {}),
    ...(skill !== undefined ? { skill } : {}),
  };
}
