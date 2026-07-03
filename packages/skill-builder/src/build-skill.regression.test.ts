// ───────────────────────────── @elio/skill-builder — Regression (confirmed findings) ─────────────────────────────
// Deckt drei bestätigte Defekte ab:
//  (1) Eine LEERE/whitespace/nicht-String Interview-Antwort darf das Interview NICHT silent bypassen
//      (kein degeneriertes Placeholder-SKILL.md, kein gate=passed). Der Lauf muss DASSELBE Feld erneut
//      erfragen (re-suspend), nicht mit der abgelehnten Antwort auto-resolven.
//  (2) Eine ABGELEHNTE Approval ({approved:false}) darf NICHTS auf die Platte schreiben und das Gate
//      darf NICHT passieren (das approve_write-Gate gatet den Write).
//  (3) Auf dem DEFAULT-Offline-Pfad (MockModel) trägt der geschriebene SKILL.md-Body das deterministische
//      Skelett (## Purpose / ## When to use / ## Instructions) — NICHT den echo'ten Prompt.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
function completed(events: RunEvent[]): Extract<RunEvent, { type: "run-completed" }> | undefined {
  const c = events.find((e) => e.type === "run-completed");
  return c && c.type === "run-completed" ? c : undefined;
}

describe("build-skill — regression: confirmed findings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elio-skill-reg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── (1) empty / whitespace / non-string interview answer must NOT bypass the interview ──
  for (const bad of [
    { label: "empty string", value: "" },
    { label: "whitespace", value: "   " },
    { label: "non-string (number)", value: 42 as unknown as string },
  ]) {
    it(`re-asks the same field when the answer is ${bad.label} (no silent bypass, no degenerate skill)`, async () => {
      const { runtime, pack, outDir } = setupSkillBuilder({
        outDir: dir,
        // name MISSING -> the very first interview question. A bad answer must re-ask name, NOT advance.
        brief: { description: "x desc; use it.", purpose: "x purpose" },
      });

      const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
      const susp1 = suspend(ev1);
      expect(susp1?.correlation.step).toBe("collect_brief");
      expect(susp1?.elicitation.what).toMatch(/skill name/i);

      // Answer with the BAD value -> the field must NOT be filled; collect_brief must re-suspend for name.
      const ev2 = await collectEvents(runtime.resume(susp1?.correlation as CorrelationId, bad.value));

      // It must NOT have advanced past the interview: no draft step, and a re-raised collect_brief suspend.
      expect(ev2.some((e) => e.type === "step-started" && e.nodeType === "skill.draft_skill")).toBe(false);
      const susp2 = suspend(ev2);
      expect(susp2?.correlation.step).toBe("collect_brief");
      expect(susp2?.elicitation.what).toMatch(/skill name/i);
      // The run did NOT complete with a passing gate from a degenerate placeholder skill.
      expect(completed(ev2)).toBeUndefined();
      // Nothing written to disk.
      expect(readdirSync(outDir).length).toBe(0);

      // A VALID answer to the re-ask advances normally (proves the re-ask is answerable, not a dead end).
      const ev3 = await collectEvents(runtime.resume(susp2?.correlation as CorrelationId, "good-name"));
      expect(ev3.some((e) => e.type === "step-started" && e.nodeType === "skill.draft_skill")).toBe(true);
      const approval = suspend(ev3);
      expect(approval?.correlation.step).toBe("approve_write");
    });
  }

  // ── (2) denying the approval must NOT write SKILL.md and must NOT pass the gate ──
  it("denying approve_write writes nothing and the gate does not pass", async () => {
    const { runtime, pack, outDir } = setupSkillBuilder({
      outDir: dir,
      brief: {
        name: "code-reviewer",
        description: "Reviews a diff for correctness bugs; use before merging.",
        purpose: "Catch correctness bugs before a change is merged.",
      },
    });

    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const approval = suspend(ev1);
    expect(approval?.correlation.step).toBe("approve_write");
    expect(existsSync(join(outDir, "code-reviewer", "SKILL.md"))).toBe(false);

    // DENY the write.
    const ev2 = await collectEvents(runtime.resume(approval?.correlation as CorrelationId, { approved: false }));

    // write_skill must NOT have written the file, and the gate must NOT pass.
    expect(existsSync(join(outDir, "code-reviewer", "SKILL.md"))).toBe(false);
    expect(readdirSync(outDir).length).toBe(0);
    const done = completed(ev2);
    expect(done).toBeDefined();
    expect(done?.gate).not.toBe("passed");
  });

  // ── (3) default offline path writes the deterministic skeleton body, not the echoed prompt ──
  it("writes the deterministic skeleton body (## Purpose/When to use/Instructions) on the default offline path", async () => {
    const { runtime, pack, outDir } = setupSkillBuilder({
      outDir: dir,
      brief: {
        name: "doc-helper",
        description: "Helps draft docs; use when writing documentation.",
        purpose: "Help the author produce clear documentation.",
        whenToUse: "When the user asks to write or improve docs.",
      },
    });

    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const approval = suspend(ev1);
    expect(approval?.correlation.step).toBe("approve_write");
    const ev2 = await collectEvents(runtime.resume(approval?.correlation as CorrelationId, { approved: true }));
    expect(completed(ev2)?.gate).toBe("passed");

    const md = readFileSync(join(outDir, "doc-helper", "SKILL.md"), "utf8");
    // Deterministic skeleton sections present.
    expect(md).toMatch(/^##\s+Purpose/m);
    expect(md).toMatch(/^##\s+When to use/m);
    expect(md).toMatch(/^##\s+Instructions/m);
    // The actual brief content made it into the body.
    expect(md).toContain("Help the author produce clear documentation.");
    // The echoed prompt scaffolding must NOT leak into the body.
    expect(md).not.toMatch(/produce the markdown body only/i);
    expect(md).not.toMatch(/end with done/i);
    expect(md).not.toContain("{{state.");
  });
});
