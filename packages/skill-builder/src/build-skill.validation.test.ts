// ───────────────────────────── @elio/skill-builder — Validation (c) ─────────────────────────────
// Das validate_skill-Verdikt (skill_well_formed-Bausteine): Frontmatter parsebar, name kebab-case,
// description einzeilig+nichtleer, Body nichtleer. Ein SKILL.md, das eines verletzt, ergibt passed:false
// mit GELISTETEN failures. Plus: das deterministische buildSkillMd liefert IMMER ein valides SKILL.md
// (auch aus einem rohen "My Skill"-Brief — kebab-case-Normalisierung), sodass der Offline-Pfad valide ist.

import { describe, it, expect } from "vitest";
import { buildSkillBody, buildSkillMd, extractBodyFromModel, validateSkillMd } from "./skill";

describe("build-skill — validate_skill reports failures on invalid frontmatter (c)", () => {
  it("fails when the frontmatter block is missing/unparseable", () => {
    const v = validateSkillMd("no frontmatter here, just a body");
    expect(v.passed).toBe(false);
    expect(v.failures.some((f) => /frontmatter not parseable/i.test(f))).toBe(true);
  });

  it("fails when name is not kebab-case", () => {
    const md = ["---", "name: Not Kebab Case", "description: A one-line description.", "---", "", "## Body", "", "do things"].join(
      "\n",
    );
    const v = validateSkillMd(md);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f) => /not kebab-case/i.test(f))).toBe(true);
  });

  it("fails when description is missing", () => {
    const md = ["---", "name: good-name", "---", "", "## Body", "", "do things"].join("\n");
    const v = validateSkillMd(md);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f) => /"description" is missing or empty/i.test(f))).toBe(true);
  });

  it("fails when the body is empty", () => {
    const md = ["---", "name: good-name", "description: A one-line description.", "---", "", ""].join("\n");
    const v = validateSkillMd(md);
    expect(v.passed).toBe(false);
    expect(v.failures.some((f) => /body is empty/i.test(f))).toBe(true);
  });

  it("fails when the frontmatter name does not match the expected directory name", () => {
    const md = ["---", "name: other-name", "description: A one-line description.", "---", "", "## Body", "", "x"].join(
      "\n",
    );
    const v = validateSkillMd(md, "expected-name");
    expect(v.passed).toBe(false);
    expect(v.failures.some((f) => /does not match directory name/i.test(f))).toBe(true);
  });

  it("fails a degenerate SKILL.md built from a collapsed (empty) brief — placeholder defaults", () => {
    // An empty brief collapses to the buildSkillMd placeholder name/description -> structurally parseable
    // but meaningless. The safety-net must REJECT it (it must never reach gate=passed).
    const md = buildSkillMd({});
    const v = validateSkillMd(md, "skill");
    expect(v.passed).toBe(false);
    expect(v.failures.some((f) => /collapsed to placeholder defaults/i.test(f))).toBe(true);
  });

  it("extractBodyFromModel rejects a raw prompt echo (no `## ` section / scaffolding) -> undefined", () => {
    // The MockModel default echoes the prompt verbatim; that is NOT a usable body -> deterministic fallback.
    const echo =
      "echo: Draft the SKILL.md body for this skill.\n\nSkill name: x\n\nProduce the markdown body only (no frontmatter). End with DONE.";
    expect(extractBodyFromModel(echo)).toBeUndefined();
    // A plausible body (carries a `## ` section, no scaffolding) is accepted.
    const real = "## Purpose\n\nDo a thing.\n\n## Instructions\n\n1. Step.\nDONE";
    expect(extractBodyFromModel(real)).toMatch(/^##\s+Purpose/);
  });

  it("buildSkillMd uses the deterministic skeleton body when no model body is supplied (offline-valid)", () => {
    const body = buildSkillBody({ name: "x", description: "d", purpose: "p" });
    expect(body).toMatch(/^##\s+Purpose/m);
    expect(body).toMatch(/^##\s+When to use/m);
    expect(body).toMatch(/^##\s+Instructions/m);
  });

  it("passes a well-formed SKILL.md (frontmatter + kebab name + one-line description + non-empty body)", () => {
    const md = buildSkillMd({
      name: "My Skill", // normalized to kebab-case -> "my-skill"
      description: "A handy skill;\n use it often.", // newline -> flattened to one line
      purpose: "Do a useful thing.",
    });
    const v = validateSkillMd(md, "my-skill");
    expect(v.passed).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.frontmatter?.name).toBe("my-skill");
    expect(v.frontmatter?.description).not.toMatch(/\r?\n/);
    expect((v.body ?? "").length).toBeGreaterThan(0);
  });
});
