// ───────────────────────────── Built-in: promote-apply + promote-complete (Inv. 6, klass "orchestration") ─────────────────────────────
// Die MUTIERENDE Seite der Learning-Engine (Doc §4): nimmt einen bestätigten Kandidaten, validiert ihn
// per Shadow-Eval gegen das Tape, und schreibt — falls bestanden — die neue Feature-Version via
// ctx.featureStore. Trägt als EINZIGE Node den "featurestore:write"-Grant (security by absence, Inv. 14)
// und läuft im promote-candidate-Feature stets HINTER einer approval-Node (menschliches Gate).

import type { GateVerdict, Node, NodeDefinition } from "../node";
import type { PromotionCandidate, ShadowEvalResult } from "../retro";
import { applyCandidate, applyDemotion, isScriptProposal, shadowEval, shadowEvalScript } from "../retro";

export interface PromoteApplyWith {
  /** Der zu promotende Kandidat — im Feature via {{state.input}} aus dem Run-Payload aufgelöst. */
  candidate?: PromotionCandidate;
  /** Shadow-Eval-Schwelle (Default 1 — Tier-0 muss exakt sein). */
  minAgreement?: number;
  /** Zeitlimit (ms) je Skript-Ausführung im Tier-2-Shadow-Eval; an ctx.scripts.run durchgereicht (symmetrisch zu synthesize). */
  timeoutMs?: number;
}

function isCandidate(x: unknown): x is PromotionCandidate {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { kind?: unknown }).kind === "string" &&
    typeof (x as { id?: unknown }).id === "string"
  );
}

export const promoteApplyHandler: Node<PromoteApplyWith, Record<string, unknown>> = async (
  input,
  ctx,
) => {
  const cfg = (input ?? {}) as PromoteApplyWith;
  // security by absence (Inv. 14): ohne Grants existieren die Capabilities nicht.
  if (ctx.featureStore === undefined) {
    throw new Error(
      "promote-apply: ctx.featureStore nicht injiziert — featurestore:write nicht freigegeben (Inv. 14).",
    );
  }
  if (ctx.traces === undefined) {
    throw new Error("promote-apply: ctx.traces nicht injiziert — shadow-eval braucht traces:read (Inv. 14).");
  }
  const candidate = cfg.candidate;
  if (!isCandidate(candidate)) {
    throw new Error("promote-apply: kein gültiger Kandidat im Input (erwartet via {{state.input}}).");
  }
  const feature = candidate.callSite?.feature;
  if (feature === undefined || feature.length === 0) {
    throw new Error("promote-apply: candidate ohne callSite.feature — Ziel-Pack unbestimmbar.");
  }

  const pack = await ctx.featureStore.get(feature);
  if (pack === null) {
    throw new Error(`promote-apply: Feature "${feature}" nicht im featureStore.`);
  }

  // Shadow-Eval gegen das Tape, auf das Ziel-Feature gescopt (6b — gleichnamige Steps fremder Features
  // zählen nicht mit). Bei Fehlschlag NICHT promoten — das Skript/Memo bliebe sonst potenziell falsch
  // (Doc §8: Shadow-Gate ist nicht optional). Beide Pfade schließen die Mining-Runs aus (held-out).
  const frames = await ctx.traces.collect({ feature });
  const minAgreement = cfg.minAgreement ?? 1;
  let verdict: ShadowEvalResult;
  if (isScriptProposal(candidate.proposal)) {
    // Tier-2: das generierte Skript wird gegen held-out Frames AUSGEFÜHRT (isoliert, ctx.scripts) — braucht
    // daher zusätzlich den scripts:execute-Grant (security by absence, Inv. 14).
    if (ctx.scripts === undefined) {
      throw new Error(
        "promote-apply: ctx.scripts nicht injiziert — Tier-2-Shadow-Eval braucht scripts:execute (Inv. 14).",
      );
    }
    const scripts = ctx.scripts;
    // timeoutMs symmetrisch zur Synthese durchreichen (sonst nähme der Re-Check den 200ms-Default und
    // könnte langsamere held-out Frames fälschlich als OOD verwerfen — fail-safe, aber irreführend).
    const runOpts = cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {};
    verdict = await shadowEvalScript(candidate, frames, (src, inp) => scripts.run(src, inp, runOpts), minAgreement);
  } else {
    verdict = shadowEval(candidate, frames, minAgreement);
  }
  if (!verdict.passed) {
    const out: Record<string, unknown> = { promoted: false, verdict };
    return { status: "resolved", output: out, confidence: 1, cost: {} };
  }

  const newPack = applyCandidate(pack, candidate);
  await ctx.featureStore.put(newPack);
  const out: Record<string, unknown> = {
    promoted: true,
    feature,
    version: newPack.metadata.version,
    contentHash: newPack.contentHash,
    verdict,
  };
  return { status: "resolved", output: out, confidence: 1, cost: {} };
};

/**
 * Built-in promote-apply-Node. Fordert featurestore:write + traces:read (security by absence — ohne
 * Grant failt sie klar). Nur das promote-candidate-Feature gibt diese Grants frei.
 */
export const promoteApplyNode: NodeDefinition<PromoteApplyWith, Record<string, unknown>> = {
  type: "promote-apply",
  klass: "orchestration",
  handler: promoteApplyHandler,
  // scripts:execute zusätzlich für Tier-2-Shadow-Eval (das generierte Skript ausführen). Für einen
  // Tier-0-Kandidaten ungenutzt (harmlos); der Grant wird ohnehin nur im promote-candidate-Feature erteilt.
  requests: { tools: ["featurestore:write", "traces:read", "scripts:execute"] },
};

// ───────────────────────────── promote-complete: Eval-Gate ─────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Eval-Gate des promote-candidate-Features: passt, sobald der apply-Step lief (Artefakt-`content` trägt
 * dann ein boolesches `promoted`). Bei DENY läuft der apply-Step nicht (Edge-Guard) → `promoted` fehlt →
 * Gate failt → run-completed gate:"stopped" (kein Side-Effect, safe-by-default).
 */
export const promoteCompleteHandler: Node<unknown, GateVerdict> = (_input, ctx) => {
  const content = ctx.artifact.content;
  const promoted = isRecord(content) ? content["promoted"] : undefined;
  // Drei Ausgänge sauber trennen (Review-Befund): NUR eine echte Promotion (promoted===true) ist "passed".
  // promoted===false = approved, aber Shadow-Eval lehnte ab → stopped (nichts geschrieben). Fehlt promoted
  // ganz = Approval verweigert → stopped. So verwechselt der Operator "promotet" nicht mit "abgelehnt".
  const verdict: GateVerdict =
    promoted === true
      ? { passed: true, score: 1, failures: [] }
      : {
          passed: false,
          score: 0,
          failures: [
            promoted === false
              ? "promote-complete: Shadow-Eval lehnte ab — nichts promotet"
              : "promote-complete: apply nicht gelaufen (Approval verweigert?)",
          ],
        };
  return Promise.resolve({ status: "resolved", output: verdict, confidence: 1, cost: {} });
};

export const promoteCompleteNode: NodeDefinition<unknown, GateVerdict> = {
  type: "promote-complete",
  klass: "orchestration",
  handler: promoteCompleteHandler,
};

// ───────────────────────────── demote-apply + demote-complete (Punkt 5: Demotion) ─────────────────────────────
// Umkehrung von promote: entfernt das Memo einer driftenden Aufrufstelle und fällt auf das LLM zurück. Wie
// promote-apply die EINZIGE mutierende Capability (featurestore:write), stets hinter einer approval-Node.

export interface DemoteApplyWith {
  feature?: string;
  step?: string;
}

export const demoteApplyHandler: Node<DemoteApplyWith, Record<string, unknown>> = async (input, ctx) => {
  const cfg = (input ?? {}) as DemoteApplyWith;
  if (ctx.featureStore === undefined) {
    throw new Error(
      "demote-apply: ctx.featureStore nicht injiziert — featurestore:write nicht freigegeben (Inv. 14).",
    );
  }
  const feature = cfg.feature;
  const step = cfg.step;
  if (typeof feature !== "string" || feature.length === 0 || typeof step !== "string" || step.length === 0) {
    throw new Error("demote-apply: erwartet { feature, step } im Input (via {{state.input}}).");
  }
  const pack = await ctx.featureStore.get(feature);
  if (pack === null) throw new Error(`demote-apply: Feature "${feature}" nicht im featureStore.`);
  const newPack = applyDemotion(pack, step);
  await ctx.featureStore.put(newPack);
  const out: Record<string, unknown> = {
    demoted: true,
    feature,
    step,
    version: newPack.metadata.version,
    contentHash: newPack.contentHash,
  };
  return { status: "resolved", output: out, confidence: 1, cost: {} };
};

export const demoteApplyNode: NodeDefinition<DemoteApplyWith, Record<string, unknown>> = {
  type: "demote-apply",
  klass: "orchestration",
  handler: demoteApplyHandler,
  requests: { tools: ["featurestore:write"] },
};

/** Eval-Gate des demote-candidate-Features: passt, sobald `content.demoted === true` (sonst stopped). */
export const demoteCompleteHandler: Node<unknown, GateVerdict> = (_input, ctx) => {
  const content = ctx.artifact.content;
  const demoted = isRecord(content) && content["demoted"] === true;
  const verdict: GateVerdict = demoted
    ? { passed: true, score: 1, failures: [] }
    : { passed: false, score: 0, failures: ["demote-complete: apply nicht gelaufen (Approval verweigert?)"] };
  return Promise.resolve({ status: "resolved", output: verdict, confidence: 1, cost: {} });
};

export const demoteCompleteNode: NodeDefinition<unknown, GateVerdict> = {
  type: "demote-complete",
  klass: "orchestration",
  handler: demoteCompleteHandler,
};
