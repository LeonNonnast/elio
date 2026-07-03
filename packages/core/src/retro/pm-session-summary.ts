// ───────────────────────────── pm.session-summary — der Summarizer (LLM, 1×/Session, Doc §3.2, Slice 3b) ─────────────────────────────
// Ein FeaturePack, das beim SessionEnd die Events EINER Session zu einer `SessionSummary` (Doc §5) verdichtet
// und idempotent (über `session`) in die durable `SummaryStore` schreibt. Saubere Trennung INNERHALB des
// Features: das Deterministische bleibt deterministisch (stats/persist), das LLM macht nur das semantische
// `intent`-Label. Es ist das EINZIGE pm-Feature mit AI — bewusst isoliert, einmal pro Session.
//
// Graph (stats → label → persist):
//   stats   (custom) liest ctx.traces der Session (variant/fingerprint/toolHistogram/cost/durationMs/steps/
//                    window — rein deterministisch), legt einen `summaryDraft` (alles AUSSER intent) + einen
//                    `variantText` (für den LLM-Prompt) in den State. FORDERT traces:read an.
//   label   (built-in llm) erzeugt das semantische intent[] aus der Aktivitätsfolge. KEIN gepinntes Profil am
//                    Step — der Worker routet auf seinen `defaultModel`; offline `mock` (deterministisch), real
//                    z.B. `claude:claude-haiku-4-5` (via defaultModel). So bleibt der Real-Provider-Swap echt.
//   persist (custom) closure-bindet die SummaryStore, merged stats-Draft + LLM-Label → SessionSummary,
//                    ruft `store.upsert` (idempotent über session). FORDERT summaries:write an.
//
// Warum CUSTOM stats/persist (nicht built-in transform/batch)? transform kann nur set/append/take/map — er kann
// weder ctx.traces lesen + variant/fingerprint/histogram berechnen (stats) noch eine SummaryStore-Closure halten
// (persist). Das migrate-Closure-Muster (registerMigrate). label dagegen IST der built-in llm-Node (Doc §3.2).
//
// Capabilities (security by absence, Inv. 14): stats fordert traces:read (sonst kein ctx.traces → wirft);
// persist fordert summaries:write (Store ist per Closure gebunden → die Node setzt den Grant aktiv durch);
// label fordert Modelle (llm-Node, requests.models ["*"]). Die Root-Policy des Laufs trägt alle drei Grants.

import type { Cost } from "../common";
import type { FeaturePack } from "../feature";
import type { GateVerdict, Node, NodeDefinition, Resolved } from "../node";
import type { NodeRegistry } from "../registry";
import type { TapeFrame } from "../run";
import { hashValue } from "./canon";
import type { SessionSummary, SummaryStore } from "./summaries";

/** Node-Typen + Gate-id des pm.session-summary-Packs. */
export const PM_STATS_TYPE = "summary-stats";
export const PM_PERSIST_TYPE = "summary-persist";
export const PM_SUMMARY_GATE_TYPE = "summary-well-formed";

/** Die Capabilities, die der Summarizer braucht (Doc §3.2 policies). */
export const TRACES_READ_PERMISSION = "traces:read";
export const SUMMARIES_WRITE_PERMISSION = "summaries:write";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Liest die Session-id aus dem (template-aufgelösten) Input: ein String ODER ein { session }-Objekt. */
export function readSessionId(input: unknown): string {
  if (typeof input === "string") return input;
  if (isRecord(input)) {
    const s = input["session"] ?? input["session_id"];
    if (typeof s === "string") return s;
  }
  return "";
}

/** Die deterministischen Stats + der summaryDraft (alles AUSSER dem LLM-intent), den `stats` in den State legt. */
export interface SummaryDraft {
  session: string;
  source: string;
  window: { start: string; end: string };
  variant: string[];
  fingerprint: string;
  stats: SessionSummary["stats"];
  outcome: SessionSummary["outcome"];
  evidence: { eventRef: string };
}

/**
 * Berechnet den deterministischen Teil einer SessionSummary aus den (geordneten) Frames EINER Session
 * (Doc §5): variant (nodeType-Folge), fingerprint (hashValue(variant)), toolHistogram, aggregierte
 * cost (usd + tokensIn+tokensOut), durationMs (letztes − erstes `ts`), steps (# Frames), window.
 * Leere Eingabe → ein wohlgeformter Null-Draft (keine Frames ⇒ window leer, steps 0).
 */
export function computeSummaryDraft(session: string, frames: readonly TapeFrame[]): SummaryDraft {
  const variant = frames.map((f) => f.nodeType);
  const fingerprint = hashValue(variant);

  const toolHistogram: Record<string, number> = {};
  for (const a of variant) toolHistogram[a] = (toolHistogram[a] ?? 0) + 1;

  let usd = 0;
  let tokens = 0;
  const source = "claude-code"; // v0.1: feste Quelle (die events-Zeile trägt sie; TapeFrame projiziert sie nicht).
  for (const f of frames) {
    if (f.result.status === "resolved") {
      const c: Cost = f.result.cost;
      if (typeof c.usd === "number") usd += c.usd;
      if (typeof c.tokensIn === "number") tokens += c.tokensIn;
      if (typeof c.tokensOut === "number") tokens += c.tokensOut;
    }
  }

  const tsList = frames.map((f) => f.ts).filter((t) => typeof t === "string" && t.length > 0);
  const start = tsList[0] ?? "";
  const end = tsList[tsList.length - 1] ?? "";
  const durationMs = start !== "" && end !== "" ? Math.max(0, Date.parse(end) - Date.parse(start)) : 0;

  return {
    session,
    source,
    window: { start, end },
    variant,
    fingerprint,
    stats: { steps: frames.length, cost: { usd, tokens }, durationMs, toolHistogram },
    outcome: "passed", // §9: outcome ist Inferenz; v0.1-Default (echte exit_reason-Inferenz später).
    evidence: { eventRef: session },
  };
}

/**
 * Leitet das deterministische `intent[]` aus dem LLM-Label-Text ab. Eine Zeile/Satz je Label; leere/echo-
 * Präfixe werden geduldet (MockModel offline liefert "echo: <prompt>"). Fällt auf [text] zurück, sonst [].
 * Bewusst tolerant — das Label ist semantisch, nicht strukturell; v0.1 nimmt den Text als EIN intent-Label.
 */
export function deriveIntent(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  return [trimmed];
}

/** Liest `stats.steps` defensiv aus dem (Artefakt-)content. -1, wenn nicht ablesbar. */
function readSteps(content: unknown): number {
  if (!isRecord(content)) return -1;
  const stats = content["stats"];
  if (!isRecord(stats)) return -1;
  const steps = stats["steps"];
  return typeof steps === "number" ? steps : -1;
}

/**
 * Eval-Gate: bestätigt eine wohlgeformte SessionSummary im Artefakt-content (session + fingerprint gesetzt UND
 * mindestens EIN erfasstes Event). Die steps>0-Schranke verhindert eine PHANTOM-Summary für eine Session ohne
 * Events: ein nie-erfasstes (Ghost-)Session-id würde sonst eine `passed`-Summary mit leerem variant prägen
 * (eine erfundene "passed"-Zeile, der Clustering/Router fälschlich vertraut). Eine 0-Event-Session ist KEINE
 * wohlgeformte Zusammenfassung — Gate fällt, persist überspringt den Upsert (keine Geister-Zeile).
 */
export const summaryWellFormedHandler: Node<unknown, GateVerdict> = (_input, ctx) => {
  const content = ctx.artifact.content;
  const ok =
    isRecord(content) &&
    typeof content["session"] === "string" &&
    (content["session"] as string).length > 0 &&
    typeof content["fingerprint"] === "string" &&
    readSteps(content) > 0;
  const verdict: GateVerdict = ok
    ? { passed: true, score: 1, failures: [] }
    : {
        passed: false,
        score: 0,
        failures: [
          "summary-well-formed: keine wohlgeformte SessionSummary im Artefakt (session/fingerprint fehlt " +
            "ODER 0 erfasste Events — keine Phantom-Summary für eine unbekannte/leere Session).",
        ],
      };
  return Promise.resolve({ status: "resolved", output: verdict, confidence: 1, cost: {} });
};

/** Built-in Eval-Gate-Node für den pm.session-summary-Pack (reiner Artefakt-Read, kein requests). */
export const summaryWellFormedNode: NodeDefinition<unknown, GateVerdict> = {
  type: PM_SUMMARY_GATE_TYPE,
  klass: "orchestration",
  handler: summaryWellFormedHandler,
};

/** Optionen der pm.session-summary-Node-Registrierung. */
export interface RegisterSessionSummaryOptions {
  /** Die durable summaries-Tabelle, per Closure in `persist` gebunden. Pflicht. */
  summaryStore: SummaryStore;
}

/**
 * Registriert die pm.session-summary-Nodes (stats + persist + Gate) an einer NodeRegistry — idempotent
 * (das migrate-`reg`-Muster). Die SummaryStore wird per Closure in `persist` gebunden. `label` ist der
 * built-in llm-Node und wird NICHT hier registriert (die Runtime trägt ihn via registerBuiltins).
 */
export function registerSessionSummary(registry: NodeRegistry, opts: RegisterSessionSummaryOptions): void {
  const { summaryStore } = opts;
  const reg = (def: NodeDefinition): void => {
    if (!registry.has(def.type)) registry.register(def);
  };

  // ── stats: ctx.traces der Session lesen → deterministischer SummaryDraft + variantText (für den Prompt). ──
  const statsNode: NodeDefinition<
    { session?: unknown },
    { summaryDraft: SummaryDraft; variant: string[]; variantText: string }
  > = {
    type: PM_STATS_TYPE,
    klass: "orchestration",
    requests: { tools: [TRACES_READ_PERMISSION] },
    handler: async (
      input,
      ctx,
    ): Promise<Resolved<{ summaryDraft: SummaryDraft; variant: string[]; variantText: string }>> => {
      if (ctx.traces === undefined) {
        throw new Error(
          "summary-stats node: ctx.traces nicht injiziert — security by absence (Inv. 14): die Node wurde " +
            'nicht für Tape-Zugriff freigegeben (requests tools:["traces:read"] + Policy-Grant nötig).',
        );
      }
      const cfg = (input ?? {}) as { session?: unknown };
      const session = readSessionId(cfg.session);
      // Genau die Frames DIESER Session (= correlation.run) ziehen — die TableTapeSource mappt jede events-Zeile.
      const frames = session.length > 0 ? await ctx.traces.collect({ runs: [session] }) : [];
      const summaryDraft = computeSummaryDraft(session, frames);
      const variantText = summaryDraft.variant.join(" → ");
      return {
        status: "resolved",
        output: { summaryDraft, variant: summaryDraft.variant, variantText },
        confidence: 1,
        cost: { usd: 0 },
      };
    },
  };

  // ── persist: stats-Draft + LLM-Label → SessionSummary; idempotenter Upsert über session. ──
  // FORDERT summaries:write an. Store ist per Closure gebunden (nicht ctx.db) → die Node setzt den Grant aktiv
  // durch: fehlt er in der resolvten Policy, wirft sie (fail-closed, Inv. 14).
  const persistNode: NodeDefinition<{ draft?: unknown; intentText?: unknown }, SessionSummary> = {
    type: PM_PERSIST_TYPE,
    klass: "orchestration",
    requests: { tools: [SUMMARIES_WRITE_PERMISSION] },
    handler: async (input, ctx): Promise<Resolved<SessionSummary>> => {
      if (!ctx.policy.toolPermissions.includes(SUMMARIES_WRITE_PERMISSION)) {
        throw new Error(
          `summary-persist node: "${SUMMARIES_WRITE_PERMISSION}" nicht gewährt — security by absence (Inv. 14): ` +
            "der Lauf wurde nicht zum Schreiben der summaries-Tabelle freigegeben (Root-Policy gewährt den " +
            "summaries:write-toolPermission nicht).",
        );
      }
      const cfg = (input ?? {}) as { draft?: unknown; intentText?: unknown };
      const draft = (isRecord(cfg.draft) ? cfg.draft : {}) as unknown as SummaryDraft;
      const intent = deriveIntent(cfg.intentText);
      const summary: SessionSummary = {
        session: draft.session,
        source: draft.source,
        window: draft.window,
        intent,
        variant: draft.variant,
        fingerprint: draft.fingerprint,
        stats: draft.stats,
        outcome: draft.outcome,
        evidence: draft.evidence,
      };
      // Phantom-Schutz: eine 0-Event-Session (unbekannte/leere/Ghost-session-id) NICHT persistieren — sonst
      // entstünde eine erfundene "passed"-Zeile mit leerem variant. Wir geben die (Null-)Summary trotzdem ins
      // Artefakt zurück, damit das summary-well-formed-Gate sie sieht und ablehnt (steps>0) → gate stopped.
      const steps = typeof draft.stats?.steps === "number" ? draft.stats.steps : 0;
      const stored = steps > 0 ? await summaryStore.upsert(summary) : summary;
      return { status: "resolved", output: stored, confidence: 1, cost: { usd: 0 } };
    },
  };

  reg(statsNode as unknown as NodeDefinition);
  reg(persistNode as unknown as NodeDefinition);
  reg(summaryWellFormedNode as unknown as NodeDefinition);
}

/**
 * Das pm.session-summary-Feature-Pack (autonomy static, artifact session-summary, evalGate summary-well-formed).
 * Der einzige pm-Pack mit AI (label-Step). Die Session-id reist als `RunInput.payload` → `state.input`.
 *
 * KEIN `policies`-Feld (wie pm.discover/pm.event-log): traces:read/summaries:write sind Root-Policy-
 * toolPermissions, KEINE PolicyRegistry-ids. Die Nodes fordern sie an; die Root-Policy des Laufs trägt die
 * Grants (setupSessionSummary). Der `label`-Step pinnt KEIN Provider-Profil: der Worker routet auf seinen
 * `defaultModel` (offline "mock", real z.B. "claude:claude-haiku-4-5") — so bleibt der Real-Provider-Swap echt.
 */
export const pmSessionSummaryPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "pm.session-summary", version: "0.1.0", owner: "process-mining" },
  contentHash: "pm.session-summary@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "session-summary", evalGate: PM_SUMMARY_GATE_TYPE },
    io: { input: {}, output: {} },
    graph: {
      steps: [
        // stats: ctx.traces der Session → deterministischer Draft (+ variantText für den Prompt).
        {
          id: "stats",
          type: PM_STATS_TYPE,
          with: { session: "{{state.input}}" },
          outputs: { summaryDraft: "state.summaryDraft", variantText: "state.variantText" },
        },
        // label: built-in llm — semantisches intent-Label aus der Aktivitätsfolge. KEIN gepinntes Provider-
        // Profil am Step: der Worker routet auf seinen `defaultModel` (offline "mock" via setupSessionSummary,
        // real z.B. "claude:claude-haiku-4-5" via defaultModel). Ein am Step gepinntes `provider: "mock"` würde
        // den Pack an den offline-Mock fesseln und die dokumentierte Real-Provider-Swapbarkeit toten Code machen
        // (mit einer realen ProviderMap ohne "mock"-Key würfe der Worker `no provider registered for "mock"`).
        {
          id: "label",
          type: "llm",
          with: {
            prompt:
              "Summarize the intent of this agent session as a short label. " +
              "Activity sequence: {{state.variantText}}",
            as: "text",
          },
          outputs: { text: "state.intentText" },
        },
        // persist: stats-Draft + LLM-Label → SessionSummary; idempotenter Upsert über session.
        {
          id: "persist",
          type: PM_PERSIST_TYPE,
          with: { draft: "{{state.summaryDraft}}", intentText: "{{state.intentText}}" },
        },
      ],
      edges: [
        { from: "stats", to: "label" },
        { from: "label", to: "persist" },
      ],
    },
  },
};
