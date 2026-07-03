// ───────────────────────────── Built-in: validate (Inv. 6/7, klass "orchestration") ─────────────────────────────
// Prüft den Input gegen ein Prädikat ODER ein minimales JSON-Schema in `with` und liefert
// Resolved<GateVerdict> ({ passed, score?, failures }). Damit ist die Node zugleich als
// Eval-Gate verwendbar (Inv. 1/6, §11/#4) — kein Sonder-Primitiv.

import type { Node, NodeDefinition, Resolved, GateVerdict } from "../node";

/**
 * Minimales JSON-Schema-Subset, das v0.1 abgedeckt ist. Reicht für die Demos + den
 * Migrations-Sample-Validate. Erweiterbar, ohne den Contract zu brechen.
 */
export interface MiniSchema {
  type?: "object" | "array" | "string" | "number" | "boolean";
  /** object: Pflichtfelder. */
  required?: string[];
  /** object: pro Property ein (rekursives) MiniSchema. */
  properties?: Record<string, MiniSchema>;
  /** string/array: Mindest-/Maximallänge. */
  minLength?: number;
  maxLength?: number;
  /** number: Grenzen. */
  minimum?: number;
  maximum?: number;
}

/**
 * Konfiguration einer validate-Node. Genau eine Prüfquelle:
 *  - { value: <x>, schema: MiniSchema }  -> prüft x gegen schema
 *  - { value: <x>, predicate: (x)=>bool }-> prüft x gegen Prädikat (Code-Node-Pfad)
 *  - { value: <x>, minLength: n }        -> Kurzform: Längenprüfung auf x (string|array)
 * `value` (template-aufgelöst) ist das zu prüfende Datum; fehlt es, wird der gesamte Input geprüft.
 */
export interface ValidateWith {
  value?: unknown;
  schema?: MiniSchema;
  predicate?: (value: unknown) => boolean;
  /** Kurzform: Mindestlänge eines Strings/Arrays. */
  minLength?: number;
  /** Optionaler Score-Override (sonst 1 bei pass, 0 bei fail). */
  score?: number;
}

function typeOf(v: unknown): MiniSchema["type"] | "null" | "undefined" {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "string" || t === "number" || t === "boolean") return t;
  return "undefined";
}

/** Prüft `value` gegen ein MiniSchema; sammelt menschenlesbare failures (Pfad-präfixiert). */
function checkSchema(value: unknown, schema: MiniSchema, path: string): string[] {
  const failures: string[] = [];
  const here = path === "" ? "(root)" : path;

  if (schema.type !== undefined) {
    const actual = typeOf(value);
    if (actual !== schema.type) {
      failures.push(`${here}: expected type ${schema.type}, got ${actual}`);
      // Bei Typ-Mismatch keine tieferen Prüfungen — sie würden nur Folgefehler erzeugen.
      return failures;
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      failures.push(`${here}: string shorter than minLength ${schema.minLength} (got ${value.length})`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      failures.push(`${here}: string longer than maxLength ${schema.maxLength} (got ${value.length})`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      failures.push(`${here}: array shorter than minLength ${schema.minLength} (got ${value.length})`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      failures.push(`${here}: array longer than maxLength ${schema.maxLength} (got ${value.length})`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      failures.push(`${here}: number below minimum ${schema.minimum} (got ${value})`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      failures.push(`${here}: number above maximum ${schema.maximum} (got ${value})`);
    }
  }

  if (typeOf(value) === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        failures.push(`${here}: missing required property "${key}"`);
      }
    }
    if (schema.properties !== undefined) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj && obj[key] !== undefined) {
          failures.push(...checkSchema(obj[key], sub, path === "" ? key : `${path}.${key}`));
        }
      }
    }
  }

  return failures;
}

/**
 * validate-Handler: liefert immer Resolved<GateVerdict> (auch bei Fehlschlag — ein Fehlschlag ist
 * kein Failed, sondern ein "passed:false"-Verdikt, das der Runner als Gate liest).
 */
export const validateHandler: Node<ValidateWith, GateVerdict> = (input) => {
  const cfg = (input ?? {}) as ValidateWith;
  const value = "value" in cfg ? cfg.value : cfg;
  const failures: string[] = [];

  if (cfg.predicate !== undefined) {
    let ok = false;
    try {
      ok = cfg.predicate(value);
    } catch (e) {
      failures.push(`predicate threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ok && failures.length === 0) failures.push("predicate returned false");
  }

  if (cfg.schema !== undefined) {
    failures.push(...checkSchema(value, cfg.schema, ""));
  }

  if (cfg.minLength !== undefined) {
    const len = typeof value === "string" || Array.isArray(value) ? value.length : 0;
    if (len < cfg.minLength) {
      failures.push(`length ${len} below minLength ${cfg.minLength}`);
    }
  }

  const passed = failures.length === 0;
  const verdict: GateVerdict = { passed, failures };
  if (cfg.score !== undefined) {
    verdict.score = cfg.score;
  } else {
    verdict.score = passed ? 1 : 0;
  }

  const result: Resolved<GateVerdict> = {
    status: "resolved",
    output: verdict,
    confidence: 1,
    cost: { usd: 0 },
  };
  return Promise.resolve(result);
};

/** Registrierbare Definition der built-in validate-Node. */
export const validateNode: NodeDefinition<ValidateWith, GateVerdict> = {
  type: "validate",
  klass: "orchestration",
  handler: validateHandler,
};
