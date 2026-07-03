// ───────────────────────────── Promotion: Graph-Rewrite + Shadow-Eval (Doc §1/§2) ─────────────────────────────
// Hier schließt sich der Loop: aus einem bestätigten node-replacement-Kandidaten wird eine NEUE
// Feature-Version, in der die deterministische LLM-Aufrufstelle über ein Memo-Lookup + LLM-Fallback
// gelöst wird (statt immer über das LLM — das ursprüngliche Ziel). Rein/deterministisch; das Schreiben
// (featureStore.put) macht die promote-apply-Node, das menschliche Gate die approval-Node davor.

import type { FeaturePack, GraphDefinition, StepRef } from "../feature";
import type { GateVerdict } from "../node";
import type { ScriptRunResult } from "../ctx";
import type { TapeFrame } from "../run";
import { hashValue } from "./canon";
import type { PromotionCandidate } from "./candidate";
import type { DeterminismProposal, ScriptProposal } from "./miners";
import { resolvedFrames } from "./stats";

/** Bumpt eine semver-Patch-Version ("0.1.0" → "0.1.1"); sonst hängt "+promoted" an. */
export function bumpVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m !== null) return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  return `${version}+promoted`;
}

/**
 * Core-lokaler contentHash über das Pack (ohne den alten contentHash). Bewusst NICHT die file-ref-aware
 * `computeContentHash` der SDK (die @elio/core nicht importieren darf, Inv. 2) — ein programmatisch
 * umgeschriebenes Pack hat ohnehin keine externen File-Refs. Deterministisch + eindeutig für Pinning.
 */
export function packContentHash(pack: FeaturePack): string {
  const { contentHash: _omit, ...rest } = pack;
  void _omit;
  return `sha256:${hashValue(rest, 64)}`;
}

/** Schmaler Shape-Guard für eine DeterminismProposal (Review-Befund: proposal kommt extern via payload). */
function isDeterminismProposal(p: unknown): p is DeterminismProposal {
  return (
    typeof p === "object" &&
    p !== null &&
    Array.isArray((p as { lookup?: unknown }).lookup)
  );
}

/** Schmaler Shape-Guard für eine Tier-2 ScriptProposal (proposal kommt extern via payload). */
export function isScriptProposal(p: unknown): p is ScriptProposal {
  return (
    typeof p === "object" &&
    p !== null &&
    (p as { tier?: unknown }).tier === 2 &&
    typeof (p as { source?: unknown }).source === "string"
  );
}

/**
 * base64(JSON) der Lookup-Tabelle. Grund (Review-Befund): der Runner template-auflöst das gesamte `with`
 * des memo-Steps rekursiv — eine memoisierte LLM-Ausgabe, die "{{…}}" enthält, würde sonst still
 * korrumpiert. base64 enthält kein "{" und entgeht damit der Template-Auflösung; der memo-Handler dekodiert.
 */
function encodeLookup(lookup: DeterminismProposal["lookup"]): string {
  return Buffer.from(JSON.stringify(lookup), "utf8").toString("base64");
}

/** base64 der generierten Source — gleicher Grund wie encodeLookup: JS-Code enthält "{" und würde sonst
 * vom Runner als Template (miss)interpretiert; base64 entgeht dem, die script-eval-Node dekodiert. */
function encodeSource(source: string): string {
  return Buffer.from(source, "utf8").toString("base64");
}

/** Suffixe der eingefügten Replacement-Steps (Tier-0 memo / Tier-2 script) — für Idempotenz + Demotion. */
const REPLACEMENT_SUFFIXES = ["__memo", "__script"] as const;

/** Findet die id eines bereits eingefügten Replacement-Steps für `stepId` (memo ODER script), sonst undefined. */
function promotedStepId(graph: GraphDefinition, stepId: string): string | undefined {
  for (const suffix of REPLACEMENT_SUFFIXES) {
    const id = `${stepId}${suffix}`;
    if (graph.steps.some((s) => s.id === id)) return id;
  }
  return undefined;
}

/**
 * Schreibt das Pack so um, dass die Aufrufstelle des Kandidaten über ein Memo-Lookup mit LLM-Fallback
 * läuft (node-replacement). Ergebnis = NEUES Pack mit gebumpter Version + frischem contentHash; das
 * Original bleibt unangetastet (tighten-only/Versionierung, Doc §2). Der eingefügte `memo`-Step probt den
 * (template-aufgelösten) Input des Ziel-Steps; bei HIT liefert er die memoisierte Ausgabe und der Graph
 * überspringt den LLM-Step, bei MISS fällt er per Edge auf den LLM-Step zurück (OOD-Sicherheit).
 *
 * v0.1-Grenzen (ehrlich, sonst throw): nur `node-replacement`; der Ziel-Step darf keine BEDINGTEN
 * ausgehenden Edges haben (eine `when`-Kombination "hit AND <cond>" ist in der v0.1-Edge-Syntax nicht
 * ausdrückbar) — der häufige Fall (unbedingte Folge-Edge oder terminaler Step) ist abgedeckt.
 */
export function applyCandidate(pack: FeaturePack, candidate: PromotionCandidate): FeaturePack {
  if (candidate.kind !== "node-replacement") {
    throw new Error(
      `applyCandidate: v0.1 promoted nur "node-replacement", nicht "${candidate.kind}".`,
    );
  }
  const proposal = candidate.proposal;
  // Tier-2 zuerst prüfen (ScriptProposal hat `source`, kein `lookup`); dann Tier-0 (DeterminismProposal).
  if (isScriptProposal(proposal)) {
    return rewriteReplacement(pack, candidate, "__script", "__script_", (target, hitFlag) => ({
      type: "script-eval",
      // sourceB64 statt source: entgeht der Runner-Template-Auflösung (JS-Code enthält "{", s. encodeSource).
      with: { probe: target.with ?? {}, sourceB64: encodeSource(proposal.source), hitFlag },
    }));
  }
  if (isDeterminismProposal(proposal)) {
    return rewriteReplacement(pack, candidate, "__memo", "__memo_", (target, hitFlag) => ({
      type: "memo-lookup",
      // lookupB64 statt lookup: entgeht der Runner-Template-Auflösung (s. encodeLookup).
      with: { probe: target.with ?? {}, lookupB64: encodeLookup(proposal.lookup), hitFlag },
    }));
  }
  throw new Error(
    "applyCandidate: malformed proposal (weder Tier-0 { lookup } noch Tier-2 { tier:2, source }).",
  );
}

/**
 * Gemeinsame Mechanik beider node-replacement-Rewrites (Tier-0 memo-lookup + Tier-2 script-eval): fügt
 * einen Replacement-Step VOR den Ziel-Step, biegt eingehende Edges darauf um, legt HIT (überspringt das
 * LLM) + MISS (Fallback auf das LLM) und bumpt Version + contentHash. `buildReplacement` liefert nur den
 * tier-spezifischen Teil (type + with); id/outputs/edges sind identisch. Pure; Original unangetastet
 * (Versionierung, Doc §2). v0.1-Grenzen (sonst throw): nur unbedingte/terminale Ziel-Steps; kein zweiter
 * Rewrite eines bereits promoteten Steps (memo ODER script).
 */
function rewriteReplacement(
  pack: FeaturePack,
  candidate: PromotionCandidate,
  suffix: (typeof REPLACEMENT_SUFFIXES)[number],
  hitFlagPrefix: string,
  buildReplacement: (target: StepRef, hitFlag: string) => { type: string; with: Record<string, unknown> },
): FeaturePack {
  const graph = pack.feature.graph;
  if (graph === undefined) {
    throw new Error(`applyCandidate: feature "${pack.metadata.id}" hat keinen graph.`);
  }
  const targetId = candidate.callSite?.step;
  if (targetId === undefined) throw new Error("applyCandidate: candidate ohne callSite.step.");
  const targetIdx = graph.steps.findIndex((s) => s.id === targetId);
  if (targetIdx < 0) throw new Error(`applyCandidate: step "${targetId}" nicht im graph.`);
  const target = graph.steps[targetIdx] as StepRef;

  // Idempotenz/No-Double-Rewrite (Review-Befund): ein bereits promotetes Pack trägt den Replacement-Step
  // schon (memo ODER script). Re-Promotion (auch ein Tier-0→Tier-2-Wechsel) ist ein expliziter Fehler —
  // erst demoten, dann neu promoten. Kein zweiter (kompoundierender) Rewrite.
  const existing = promotedStepId(graph, target.id);
  if (existing !== undefined) {
    throw new Error(
      `applyCandidate: "${target.id}" ist bereits promotet (Step "${existing}" existiert) — kein zweiter Rewrite.`,
    );
  }

  const outgoing = graph.edges.filter((e) => e.from === target.id);
  if (outgoing.some((e) => e.when !== undefined && e.when.trim() !== "")) {
    throw new Error(
      `applyCandidate: step "${target.id}" hat bedingte ausgehende Edges — v0.1-Promotion unterstützt nur ` +
        "unbedingte/terminale Ziel-Steps (hit∧cond ist in der Edge-Syntax nicht ausdrückbar).",
    );
  }

  const replacementId = `${target.id}${suffix}`;
  const hitFlag = `${hitFlagPrefix}${target.id}`;
  const built = buildReplacement(target, hitFlag);
  const replacementStep: StepRef = {
    id: replacementId,
    type: built.type,
    with: built.with,
    // Bei HIT mappt die Ausgabe auf DIESELBEN state-Felder wie der LLM-Step (downstream identisch) + den
    // hit-Flag. Bei MISS schreibt der Replacement-Step nur den (false-)Flag.
    outputs: { ...(target.outputs ?? {}), [hitFlag]: `state.${hitFlag}` },
  };

  const newEdges: GraphDefinition["edges"] = [];
  for (const e of graph.edges) {
    // Eingänge auf den LLM-Step auf den Replacement-Step umbiegen.
    newEdges.push(e.to === target.id ? { ...e, to: replacementId } : { ...e });
  }
  // MISS: replacement → llm.
  newEdges.push({ from: replacementId, to: target.id, when: `!state.${hitFlag}` });
  // HIT: replacement → wohin der LLM-Step gezeigt hätte (LLM übersprungen). Terminaler LLM → keine Edge → DONE.
  for (const e of outgoing) {
    newEdges.push({ from: replacementId, to: e.to, when: `state.${hitFlag}` });
  }

  const steps = [...graph.steps];
  steps.splice(targetIdx, 0, replacementStep); // Replacement direkt vor den LLM-Step.

  const newPack: FeaturePack = {
    ...pack,
    metadata: { ...pack.metadata, version: bumpVersion(pack.metadata.version) },
    feature: { ...pack.feature, graph: { ...graph, steps, edges: newEdges } },
  };
  newPack.contentHash = packContentHash(newPack);
  return newPack;
}

/**
 * Umkehrung von `applyCandidate` (Demotion, Doc §8 Drift): entfernt den `<step>__memo`-Step und seine
 * Edges, stellt die direkten Eingangs-Edges auf den LLM-Step wieder her (die ursprünglichen llm→X-Edges
 * blieben beim Promoten erhalten) und bumpt die Version. So fällt eine driftende Aufrufstelle sauber auf
 * das LLM zurück. Wirft, wenn der Step nicht promotet ist.
 */
export function applyDemotion(pack: FeaturePack, stepId: string): FeaturePack {
  const graph = pack.feature.graph;
  if (graph === undefined) throw new Error(`applyDemotion: feature "${pack.metadata.id}" hat keinen graph.`);
  // Den eingefügten Replacement-Step finden (memo ODER script) — Demotion ist für beide Tiers die Umkehrung.
  const replacementId = promotedStepId(graph, stepId);
  if (replacementId === undefined) {
    throw new Error(`applyDemotion: "${stepId}" ist nicht promotet (kein __memo/__script-Step).`);
  }
  const steps = graph.steps.filter((s) => s.id !== replacementId);
  const newEdges: GraphDefinition["edges"] = [];
  for (const e of graph.edges) {
    if (e.from === replacementId) continue; // ausgehende Edges des Replacements (miss + hit) entfernen
    if (e.to === replacementId) {
      newEdges.push({ ...e, to: stepId }); // eingehende auf den LLM-Step zurückbiegen
      continue;
    }
    newEdges.push({ ...e });
  }
  const newPack: FeaturePack = {
    ...pack,
    metadata: { ...pack.metadata, version: bumpVersion(pack.metadata.version) },
    feature: { ...pack.feature, graph: { ...graph, steps, edges: newEdges } },
  };
  newPack.contentHash = packContentHash(newPack);
  return newPack;
}

/** Shadow-Eval-Verdikt: GateVerdict + Abdeckung/Übereinstimmung (Diagnose). */
export interface ShadowEvalResult extends GateVerdict {
  /** # ausgewertete (held-out) Frames, deren Input in der Lookup-Domäne liegt (memoisierbar). */
  covered: number;
  /** # davon, deren tatsächlicher Output mit dem memoisierten übereinstimmt. */
  agreed: number;
  /** true = auf held-out Frames validiert (Mining-Runs ausgeschlossen, covered>0); false = keine unabhängige Validierung. */
  heldOut: boolean;
}

/**
 * Validiert einen node-replacement-Kandidaten auf HELD-OUT Frames seiner Aufrufstelle: Frames aus den
 * Mining-Runs (`candidate.evidence.runs`) werden AUSGESCHLOSSEN — sonst wäre die Prüfung eine Tautologie
 * (die Lookup-Domäne ist per Konstruktion exakt die eindeutigen Inputs jener Runs, Agreement also
 * zwangsläufig 1). Für jeden verbleibenden resolved Frame, dessen Input in der Domäne liegt, prüft sie, ob
 * der memoisierte Output dem tatsächlichen entspricht. `passed` = `covered` > 0 UND Agreement ≥
 * minAgreement (Tier-0 muss exakt sein → Default 1). Gibt es KEINE held-out Frames in der Domäne
 * (covered=0), gilt der Kandidat als NICHT unabhängig validiert (`heldOut:false`, nicht promoten).
 *
 * Der Filter ist (feature, step, nodeType): seit dem Feature-Stempel am TapeFrame (6b) zählen gleichnamige
 * Steps fremder Features NICHT mehr mit. Ist `callSite.feature` leer (unbekannt), greift nur (step,nodeType).
 */
export function shadowEval(
  candidate: PromotionCandidate,
  evalFrames: readonly TapeFrame[],
  minAgreement = 1,
): ShadowEvalResult {
  if (!isDeterminismProposal(candidate.proposal)) {
    return { passed: false, score: 0, failures: ["shadow-eval: malformed determinism proposal"], covered: 0, agreed: 0, heldOut: false };
  }
  const lookup = new Map(candidate.proposal.lookup.map((e) => [e.inputHash, e.output] as const));
  const site = candidate.callSite;
  const miningRuns = new Set(candidate.evidence.runs);
  let covered = 0;
  let agreed = 0;
  for (const f of resolvedFrames(evalFrames)) {
    if (miningRuns.has(f.correlation.run)) continue; // held-out: Mining-Runs ausschließen (sonst Tautologie).
    // Nur Frames der Kandidaten-Aufrufstelle (falls bekannt) bewerten — inkl. Feature-Achse (6b): ein
    // gleichnamiger Step in einem anderen Feature zählt NICHT mehr mit (TapeFrame.feature ist gestempelt).
    if (
      site !== undefined &&
      (f.correlation.step !== site.step ||
        f.nodeType !== site.nodeType ||
        (site.feature !== "" && f.feature !== site.feature))
    ) {
      continue;
    }
    const ih = hashValue(f.input);
    if (!lookup.has(ih)) continue; // OOD → LLM-Fallback, nicht Teil der Skript-Behauptung.
    covered += 1;
    if (hashValue(lookup.get(ih)) === hashValue(f.result.output)) agreed += 1;
  }
  const agreement = covered === 0 ? 0 : agreed / covered;
  const passed = covered > 0 && agreement >= minAgreement;
  const failures = passed
    ? []
    : covered === 0
      ? ["shadow-eval: keine held-out Frames in der Domäne (Mining-Runs ausgeschlossen) — keine unabhängige Validierung"]
      : [`shadow-eval: Agreement ${Math.round(agreement * 100)}% < ${Math.round(minAgreement * 100)}%`];
  return { passed, score: agreement, failures, covered, agreed, heldOut: covered > 0 };
}

/**
 * Shadow-Eval für Tier-2 (generiertes Skript): wie `shadowEval`, aber statt eines Lookups FÜHRT es das
 * generierte Skript gegen jeden held-out Frame AUS (über den injizierten `runScript` — die promote-apply-
 * Node reicht ctx.scripts.run isoliert durch). Ein Frame zählt als `covered`, wenn das Skript einen Output
 * liefert (ok:true); ein ok:false (Wurf/Timeout/OOD) heißt, das Skript defert dort aufs LLM und ist NICHT
 * Teil seiner Behauptung (analog Tier-0 OOD: dort `!lookup.has`). `agreed` = covered-Frames, deren
 * Skript-Output dem tatsächlichen (getapten) gleicht. `passed` = covered>0 UND Agreement ≥ minAgreement.
 *
 * Held-out (Mining-/Synthese-Runs ausgeschlossen) ist NICHT optional (Doc §8): das Skript generalisiert
 * ÜBER die Synthese-Beispiele hinaus, also misst nur UNABHÄNGIGES Tape, ob es korrekt generalisiert. Läuft
 * sequenziell (ein isolierter Worker je Frame) — für held-out-Größen unkritisch; Parallelisierung vertagt.
 */
export async function shadowEvalScript(
  candidate: PromotionCandidate,
  evalFrames: readonly TapeFrame[],
  runScript: (source: string, input: unknown) => Promise<ScriptRunResult>,
  minAgreement = 1,
): Promise<ShadowEvalResult> {
  if (!isScriptProposal(candidate.proposal)) {
    return { passed: false, score: 0, failures: ["shadow-eval: malformed script proposal"], covered: 0, agreed: 0, heldOut: false };
  }
  const source = candidate.proposal.source;
  const site = candidate.callSite;
  const miningRuns = new Set(candidate.evidence.runs);
  let covered = 0;
  let agreed = 0;
  for (const f of resolvedFrames(evalFrames)) {
    if (miningRuns.has(f.correlation.run)) continue; // held-out: Synthese-Runs ausschließen (sonst Tautologie).
    if (
      site !== undefined &&
      (f.correlation.step !== site.step ||
        f.nodeType !== site.nodeType ||
        (site.feature !== "" && f.feature !== site.feature))
    ) {
      continue;
    }
    const r = await runScript(source, f.input);
    if (!r.ok) continue; // Skript defert hier aufs LLM (OOD/Fehler) → nicht Teil der Behauptung.
    covered += 1;
    if (hashValue(r.output) === hashValue(f.result.output)) agreed += 1;
  }
  const agreement = covered === 0 ? 0 : agreed / covered;
  const passed = covered > 0 && agreement >= minAgreement;
  const failures = passed
    ? []
    : covered === 0
      ? ["shadow-eval: kein held-out Frame, auf dem das Skript einen Output liefert — keine unabhängige Validierung"]
      : [`shadow-eval: Agreement ${Math.round(agreement * 100)}% < ${Math.round(minAgreement * 100)}%`];
  return { passed, score: agreement, failures, covered, agreed, heldOut: covered > 0 };
}
