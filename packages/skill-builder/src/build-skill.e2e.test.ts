// ───────────────────────────── @elio/skill-builder — End-to-End (Meta-Vertikale) ─────────────────────────────
// (a) Lädt das kanonische build-skill-feature.yaml, fährt es mit einem VOLLSTÄNDIGEN Brief + MockModel
//     (deterministisch, offline) gegen ein temp outDir: draftet -> validiert -> (blocking) approve_write
//     -> approved -> write_skill schreibt <outDir>/<name>/SKILL.md. Assert: Datei existiert mit validem
//     Frontmatter (name+description) + nichtleerem Body; Gate "skill_well_formed" passed.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { collectEvents } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { setupSkillBuilder } from "./setup";
import { parseSkillMd } from "./skill";

function suspendStep(events: RunEvent[]): CorrelationId | undefined {
  const s = events.find((e) => e.type === "node-suspended");
  return s && s.type === "node-suspended" ? s.correlation : undefined;
}

describe("build-skill — end-to-end load + run + approve (a)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elio-skill-e2e-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drafts, validates, approves and writes <outDir>/<name>/SKILL.md with valid frontmatter + body", async () => {
    const { runtime, pack, outDir } = setupSkillBuilder({
      outDir: dir,
      brief: {
        name: "Code Reviewer",
        description: "Reviews a diff for correctness bugs; use before merging a PR.",
        purpose: "Help the author catch correctness bugs in a code change before it is merged.",
        whenToUse: "When the user asks to review a diff or PR.",
        instructions: "1. Read the diff.\n2. Flag correctness bugs.\n3. Summarize findings.",
      },
    });

    // Sanity: the canonical pack loaded from feature.yaml.
    expect(pack.metadata.id).toBe("build-skill");
    expect(pack.feature.artifact.kind).toBe("skill");
    expect(pack.feature.artifact.evalGate).toBe("skill_well_formed");
    expect(pack.contentHash).toMatch(/^sha256:/);

    // Run 1: collect_brief (complete -> no interview) -> draft_skill -> validate_skill -> approve_write.
    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));

    // The draft (intelligence) step ran and the validate gate ran.
    expect(ev1.some((e) => e.type === "step-started" && e.nodeType === "skill.draft_skill")).toBe(true);
    expect(ev1.some((e) => e.type === "step-started" && e.nodeType === "skill.validate_skill")).toBe(true);

    // The run is suspended at the approve_write approval (blocking) — NOTHING written yet.
    const corr = suspendStep(ev1);
    expect(corr).toBeDefined();
    expect(corr?.step).toBe("approve_write");
    expect(existsSync(join(outDir, "code-reviewer", "SKILL.md"))).toBe(false);

    // Approve -> write_skill writes the file -> gate "skill_well_formed" passes.
    const ev2 = await collectEvents(runtime.resume(corr as CorrelationId, { approved: true }));
    const completed = ev2.find((e) => e.type === "run-completed");
    expect(completed).toBeDefined();
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("passed");

    // The SKILL.md exists at <outDir>/code-reviewer/SKILL.md (name normalized to kebab-case).
    const skillPath = join(outDir, "code-reviewer", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);

    const md = readFileSync(skillPath, "utf8");
    const parsed = parseSkillMd(md);
    expect(parsed).toBeDefined();
    expect(parsed?.frontmatter.name).toBe("code-reviewer");
    expect(parsed?.frontmatter.description).toBeDefined();
    expect((parsed?.frontmatter.description ?? "").length).toBeGreaterThan(0);
    expect((parsed?.frontmatter.description ?? "")).not.toMatch(/\r?\n/); // one line
    expect((parsed?.body ?? "").length).toBeGreaterThan(0); // non-empty body
  });
});
