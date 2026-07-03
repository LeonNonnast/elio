// ───────────────────────────── pm.discover — Conformance-Route-Node (Doc §6, Slice 3a) ─────────────────────────────
// Die read-only Routing-Node des pm.discover-Feature-Packs: sie klassifiziert JEDE beobachtete Session
// (eine `correlation.run`-Gruppe der getapten Frames) gegen einen INJIZIERTEN Prozess-Katalog
// (`classifySession`, ../process). Ein leerer Katalog → jede Session ist `unknown` (Bootstrapping, Doc §5):
// es gibt noch kein bekanntes Muster, also gehört JEDE Session in die Discovery.
//
// Anders als der built-in `router` (rein deterministische Literal-/cases-Auswahl) muss diese Node (a) den
// Katalog per CLOSURE gebunden bekommen (er ist kein template-auflösbarer Input) und (b) ctx.traces lesen,
// um pro Session den Directly-Follows-Footprint zu bauen — darum eine eigene Node (das migrate-Closure-Muster),
// kein built-in. Sie MUTIERT NICHTS (read-only, off the hot path): `requests.tools = ["traces:read"]`,
// security by absence (Inv. 14) — ohne Grant existiert ctx.traces nicht und die Node failt klar.
//
// Output: `state.classification` (der STRING "unknown" | "known") für die Folge-Edge
// `when: state.classification == 'unknown'` (der Runner-`evalWhen` vergleicht gegen ein String-Literal, kein
// Objekt), plus eine per-Session-Aufstellung (`sessionClassifications`) ins Artefakt-content (Provenance).

import type { Node, NodeDefinition, Resolved } from "../node";
import type { TapeFrame } from "../run";
import { classifySession, directlyFollows } from "./process";
import type { ProcessSignature } from "./process";

/** Node-Typ der Conformance-Route-Node (built-in == custom, Inv. 6). */
export const PROCESS_ROUTE_TYPE = "process-route";

/** Die Aktivitätsfolge (nodeTypes) einer Session = die geordneten Frames auf ihre nodeTypes projiziert. */
function variantOf(frames: readonly TapeFrame[]): string[] {
  return frames.map((f) => f.nodeType);
}

/** Pro-Session-Klassifikation, die ins Artefakt-content gespiegelt wird (Provenance/Debug). */
export interface SessionClassification {
  /** session id (= correlation.run). */
  run: string;
  classification: "known" | "unknown";
  /** id des best-passenden Katalog-Prozesses (falls known). */
  matched?: string;
  /** beste Directly-Follows-Jaccard-Ähnlichkeit zum Katalog. */
  similarity: number;
}

/** Output der process-route-Node (flach in den State gemerged → speist die `when`-Edge). */
export interface ProcessRouteOutput extends Record<string, unknown> {
  /** Aggregierter Routing-Entscheid: "unknown", sobald MINDESTENS eine Session unbekannt ist (→ Discovery). */
  classification: "known" | "unknown";
  /** Pro-Session-Aufschlüsselung (deterministisch nach run sortiert). */
  sessionClassifications: SessionClassification[];
}

/** Konfiguration der process-route-Node (via `with`). */
export interface ProcessRouteWith {
  /** Auf diese Runs/Sessions einschränken; fehlt → alle (read-)erlaubten Sessions. */
  runs?: string[];
  /** Conformance-Schwellwert (Directly-Follows-Jaccard ≥ theta → known). Default 0.8 (classifySession). */
  theta?: number;
}

/**
 * Baut die Conformance-Route-Node mit dem per Closure gebundenen Katalog (das migrate-Closure-Muster).
 * Sie liest ctx.traces, gruppiert die Frames per `correlation.run`, klassifiziert jede Session gegen den
 * Katalog und schreibt den aggregierten Entscheid nach `state.classification` (String).
 *
 * Aggregation: `unknown`, sobald mindestens EINE Session unbekannt ist — dann gibt es etwas zu entdecken und
 * die `when: state.classification == 'unknown'`-Edge feuert den mine-Step. Leerer Katalog → alle Sessions
 * unknown → mine läuft (Bootstrapping, Doc §5). Keine Sessions → `unknown` (nichts ausgeschlossen; der
 * mine-Step liefert dann schlicht keine Kandidaten).
 */
export function createProcessRouteNode(
  catalog: readonly ProcessSignature[] = [],
): NodeDefinition<ProcessRouteWith, ProcessRouteOutput> {
  const handler: Node<ProcessRouteWith, ProcessRouteOutput> = async (input, ctx) => {
    const cfg = (input ?? {}) as ProcessRouteWith;
    // security by absence (Inv. 14): ohne granteten Tape-Zugriff existiert ctx.traces nicht — klarer Fehler,
    // dass die Node nicht für Tape-Zugriff freigegeben wurde (analog retro-miner).
    if (ctx.traces === undefined) {
      throw new Error(
        "process-route node: ctx.traces nicht injiziert — security by absence (Inv. 14): die Node wurde " +
          'nicht für Tape-Zugriff freigegeben (requests tools:["traces:read"] + Policy-Grant nötig).',
      );
    }
    const frames = await ctx.traces.collect(cfg.runs !== undefined ? { runs: cfg.runs } : {});

    // Pro Session (correlation.run) gruppieren — die Klassifikations-Einheit des Routers.
    const byRun = new Map<string, TapeFrame[]>();
    for (const f of frames) {
      const run = f.correlation.run;
      const bucket = byRun.get(run);
      if (bucket === undefined) byRun.set(run, [f]);
      else bucket.push(f);
    }

    const sessionClassifications: SessionClassification[] = [];
    let anyUnknown = false;
    // Über sortierte run-ids ⇒ deterministische Reihenfolge der Aufstellung.
    for (const run of [...byRun.keys()].sort()) {
      const sessionFrames = byRun.get(run) as TapeFrame[];
      const variant = variantOf(sessionFrames);
      const sig = { variant, follows: directlyFollows(variant) };
      const res =
        cfg.theta !== undefined
          ? classifySession(sig, catalog, cfg.theta)
          : classifySession(sig, catalog);
      if (res.classification === "unknown") anyUnknown = true;
      sessionClassifications.push({
        run,
        classification: res.classification,
        ...(res.matched !== undefined ? { matched: res.matched } : {}),
        similarity: res.similarity,
      });
    }

    // Leere Beobachtung (keine Session) ⇒ "unknown" (nichts wird ausgeschlossen; mine liefert dann 0 Kandidaten).
    const classification: "known" | "unknown" =
      sessionClassifications.length === 0 || anyUnknown ? "unknown" : "known";

    const result: Resolved<ProcessRouteOutput> = {
      status: "resolved",
      output: { classification, sessionClassifications },
      confidence: 1,
      cost: {}, // reine Analyse über bereits getapte Daten — keine LLM-/Side-Effect-Kosten.
    };
    return result;
  };

  return {
    type: PROCESS_ROUTE_TYPE,
    klass: "orchestration",
    handler,
    requests: { tools: ["traces:read"] },
  };
}
