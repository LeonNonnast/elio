// ───────────────────────────── Built-in: subworkflow (Inv. 6/7/8, klass "orchestration") ─────────────────────────────
// Minimaler nested-Outer-Loop / Inv. 8-Mechanismus: die subworkflow-Node fächert über `input.forEach`
// (ein Array aus dem branchState) und spawnt EINEN Kind-Branch pro Item:
//   branch id = parentBranch + "/" + (item.id ?? index)
// Jeder Kind-Branch läuft `with.steps` mit einem EIGENEN, frischen branchState (KEIN Aliasing zwischen
// Items); alle Kinder teilen sich das Run-Artefakt über dessen Data-Holder (Inv. 22). Jedes
// per-item-Ergebnis landet in einem disjoint-key DbStateHolder (keyed by item id) — Keys kollidieren
// nie (§11/#6), egal in welcher Reihenfolge die Kinder fertig werden. Den Holder-Write übernimmt der
// Runner bei Kind-Completion (sowohl First-Pass als auch Resume eines parked Kindes), damit das
// Artefakt unabhängig von der Resume-Reihenfolge identisch wird.
//
// Parkt ein Kind auf einer Elicitation (z.B. approval, mode "parked"), speichert der Runner dessen
// Checkpoint und die subworkflow fährt mit den übrigen Kindern FORT (ein parked Geschwister blockt
// die anderen NICHT, §6 / Inv. 12). Parked Kinder sind später per correlation-id via runner.resume()
// resumebar.
//
// Bewusst NUR der Mechanismus: der volle per-record Idempotenz-Effect-Ledger + Batch-Commit der
// Migrate-Vertikale bleibt Slice 6 (§7, §11/#11).

import { getChildExecutor } from "../branch";
import type { ChildBranchSpec } from "../branch";
import type { CorrelationId } from "../elicitation";
import type { Node, NodeDefinition, Resolved } from "../node";
import type { StepRef } from "../feature";

/**
 * Konfiguration einer subworkflow-Node. `with` ist via `resolveInput` bereits template-aufgelöst,
 * d.h. `forEach` trägt schon das konkrete Array aus dem branchState (z.B. `{{state.items}}`).
 *  - forEach: das Array, über das gefächert wird (ein Kind-Branch pro Element).
 *  - steps:   die Steps, die jeder Kind-Branch ausführt (linear; Edges werden synthetisiert).
 *  - itemKey: unter welchem Key das Item dem Kind-branchState bereitgestellt wird (Default "item").
 */
export interface SubworkflowWith {
  forEach?: unknown;
  steps?: StepRef[];
  itemKey?: string;
}

interface SubItem {
  id: string;
  index: number;
  value: unknown;
}

/** Normalisiert ein forEach-Element zu { id, index, value }. id = element.id ?? String(index). */
function toItem(value: unknown, index: number): SubItem {
  let id = String(index);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const maybe = (value as Record<string, unknown>)["id"];
    if (typeof maybe === "string" && maybe.length > 0) id = maybe;
    else if (typeof maybe === "number") id = String(maybe);
  }
  return { id, index, value };
}

/**
 * subworkflow-Handler: fächert über forEach, fährt jeden Kind-Branch über den (vom Runner pro Run
 * bereitgestellten) ChildBranchExecutor bis completion-or-park und sammelt completed/parked ids. Der
 * disjoint-key Holder-Write erfolgt im Runner (bei Kind-Completion). Die subworkflow parkt selbst
 * nie — der Run hält nicht an, weil ein Kind parkt (§6).
 *
 * Rückgabe (Resolved): aggregierter Output
 *   { results: <record[]>, completed: <id[]>, parked: <{ id, correlation }[]>, total: <n> }
 */
export const subworkflowHandler: Node<SubworkflowWith, unknown> = async (input, ctx) => {
  const cfg = (input ?? {}) as SubworkflowWith;
  const items = Array.isArray(cfg.forEach) ? cfg.forEach : [];
  const steps = Array.isArray(cfg.steps) ? cfg.steps : [];
  const itemKey = cfg.itemKey ?? "item";

  const exec = getChildExecutor(ctx.correlation.run);
  if (exec === undefined) {
    // Kein Executor verdrahtet -> die subworkflow kann keine Kind-Branches fahren. Das ist ein
    // Runner-Verdrahtungsfehler (der Runner registriert den Executor pro Run), kein Node-Fehler.
    throw new Error(
      `subworkflow node: kein ChildBranchExecutor für run "${ctx.correlation.run}" registriert ` +
        `(der OuterLoopRunner muss ihn vor dem Antreiben registrieren).`,
    );
  }

  const parentBranch = ctx.correlation.branch;
  const completed: string[] = [];
  const parked: { id: string; correlation: CorrelationId }[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = toItem(items[i], i);
    const spec: ChildBranchSpec = {
      branch: `${parentBranch}/${item.id}`,
      // Eigener, frischer State pro Kind (kein Aliasing): das Item + seine id/index.
      initialState: { [itemKey]: item.value, id: item.id, index: item.index },
      steps,
    };

    const { outcome } = await exec.runChild(spec);

    if (outcome.kind === "suspended") {
      // Parked (oder blocking): Checkpoint liegt bereits (vom Runner) — Geschwister laufen weiter.
      parked.push({ id: item.id, correlation: outcome.correlation });
      continue;
    }
    completed.push(item.id);
  }

  // Aggregat: der aktuelle Stand des disjoint-key Holders (alle bislang completed Records).
  const records = await readDbState(ctx);
  const result: Resolved = {
    status: "resolved",
    output: {
      results: records,
      completed,
      parked: parked.map((p) => ({ id: p.id, correlation: p.correlation })),
      total: items.length,
    },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

/** Liest den aktuellen Stand des disjoint-key db-state-Holders (oder [] wenn keiner existiert). */
async function readDbState(ctx: import("../ctx").Ctx): Promise<unknown[]> {
  for (const holder of Object.values(ctx.artifact.holders)) {
    if (holder.kind === "db-state" && holder.concurrency === "disjoint-key") {
      return (await holder.read()) as unknown[];
    }
  }
  return [];
}

/** Registrierbare Definition der built-in subworkflow-Node (Inv. 6 — built-in == custom). */
export const subworkflowNode: NodeDefinition<SubworkflowWith, unknown> = {
  type: "subworkflow",
  klass: "orchestration",
  handler: subworkflowHandler,
};
