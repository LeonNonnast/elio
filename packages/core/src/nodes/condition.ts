// ───────────────────────────── Built-in: condition (Inv. 6/7, klass "orchestration") ─────────────────────────────
// Boolean-Prädikat über den (template-aufgelösten) State (Klasse 1, kein Denken): wertet eine Bedingung
// aus und liefert Resolved<{ passed }>. Kontrast zu router (wählt EINE aus N Routen): condition ist der
// boolean-Zweig (passed true/false). Reine Funktion (input, ctx) => NodeResult.

import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer condition-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst.
 * Auswahl-Strategien (Reihenfolge der Erkennung):
 *  - { predicate: (value)=>bool, value? }  -> passed = predicate(value) (Code-Node-Pfad).
 *  - { value: <a>, equals: <b> }           -> passed = (a === b).
 *  - { value: <a>, gt | gte | lt | lte }   -> numerischer Vergleich.
 *  - { value: <x> }                         -> passed = truthy(x).
 * `as` (Default "passed") bestimmt den Output-Feldnamen.
 */
export interface ConditionWith {
  value?: unknown;
  predicate?: (value: unknown) => boolean;
  equals?: unknown;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  /** Output-Feldname (Default "passed"). */
  as?: string;
}

function truthy(v: unknown): boolean {
  return Boolean(v) && !(Array.isArray(v) && v.length === 0);
}

/** Wertet das Prädikat deterministisch aus. */
function evaluate(cfg: ConditionWith): boolean {
  const value = cfg.value;

  if (cfg.predicate !== undefined) {
    return cfg.predicate(value);
  }
  if ("equals" in cfg) {
    return value === cfg.equals;
  }
  if (typeof cfg.gt === "number") return typeof value === "number" && value > cfg.gt;
  if (typeof cfg.gte === "number") return typeof value === "number" && value >= cfg.gte;
  if (typeof cfg.lt === "number") return typeof value === "number" && value < cfg.lt;
  if (typeof cfg.lte === "number") return typeof value === "number" && value <= cfg.lte;

  return truthy(value);
}

/**
 * condition-Handler: deterministisch, kostenfrei, volle Confidence. Liefert Resolved<{ passed }>
 * (bzw. unter `as`). Eine when-Edge verzweigt darauf (z.B. `when: state.passed`).
 */
export const conditionHandler: Node<ConditionWith, unknown> = async (input) => {
  const cfg = (input ?? {}) as ConditionWith;
  let passed: boolean;
  try {
    passed = evaluate(cfg);
  } catch (e) {
    throw new Error(
      `condition node: predicate threw: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const key = cfg.as ?? "passed";
  const result: Resolved = {
    status: "resolved",
    output: { [key]: passed },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

/** Registrierbare Definition der built-in condition-Node (Inv. 6 — built-in == custom). */
export const conditionNode: NodeDefinition<ConditionWith, unknown> = {
  type: "condition",
  klass: "orchestration",
  handler: conditionHandler,
};
