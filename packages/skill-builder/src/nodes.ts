// ───────────────────────────── Skill-Builder-Nodes + registerSkillBuilder (Inv. 6 — built-in == custom) ─────────────────────────────
// Die Meta-Vertikale registriert ihre Fach-Nodes wie jede Custom-Node an der Runtime-Registry. Der Brief
// + das outDir sind INJIZIERTE WERTE (per Closure gebunden, analog zu migrate.{source,target}) — KEINE
// Steps. Das ARTEFAKT ist ein Claude-Code-Skill (eine SKILL.md, Inv. 1).
//
// Nodes (linearer Graph):
//  1. skill.collect_brief  : prüft den Brief auf Pflichtfelder; fehlt eines, raised es eine Elicitation
//                            (ctx.elicit.raise) = das INTERVIEW. Auf Resume füllt die Antwort den Brief.
//                            Ist der Brief vollständig, geht er durch (ohne zu suspenden) und legt die
//                            Brief-Felder in den State (für die Draft-Templates) + ins Artefakt.
//  2. skill.draft_skill    : draftet den SKILL.md-TEXT. Deterministisches, strukturell VALIDES Skelett aus
//                            dem Brief; wenn ctx.model present ist, reichert es den Body via one-shot llm
//                            an (Prompts aus with.system/with.prompt). Output { skillName, skillMd }.
//  3. skill.validate_skill : validate-Style Node -> Resolved<GateVerdict>: Frontmatter parsebar, name
//                            kebab-case, description einzeilig+nichtleer, Body nichtleer. Failures gelistet.
//  4. approve_write        : built-in approval-Node (suspend blocking) — bestätigt den irreversiblen Write.
//  5. skill.write_skill    : schreibt <outDir>/<skillName>/SKILL.md über ctx.fs (ScopedFsService —
//                            confined auf outDir; ein Pfad, der outDir verlässt, wird abgelehnt).
//  skill_well_formed       : das Eval-Gate (Inv. 1) — bestanden, wenn validate passed UND die Datei
//                            geschrieben wurde.

import { join, resolve as resolvePath } from "node:path";
import type { GateVerdict, NodeDefinition, NodeResult, Resolved, Suspended } from "@elio/core";
import type { Runtime } from "@elio/sdk";
import {
  buildSkillMd,
  extractBodyFromModel,
  firstMissingField,
  questionFor,
  REQUIRED_BRIEF_FIELDS,
  skillNameFrom,
  validateSkillMd,
} from "./skill";
import type { SkillBrief } from "./skill";

// ───────────────────────────── geteilter Artefakt-Stand (Brief + Skill) ─────────────────────────────

/** Form des im Artefakt-content gehaltenen build-skill-Stands (überlebt Suspend/Resume, Inv. 4). */
interface SkillArtifactContent {
  brief?: SkillBrief;
  /** Das Feld, für das collect_brief zuletzt eine Elicitation raised hat (Resume füllt es). */
  pendingField?: string;
  /**
   * Wie oft collect_brief für `pendingField` schon gefragt hat (1-basiert). Der Zähler wandert in das
   * elicitation.`what` als Attempt-Nonce: so kann eine STALE keyed Antwort (`_answers[what]`) aus einem
   * abgelehnten (leer/whitespace/nicht-String) Versuch NIE den Re-Raise via Parent-State auto-resolven
   * (der Re-Raise trägt ein anderes `what`). Eine VALIDE Antwort advanced ohnehin (kein Re-Raise).
   */
  pendingAttempt?: number;
  skillName?: string;
  skillMd?: string;
  /** Validierungs-Ergebnis (vom validate_skill-Schritt). */
  validated?: boolean;
  /** Ob die SKILL.md auf die Platte geschrieben wurde (vom write_skill-Schritt). */
  written?: boolean;
  /** Absoluter Pfad der geschriebenen SKILL.md. */
  path?: string;
}

/** Liest den build-skill-Stand aus dem geteilten Artefakt-content (Inv. 4). */
function readContent(content: unknown): SkillArtifactContent {
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    return content as SkillArtifactContent;
  }
  return {};
}

/** Mutiert den Artefakt-content in-place (single artifact state, Inv. 1/4) und liefert ihn typisiert. */
function mutContent(content: unknown): SkillArtifactContent {
  const c = readContent(content);
  return c;
}

/**
 * Ob eine Approval-Antwort eine ZUSTIMMUNG ist. Die Approval-Inbox/CLI liefert `{ approved: true }`
 * (vgl. parseAnswer "y" -> {approved:true}); auf dem auto-resolve-Pfad landet genau dieses Objekt in
 * state.answer und wird via {{state.answer}} an write_skill gereicht. Alles andere (false, undefined,
 * irgendeine andere Form) ist KEINE Zustimmung -> kein Write (defense in depth).
 */
function isApproved(answer: unknown): boolean {
  return (
    typeof answer === "object" &&
    answer !== null &&
    !Array.isArray(answer) &&
    (answer as { approved?: unknown }).approved === true
  );
}

// ───────────────────────────── Registrierungs-Optionen ─────────────────────────────

export interface RegisterSkillBuilderOptions {
  /**
   * Der injizierte Skill-Brief (per Closure gebunden, KEIN Step). collect_brief seedet seinen
   * Arbeits-Brief hieraus beim ersten Aufruf; fehlende Pflichtfelder werden per Interview ergänzt.
   */
  brief?: SkillBrief;
  /**
   * Das aufgelöste Ausgabe-Verzeichnis. write_skill schreibt <outDir>/<skillName>/SKILL.md hierhin.
   * Der fs-Write-Scope (Root-Policy) ist auf GENAU dieses Verzeichnis confined (security by absence):
   * ein Pfad, der outDir verlässt, wird vom ScopedFsService abgelehnt.
   */
  outDir: string;
}

// ───────────────────────────── registerSkillBuilder ─────────────────────────────

/**
 * Registriert die build-skill-Nodes + das Eval-Gate an einer Runtime. Brief/outDir sind injizierte
 * Werte (über Closures gebunden, nicht als Steps deklariert) — analog registerMigrate. Idempotent:
 * bereits registrierte Typen werden nicht doppelt registriert.
 */
export function registerSkillBuilder(runtime: Runtime, opts: RegisterSkillBuilderOptions): void {
  const injectedBrief: SkillBrief = { ...(opts.brief ?? {}) };
  const outDir = resolvePath(opts.outDir);

  const reg = (def: NodeDefinition): void => {
    if (!runtime.registry.has(def.type)) runtime.registry.register(def);
  };

  // ── skill.collect_brief: prüft Pflichtfelder; fehlt eines -> Elicitation (Interview). ──
  // Liest seinen Arbeits-Brief aus dem GETEILTEN Artefakt (überlebt Suspend/Resume); seedet ihn beim
  // ersten Aufruf aus dem injizierten Brief. `with.answer` ({{state.answer}}) trägt die Resume-Antwort.
  const collectBriefNode: NodeDefinition<{ answer?: unknown }, CollectBriefOutput> = {
    type: "skill.collect_brief",
    klass: "orchestration",
    handler: (input, ctx): Promise<NodeResult<CollectBriefOutput>> => {
      const cfg = (input ?? {}) as { answer?: unknown };
      const content = mutContent(ctx.artifact.content);

      // 1) Arbeits-Brief: aus dem Artefakt (Resume) ODER beim ersten Aufruf aus dem injizierten Brief.
      const brief: SkillBrief = content.brief ?? { ...injectedBrief };

      // 2) Resume-Antwort in das zuletzt gefragte Feld falten (das Interview-Increment). NUR ein
      //    nichtleerer String ist gültig (brief.schema.json: required, minLength 1). Eine leere/whitespace/
      //    nicht-String-Antwort wird VERWORFEN -> das Feld bleibt fehlend -> Re-Raise (Schritt 4).
      const pending = content.pendingField;
      const answerIsValid = typeof cfg.answer === "string" && cfg.answer.trim().length > 0;
      if (pending !== undefined && answerIsValid) {
        (brief as Record<string, unknown>)[pending] = (cfg.answer as string).trim();
        delete content.pendingField;
        delete content.pendingAttempt;
      }

      // 3) Arbeits-Brief im Artefakt persistieren (überlebt den nächsten Suspend/Resume-Zyklus).
      content.brief = brief;

      // 4) Erstes noch fehlendes Pflichtfeld -> Elicitation raisen (= Interview). Sonst durchgehen.
      const missing = firstMissingField(brief);
      if (missing !== undefined) {
        if (ctx.elicit === undefined) {
          throw new Error(
            "skill.collect_brief: ctx.elicit ist nicht injiziert — das Interview braucht den Suspend-Pfad.",
          );
        }
        // Attempt-Nonce hochzählen: ein erneuter Raise für DASSELBE Feld (z.B. nach einer abgelehnten
        // leeren Antwort) trägt ein anderes `what` als der vorige Versuch. Damit kann der Runner die
        // STALE keyed Antwort (`_answers[<altes what>]`) NIE als Parent-State auto-resolve für den
        // Re-Raise wiederverwenden (das war der silent-bypass: leere Antwort -> Re-Raise -> auto-resolve
        // mit genau der abgelehnten Antwort). Bei einem Feldwechsel beginnt der Zähler neu bei 1.
        const attempt = pending === missing ? (content.pendingAttempt ?? 1) + 1 : 1;
        content.pendingField = missing;
        content.pendingAttempt = attempt;
        const suspended: Suspended = ctx.elicit.raise({
          what: questionFor(missing, attempt),
          whoCanAnswer: { users: ["author"] },
          schema: { type: "string" },
        });
        return Promise.resolve(suspended);
      }

      // 5) Vollständig: Brief-Felder in den State legen (für die Draft-Templates) + ins Artefakt.
      const resolved: Resolved<CollectBriefOutput> = {
        status: "resolved",
        output: {
          brief,
          skillName: skillNameFrom(brief),
          skillDescription: (brief.description ?? "").trim(),
          skillPurpose: (brief.purpose ?? "").trim(),
          skillWhenToUse: (brief.whenToUse ?? "").trim(),
          skillInstructions: (brief.instructions ?? "").trim(),
        },
        confidence: 1,
        cost: { usd: 0 },
      };
      return Promise.resolve(resolved);
    },
  };

  // ── skill.draft_skill: draftet den SKILL.md-TEXT (deterministisches Skelett + optionale model-Anreicherung). ──
  // Liest die Brief-Felder aus dem State (von collect_brief gemerged). Baut IMMER ein strukturell valides
  // Skelett; ist ctx.model present (Policy gab ein Modell frei + with.system/with.prompt gesetzt), reichert
  // es den Body via one-shot llm an. Mit MockModel (default/offline) bleibt es beim deterministischen Body.
  const draftSkillNode: NodeDefinition<DraftSkillWith, DraftSkillOutput> = {
    type: "skill.draft_skill",
    klass: "intelligence",
    requests: { models: ["*"] },
    handler: async (input, ctx): Promise<Resolved<DraftSkillOutput>> => {
      const cfg = (input ?? {}) as DraftSkillWith;
      const content = mutContent(ctx.artifact.content);
      const brief: SkillBrief = content.brief ?? {
        ...(typeof cfg.brief === "object" && cfg.brief !== null ? (cfg.brief as SkillBrief) : {}),
      };

      // Deterministischer, strukturell valider Body (Offline-Fallback / MockModel).
      let body: string | undefined;
      let cost = { usd: 0 } as Resolved<DraftSkillOutput>["cost"];

      // Optionale Anreicherung über ctx.model (one-shot). Nur wenn ctx.model present UND ein User-Prompt da.
      if (ctx.model !== undefined && typeof cfg.prompt === "string" && cfg.prompt.trim().length > 0) {
        const messages = [{ role: "user", content: cfg.prompt }];
        const req: { system?: string; messages: { role: string; content: string }[]; maxTokens?: number } = {
          messages,
        };
        if (typeof cfg.system === "string" && cfg.system.length > 0) req.system = cfg.system;
        if (typeof cfg.maxTokens === "number") req.maxTokens = cfg.maxTokens;
        try {
          const out = await ctx.model.complete(req);
          body = extractBodyFromModel(out.text);
          cost = out.cost;
        } catch {
          // Modell-Fehler -> stiller Fallback auf das deterministische Skelett (offline-valide bleibt valide).
          body = undefined;
        }
      }

      const skillName = skillNameFrom(brief);
      const skillMd = buildSkillMd(brief, body);

      // In den geteilten Stand schreiben (für validate/write + reDerive).
      content.skillName = skillName;
      content.skillMd = skillMd;

      const result: Resolved<DraftSkillOutput> = {
        status: "resolved",
        output: { skillName, skillMd },
        confidence: 1,
        cost,
      };
      return result;
    },
  };

  // ── skill.validate_skill: validate-Style Node -> Resolved<GateVerdict>. ──
  // Liest skillMd/skillName aus dem State (von draft_skill gemerged) ODER aus dem Artefakt. Prüft die
  // SKILL.md-Struktur (Frontmatter parsebar, name kebab-case = Verzeichnisname, description einzeilig
  // nichtleer, Body nichtleer). Failures gelistet. Schreibt `validated` ins Artefakt (Gate-Baustein).
  const validateSkillNode: NodeDefinition<{ skillMd?: unknown; skillName?: unknown }, GateVerdict> = {
    type: "skill.validate_skill",
    klass: "orchestration",
    handler: (input, ctx): Promise<Resolved<GateVerdict>> => {
      const cfg = (input ?? {}) as { skillMd?: unknown; skillName?: unknown };
      const content = mutContent(ctx.artifact.content);
      const skillMd = typeof cfg.skillMd === "string" ? cfg.skillMd : content.skillMd ?? "";
      const skillName = typeof cfg.skillName === "string" ? cfg.skillName : content.skillName;
      const v = validateSkillMd(skillMd, skillName);
      content.validated = v.passed;
      const verdict: GateVerdict = { passed: v.passed, score: v.passed ? 1 : 0, failures: v.failures };
      return Promise.resolve({
        status: "resolved",
        output: verdict,
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  // ── skill.write_skill: schreibt <outDir>/<skillName>/SKILL.md über ctx.fs (ScopedFsService). ──
  // FAILS BY ABSENCE (Inv. 14): fehlt ctx.fs (Policy gab keinen fsPath frei), wirft die Node. Der Ziel-
  // Pfad ist <outDir>/<skillName>/SKILL.md — innerhalb des outDir-Scopes; ein Pfad, der outDir verlässt
  // (z.B. ein skillName mit "../"), kollabiert via path.resolve und wird vom ScopedFsService abgelehnt.
  const writeSkillNode: NodeDefinition<
    { skillMd?: unknown; skillName?: unknown; approved?: unknown },
    { path: string; bytes: number; written: boolean }
  > = {
    type: "skill.write_skill",
    klass: "orchestration",
    requests: { fs: { write: ["*"] } },
    handler: async (input, ctx): Promise<Resolved<{ path: string; bytes: number; written: boolean }>> => {
      const cfg = (input ?? {}) as { skillMd?: unknown; skillName?: unknown; approved?: unknown };

      // Defense in depth (das approve_write-Gate gatet den Write, Inv. 12): write_skill schreibt NUR bei
      // einer ZUSTIMMENDEN Approval. Der Edge-Guard (feature.yaml) verhindert den Aufruf bereits bei
      // Ablehnung; landet der Node dennoch hier OHNE Zustimmung (z.B. fehlender Guard), no-op't er OHNE
      // ctx.fs.write — eine Ablehnung kann so nie die Platte erreichen.
      if (!isApproved(cfg.approved)) {
        return {
          status: "resolved",
          output: { path: "", bytes: 0, written: false },
          confidence: 1,
          cost: { usd: 0 },
        };
      }

      if (ctx.fs === undefined) {
        throw new Error(
          "skill.write_skill: ctx.fs ist nicht injiziert — security by absence (Inv. 14): der Lauf wurde " +
            "nicht für Datei-Schreibzugriff freigegeben (Policy gab keinen fsPath write-Scope frei).",
        );
      }
      const content = mutContent(ctx.artifact.content);
      const skillMd = typeof cfg.skillMd === "string" ? cfg.skillMd : content.skillMd ?? "";
      const skillName = typeof cfg.skillName === "string" ? cfg.skillName : content.skillName ?? "skill";

      // Ziel-Pfad: <outDir>/<skillName>/SKILL.md. join+resolve kollabiert ".." -> ein outDir-verlassender
      // skillName landet außerhalb des Scopes und wird vom ScopedFsService abgelehnt (security by absence).
      const target = resolvePath(join(outDir, skillName, "SKILL.md"));
      await ctx.fs.write(target, skillMd);

      content.written = true;
      content.path = target;

      return {
        status: "resolved",
        output: { path: target, bytes: skillMd.length, written: true },
        confidence: 1,
        cost: { usd: 0 },
      };
    },
  };

  // ── skill_well_formed: das Eval-Gate (Inv. 1). ──
  // Bestanden, wenn (a) die SKILL.md validiert UND (b) auf die Platte geschrieben wurde. Der Runner prüft
  // das Gate nach JEDEM resolved Step; vor write_skill ist `written` false -> das Gate hält den Loop offen
  // (bewusst), bis nach dem approve_write-Approval die Datei wirklich geschrieben ist (vgl. migrate).
  const skillGate: NodeDefinition<{ artifact?: { content?: unknown } }, GateVerdict> = {
    type: "skill_well_formed",
    klass: "orchestration",
    handler: (input): Promise<Resolved<GateVerdict>> => {
      const content = readContent(input?.artifact?.content);
      const failures: string[] = [];
      // Re-Validierung gegen den finalen SKILL.md-Text (autoritativ, unabhängig vom `validated`-Flag).
      const v = validateSkillMd(content.skillMd ?? "", content.skillName);
      if (!v.passed) failures.push(...v.failures);
      if (content.written !== true) failures.push("SKILL.md not yet written to disk");
      const passed = failures.length === 0;
      return Promise.resolve({
        status: "resolved",
        output: { passed, score: passed ? 1 : 0, failures },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  reg(collectBriefNode as unknown as NodeDefinition);
  reg(draftSkillNode as unknown as NodeDefinition);
  reg(validateSkillNode as unknown as NodeDefinition);
  reg(writeSkillNode as unknown as NodeDefinition);
  reg(skillGate as unknown as NodeDefinition);
}

// ───────────────────────────── lokale Typen ─────────────────────────────

interface CollectBriefOutput {
  brief: SkillBrief;
  skillName: string;
  skillDescription: string;
  skillPurpose: string;
  skillWhenToUse: string;
  skillInstructions: string;
}

interface DraftSkillWith {
  system?: string;
  prompt?: string;
  maxTokens?: number;
  brief?: unknown;
}

interface DraftSkillOutput {
  skillName: string;
  skillMd: string;
}

// Re-export der Pflichtfeld-Liste (Diagnose/Tests).
export { REQUIRED_BRIEF_FIELDS };
