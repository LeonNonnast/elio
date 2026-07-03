// ───────────────────────────── Built-in: feature-ref (Inv. 6/8, klass "orchestration") ─────────────────────────────
// Registry-driven Fan-out (§3): fächert über `with.featureIds` und fährt JEDES referenzierte Sub-Feature
// als eigenen Kind-Branch — mit seiner echten Graph-Topologie UND eigener Governance (Pack), nicht inline-
// Steps wie subworkflow. Damit kann z.B. der retro.orchestrator je registrierter Retro ein Sub-Feature
// fahren, ohne den Pack zu ändern (neue Retro = registrieren). Wie subworkflow gate-los und auf dem
// geteilten Run-Artefakt; ein parkendes Kind blockt die Geschwister nicht.
//
// v0.1-Grenze (ehrlich): das Kind ist gate-los (das Sub-Feature-Eval-Gate läuft NICHT als Kind). Parkt ein
// Kind und wird später resumed, fehlt der Sub-Pack im Checkpoint → der Resume läuft unter der Parent-
// Governance (der Sub-Graph reist im childGraph mit, der Sub-Pack nicht). Für nicht-parkende Fan-outs
// (read-only Retros) ist beides irrelevant.

import { getChildExecutor, getFeatureResolver } from "../branch";
import type { ChildBranchSpec } from "../branch";
import type { CorrelationId } from "../elicitation";
import type { Node, NodeDefinition, Resolved } from "../node";

export interface FeatureRefWith {
  /** Die per id zu fahrenden Sub-Features (ein Kind-Branch pro id). */
  featureIds?: string[];
}

export const featureRefHandler: Node<FeatureRefWith, unknown> = async (input, ctx) => {
  const cfg = (input ?? {}) as FeatureRefWith;
  // Deduplizieren (Review-Befund): eine doppelte id liefe zweimal in DIESELBE Kind-branch-id und der
  // zweite disjoint-key-Write überschriebe still den ersten. Jede Sub-Feature-id läuft genau einmal.
  const ids = [...new Set(Array.isArray(cfg.featureIds) ? cfg.featureIds : [])];

  const exec = getChildExecutor(ctx.correlation.run);
  if (exec === undefined) {
    throw new Error(
      `feature-ref node: kein ChildBranchExecutor für run "${ctx.correlation.run}" registriert.`,
    );
  }
  const resolver = getFeatureResolver(ctx.correlation.run);
  if (resolver === undefined) {
    throw new Error(
      "feature-ref node: keine FeatureRegistry verdrahtet (OuterLoopRunnerDeps.featureRegistry) — " +
        "registry-driven fan-out nicht freigegeben.",
    );
  }

  const parentBranch = ctx.correlation.branch;
  const completed: string[] = [];
  const parked: { id: string; correlation: CorrelationId }[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    const pack = resolver.resolve(id);
    if (pack === undefined || pack.feature.graph === undefined) {
      missing.push(id); // unbekanntes / graph-loses Sub-Feature → übersprungen (kein harter Fehler)
      continue;
    }
    const spec: ChildBranchSpec = {
      branch: `${parentBranch}/${id}`,
      initialState: {},
      steps: [],
      graph: pack.feature.graph,
      pack,
    };
    const { outcome } = await exec.runChild(spec);
    if (outcome.kind === "suspended") parked.push({ id, correlation: outcome.correlation });
    else completed.push(id);
  }

  const result: Resolved = {
    status: "resolved",
    output: { completed, parked: parked.map((p) => ({ id: p.id, correlation: p.correlation })), missing, total: ids.length },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

export const featureRefNode: NodeDefinition<FeatureRefWith, unknown> = {
  type: "feature-ref",
  klass: "orchestration",
  handler: featureRefHandler,
};
