// ───────────────────────────── @elio/skill-builder — echter Provider statt mock (Vertical-Retrofit) ─────────────────────────────
// Beweist: setupSkillBuilder({ models }) verdrahtet eine ECHTE Provider-Map (hier ein OllamaModel mit
// injiziertem fetchImpl — kein echtes Netz) unter ihrem echten Profil-Key. Der Draft-Schritt reichert NICHT
// über die mock-id an, sondern über "ollama:llama3"; der Worker reicht dem Adapter NUR den reinen
// Modellnamen ("llama3", nie "ollama:llama3"). Der Lauf erreicht das blocking approve_write und schreibt
// auf Approve eine valide SKILL.md (gate=passed).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { collectEvents, OllamaModel } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { setupSkillBuilder } from "./setup";
import { parseSkillMd } from "./skill";

function suspendStep(events: RunEvent[]): CorrelationId | undefined {
  const s = events.find((e) => e.type === "node-suspended");
  return s && s.type === "node-suspended" ? s.correlation : undefined;
}

describe("build-skill — runs on a REAL (non-mock) provider profile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elio-skill-real-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes the draft step through OllamaModel and reaches gate=passed", async () => {
    // Fängt den an den Adapter gereichten Modellnamen ab. Liefert einen validen `## `-Body (+ DONE), sodass
    // extractBodyFromModel ihn akzeptiert (Beweis, dass die ECHTE Provider-Ausgabe — nicht der Fallback — floss).
    const seenModels: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { model?: string };
      if (typeof body.model === "string") seenModels.push(body.model);
      const content =
        "## Purpose\nReview a diff for correctness bugs before merging.\n\n" +
        "## When to use\nWhen the user asks to review a PR.\n\n" +
        "## Instructions\n1. Read the diff.\n2. Flag correctness bugs.\nDONE";
      return new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const ollama = new OllamaModel({ fetchImpl });

    // ECHTE Provider-Map unter dem Profil-Key "ollama"; Default kanonisch "ollama:llama3"; Wildcard-Freigabe.
    const { runtime, pack, outDir } = setupSkillBuilder({
      outDir: dir,
      brief: {
        name: "Code Reviewer",
        description: "Reviews a diff for correctness bugs; use before merging a PR.",
        purpose: "Help the author catch correctness bugs in a code change before it is merged.",
      },
      models: { ollama },
      defaultModel: "ollama:llama3",
      allowedModels: ["ollama:*"],
    });

    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));

    // Der Draft-Schritt lief und reichte den echten Provider an.
    expect(ev1.some((e) => e.type === "step-started" && e.nodeType === "skill.draft_skill")).toBe(true);
    // Der Adapter sah den REINEN Modellnamen "llama3" — NIE die kanonische Spec "ollama:llama3", NIE "mock".
    expect(seenModels.length).toBeGreaterThan(0);
    expect(seenModels.every((m) => m === "llama3")).toBe(true);
    expect(seenModels).not.toContain("ollama:llama3");
    expect(seenModels).not.toContain("mock");

    // Lauf suspendiert am blocking approve_write — noch NICHTS geschrieben.
    const corr = suspendStep(ev1);
    expect(corr?.step).toBe("approve_write");
    expect(existsSync(join(outDir, "code-reviewer", "SKILL.md"))).toBe(false);

    // Approve -> write_skill -> gate "skill_well_formed" passed; valide SKILL.md mit dem echt-angereicherten Body.
    const ev2 = await collectEvents(runtime.resume(corr as CorrelationId, { approved: true }));
    const completed = ev2.find((e) => e.type === "run-completed");
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("passed");

    const skillPath = join(outDir, "code-reviewer", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const parsed = parseSkillMd(readFileSync(skillPath, "utf8"));
    expect(parsed?.frontmatter.name).toBe("code-reviewer");
    expect((parsed?.body ?? "").length).toBeGreaterThan(0);
    // Der vom echten Provider gelieferte Body (## Purpose …) floss in die SKILL.md (kein stiller Fallback).
    expect(parsed?.body ?? "").toMatch(/##\s+Purpose/);
  });
});
