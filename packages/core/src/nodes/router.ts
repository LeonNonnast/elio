// ───────────────────────────── Built-in: router (Inv. 6/7, klass "orchestration") ─────────────────────────────
// Deterministische Verzweigung (Klasse 1, kein Denken): wählt aus einer Menge von Routen GENAU EINE
// anhand des (template-aufgelösten) Inputs/States und gibt sie als Resolved zurück. Die gewählte Route
// landet via outputs:{ route: "state.route" } im branchState; eine when-Edge des Feature-Graphen kann
// dann darauf verzweigen (z.B. `when: state.route == "a"`). Reine Funktion (input, ctx) => NodeResult.

import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer router-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst.
 * Auswahl-Strategien (Reihenfolge der Erkennung):
 *  - { value: <x>, cases: { a: ..., b: ... }, default? } -> route = String(x) falls in `cases`, sonst default.
 *  - { routes: [{ to, when? }, ...], default? }          -> erste Route, deren `when` (boolean) truthy ist.
 *  - { value: <x> }                                      -> route = String(x) (direkte Durchreiche).
 * `as` (Default "route") bestimmt den Output-Feldnamen.
 */
export interface RouterWith {
  value?: unknown;
  cases?: Record<string, unknown>;
  routes?: { to: string; when?: unknown }[];
  default?: string;
  /** Output-Feldname (Default "route"). */
  as?: string;
}

function truthy(v: unknown): boolean {
  return Boolean(v) && !(Array.isArray(v) && v.length === 0);
}

/** Bestimmt die gewählte Route deterministisch aus der Konfiguration. */
function pickRoute(cfg: RouterWith): string {
  // routes[] mit when-Prädikaten: erste truthy gewinnt.
  if (Array.isArray(cfg.routes) && cfg.routes.length > 0) {
    for (const r of cfg.routes) {
      // `when` fehlt -> immer wählbar (Fallback-Route); sonst truthy-Test des (aufgelösten) Werts.
      if (r.when === undefined || truthy(r.when)) {
        if (typeof r.to === "string" && r.to.length > 0) return r.to;
      }
    }
    if (typeof cfg.default === "string") return cfg.default;
    throw new Error("router node: keine Route matched und kein `default` gesetzt.");
  }

  // cases-Map: route = String(value), falls als Key vorhanden.
  if (cfg.cases !== undefined && cfg.value !== undefined) {
    const key = String(cfg.value);
    if (key in cfg.cases) return key;
    if (typeof cfg.default === "string") return cfg.default;
    throw new Error(`router node: value "${key}" nicht in cases und kein \`default\` gesetzt.`);
  }

  // direkte Durchreiche: route = String(value).
  if (cfg.value !== undefined) return String(cfg.value);

  if (typeof cfg.default === "string") return cfg.default;
  throw new Error("router node: keine Auswahlquelle (value/cases/routes) und kein `default`.");
}

/**
 * router-Handler: deterministisch, kostenfrei, volle Confidence. Liefert Resolved<{ route }>
 * (bzw. unter `as`). Der Runner merged das in den State; eine when-Edge verzweigt darauf.
 */
export const routerHandler: Node<RouterWith, unknown> = async (input) => {
  const cfg = (input ?? {}) as RouterWith;
  const route = pickRoute(cfg);
  const key = cfg.as ?? "route";
  const result: Resolved = {
    status: "resolved",
    output: { [key]: route },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

/** Registrierbare Definition der built-in router-Node (Inv. 6 — built-in == custom). */
export const routerNode: NodeDefinition<RouterWith, unknown> = {
  type: "router",
  klass: "orchestration",
  handler: routerHandler,
};
