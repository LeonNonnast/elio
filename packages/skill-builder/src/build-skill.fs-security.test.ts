// ───────────────────────────── @elio/skill-builder — FS-Security (d) ─────────────────────────────
// write_skill schreibt über die policy-gescopte ctx.fs (ScopedFsService), CONFINED auf outDir. Ein Pfad,
// der outDir verlässt (Path-Traversal "../"), MUSS abgelehnt werden (security by absence / ScopedFsService)
// und darf NICHTS außerhalb von outDir schreiben. Dieser Test übt die echte Durchsetzungs-Schicht: den
// ScopedFsService, den setupSkillBuilder hinter ctx.fs verdrahtet (auf outDir confined).

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { collectEvents, ScopedFsService } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { setupSkillBuilder } from "./setup";

describe("build-skill — a write escaping outDir is rejected (security by absence) (d)", () => {
  let root: string;
  let outDir: string;

  beforeEach(() => {
    // root/ contains outDir/ (the confined scope) and is itself OUTSIDE the scope.
    root = mkdtempSync(join(tmpdir(), "elio-skill-fs-"));
    outDir = join(root, "skills");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes inside outDir but REJECTS a traversal that escapes it, leaving nothing outside", async () => {
    // The exact fs backend setupSkillBuilder confines to outDir.
    const fs = new ScopedFsService({ roots: [resolve(outDir)] });

    // (1) An in-scope write succeeds (the normal write_skill target shape).
    const inScope = join(outDir, "good-skill", "SKILL.md");
    await fs.write(inScope, "---\nname: good-skill\ndescription: ok\n---\n\n## Body\n\nx\n");
    expect(existsSync(inScope)).toBe(true);

    // (2) A traversal target that resolves OUTSIDE outDir (as write_skill would build for a malicious
    //     skillName "../escape": <outDir>/../escape/SKILL.md == <root>/escape/SKILL.md) is REJECTED.
    const escapeTarget = join(outDir, "..", "escape", "SKILL.md"); // -> root/escape/SKILL.md
    await expect(fs.write(escapeTarget, "PWNED")).rejects.toThrow(/escapes allowed roots/i);

    // (3) Nothing was written outside outDir.
    expect(existsSync(join(root, "escape", "SKILL.md"))).toBe(false);
    expect(existsSync(resolve(escapeTarget))).toBe(false);

    // The in-scope file is intact and untouched by the rejected write.
    expect(readFileSync(inScope, "utf8")).toMatch(/name: good-skill/);
  });

  it("the default skillBuilderRootPolicy confines fs write to outDir only (no read, no escape prefix)", async () => {
    const { skillBuilderRootPolicy } = await import("./setup");
    const policy = skillBuilderRootPolicy(outDir);
    expect(policy.fsPaths?.write).toEqual([resolve(outDir)]);
    expect(policy.fsPaths?.read).toEqual([]);
    // The scope is exactly outDir — the parent root is NOT in scope (no widening).
    expect(policy.fsPaths?.write).not.toContain(resolve(root));
  });

  // Drives the REAL skill.write_skill node through the injector-scoped ctx.fs (not a standalone
  // ScopedFsService): a brief-supplied name carrying a traversal must NOT land anything outside outDir.
  // toKebabCase collapses "../escape" -> "escape", so the write is confined under outDir; even if it did
  // not, the injector-scoped ctx.fs (confined on outDir) would reject an escaping target.
  it("write_skill (full feature, injector-scoped ctx.fs) confines a traversal skillName under outDir", async () => {
    function suspend(events: RunEvent[]): Extract<RunEvent, { type: "node-suspended" }> | undefined {
      const s = events.find((e) => e.type === "node-suspended");
      return s && s.type === "node-suspended" ? s : undefined;
    }

    const { runtime, pack } = setupSkillBuilder({
      outDir,
      brief: {
        name: "../../escape", // traversal in the brief name
        description: "Tries to escape; do not use.",
        purpose: "Attempt a path traversal via the skill name.",
      },
    });

    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const approval = suspend(ev1);
    expect(approval?.correlation.step).toBe("approve_write");

    const ev2 = await collectEvents(runtime.resume(approval?.correlation as CorrelationId, { approved: true }));
    const done = ev2.find((e) => e.type === "run-completed");
    expect(done).toBeDefined();

    // Nothing escaped outDir: no SKILL.md anywhere under root OUTSIDE outDir.
    expect(existsSync(join(root, "escape", "SKILL.md"))).toBe(false);
    expect(existsSync(join(root, "SKILL.md"))).toBe(false);
    // Whatever was written (if anything) is strictly under outDir.
    const escapeDirs = readdirSync(root).filter((n) => n !== "skills");
    for (const d of escapeDirs) {
      expect(existsSync(join(root, d, "SKILL.md"))).toBe(false);
    }
  });
});
