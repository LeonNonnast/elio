// ───────────────────────────── Built-in: retro-miner + retro-complete (Inv. 6, klass "orchestration") ─────────────────────────────
// Die read-only Orchestrierungs-Schicht der Learning/Optimization-Engine (docs/elio-learning-engine.md §3/§9).
// `retro-miner` macht die reinen Miner-Funktionen (../retro) als echte Node lauffähig: es liest das Loop Tape
// über ctx.traces (Capability "traces:read", security by absence — Inv. 14), fährt die konfigurierten Miner und
// gibt Kandidaten zurück. Es MUTIERT NICHTS (off the hot path, Doc §4) — Promotion ist ein separates,
// menschlich gegatetes Feature (featureStore:write, nächster Slice).
//
// `retro-complete` ist der zugehörige Eval-Gate (Inv. 1): mining ist EIN-SCHUSS (kein Konvergenz-Loop wie
// draft-until-good), der Gate bestätigt also schlicht, dass ein candidate-set produziert wurde.

import type { TraceQuery } from "../ctx";
import type { GateVerdict, Node, NodeDefinition, Resolved } from "../node";
import type {
  DeterminismMinerOptions,
  FlakyRetryMinerOptions,
  MinerFeatureOption,
  PromotionCandidate,
} from "../retro";
import {
  mineDeterminism,
  mineDfg,
  mineDrift,
  mineElicitations,
  mineFailFast,
  mineFlakyRetry,
  mineLoopBound,
  mineModelRightSizing,
  mineRedactionLeaks,
  mineVariants,
} from "../retro";
import type { ProcessDiscoveryOptions } from "../retro";

/** Welche Miner die Node fahren kann. Erweiterbar, wenn weitere Miner aus ../retro dazukommen. */
export type RetroMinerName =
  | "determinism"
  | "flaky-retry"
  | "loop-bound"
  | "elicitation"
  | "model-right-sizing"
  | "redaction-leak"
  | "fail-fast"
  | "drift"
  // Process-Mining-Discovery (Doc §6): über (run, branch) gruppierte Aktivitätsfolgen → Varianten/DFG.
  | "variants"
  | "dfg";

/**
 * Konfiguration der retro-miner-Node (via `with`, template-aufgelöst).
 *  - miners:  welche Miner laufen (Default: beide).
 *  - runs:    auf diese Runs einschränken (sonst alle getapten Runs, v0.1 read-all).
 *  - feature: Feature-Label, das den Kandidaten zugeordnet wird (v0.1: kein run→feature-Mapping im Tape).
 *  - prior:   bereits gesammelte Kandidaten (Akkumulation über Steps); per id dedupliziert.
 *  - *Support/*Determinism/*Failures/…: an die Miner durchgereichte Schwellwerte.
 *
 * Der Output-Key ist bewusst FEST "candidates" (kein `as`): der gepaarte retro-complete-Gate liest genau
 * diesen Key — ein konfigurierbarer Key würde den Gate still entkoppeln (Review-Befund A).
 */
export interface RetroMinerWith {
  miners?: RetroMinerName[];
  runs?: string[];
  feature?: string;
  minSupport?: number;
  minDeterminism?: number;
  intelligenceNodeTypes?: string[];
  minFailures?: number;
  retryableThreshold?: number;
  prior?: PromotionCandidate[];
}

const ALL_MINERS: readonly RetroMinerName[] = [
  "determinism",
  "flaky-retry",
  "loop-bound",
  "elicitation",
  "model-right-sizing",
  "redaction-leak",
  "fail-fast",
  "drift",
  "variants",
  "dfg",
];

/**
 * Eigene Node-Typen, die ein Miner NICHT analysieren darf (Selbst-Mining vermeiden, Review-Befund B):
 * frühere Orchestrator-Runs hinterlassen retro-miner/-complete-Frames im selben Store, und ein
 * fail-closed-Run (kein traces:read-Grant) hinterlässt Failed-"retro-miner"- + "dead-letter"-Frames —
 * ohne Filter würde ein späterer Run einen flaky-retry-Kandidaten ÜBER DIE MINER-NODE SELBST minten.
 * Bis es feature-granulares Trace-Scoping gibt (v0.2), filtert die Node ihre eigene Infrastruktur heraus.
 */
const RETRO_INFRA_NODE_TYPES = new Set(["retro-miner", "retro-complete", "dead-letter"]);

/** Dedupliziert Kandidaten per (idempotenter) id — Akkumulation/Mehrfach-Mining vervielfältigt nicht. */
function dedupeById(cands: readonly PromotionCandidate[]): PromotionCandidate[] {
  const seen = new Set<string>();
  const out: PromotionCandidate[] = [];
  for (const c of cands) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

export const retroMinerHandler: Node<RetroMinerWith, Record<string, unknown>> = async (
  input,
  ctx,
) => {
  const cfg = (input ?? {}) as RetroMinerWith;
  // security by absence (Inv. 14): ohne granteten Tape-Zugriff existiert ctx.traces nicht — kein
  // runtime-permission-check, sondern ein klarer Fehler, dass die Node nicht freigegeben wurde.
  if (ctx.traces === undefined) {
    throw new Error(
      "retro-miner node: ctx.traces nicht injiziert — security by absence (Inv. 14): die Node wurde " +
        'nicht für Tape-Zugriff freigegeben (requests tools:["traces:read"] + Policy-Grant nötig).',
    );
  }
  const query: TraceQuery = cfg.runs !== undefined ? { runs: cfg.runs } : {};
  // Eigene Infrastruktur-Frames ausschließen (Review-Befund B): die Node liest über ANDERE Features,
  // nicht über sich selbst (s. RETRO_INFRA_NODE_TYPES).
  const frames = (await ctx.traces.collect(query)).filter(
    (f) => !RETRO_INFRA_NODE_TYPES.has(f.nodeType),
  );

  const feature = cfg.feature;
  const featureOf = feature !== undefined ? (): string => feature : undefined;
  const which = cfg.miners ?? ALL_MINERS;
  const found: PromotionCandidate[] = [...(cfg.prior ?? [])];

  if (which.includes("determinism")) {
    const opts: DeterminismMinerOptions = {
      ...(cfg.minSupport !== undefined ? { minSupport: cfg.minSupport } : {}),
      ...(cfg.minDeterminism !== undefined ? { minDeterminism: cfg.minDeterminism } : {}),
      ...(cfg.intelligenceNodeTypes !== undefined
        ? { intelligenceNodeTypes: cfg.intelligenceNodeTypes }
        : {}),
      ...(featureOf !== undefined ? { featureOf } : {}),
    };
    found.push(...mineDeterminism(frames, opts));
  }
  if (which.includes("flaky-retry")) {
    const opts: FlakyRetryMinerOptions = {
      ...(cfg.minFailures !== undefined ? { minFailures: cfg.minFailures } : {}),
      ...(cfg.retryableThreshold !== undefined ? { retryableThreshold: cfg.retryableThreshold } : {}),
      ...(featureOf !== undefined ? { featureOf } : {}),
    };
    found.push(...mineFlakyRetry(frames, opts));
  }
  // Die weiteren tape-getreuen Miner (advisory; v0.1 nutzen sie nur die geteilte featureOf-Option, ihre
  // Schwellwerte bleiben auf Default — feinere Konfiguration ist ein späterer Schritt).
  const ext: MinerFeatureOption = featureOf !== undefined ? { featureOf } : {};
  if (which.includes("loop-bound")) found.push(...mineLoopBound(frames, ext));
  if (which.includes("elicitation")) found.push(...mineElicitations(frames, ext));
  if (which.includes("model-right-sizing")) found.push(...mineModelRightSizing(frames, ext));
  if (which.includes("redaction-leak")) found.push(...mineRedactionLeaks(frames, ext));
  if (which.includes("fail-fast")) found.push(...mineFailFast(frames, ext));
  if (which.includes("drift")) found.push(...mineDrift(frames, ext));
  // Process-Mining-Discovery (Doc §6): mineVariants/mineDfg nehmen ProcessDiscoveryOptions (kein
  // MinerFeatureOption — sie kennen kein featureOf; `minSupport` ist die einzige geteilte Option).
  const pmOpts: ProcessDiscoveryOptions = cfg.minSupport !== undefined ? { minSupport: cfg.minSupport } : {};
  if (which.includes("variants")) found.push(...mineVariants(frames, pmOpts));
  if (which.includes("dfg")) found.push(...mineDfg(frames, pmOpts));

  const candidates = dedupeById(found);
  const result: Resolved<Record<string, unknown>> = {
    status: "resolved",
    // Output-Key fest "candidates" — der retro-complete-Gate liest genau diesen Key (Review-Befund A).
    output: { candidates, candidateCount: candidates.length },
    confidence: 1,
    cost: {}, // reine Analyse über bereits getapte Daten — keine LLM-/Side-Effect-Kosten.
  };
  return result;
};

/**
 * Built-in retro-miner-Node (Inv. 6 — built-in == custom). Fordert "traces:read" an ("*"-Semantik wie
 * andere Caps: die Policy verschärft). Ohne Policy-Grant wird ctx.traces nicht injiziert und die Node
 * failt klar — sie liest sonst nichts (security by absence, Inv. 14).
 */
export const retroMinerNode: NodeDefinition<RetroMinerWith, Record<string, unknown>> = {
  type: "retro-miner",
  klass: "orchestration",
  handler: retroMinerHandler,
  requests: { tools: ["traces:read"] },
};

// ───────────────────────────── retro-complete: Eval-Gate (Inv. 1) ─────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Eval-Gate des retro.orchestrator: bestätigt, dass ein candidate-set produziert wurde. Mining ist
 * EIN-SCHUSS (kein Konvergenz-Loop), darum genügt die Anwesenheit eines `candidates`-Arrays im Artefakt —
 * der Runner ruft den Gate nach dem mine-Step (runner.ts), das Array ist dann via applyTo im content.
 */
export const retroCompleteHandler: Node<unknown, GateVerdict> = (_input, ctx) => {
  const content = ctx.artifact.content;
  const candidates = isRecord(content) ? content["candidates"] : undefined;
  const verdict: GateVerdict = Array.isArray(candidates)
    ? { passed: true, score: 1, failures: [] }
    : { passed: false, score: 0, failures: ["retro-complete: noch kein candidate-set im Artefakt"] };
  return Promise.resolve({ status: "resolved", output: verdict, confidence: 1, cost: {} });
};

/** Built-in Eval-Gate-Node für den retro.orchestrator. */
export const retroCompleteNode: NodeDefinition<unknown, GateVerdict> = {
  type: "retro-complete",
  klass: "orchestration",
  handler: retroCompleteHandler,
};
