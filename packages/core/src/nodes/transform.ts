// ───────────────────────────── Built-in: transform (Inv. 6/7, klass "orchestration") ─────────────────────────────
// Reine Daten-Transformation aus `input`/`with` (kein Denken — Klasse 1, deterministische Orchestrierung).
// Unterstützt ein minimales {{state.x}}-Template + ein Op-Set (append/take/map/set), das für die Demos
// (draft-until-good, Migrations-Sample) ausreicht. Eine Node ist eine reine Funktion (input, ctx) => NodeResult.

import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer transform-Node. `with` (über `resolveInput` schon template-aufgelöst) trägt
 * genau eine der folgenden Operationen plus optionale gemeinsame Felder:
 *  - { set: <value> }                       -> output = value
 *  - { append: <chunk>, to?: <base> }       -> output = base + chunk (String-Konkat ODER Array-Push)
 *  - { take: <n>, from?: <array> }          -> output = array.slice(0, n)
 *  - { map: { from: <array>, pick?: string }} -> output = array.map(pick)  (v0.1: pick = ein Feldname)
 * `as` (optional) bestimmt, unter welchem Output-Key das Ergebnis landet, wenn der Step keine
 * `outputs`-Map deklariert (sonst flach via `value`).
 */
export interface TransformWith {
  set?: unknown;
  append?: unknown;
  to?: unknown;
  take?: number;
  from?: unknown;
  map?: { from: unknown; pick?: string };
  /** Output-Feldname (Default "value"), falls der Step keine outputs-Map hat. */
  as?: string;
  /**
   * Optionale nominelle Kosten (USD), die der Runner gegen das Budget bucht (Inv. 21).
   * transform ist deterministisch & im Kern kostenfrei; dieses Feld erlaubt einem Feature,
   * pro Iteration ein Budget-Dekrement zu attribuieren (z.B. für Demo/Throttling). Default 0.
   */
  cost?: number;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

/**
 * Wendet die in `cfg` deklarierte Operation an und liefert den rohen Output-Wert.
 * Reihenfolge der Erkennung ist fix; genau eine Operation wird erwartet.
 */
function applyOp(cfg: TransformWith): unknown {
  // set: direkter Wert.
  if ("set" in cfg && cfg.set !== undefined) {
    return cfg.set;
  }

  // append: String-Konkatenation ODER Array-Append (je nach Basistyp).
  if ("append" in cfg && cfg.append !== undefined) {
    const base = cfg.to;
    if (typeof base === "string" || (base === undefined && typeof cfg.append === "string")) {
      return `${typeof base === "string" ? base : ""}${String(cfg.append)}`;
    }
    if (Array.isArray(base)) {
      return [...base, cfg.append];
    }
    // base undefined + non-string append -> frisches Array.
    return [cfg.append];
  }

  // take: erste n Elemente eines Arrays.
  if (typeof cfg.take === "number") {
    return asArray(cfg.from).slice(0, cfg.take);
  }

  // map: über ein Array; pick zieht ein Feld pro Element (sonst Identität).
  if (cfg.map !== undefined) {
    const src = asArray(cfg.map.from);
    const pick = cfg.map.pick;
    if (pick === undefined) return [...src];
    return src.map((el) =>
      typeof el === "object" && el !== null ? (el as Record<string, unknown>)[pick] : undefined,
    );
  }

  // Keine bekannte Operation -> der ganze (template-aufgelöste) `with`-Block ist der Output.
  // Erlaubt rein deklarative "shape"-Transforms (z.B. { mode: "dry-run" }).
  return cfg;
}

/**
 * transform-Handler: deterministisch, kostenfrei (cost.usd = 0), volle Confidence.
 * Der Input ist bereits via `resolveInput` template-aufgelöst ({{state.x}} -> branchState.x).
 */
export const transformHandler: Node<TransformWith, unknown> = (input) => {
  const cfg = (input ?? {}) as TransformWith;
  const value = applyOp(cfg);

  // Output-Form: wenn eine bekannte Op lief, packen wir den Wert unter `as` (Default "value"),
  // damit ein Step ihn per outputs:{ x: "state.x" } abgreifen ODER flach mergen kann.
  const known =
    ("set" in cfg && cfg.set !== undefined) ||
    ("append" in cfg && cfg.append !== undefined) ||
    typeof cfg.take === "number" ||
    cfg.map !== undefined;

  let output: unknown;
  if (known) {
    const key = cfg.as ?? "value";
    output = { [key]: value };
  } else {
    // shape-transform: der Block selbst ist der Output (ohne die Steuerfelder).
    const { as: _as, cost: _cost, ...rest } = cfg;
    void _as;
    void _cost;
    output = rest;
  }

  const usd = typeof cfg.cost === "number" ? cfg.cost : 0;
  const result: Resolved = { status: "resolved", output, confidence: 1, cost: { usd } };
  return Promise.resolve(result);
};

/** Registrierbare Definition der built-in transform-Node. */
export const transformNode: NodeDefinition<TransformWith, unknown> = {
  type: "transform",
  klass: "orchestration",
  handler: transformHandler,
};
