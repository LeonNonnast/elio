// ───────────────────────────── Retro-Toolkit: Promotion-Kandidaten + Store ─────────────────────────────
// Eine Retro ist ein read-only Analysator: sie liest Tapes und SCHLÄGT VOR (schreibt Kandidaten), mutiert
// aber NIE ein Feature/Policy (Doc §4 — die mutierende Promotion ist entkoppelt + menschlich gegated).
// Der Store ist die Schnittstelle zwischen Retro (schreibt) und `promote-candidate` (liest).
//
// Provenance (`evidence`) ist Pflicht (Doc §5): jede Aussage ist an die Runs gebunden, aus denen sie stammt.

import type { Cost } from "../common";
import type { GateVerdict } from "../node";
import type { CallSiteKey } from "./callsite";
import { hashValue } from "./canon";

/** Die Sorten von Vorschlägen, die verschiedene Miner erzeugen (Doc §5/§6). */
export type CandidateKind =
  | "node-replacement" // Skript ersetzt/ergänzt eine intelligence-Node (→ Graph-Rewrite, neue Version)
  | "node-config" // Node-Parameter ändern (Modell, RetryPolicy, maxTurns) — keine neue Graph-Topologie
  | "graph-edit" // Step entfernen / Reihenfolge / Edge tighten
  | "policy-tighten" // engerer CapabilityRequest / Interceptor / Default (Inv. 13) — keine neue Version
  | "process-variant" // entdeckte Trace-Variante / DFG eines beobachteten Prozesses (Discovery, Doc §6)
  | "process-conformance" // Abweichung known-Prozess ↔ beobachtete Session (Conformance, Doc §6)
  | "alert"; // kein Vorschlag, sondern Incident (z.B. PII-Leak, systematischer Fehler)

// ───────────────────────────── Process-Mining-Proposals (Doc §6, Discovery-Core) ─────────────────────────────
// Sorten-spezifische `proposal`-Formen der Discovery-Miner (mineVariants/mineDfg) und des Conformance-Routers.
// Rein deskriptiv: ein entdecktes Prozess-Muster aus dem beobachteten Loop Tape, kein Graph-Rewrite.

/** Eine entdeckte Trace-Variante: identische nodeType-Sequenz über `support` Sessions (mineVariants). */
export interface ProcessVariantProposal {
  kind: "variant";
  /** Die nodeType-Aktivitätsfolge (Reihenfolge = Bedeutung) dieser Variante. */
  trace: string[];
  /** # Sessions/Runs, die exakt diese Variante zeigen. */
  support: number;
  /** Anteil dieser Variante am Gesamt (`support / totalRuns`) in [0,1]. */
  frequency: number;
  /** ⌀ aggregierte Kosten je Run dieser Variante (falls Kosten getapt wurden). */
  avgCost?: Cost;
}

/** Der Directly-Follows-Graph über alle beobachteten Sessions (mineDfg) — EIN Vorschlag. */
export interface ProcessDfgProposal {
  kind: "dfg";
  /** Kanten `from→to` mit Häufigkeit + Median-Latenz/-Kosten der Übergänge. */
  edges: { from: string; to: string; freq: number; medianLatencyMs?: number; medianCost?: Cost }[];
  /** Start-Aktivitäten (erste nodeType je Session). */
  start: string[];
  /** End-Aktivitäten (letzte nodeType je Session). */
  end: string[];
}

/** Abweichung einer beobachteten Session vom best-passenden bekannten Prozess (Conformance-Router). */
export interface ProcessConformanceProposal {
  kind: "conformance";
  /** id des best-passenden Katalog-Prozesses. */
  matched: string;
  /** Directly-Follows-Kanten der Session, die der bekannte Prozess NICHT enthält. */
  deviations: string[];
}

/** Geschätzte Wirkung eines Kandidaten (Priorisierung). Alle Felder optional. */
export interface CandidateImpact {
  usd?: number;
  tokens?: number;
  latencyMs?: number;
  /** Reduzierte menschliche Toil (z.B. eingesparte Approvals) — für elicitation-/approval-Miner. */
  toilReduced?: number;
}

/** Provenance: aus welchen Runs (+ optionalem Zeitfenster) stammt die Aussage. */
export interface CandidateEvidence {
  runs: string[];
  window?: { since?: string; until?: string };
}

/** Ein Vorschlag einer Retro (read-only erzeugt). `proposal` ist sorten-spezifisch. */
export interface PromotionCandidate {
  /** Inhalts-Hash über (source, kind, callSite, proposal) → derselbe Befund ⇒ dieselbe id (idempotent). */
  id: string;
  /** Welche Retro den Kandidaten erzeugt hat (z.B. "determinism-miner"). */
  source: string;
  kind: CandidateKind;
  /** Aufrufstelle, auf die sich der Kandidat bezieht (falls call-site-bezogen). */
  callSite?: CallSiteKey;
  /** Auf wie vielen Beobachtungen die Aussage beruht. */
  support: number;
  evidence: CandidateEvidence;
  /** Geschätzte Wirkung (Priorisierung). */
  estImpact?: CandidateImpact;
  /** Verdikt eines Shadow-Evals (falls die Retro eines fährt). */
  verdict?: GateVerdict;
  /** Sorten-spezifischer Inhalt: Skript-Source, Policy-Diff, Graph-Diff, Lookup-Tabelle … */
  proposal: unknown;
  /** Menschenlesbare Ein-Zeilen-Begründung. */
  summary: string;
}

/** Spec für `makeCandidate` — wie PromotionCandidate, aber ohne (abgeleitete) `id`. */
export type CandidateSpec = Omit<PromotionCandidate, "id">;

/**
 * Baut einen Kandidaten und leitet die `id` als Inhalts-Hash über (source, kind, callSite, proposal) ab.
 * Idempotent: derselbe Befund erzeugt dieselbe id → der Store dedupliziert ihn (re-mining überschreibt,
 * vervielfältigt nicht). Optionale Felder werden nur gesetzt, wenn vorhanden (exactOptionalPropertyTypes).
 */
export function makeCandidate(spec: CandidateSpec): PromotionCandidate {
  const id = hashValue([spec.source, spec.kind, spec.callSite ?? null, spec.proposal]);
  const candidate: PromotionCandidate = {
    id,
    source: spec.source,
    kind: spec.kind,
    support: spec.support,
    evidence: spec.evidence,
    proposal: spec.proposal,
    summary: spec.summary,
  };
  if (spec.callSite !== undefined) candidate.callSite = spec.callSite;
  if (spec.estImpact !== undefined) candidate.estImpact = spec.estImpact;
  if (spec.verdict !== undefined) candidate.verdict = spec.verdict;
  return candidate;
}

/** Filter für `CandidateStore.list`. */
export interface CandidateFilter {
  source?: string;
  kind?: CandidateKind;
}

/**
 * Read/Write-Contract des Candidate-Stores. Retros rufen `add` (idempotent über die id), die entkoppelte
 * `promote-candidate`-Aktion liest via `list`/`get`. Persistente Stores docken am gleichen Interface an
 * (analog RunStore). `add` ist UPSERT auf der id (re-mining vervielfältigt nicht).
 */
export interface CandidateStore {
  add(candidate: PromotionCandidate): Promise<void>;
  get(id: string): Promise<PromotionCandidate | null>;
  list(filter?: CandidateFilter): Promise<PromotionCandidate[]>;
}

/** In-Memory-Store; Einfügereihenfolge bleibt erhalten (Map). Upsert auf der id. */
export class InMemoryCandidateStore implements CandidateStore {
  private readonly byId = new Map<string, PromotionCandidate>();

  add(candidate: PromotionCandidate): Promise<void> {
    this.byId.set(candidate.id, candidate);
    return Promise.resolve();
  }

  get(id: string): Promise<PromotionCandidate | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  list(filter?: CandidateFilter): Promise<PromotionCandidate[]> {
    let out = [...this.byId.values()];
    if (filter?.source !== undefined) out = out.filter((c) => c.source === filter.source);
    if (filter?.kind !== undefined) out = out.filter((c) => c.kind === filter.kind);
    return Promise.resolve(out);
  }
}
