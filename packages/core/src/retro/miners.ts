// ───────────────────────────── Retro-Miner (read-only Analyse-Funktionen) ─────────────────────────────
// Zwei Anker-Miner als REINE Funktionen — sie komponieren das Toolkit (canon/callsite/stats/candidate)
// und beweisen die Wiederverwertbarkeit über ZWEI verschiedene Tape-Signale + Kandidaten-Sorten:
//   - mineDeterminism: liest `resolved` Outputs  → node-replacement (Doc §6 determinism-miner, Anker)
//   - mineFlakyRetry:  liest `failed`   Frames   → node-config / alert (Doc §6 flaky-retry-miner)
// Beide mutieren nichts (off the hot path, Doc §4) — sie geben Kandidaten zurück, die der Aufrufer in
// einen CandidateStore schreibt. Als Funktionen (nicht Nodes) bleiben sie trivial testbar; das Wrappen
// als retro-Subworkflow-Node ist der nächste Slice.

import type { Cost } from "../common";
import type { Suspended } from "../node";
import type { TapeFrame } from "../run";
import { canonicalJson, hashValue } from "./canon";
import { groupByCallSite } from "./callsite";
import {
  makeCandidate,
  type ProcessDfgProposal,
  type ProcessVariantProposal,
  type PromotionCandidate,
} from "./candidate";
import {
  aggregateCost,
  determinismStats,
  failedFrames,
  groupByRun,
  resolvedFrames,
  uniqueRuns,
} from "./stats";

// ───────────────────────────── determinism-miner ─────────────────────────────

/**
 * Tier-1-Regel: eine einfachere, ÜBER die beobachtete Domäne hinaus generalisierende Form der
 * deterministischen Abbildung (Punkt 4). `constant` = jeder Input liefert denselben Output; `passthrough`
 * = der Output gleicht dem Input. EHRLICH: das Promoten OHNE LLM-Fallback (echte Generalisierung) bräuchte
 * eine OOD-Validierung (= Tier-2, vertagt) — die aktuelle Promotion nutzt weiter die sichere Lookup-Tabelle.
 */
export type Tier1Rule = { kind: "constant"; value: unknown } | { kind: "passthrough" };

/** Erkennt eine einfache Tier-1-Regel (constant/passthrough) über den resolved Frames, sonst undefined. */
export function detectRule(frames: readonly TapeFrame[]): Tier1Rule | undefined {
  const resolved = resolvedFrames(frames);
  if (resolved.length === 0) return undefined;
  const sample = resolved[0] as (typeof resolved)[number];
  const firstOut = hashValue(sample.result.output);
  if (resolved.every((f) => hashValue(f.result.output) === firstOut)) {
    return { kind: "constant", value: sample.result.output };
  }
  if (resolved.every((f) => hashValue(f.result.output) === hashValue(f.input))) {
    return { kind: "passthrough" };
  }
  return undefined;
}

/** Tier-0 Memo-Vorschlag: pro Input-Hash der (eindeutige) Output — eine deterministische Lookup-Tabelle. */
export interface DeterminismProposal {
  tier: 0;
  /** Input-Hashes mit eindeutigem Output = sichere Domäne; außerhalb → LLM-Fallback (OOD-Sicherheit). */
  domain: string[];
  /** Lookup-Einträge (inputHash → Beispiel-Output) für die eindeutigen Inputs. */
  lookup: { inputHash: string; output: unknown }[];
  /** Tier-1: zusätzlich erkannte einfache Regel (generalisiert; Promotion bleibt vorerst Tier-0, s.o.). */
  rule?: Tier1Rule;
}

/**
 * Tier-2 Skript-Vorschlag: eine vom LLM GENERIERTE reine Funktion `(input) => output`, die ÜBER die
 * beobachtete Domäne hinaus generalisiert (anders als die Tier-0-Lookup, die nur gesehene Inputs trifft).
 * Anders als Tier-0 (reine Tabelle, gefahrlos) führt die Promotion echten Code AUS → isoliert über
 * ctx.scripts (Worker/VM, Inv. 20) mit LLM-Fallback bei OOD/Fehler. Im Gegensatz zur Tier-1-Annotation
 * (`DeterminismProposal.rule`, die NICHT ausgeführt wird) ist DAS der ausführbare Code. Wird NICHT von
 * einem (ctx-losen) Miner erzeugt, sondern vom synthesize-script-Node (er hat ctx.model + ctx.scripts).
 */
export interface ScriptProposal {
  tier: 2;
  /** Der generierte Funktions-Ausdruck, z.B. "function (input) { … }" oder "(input) => …". */
  source: string;
  /** Beobachtete Domäne (Input-Hashes), gegen die das Skript bei der Synthese validiert wurde (Provenance). */
  domain: string[];
  /** Optional die zugrundeliegende Tier-1-Regel (constant/passthrough), aus der das Skript hervorging. */
  rule?: Tier1Rule;
}

export interface DeterminismMinerOptions {
  /** Mindest-Beobachtungen (resolved Frames) je Call-Site, bevor ein Kandidat erzeugt wird. Default 20. */
  minSupport?: number;
  /** Mindest-Determinismus-Quote in [0,1]. Default 0.98. */
  minDeterminism?: number;
  /** Welche nodeTypes als "intelligence" gelten (nur DIE lohnen Ersatz). Default ["llm","agent"]. */
  intelligenceNodeTypes?: string[];
  /** Feature-Zuordnung pro Frame (run→feature des Aufrufers); fehlt es, ist das Feature leer. */
  featureOf?: (frame: TapeFrame) => string;
}

const DEFAULT_INTELLIGENCE_NODE_TYPES = ["llm", "agent"];

/**
 * Findet intelligence-Aufrufstellen, die sich deterministisch verhalten (gleicher Input → gleicher Output
 * über Runs), und schlägt sie als `node-replacement` vor (Tier-0 Memo + LLM-Fallback, Doc §6). REIN:
 * liest nur Frames, mutiert nichts. `estImpact.usd` = aggregierte LLM-Kosten dieser Call-Site (die durch
 * das Skript einsparbare Spend auf dem deterministischen Anteil).
 */
export function mineDeterminism(
  frames: readonly TapeFrame[],
  opts: DeterminismMinerOptions = {},
): PromotionCandidate[] {
  const minSupport = opts.minSupport ?? 20;
  const minDeterminism = opts.minDeterminism ?? 0.98;
  const intelligence = new Set(opts.intelligenceNodeTypes ?? DEFAULT_INTELLIGENCE_NODE_TYPES);
  const groups = groupByCallSite(frames, opts.featureOf);
  const out: PromotionCandidate[] = [];

  for (const group of groups.values()) {
    if (!intelligence.has(group.key.nodeType)) continue;
    const stats = determinismStats(group.frames);
    if (stats.support < minSupport) continue;
    if (stats.determinism < minDeterminism) continue;

    // Tier-0 Lookup aus der (bereits sortierten, Doc §5) Domäne ableiten: NUR Input-Hashes mit EINDEUTIGEM
    // Output. Über die sortierte Domäne iteriert ⇒ deterministische Lookup-Reihenfolge ⇒ stabile
    // Kandidaten-id (makeCandidate hasht das proposal; canonicalize bewahrt Array-Reihenfolge). Inputs mit
    // mehreren gesehenen Outputs sind nicht in der Domäne → dort greift weiter der LLM-Fallback.
    const lookup: { inputHash: string; output: unknown }[] = [];
    for (const inputHash of stats.domain) {
      const rec = stats.perInput.get(inputHash);
      if (rec !== undefined) lookup.push({ inputHash, output: rec.sample.output });
    }
    const rule = detectRule(group.frames); // Tier-1 (Punkt 4): zusätzlich erkannte Regel (constant/passthrough)
    const proposal: DeterminismProposal = {
      tier: 0,
      domain: stats.domain,
      lookup,
      ...(rule !== undefined ? { rule } : {}),
    };

    // estImpact NUR über die memoisierbaren (deterministischen) Frames — nicht-deterministische Inputs
    // fallen aufs LLM zurück und werden NICHT eingespart; sonst überschätzt der Wert die Ersparnis und
    // mis-priorisiert den Kandidaten (Review-Befund #2).
    const domainSet = new Set(stats.domain);
    const memoizableCosts: Cost[] = resolvedFrames(group.frames)
      .filter((f) => domainSet.has(hashValue(f.input)))
      .map((f) => f.result.cost);
    const estUsd = aggregateCost(memoizableCosts).usd;
    const pct = Math.round(stats.determinism * 100);

    out.push(
      makeCandidate({
        source: "determinism-miner",
        kind: "node-replacement",
        callSite: group.key,
        support: stats.support,
        evidence: { runs: uniqueRuns(group.frames) },
        ...(estUsd !== undefined ? { estImpact: { usd: estUsd } } : {}),
        proposal,
        summary:
          `${group.key.nodeType}@${group.key.step}: ${pct}% deterministisch über ${stats.support} ` +
          `Beobachtungen → Tier-0 Memo (${lookup.length} Einträge) + LLM-Fallback` +
          (rule !== undefined ? ` [Tier-1-Regel: ${rule.kind}]` : ""),
      }),
    );
  }
  return out;
}

// ───────────────────────────── flaky-retry-miner ─────────────────────────────
//
// Ehrliche Signal-Grenze (v0.1): der Runner tapet EIN Frame pro Step mit dem FINALEN Result
// (runner.ts). Ein fail-then-succeed (Retry hat geholfen) wird damit in ein `resolved` absorbiert und ist
// NICHT einzeln sichtbar. Im Tape beobachtbar ist der `failed`-Pfad: Steps, die ihre Retries ERSCHÖPFT
// haben (`Failed{retryable, attempts}`). Dieser Miner mint daher Failed-Frames:
//   - retryable dominiert  → transient, aber Policy zu knapp  → `node-config` (RetryPolicy hochsetzen)
//   - non-retryable cluster → systematischer Fehler           → `alert`

/** node-config-Vorschlag: eine getunte RetryPolicy (absolute Empfehlung — die aktuelle Policy steht nicht im Tape). */
export interface RetryTuneProposal {
  retry: { maxAttempts: number; backoff: "exponential"; baseDelayMs: number };
}

/** alert-Vorschlag: systematische (non-retryable) Fehler, nach error.code histogrammiert. */
export interface FailureAlertProposal {
  errorCodes: { code: string; count: number }[];
}

export interface FlakyRetryMinerOptions {
  /** Mindestzahl `failed` Frames je Call-Site, bevor ein Kandidat erzeugt wird. Default 3. */
  minFailures?: number;
  /** Ab welchem retryable-Anteil als "transient" (→ node-config) statt "systematisch" (→ alert) gilt. Default 0.5. */
  retryableThreshold?: number;
  featureOf?: (frame: TapeFrame) => string;
}

/** Histogramm der error.codes (absteigend), für FailureAlertProposal. `code` fehlend → "(none)". */
function errorCodeHistogram(frames: readonly { result: { error: { code?: string } } }[]): {
  code: string;
  count: number;
}[] {
  const counts = new Map<string, number>();
  for (const f of frames) {
    const code = f.result.error.code ?? "(none)";
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    // count desc; bei Gleichstand stabil nach code (sonst hinge die Reihenfolge — und via proposal die
    // Kandidaten-id — an der Map-Insertion-Order, Review-Befund #1).
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Findet Aufrufstellen mit gehäuften erschöpften Fehlschlägen und schlägt — je nach retryable-Anteil —
 * eine getunte RetryPolicy (`node-config`) oder einen Incident (`alert`) vor (Doc §6). REIN/read-only.
 */
export function mineFlakyRetry(
  frames: readonly TapeFrame[],
  opts: FlakyRetryMinerOptions = {},
): PromotionCandidate[] {
  const minFailures = opts.minFailures ?? 3;
  const retryableThreshold = opts.retryableThreshold ?? 0.5;
  const groups = groupByCallSite(frames, opts.featureOf);
  const out: PromotionCandidate[] = [];

  for (const group of groups.values()) {
    const failed = failedFrames(group.frames);
    if (failed.length < minFailures) continue;

    const retryableCount = failed.filter((f) => f.result.retryable).length;
    const retryableRatio = retryableCount / failed.length;
    const maxAttempts = failed.reduce((m, f) => Math.max(m, f.result.attempts), 0);
    const runs = uniqueRuns(failed);

    if (retryableRatio >= retryableThreshold) {
      // Transient: Retry hilft grundsätzlich, aber die Policy war zu knapp. Empfehle einen Attempt mehr
      // als das beobachtete Maximum + exponentielles Backoff.
      const proposal: RetryTuneProposal = {
        retry: { maxAttempts: maxAttempts + 1, backoff: "exponential", baseDelayMs: 200 },
      };
      out.push(
        makeCandidate({
          source: "flaky-retry-miner",
          kind: "node-config",
          callSite: group.key,
          support: failed.length,
          evidence: { runs },
          proposal,
          summary:
            `${group.key.nodeType}@${group.key.step}: ${failed.length} erschöpfte Fehlschläge, ` +
            `${Math.round(retryableRatio * 100)}% retryable → RetryPolicy maxAttempts ${maxAttempts + 1} + exponential`,
        }),
      );
    } else {
      // Systematisch: Retry rettet nicht. Eskalieren statt Policy aufbohren.
      const proposal: FailureAlertProposal = { errorCodes: errorCodeHistogram(failed) };
      const topCode = proposal.errorCodes[0];
      out.push(
        makeCandidate({
          source: "flaky-retry-miner",
          kind: "alert",
          callSite: group.key,
          support: failed.length,
          evidence: { runs },
          proposal,
          summary:
            `${group.key.nodeType}@${group.key.step}: ${failed.length} überwiegend NICHT-retryable Fehlschläge ` +
            `(häufigster Code "${topCode?.code ?? "(none)"}") → systematisch, eskalieren statt Retry`,
        }),
      );
    }
  }
  return out;
}

// ───────────────────────────── Weitere tape-getreue Miner (Doc §6) ─────────────────────────────
// Anders als determinism/flaky erzeugen diese ADVISORY-Kandidaten (node-config/graph-edit/policy-tighten/
// alert), die v0.1 NICHT automatisch promotet werden (applyCandidate deckt nur node-replacement) — sie sind
// für den menschlichen Operator. Jede Rahmung ist ehrlich: ein FLAG/Vorschlag aus dem beobachteten Tape,
// kein bewiesener Fix. Geteilte Option: `featureOf` (Feature-Zuordnung, da das Tape keins trägt).

/** Geteilte Basis-Option der zusätzlichen Miner. */
export interface MinerFeatureOption {
  featureOf?: (frame: TapeFrame) => string;
}

function percentile(sortedAsc: readonly number[], frac: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(frac * sortedAsc.length) - 1));
  return sortedAsc[idx] as number;
}

// ── loop-bound-miner ──────────────────────────────────────────────────────────
/** node-config-Vorschlag: ein engerer maxDepth/Budget-Default aus den real beobachteten Iterationen. */
export interface LoopBoundProposal {
  /** Iterationen je (run, branch) dieser Aufrufstelle: Maximum, p95, # beobachtete Branches. */
  observed: { max: number; p95: number; branches: number };
  /**
   * Vorgeschlagener Iterations-Cap DIESER Aufrufstelle (nicht das globale maxDepth — das ist ein run-
   * weites Tiefen-Budget über den ganzen Graphen, Review-Befund): beobachtetes Maximum + 1.
   */
  suggestedIterationCap: number;
}
export interface LoopBoundMinerOptions extends MinerFeatureOption {
  /** Mindestzahl Runs, bevor eine Schranke vorgeschlagen wird. Default 5. */
  minRuns?: number;
}

/**
 * Findet selbst-schleifende Aufrufstellen (mehr als 1 Frame je Run) und schlägt aus der real beobachteten
 * Iterations-Verteilung einen engeren maxDepth-Default vor (Doc §6 loop-bound-miner). Iterationen je Run =
 * Anzahl Frames dieser Call-Site im Run (tape-getreu).
 */
export function mineLoopBound(
  frames: readonly TapeFrame[],
  opts: LoopBoundMinerOptions = {},
): PromotionCandidate[] {
  const minRuns = opts.minRuns ?? 5;
  const groups = groupByCallSite(frames, opts.featureOf);
  const out: PromotionCandidate[] = [];
  for (const group of groups.values()) {
    // Pro (run, branch) zählen, NICHT pro run (Review-Befund): Geschwister-Branches eines subworkflow/
    // feature-ref-Fan-outs teilen den runId — würde man pro run zählen, läsen sich N parallele Kinder als
    // "loopt N×". (run, branch) isoliert die echte Iteration einer Aufrufstelle.
    const perBranch = new Map<string, number>();
    for (const f of group.frames) {
      const key = `${f.correlation.run}::${f.correlation.branch}`;
      perBranch.set(key, (perBranch.get(key) ?? 0) + 1);
    }
    const counts = [...perBranch.values()].sort((a, b) => a - b);
    const branches = counts.length;
    const max = counts[counts.length - 1] ?? 0;
    if (branches < minRuns || max <= 1) continue; // keine Schleife / zu wenig Evidenz
    const p95 = percentile(counts, 0.95);
    const suggestedIterationCap = max + 1; // konservativ: beobachtetes Maximum + 1
    const proposal: LoopBoundProposal = { observed: { max, p95, branches }, suggestedIterationCap };
    out.push(
      makeCandidate({
        source: "loop-bound-miner",
        kind: "node-config",
        callSite: group.key,
        support: branches,
        evidence: { runs: uniqueRuns(group.frames) },
        proposal,
        summary: `${group.key.step}: loopt bis ${max}×/Branch (p95=${p95}) über ${branches} Branches → Iterations-Cap ${suggestedIterationCap}`,
      }),
    );
  }
  return out;
}

// ── elicitation-eliminator ──────────────────────────────────────────────────────
/** policy-tighten-Vorschlag: eine häufige Frage automatisch auflösen. */
export interface ElicitationProposal {
  what: string;
  mode: string;
  count: number;
  suggestion: string;
}
export interface ElicitationMinerOptions extends MinerFeatureOption {
  /** Mindestzahl Suspends derselben Frage, bevor ein Kandidat erzeugt wird. Default 3. */
  minSuspends?: number;
}

/**
 * Findet Aufrufstellen, die häufig dieselbe Elicitation suspendieren, und schlägt einen Auto-Resolve
 * (Policy-Interceptor/Default) vor (Doc §6 elicitation-eliminator — treibt den Autonomie-Dial).
 *
 * Ehrliche Grenze: dies ist ein FREQUENZ-Signal aus den suspended Frames. Die stärkere Aussage „ein Mensch
 * antwortet stets identisch" braucht die AUFGELÖSTEN Antworten (im Run Store / als RunEvents, NICHT im
 * TapeFrame) — die fließen hier noch nicht ein.
 */
export function mineElicitations(
  frames: readonly TapeFrame[],
  opts: ElicitationMinerOptions = {},
): PromotionCandidate[] {
  const minSuspends = opts.minSuspends ?? 3;
  const groups = groupByCallSite(frames, opts.featureOf);
  const out: PromotionCandidate[] = [];
  for (const group of groups.values()) {
    const byWhat = new Map<string, { count: number; mode: string; frames: TapeFrame[] }>();
    for (const f of group.frames) {
      if (f.result.status !== "suspended") continue;
      const el = (f.result as Suspended).elicitation;
      const rec = byWhat.get(el.what);
      if (rec === undefined) byWhat.set(el.what, { count: 1, mode: el.mode, frames: [f] });
      else {
        rec.count += 1;
        rec.frames.push(f);
      }
    }
    for (const [what, rec] of byWhat) {
      if (rec.count < minSuspends) continue;
      const proposal: ElicitationProposal = {
        what,
        mode: rec.mode,
        count: rec.count,
        suggestion: "Policy-Interceptor oder Default, um die Frage automatisch aufzulösen",
      };
      out.push(
        makeCandidate({
          source: "elicitation-eliminator",
          kind: "policy-tighten",
          callSite: group.key,
          support: rec.count,
          evidence: { runs: uniqueRuns(rec.frames) },
          proposal,
          summary: `${group.key.step}: suspendiert "${what}" ${rec.count}× → Auto-Resolve erwägen (Frequenz-Signal)`,
        }),
      );
    }
  }
  return out;
}

// ── model-right-sizing ──────────────────────────────────────────────────────────
/** node-config-Vorschlag (Flag): ein teures Modell mit konsistent hoher Confidence — billigeres testen. */
export interface ModelRightSizingProposal {
  currentModel: string;
  /** ⌀ Confidence, auf 4 Nachkommastellen QUANTISIERT — s. mineModelRightSizing zur id-Stabilität. */
  meanConfidence: number;
  /** Gesamtkosten (USD), auf Cent QUANTISIERT — s. mineModelRightSizing zur id-Stabilität. */
  totalUsd: number;
  observations: number;
  suggestion: string;
}
export interface ModelRightSizingMinerOptions extends MinerFeatureOption {
  /** Mindest-Mittel-Confidence, um zu flaggen. Default 0.8. */
  minConfidence?: number;
  /** Mindest-Gesamtkosten (USD), um zu flaggen. Default 0 (alle mit Modell+Kosten). */
  minUsd?: number;
  intelligenceNodeTypes?: string[];
}

/**
 * Flaggt intelligence-Aufrufstellen mit teurem Modell + konsistent hoher Confidence als „lohnt einen
 * Shadow-Test mit billigerem Modell" (Doc §6 model-right-sizing). EHRLICH: ein FLAG, kein verifizierter
 * Downgrade — ob ein billigeres Modell das Gate hält, klärt erst ein Shadow-Replay (nicht reine Analyse).
 */
export function mineModelRightSizing(
  frames: readonly TapeFrame[],
  opts: ModelRightSizingMinerOptions = {},
): PromotionCandidate[] {
  const minConfidence = opts.minConfidence ?? 0.8;
  const minUsd = opts.minUsd ?? 0;
  const intelligence = new Set(opts.intelligenceNodeTypes ?? DEFAULT_INTELLIGENCE_NODE_TYPES);
  const groups = groupByCallSite(frames, opts.featureOf);
  const out: PromotionCandidate[] = [];
  for (const group of groups.values()) {
    if (!intelligence.has(group.key.nodeType)) continue;
    // Pro MODELL bucketen (Review-Befund): eine Call-Site kann über Runs mehrere Modelle nutzen (A/B,
    // Mid-Window-Swap). Ein Kandidat je (Call-Site, Modell) — sonst meldete man das zuletzt gesehene
    // Modell mit über alle Modelle gemittelten Kennzahlen.
    const byModel = new Map<string, { frames: typeof group.frames; conf: number; usd: number; n: number }>();
    for (const f of resolvedFrames(group.frames)) {
      const model = f.result.cost.model;
      if (model === undefined) continue; // kein Modell getapt → nicht right-sizebar
      const rec = byModel.get(model);
      const usd = f.result.cost.usd ?? 0;
      if (rec === undefined) byModel.set(model, { frames: [f], conf: f.result.confidence, usd, n: 1 });
      else {
        rec.frames.push(f);
        rec.conf += f.result.confidence;
        rec.usd += usd;
        rec.n += 1;
      }
    }
    for (const [model, rec] of byModel) {
      const meanConfidence = rec.conf / rec.n;
      if (meanConfidence < minConfidence || rec.usd <= minUsd) continue;
      // QUANTISIEREN, bevor die akkumulierten Floats ins (id-gehashte) proposal gehen (Review-Befund):
      // rec.conf/rec.usd sind in FRAME-Reihenfolge aufsummiert; IEEE-754-Addition ist nicht assoziativ, also
      // verschöbe eine andere Frame-Reihenfolge den Float — und damit die makeCandidate-id (re-mining
      // dupliziert statt upsertet). Auf Cent/4-Stellen gerundet ist der Wert reihenfolge-unabhängig stabil.
      // estImpact.usd (unten) bleibt der rohe Wert — es wird NICHT gehasht.
      const proposal: ModelRightSizingProposal = {
        currentModel: model,
        meanConfidence: Math.round(meanConfidence * 10000) / 10000,
        totalUsd: Math.round(rec.usd * 100) / 100,
        observations: rec.n,
        suggestion: "billigeres Modell shadow-testen (Agreement/Gate-Pass prüfen, bevor umgestellt wird)",
      };
      out.push(
        makeCandidate({
          source: "model-right-sizing",
          kind: "node-config",
          callSite: group.key,
          support: rec.n,
          evidence: { runs: uniqueRuns(rec.frames) },
          ...(rec.usd > 0 ? { estImpact: { usd: rec.usd } } : {}),
          proposal,
          summary: `${group.key.nodeType}@${group.key.step}: Modell "${model}", ⌀Confidence ${Math.round(meanConfidence * 100)}%, $${rec.usd.toFixed(2)} → billigeres Modell shadow-testen`,
        }),
      );
    }
  }
  return out;
}

// ── redaction-leak-sniffer ──────────────────────────────────────────────────────
const PII_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: "long-digit-run", re: /\b\d{13,19}\b/ }, // karten-/kontoartig
];
/** alert-Vorschlag: PII-artiger Inhalt unredacted im Tape. */
export interface RedactionLeakProposal {
  patterns: string[];
  declaredLevel?: string;
  suggestion: string;
}
export interface RedactionLeakMinerOptions extends MinerFeatureOption {
  /** Mindestzahl betroffener Frames, bevor geflaggt wird. Default 1. */
  minHits?: number;
}

/** Baut einen durchsuchbaren String aus Input + (resolved-)Output bzw. (failed-)Fehlermeldung eines Frames. */
function frameBlob(f: TapeFrame): string {
  const parts: string[] = [canonicalJson(f.input)];
  if (f.result.status === "resolved") parts.push(canonicalJson(f.result.output));
  else if (f.result.status === "failed") parts.push(f.result.error.message);
  return parts.join(" ");
}

/**
 * Flaggt Aufrufstellen, deren Frames PII-artigen Inhalt UNREDACTED tragen (Doc §6 redaction-leak-sniffer).
 * EHRLICH: heuristische Muster (email/lange Ziffernfolgen) — ein Hinweis zur menschlichen Prüfung, kein
 * Beweis. Wir scannen den ROHEN Frame-Inhalt: liegt PII im Klartext vor, wurde sie nicht maskiert.
 */
export function mineRedactionLeaks(
  frames: readonly TapeFrame[],
  opts: RedactionLeakMinerOptions = {},
): PromotionCandidate[] {
  const minHits = opts.minHits ?? 1;
  const groups = groupByCallSite(frames, opts.featureOf);
  const out: PromotionCandidate[] = [];
  for (const group of groups.values()) {
    const hits = new Set<string>();
    const hitFrames: TapeFrame[] = [];
    let level: string | undefined;
    for (const f of group.frames) {
      const blob = frameBlob(f);
      let found = false;
      for (const p of PII_PATTERNS) if (p.re.test(blob)) { hits.add(p.name); found = true; }
      if (found) {
        hitFrames.push(f);
        level = f.redaction?.level;
      }
    }
    if (hitFrames.length < minHits) continue;
    const proposal: RedactionLeakProposal = {
      patterns: [...hits],
      ...(level !== undefined ? { declaredLevel: level } : {}),
      suggestion: "Datenklasse anheben / Feld redacten — heuristische PII-Erkennung, menschlich prüfen",
    };
    out.push(
      makeCandidate({
        source: "redaction-leak-sniffer",
        kind: "alert",
        callSite: group.key,
        support: hitFrames.length,
        evidence: { runs: uniqueRuns(hitFrames) },
        proposal,
        summary: `${group.key.step}: ${hitFrames.length} Frames mit PII-artigem Inhalt (${[...hits].join(", ")}) unredacted → Leak prüfen`,
      }),
    );
  }
  return out;
}

// ── fail-fast-reorder ──────────────────────────────────────────────────────────
/** graph-edit-Vorschlag: ein ablehnendes Gate vor einen teuren Step ziehen. */
export interface FailFastProposal {
  gateStep: string;
  expensiveStep: string;
  rejections: number;
  suggestion: string;
  // HINWEIS: die geschätzte verschwendete Spend steht in `estImpact.usd` (NICHT hier) — sie ist ein in
  // Run-Reihenfolge akkumulierter Float; läge sie im id-gehashten proposal, verschöbe eine andere
  // Run-Reihenfolge die makeCandidate-id (re-mining dupliziert statt upsertet, Review-Befund).
}
export interface FailFastMinerOptions extends MinerFeatureOption {
  /** Mindestzahl Ablehnungen-nach-teurem-Step, bevor geflaggt wird. Default 3. */
  minRejections?: number;
  /** Welche nodeTypes als Gate zählen. Default ["validate","condition"]. */
  gateNodeTypes?: string[];
  intelligenceNodeTypes?: string[];
}

/** Ist der Frame ein ablehnendes Gate (validate/condition mit output.passed === false)? */
function isRejectingGate(f: TapeFrame, gates: ReadonlySet<string>): boolean {
  if (!gates.has(f.nodeType) || f.result.status !== "resolved") return false;
  const o = f.result.output;
  return typeof o === "object" && o !== null && (o as { passed?: unknown }).passed === false;
}

/**
 * Findet Muster „billiges Gate lehnt NACH teurem intelligence-Step ab" innerhalb eines Runs und schlägt vor,
 * das Gate vorzuziehen (Doc §6 fail-fast-reorder). EHRLICH: flaggt die Chance + schätzt die verschwendeten
 * Kosten; der eigentliche Reorder ist ein graph-edit (nur anwenden, wenn keine Datenabhängigkeit es verbietet).
 */
export function mineFailFast(
  frames: readonly TapeFrame[],
  opts: FailFastMinerOptions = {},
): PromotionCandidate[] {
  const minRejections = opts.minRejections ?? 3;
  const gates = new Set(opts.gateNodeTypes ?? ["validate", "condition"]);
  const intelligence = new Set(opts.intelligenceNodeTypes ?? DEFAULT_INTELLIGENCE_NODE_TYPES);
  const opp = new Map<
    string,
    { gateStep: string; expensiveStep: string; rejections: number; wasteUsd: number; runs: Set<string> }
  >();
  for (const [run, runFrames] of groupByRun(frames)) {
    for (let i = 0; i < runFrames.length; i += 1) {
      const gf = runFrames[i] as TapeFrame;
      if (!isRejectingGate(gf, gates)) continue;
      // GENAU den nächsten vorausgehenden teuren intelligence-Frame im SELBEN Branch (Review-Befund):
      // einmal pro Gate-Ablehnung (nicht pro vorherigem Frame → keine Über-Zählung bei Loops/Mehrfach-
      // Gates), und nur same-branch (Geschwister-Branches teilen den runId, sind aber nie sequentiell).
      let chosen: TapeFrame | undefined;
      let chosenUsd = 0;
      for (let j = i - 1; j >= 0; j -= 1) {
        const ef = runFrames[j] as TapeFrame;
        if (ef.correlation.branch !== gf.correlation.branch) continue;
        if (!intelligence.has(ef.nodeType)) continue;
        const usd = ef.result.status === "resolved" ? (ef.result.cost.usd ?? 0) : 0;
        if (usd <= 0) continue;
        chosen = ef;
        chosenUsd = usd;
        break;
      }
      if (chosen === undefined) continue;
      const key = `${chosen.correlation.step}->${gf.correlation.step}`;
      const rec = opp.get(key) ?? {
        gateStep: gf.correlation.step,
        expensiveStep: chosen.correlation.step,
        rejections: 0,
        wasteUsd: 0,
        runs: new Set<string>(),
      };
      rec.rejections += 1;
      rec.wasteUsd += chosenUsd;
      rec.runs.add(run);
      opp.set(key, rec);
    }
  }
  const out: PromotionCandidate[] = [];
  for (const rec of opp.values()) {
    if (rec.rejections < minRejections) continue;
    const proposal: FailFastProposal = {
      gateStep: rec.gateStep,
      expensiveStep: rec.expensiveStep,
      rejections: rec.rejections,
      suggestion:
        "das ablehnende Gate VOR den teuren Step ziehen (nur, wenn keine Datenabhängigkeit das verbietet)",
    };
    out.push(
      makeCandidate({
        source: "fail-fast-reorder",
        kind: "graph-edit",
        support: rec.rejections,
        evidence: { runs: [...rec.runs] },
        estImpact: { usd: rec.wasteUsd },
        proposal,
        summary: `Gate "${rec.gateStep}" lehnt ${rec.rejections}× NACH teurem "${rec.expensiveStep}" ab ($${rec.wasteUsd.toFixed(2)} verschwendet) → Gate vorziehen`,
      }),
    );
  }
  return out;
}

// ── drift-monitor (Doc §8 / Punkt 5) ──────────────────────────────────────────
const MEMO_NODE_TYPE = "memo-lookup";
/** alert-Vorschlag: eine promotete Memo-Aufrufstelle trifft kaum noch (Domäne veraltet). */
export interface DriftProposal {
  observations: number;
  missRate: number;
  suggestion: string;
}
export interface DriftMinerOptions extends MinerFeatureOption {
  /** Mindestzahl Memo-Beobachtungen, bevor geurteilt wird. Default 10. */
  minObservations?: number;
  /** Ab dieser Miss-Rate gilt die Memo-Domäne als veraltet. Default 0.5. */
  maxMissRate?: number;
}

/** Liest den Hit-Flag (`__memo*`-Boolean) aus dem Output eines memo-lookup-Frames; undefined, wenn keiner. */
function memoHit(f: TapeFrame): boolean | undefined {
  if (f.result.status !== "resolved") return undefined;
  const o = f.result.output;
  if (typeof o !== "object" || o === null) return undefined;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k.startsWith("__memo") && typeof v === "boolean") return v;
  }
  return undefined;
}

/**
 * Drift-Monitor (Punkt 5): mint die `memo-lookup`-Frames promoteter Aufrufstellen und flaggt eine HOHE
 * Miss-Rate — die memoisierte Domäne deckt den aktuellen Traffic kaum noch ab (Input-Verteilung hat sich
 * verschoben). Vorschlag: neu minen oder demoten (`applyDemotion`). TAPE-GETREU: der Hit/Miss-Flag steht im
 * Frame-Output (das Tape hält das rohe Node-Result, vor dem content-Stripping). EHRLICH: das ist das
 * Drift-Signal der DOMÄNEN-ABDECKUNG; eine Aussage „die memoisierte Antwort ist inzwischen falsch" bräuchte
 * ein Shadow-Sampling gegen ein frisches LLM (Laufzeit-Pfad, nicht reine Analyse).
 */
export function mineDrift(
  frames: readonly TapeFrame[],
  opts: DriftMinerOptions = {},
): PromotionCandidate[] {
  const minObs = opts.minObservations ?? 10;
  const maxMiss = opts.maxMissRate ?? 0.5;
  const memoFrames = frames.filter((f) => f.nodeType === MEMO_NODE_TYPE);
  const groups = groupByCallSite(memoFrames, opts.featureOf);
  const out: PromotionCandidate[] = [];
  for (const group of groups.values()) {
    let obs = 0;
    let misses = 0;
    for (const f of group.frames) {
      const hit = memoHit(f);
      if (hit === undefined) continue;
      obs += 1;
      if (!hit) misses += 1;
    }
    if (obs < minObs) continue;
    const missRate = misses / obs;
    if (missRate < maxMiss) continue;
    const proposal: DriftProposal = {
      observations: obs,
      missRate,
      suggestion: "Memo-Domäne veraltet — neu minen oder demoten (LLM-Fallback dominiert)",
    };
    out.push(
      makeCandidate({
        source: "drift-monitor",
        kind: "alert",
        callSite: group.key,
        support: obs,
        evidence: { runs: uniqueRuns(group.frames) },
        proposal,
        summary: `${group.key.step}: Memo-Miss-Rate ${Math.round(missRate * 100)}% über ${obs} Beobachtungen → Domäne veraltet, re-mine/demote`,
      }),
    );
  }
  return out;
}

// ───────────────────────────── Process-Discovery-Miner (Doc §6, deterministisch — kein LLM) ─────────────────────────────
// Anders als die call-site-gruppierten Miner oben operieren diese PRO SESSION = pro (run, branch): aus jeder
// `groupByRunBranch`-Gruppe wird die nodeType-AKTIVITÄTSFOLGE extrahiert (= „Trace"/„variant"). Pro (run, branch)
// statt pro run, weil Geschwister-Branches eines Fan-outs den runId teilen (sonst würden sie zu einer Misch-
// Variante / Phantom-Kanten verschmolzen). mineVariants gruppiert Branch-Sessions nach identischer Variante (ein
// process-variant-Kandidat je distinkter Variante), mineDfg baut den Directly-Follows-Graphen über ALLE Branch-
// Sessions (ein process-variant-Kandidat mit ProcessDfgProposal). REIN/read-only: liest nur Frames, mutiert
// nichts (off the hot path, Doc §4).

/** Geteilte Optionen der Discovery-Miner. */
export interface ProcessDiscoveryOptions {
  /** Mindestzahl Runs mit identischer Variante, bevor ein Variant-Kandidat erzeugt wird. Default 1. */
  minSupport?: number;
}

/** Die nodeType-Aktivitätsfolge einer Session = die geordneten Frames eines Runs auf ihre nodeTypes projiziert. */
function variantOf(runFrames: readonly TapeFrame[]): string[] {
  return runFrames.map((f) => f.nodeType);
}

/**
 * Gruppiert Frames pro (run, branch) — NICHT pro run (Review-Befund): Geschwister-Branches eines
 * subworkflow/batch/feature-ref-Fan-outs teilen den runId und werden vom Runner interleaved in dasselbe
 * Run-Tape getapt. Würde Discovery pro run sequenzieren, fabrizierte mineDfg Directly-Follows-Kanten über
 * die Branch-Grenze und mineVariants eine lineare Misch-Variante, die KEIN Branch je ausführte. Pro
 * (run, branch) ist eine Sequenz = die echte Aktivitätsfolge EINES Branches. Reihenfolge innerhalb des
 * Branches bleibt erhalten (= Tape-Reihenfolge). Diese Sequenz ist die „Session"-Einheit der Discovery-Miner;
 * `evidence.runs` wird weiter über die distinkten runIds gebildet (uniqueRuns).
 */
function groupByRunBranch(frames: readonly TapeFrame[]): Map<string, { run: string; frames: TapeFrame[] }> {
  const byBranch = new Map<string, { run: string; frames: TapeFrame[] }>();
  for (const f of frames) {
    const key = `${f.correlation.run}::${f.correlation.branch}`;
    const existing = byBranch.get(key);
    if (existing === undefined) byBranch.set(key, { run: f.correlation.run, frames: [f] });
    else existing.frames.push(f);
  }
  return byBranch;
}

/** Median einer Zahlen-Liste (unsortiert erlaubt); leer → undefined. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * Discovery: gruppiert Sessions (pro (run, branch)) nach IDENTISCHER nodeType-Variante (Fingerprint via
 * `hashValue`) und schlägt je distinkter Variante EINEN `process-variant`-Kandidaten vor (Doc §6 mineVariants).
 * `support` = # Branch-Sessions der Variante, `frequency` = support/totalSessions, `evidence.runs` = die
 * distinkten Runs, `avgCost` = ⌀ aggregierte Kosten je Branch-Session. Über die SORTIERTEN Varianten-
 * Fingerprints iteriert ⇒ stabile Kandidaten-Reihenfolge/-ids.
 */
export function mineVariants(
  frames: readonly TapeFrame[],
  opts: ProcessDiscoveryOptions = {},
): PromotionCandidate[] {
  const minSupport = opts.minSupport ?? 1;
  // Pro (run, branch) sequenzieren, NICHT pro run (Review-Befund): sonst mischte ein Fan-out (Geschwister-
  // Branches, die sich den runId teilen) interleaved zu EINER Pseudo-Variante, die kein Branch je ausführte.
  const byBranch = groupByRunBranch(frames);
  const totalSessions = byBranch.size;
  // Pro Varianten-Fingerprint: die Variante + die distinkten Runs + die Session-Gesamtkosten (für avgCost).
  const byVariant = new Map<string, { variant: string[]; runs: Set<string>; costs: Cost[] }>();
  for (const { run, frames: branchFrames } of byBranch.values()) {
    const variant = variantOf(branchFrames);
    const fp = hashValue(variant);
    const branchCost = aggregateCost(resolvedFrames(branchFrames).map((f) => f.result.cost));
    const rec = byVariant.get(fp);
    if (rec === undefined) byVariant.set(fp, { variant, runs: new Set([run]), costs: [branchCost] });
    else {
      rec.runs.add(run);
      rec.costs.push(branchCost);
    }
  }
  const out: PromotionCandidate[] = [];
  // Über sortierte Fingerprints ⇒ deterministische Reihenfolge (unabhängig von Run-/Insertion-Order).
  for (const fp of [...byVariant.keys()].sort()) {
    const rec = byVariant.get(fp) as { variant: string[]; runs: Set<string>; costs: Cost[] };
    // support = # Branch-Sessions dieser Variante (eine Iteration je Branch); evidence = distinkte Runs.
    const support = rec.costs.length;
    if (support < minSupport) continue;
    const frequency = totalSessions === 0 ? 0 : support / totalSessions;
    // ⌀ Kosten je Branch-Session: über die Session-Gesamtkosten aggregieren und durch support teilen.
    const total = aggregateCost(rec.costs);
    const avgCost: Cost = {};
    if (total.usd !== undefined) avgCost.usd = total.usd / support;
    if (total.tokensIn !== undefined) avgCost.tokensIn = total.tokensIn / support;
    if (total.tokensOut !== undefined) avgCost.tokensOut = total.tokensOut / support;
    if (total.model !== undefined) avgCost.model = total.model;
    const hasCost = Object.keys(avgCost).length > 0;
    const proposal: ProcessVariantProposal = {
      kind: "variant",
      trace: rec.variant,
      support,
      frequency,
      ...(hasCost ? { avgCost } : {}),
    };
    out.push(
      makeCandidate({
        source: "process-variant-miner",
        kind: "process-variant",
        support,
        evidence: { runs: [...rec.runs] },
        proposal,
        summary:
          `Variante [${rec.variant.join(" → ")}]: ${support} Sessions ` +
          `(${Math.round(frequency * 100)}% des Traffics)`,
      }),
    );
  }
  return out;
}

/**
 * Discovery: baut den Directly-Follows-Graphen über ALLE Sessions (Doc §6 mineDfg) und emittiert GENAU EINEN
 * `process-variant`-Kandidaten mit `ProcessDfgProposal`. Je gerichteter Kante `from→to` (konsekutive Frames
 * innerhalb EINES Branches, NICHT über Branch-Grenzen — sonst fabrizierte ein Fan-out Kanten zwischen
 * Geschwister-Branches): Häufigkeit, Median-Latenz (aus den `ts`-Deltas der Frame-Paare) und Median-Kosten
 * (aggregierte Cost des Ziel-Frames). `start`/`end` = distinkte erste/letzte Aktivität je Branch-Session.
 * `support`/`evidence.runs` = distinkte Runs. Leere Eingabe → keine Kandidaten. Kanten/Start/End sortiert ⇒
 * stabile Kandidaten-id (idempotentes re-mining).
 */
export function mineDfg(
  frames: readonly TapeFrame[],
  _opts: ProcessDiscoveryOptions = {},
): PromotionCandidate[] {
  // Pro (run, branch) sequenzieren, NICHT pro run (Review-Befund): konsekutive Frames eines Fan-outs teilen
  // den runId, sind aber verschiedene Branches; pro run gepaart entstuenden Kanten ueber die Branch-Grenze
  // (z.B. file(b1) auf file(b2)), die KEIN echter Uebergang sind und die dt>=0-Latenzfilter still verschluckt.
  const byBranch = groupByRunBranch(frames);
  if (byBranch.size === 0) return [];
  // Pro Kante: Frequenz + gesammelte Latenz-Deltas (ms) + Cost der Ziel-Frames (für die Mediane).
  const edges = new Map<string, { from: string; to: string; freq: number; latencies: number[]; costs: Cost[] }>();
  const starts = new Set<string>();
  const ends = new Set<string>();
  const runs = new Set<string>();
  for (const { run, frames: branchFrames } of byBranch.values()) {
    if (branchFrames.length === 0) continue;
    runs.add(run);
    starts.add((branchFrames[0] as TapeFrame).nodeType);
    ends.add((branchFrames[branchFrames.length - 1] as TapeFrame).nodeType);
    for (let i = 0; i + 1 < branchFrames.length; i += 1) {
      const a = branchFrames[i] as TapeFrame;
      const b = branchFrames[i + 1] as TapeFrame;
      // Kollisionsfreier Bucket-Key (Review-Befund): nodeType ist ein unbeschraenkter String; ein einzelnes
      // Separator-Zeichen koennte kollidieren. JSON-Array kodiert das Paar eindeutig und stabil.
      const key = JSON.stringify([a.nodeType, b.nodeType]);
      const rec = edges.get(key) ?? { from: a.nodeType, to: b.nodeType, freq: 0, latencies: [], costs: [] };
      rec.freq += 1;
      const dt = Date.parse(b.ts) - Date.parse(a.ts);
      if (Number.isFinite(dt) && dt >= 0) rec.latencies.push(dt);
      if (b.result.status === "resolved") rec.costs.push(b.result.cost);
      edges.set(key, rec);
    }
  }
  // Kanten stabil sortieren (from, dann to) ⇒ die proposal-Reihenfolge — und via makeCandidate die id —
  // hängt NICHT an der Run-/Insertion-Order (idempotentes re-mining, Doc §5).
  const edgeList = [...edges.values()]
    .sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0))
    .map((e) => {
      const medianLatencyMs = median(e.latencies);
      // Median über die per-Frame usd-Kosten der Übergänge (robuster Mittelwert; nur Frames mit usd zählen).
      const usds = e.costs.map((c) => c.usd).filter((u): u is number => u !== undefined);
      const medUsd = median(usds);
      const medianCost = medUsd !== undefined ? { usd: medUsd } : undefined;
      return {
        from: e.from,
        to: e.to,
        freq: e.freq,
        ...(medianLatencyMs !== undefined ? { medianLatencyMs } : {}),
        ...(medianCost !== undefined ? { medianCost } : {}),
      };
    });
  const proposal: ProcessDfgProposal = {
    kind: "dfg",
    edges: edgeList,
    start: [...starts].sort(),
    end: [...ends].sort(),
  };
  const runList = [...runs];
  return [
    makeCandidate({
      source: "process-dfg-miner",
      kind: "process-variant",
      support: runList.length,
      evidence: { runs: runList },
      proposal,
      summary: `Directly-Follows-Graph: ${edgeList.length} Kanten über ${runList.length} Sessions`,
    }),
  ];
}
