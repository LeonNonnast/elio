// ───────────────────────────── Built-in: db (Inv. 6/7/14, klass "orchestration") ─────────────────────────────
// DB-I/O über ctx.db (Klasse 1, kein Denken). Scope-gegated: ctx.db ist der vom Injector gebaute
// ScopedDbService — er wird NUR injiziert, wenn die getightenete Policy mindestens einen dbScope
// trägt (gewünschte ∩ erlaubte Scopes). FAILS BY ABSENCE (Inv. 14): wurde ctx.db nicht injiziert,
// wirft die Node — kein stiller No-op, kein runtime permission-check. tryWithRetry fängt den throw.
//
// Lese- UND Schreibpfad laufen beide über DbService.query(sql, params) (der Service-Contract hat eine
// Methode): ein SELECT liefert Zeilen; ein INSERT/UPDATE/DELETE führt aus und liefert i.d.R. [] bzw.
// affected-rows (Backend-abhängig). Die Node FORDERT db (requests.db) mit "*"-Wildcard an; der
// getightenete Scope-Schnitt entscheidet, welche Scopes überleben (tighten-only, Inv. 13).

import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer db-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst.
 *  - { op: "query", sql: "SELECT …", params?, as? } -> Resolved<{ [as|rows]: unknown[] }>
 *  - { op: "write", sql: "INSERT …", params? }      -> Resolved<{ affected: number }>
 * `op` ist optional: fehlt es, wird "query" für ein führendes SELECT angenommen, sonst "write".
 */
export interface DbWith {
  op?: "query" | "write";
  sql?: string;
  params?: unknown[];
  /** Output-Feldname für query (Default "rows"). */
  as?: string;
}

function resolveOp(cfg: DbWith): "query" | "write" {
  if (cfg.op === "query" || cfg.op === "write") return cfg.op;
  const sql = (cfg.sql ?? "").trimStart().toLowerCase();
  return sql.startsWith("select") ? "query" : "write";
}

/**
 * db-Handler: liest/schreibt über ctx.db. Wirft, wenn ctx.db fehlt (security by absence, Inv. 14)
 * oder `sql` fehlt. Der ScopedDbService ist auf die erlaubten Scopes gebunden.
 */
export const dbHandler: Node<DbWith, unknown> = async (input, ctx) => {
  const cfg = (input ?? {}) as DbWith;
  if (ctx.db === undefined) {
    throw new Error(
      "db node: ctx.db ist nicht injiziert — security by absence (Inv. 14): diese Node wurde nicht " +
        "für DB-Zugriff freigegeben (Policy gab keinen dbScope frei ODER kein DbService verdrahtet).",
    );
  }
  const sql = cfg.sql;
  if (typeof sql !== "string" || sql.length === 0) {
    throw new Error("db node: `sql` fehlt (string erwartet).");
  }

  const op = resolveOp(cfg);
  const rows = await ctx.db.query(sql, cfg.params);

  if (op === "query") {
    const key = cfg.as ?? "rows";
    const result: Resolved = {
      status: "resolved",
      output: { [key]: rows },
      confidence: 1,
      cost: { usd: 0 },
    };
    return result;
  }

  // write: ein Backend liefert i.d.R. affected-rows als Zahl oder [] zurück.
  const affected = Array.isArray(rows) ? rows.length : 0;
  const result: Resolved = {
    status: "resolved",
    output: { affected },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

/**
 * Registrierbare Definition der built-in db-Node. `requests.db` mit "*"-Wildcard signalisiert dem
 * Injector "diese Node will DB-Zugriff"; der getightenete Scope-Schnitt (req ∩ parent) entscheidet,
 * welche Scopes erlaubt sind (Inv. 13/14). Leerer Schnitt -> kein ctx.db -> die Node failt by absence.
 */
export const dbNode: NodeDefinition<DbWith, unknown> = {
  type: "db",
  klass: "orchestration",
  handler: dbHandler,
  requests: { db: ["*"] },
};
