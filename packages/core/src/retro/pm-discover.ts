// ───────────────────────────── pm.discover — der lauffähige Process-Discovery-Loop (Doc §3.3/§6, Slice 3a) ─────────────────────────────
// Ein FeaturePack, das die beobachteten Sessions gegen einen Prozess-Katalog routet (process-route) und —
// solange noch UNBEKANNTE Sessions existieren — die Discovery-Miner (variants + dfg) über ctx.traces fährt
// und die Kandidaten ins durable Artefakt (kind "promotion-candidate-set") aggregiert. EIN-SCHUSS + read-only:
// kein Konvergenz-Loop, kein featureStore:write. Lauffähig über den OuterLoopRunner.
//
// Graph (route → mine):
//   route  (process-route)  klassifiziert jede Session; setzt state.classification ("unknown"|"known").
//   mine   (retro-miner)    fährt explizit die Discovery-Miner (with.miners ["variants","dfg"]).
//   Edge route→mine  when "state.classification == 'unknown'": nur wenn es unbekannte Sessions gibt, wird
//                    gemint (leerer Katalog ⇒ alle unknown ⇒ mine läuft — Bootstrapping, Doc §5).
//
// Warum ein SEPARATER Pack (nicht der retro.orchestrator)? Beide fahren `retro-miner`, aber pm.discover pinnt
// `with.miners` explizit auf die Discovery-Miner — die Conformance-Route + die Discovery-Semantik sind eine
// eigene Vertikale, unabhängig von der Default-Miner-Suite des retro.orchestrator.
//
// Damit ctx.traces injiziert wird (security by absence, Inv. 14), MUSS die Root-Policy des Laufs
// "traces:read" gewähren (s. `policies`/Runtime-rootPolicy). Ohne Grant failt route/mine klar.

import type { FeaturePack } from "../feature";
import type { GateVerdict, Node, NodeDefinition } from "../node";
import type { NodeRegistry } from "../registry";
import type { ProcessSignature } from "./process";
import { createProcessRouteNode, PROCESS_ROUTE_TYPE } from "./process-route";

/** Node-Typ + Gate-id des pm.discover-Eval-Gates. */
export const PM_DISCOVER_COMPLETE_TYPE = "discovery-complete";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Eval-Gate des pm.discover (mirror von retro-complete): bestätigt, dass ein candidate-set produziert wurde.
 * Discovery ist EIN-SCHUSS (kein Konvergenz-Loop), darum genügt die Anwesenheit eines `candidates`-Arrays im
 * Artefakt — der Runner faltet den retro-miner-Output via applyTo flach in den content.
 */
export const pmDiscoverCompleteHandler: Node<unknown, GateVerdict> = (_input, ctx) => {
  const content = ctx.artifact.content;
  const candidates = isRecord(content) ? content["candidates"] : undefined;
  const verdict: GateVerdict = Array.isArray(candidates)
    ? { passed: true, score: 1, failures: [] }
    : {
        passed: false,
        score: 0,
        failures: ["discovery-complete: noch kein candidate-set im Artefakt"],
      };
  return Promise.resolve({ status: "resolved", output: verdict, confidence: 1, cost: {} });
};

/** Built-in Eval-Gate-Node für den pm.discover-Pack (reiner Artefakt-Read, kein requests). */
export const pmDiscoverCompleteNode: NodeDefinition<unknown, GateVerdict> = {
  type: PM_DISCOVER_COMPLETE_TYPE,
  klass: "orchestration",
  handler: pmDiscoverCompleteHandler,
};

/** Optionen der pm.discover-Node-Registrierung. */
export interface RegisterProcessMiningNodesOptions {
  /** Prozess-Katalog hinter der process-route-Node (per Closure gebunden). Default: leer ⇒ alle unknown. */
  catalog?: readonly ProcessSignature[];
}

/**
 * Registriert die pm.discover-spezifischen Nodes (die katalog-gebundene process-route-Node + den
 * discovery-complete-Gate) an einer NodeRegistry. Idempotent: bereits registrierte Typen werden NICHT
 * überschrieben (das migrate-`reg`-Muster). `retro-miner` (der mine-Step) ist bereits ein Built-in und wird
 * NICHT hier registriert — pm.discover setzt nur `with.miners` darauf.
 */
export function registerProcessMiningNodes(
  registry: NodeRegistry,
  opts: RegisterProcessMiningNodesOptions = {},
): void {
  const reg = (def: NodeDefinition): void => {
    if (!registry.has(def.type)) registry.register(def);
  };
  reg(createProcessRouteNode(opts.catalog ?? []) as unknown as NodeDefinition);
  reg(pmDiscoverCompleteNode as unknown as NodeDefinition);
}

/**
 * Das pm.discover-Feature-Pack (autonomy static, artifact promotion-candidate-set, evalGate discovery-complete).
 *
 * KEIN `policies`-Feld: "traces:read" ist KEINE Pack-Policy (eine Policy-id im PolicyRegistry), sondern ein
 * Root-Policy-`toolPermission` (s. ../traces:allowedTraceScopes). Die route/mine-Nodes FORDERN
 * `requests.tools = ["traces:read"]` an; die Root-Policy des Laufs muss den Grant tragen (security by absence,
 * Inv. 14) — setupProcessMining setzt dafür `rootPolicy({ toolPermissions: ["traces:read"] })`. Ein
 * `policies: ["traces:read"]` würde den Runner werfen lassen (keine so benannte Policy registriert), exakt wie
 * der retro.orchestrator-Pack daher auch kein `policies`-Feld trägt.
 */
export const pmDiscoverPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "pm.discover", version: "0.1.0", owner: "process-mining" },
  contentHash: "pm.discover@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "promotion-candidate-set", evalGate: PM_DISCOVER_COMPLETE_TYPE },
    io: { input: {}, output: {} },
    graph: {
      steps: [
        // route: klassifiziert jede Session gegen den Katalog; setzt state.classification.
        { id: "route", type: PROCESS_ROUTE_TYPE },
        // mine: fährt EXPLIZIT die Discovery-Miner (nicht die volle Default-Suite). Der retro-miner-Output
        // ("candidates"/"candidateCount") wird via applyTo flach ins Artefakt-content gefaltet → der Gate liest ihn.
        { id: "mine", type: "retro-miner", with: { miners: ["variants", "dfg"] } },
      ],
      edges: [
        // Nur minen, wenn es UNBEKANNTE Sessions gibt (leerer Katalog ⇒ alle unknown ⇒ mine läuft, Doc §5).
        { from: "route", to: "mine", when: "state.classification == 'unknown'" },
      ],
    },
  },
};
