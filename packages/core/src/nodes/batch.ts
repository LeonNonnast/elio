// ───────────────────────────── Built-in: batch (Inv. 6/7, klass "orchestration", §11/#1/#11) ─────────────────────────────
// Massen-I/O über ein Array OHNE per-record Checkpoint/Sandbox (§11/#11). KONTRAST zu subworkflow:
//   subworkflow = per-record nested Outer Loop (jedes Item = eigener Branch + eigene correlation-id +
//                 resumebarer Checkpoint) -> richtig fürs Sample, skaliert aber nicht für Massen-Commits.
//   batch       = EIN Node-Call verarbeitet ALLE Items in-process, ein Checkpoint für die ganze Charge.
//                 Sandbox/Checkpoint pro Record skaliert nicht für Massen-I/O (Inv. 20 + §11/#1) -> batch
//                 ist die dafür vorgesehene Node-Klasse. Idempotenz/Effect-Ledger ist Slice 6 (§11/#11).
//
// batch ist eine reine Funktion (input, ctx) => NodeResult. Pro Item führt es EINE der I/O-Operationen
// aus — db-write, fs-write oder eine reine transform-artige Projektion — über DIESELBEN gescopten
// ctx-Services (security by absence: fehlt der geforderte Service, failt batch by absence wie file/db).

import type { Ctx } from "../ctx";
import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer batch-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst
 * (d.h. `items` trägt schon das konkrete Array aus dem branchState).
 *  - items:   das Array, über das in-process iteriert wird (ein Effekt pro Element, KEIN Branch).
 *  - op:      "db" (jedes Item -> ctx.db.query(sql, params)), "fs" (jedes Item -> ctx.fs.write(path)),
 *             oder "collect" (kein Side-Effect; sammelt die Items, optional über `pick` projiziert).
 *  - sql:     (op=db) SQL-Template; "{{item}}"/"{{item.field}}" wird pro Item ersetzt.
 *  - pathKey: (op=fs) Item-Feld mit dem Zielpfad (Default "path").
 *  - contentKey: (op=fs) Item-Feld mit dem Inhalt (Default "content").
 *  - pick:    (op=collect) Item-Feldname, der pro Item gezogen wird (sonst das ganze Item).
 *  - as:      Output-Feldname für den Ergebnis-Aggregat (Default "results").
 */
export interface BatchWith {
  items?: unknown;
  op?: "db" | "fs" | "collect";
  sql?: string;
  params?: unknown[];
  pathKey?: string;
  contentKey?: string;
  pick?: string;
  /** Output-Feldname (Default "results"). */
  as?: string;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

/** Ersetzt "{{item}}" / "{{item.field}}" in einem SQL-Template gegen ein Item. */
function fillSql(template: string, item: unknown): string {
  return template.replace(/\{\{\s*item(?:\.([\w.]+))?\s*\}\}/g, (_m, field?: string) => {
    if (field === undefined) return String(item);
    let cur: unknown = item;
    for (const p of field.split(".")) {
      if (cur === undefined || cur === null || typeof cur !== "object") return "";
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur === undefined || cur === null ? "" : String(cur);
  });
}

function field(item: unknown, key: string): unknown {
  if (typeof item === "object" && item !== null && !Array.isArray(item)) {
    return (item as Record<string, unknown>)[key];
  }
  return undefined;
}

async function runItem(cfg: BatchWith, op: "db" | "fs" | "collect", item: unknown, ctx: Ctx): Promise<unknown> {
  if (op === "db") {
    if (ctx.db === undefined) {
      throw new Error(
        "batch node (op=db): ctx.db ist nicht injiziert — security by absence (Inv. 14).",
      );
    }
    const sql = typeof cfg.sql === "string" ? fillSql(cfg.sql, item) : "";
    if (sql.length === 0) throw new Error("batch node (op=db): `sql` fehlt.");
    const rows = await ctx.db.query(sql, cfg.params);
    return { affected: Array.isArray(rows) ? rows.length : 0 };
  }
  if (op === "fs") {
    if (ctx.fs === undefined) {
      throw new Error(
        "batch node (op=fs): ctx.fs ist nicht injiziert — security by absence (Inv. 14).",
      );
    }
    const path = field(item, cfg.pathKey ?? "path");
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("batch node (op=fs): Item ohne gültigen Pfad.");
    }
    const content = field(item, cfg.contentKey ?? "content");
    const text = typeof content === "string" ? content : String(content ?? "");
    await ctx.fs.write(path, text);
    return { path, bytes: text.length };
  }
  // collect: kein Side-Effect.
  if (cfg.pick !== undefined) return field(item, cfg.pick);
  return item;
}

/**
 * batch-Handler: iteriert IN-PROCESS über `items` und führt pro Item EINEN Effekt aus (db/fs/collect).
 * EIN Resolved für die ganze Charge — KEIN per-record Checkpoint, KEIN per-record Branch (§11/#11).
 * Failt der Service by absence (kein ctx.db/ctx.fs), wirft das erste Item -> tryWithRetry -> Failed.
 */
export const batchHandler: Node<BatchWith, unknown> = async (input, ctx) => {
  const cfg = (input ?? {}) as BatchWith;
  const items = asArray(cfg.items);
  const op = cfg.op ?? "collect";

  const results: unknown[] = [];
  for (const item of items) {
    // Bewusst sequenziell + ohne per-record Checkpoint: ein Fehler propagiert als throw (die ganze
    // Charge schlägt fehl), statt pro Record zu parken — das ist der definierende Unterschied zu
    // subworkflow (per-record Resume). Idempotenz/partielle Re-Runs sind Slice 6 (§11/#11).
    results.push(await runItem(cfg, op, item, ctx));
  }

  const key = cfg.as ?? "results";
  const result: Resolved = {
    status: "resolved",
    output: { [key]: results, processed: results.length },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

/**
 * Registrierbare Definition der built-in batch-Node. Fordert fs+db an (wie file/db); der getightenete
 * Schnitt entscheidet, was injiziert wird. Eine op=collect-Charge braucht keinen Service und läuft auch
 * ohne fs/db (security by absence betrifft nur die I/O-Ops).
 */
export const batchNode: NodeDefinition<BatchWith, unknown> = {
  type: "batch",
  klass: "orchestration",
  handler: batchHandler,
  requests: { fs: { write: ["*"] }, db: ["*"] },
};
