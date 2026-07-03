// ───────────────────────────── InMemoryDbService: map-backed, scope-gegated (Inv. 14, §11/#11) ─────────────────────────────
// DbService-Impl ohne echte DB-Engine: ein Map<table, Map<rowKey,row>>-Backing-Store. Reicht für die
// Demos + Tests (scope-gegated db-Node, batch-Massen-Write) ohne sqlite/native-Deps. Das Policy-Scoping
// (welche dbScopes eine Node sehen darf) passiert im Injector über dessen ScopedDbService; ZUSÄTZLICH
// kann dieser Store selbst auf eine Menge erlaubter Scopes (= Tabellen-Präfixe) begrenzt werden —
// defense in depth analog zu ScopedFsService.roots.
//
// query(sql, params) versteht ein winziges SQL-Subset, das für I/O-Demos genügt:
//   SELECT * FROM <table>                                   -> alle Zeilen
//   SELECT * FROM <table> WHERE <col> = <val>               -> gefiltert
//   INSERT INTO <table> (c1, c2, …) VALUES (v1, v2, …)      -> Upsert (key = erste Spalte ODER `id`)
//   DELETE FROM <table> WHERE <col> = <val>                 -> Löschen
// Kein vollständiger SQL-Parser — bewusst klein gehalten; ein echter Adapter dockt am selben
// DbService-Contract an.

import type { DbService } from "@elio/core";

export interface InMemoryDbServiceOptions {
  /**
   * Erlaubte Scopes (= Tabellennamen oder -präfixe). Ist die Liste gesetzt, wird ein Zugriff auf eine
   * Tabelle außerhalb davon abgelehnt. Fehlt sie, ist jeder Tabellenname erlaubt (das Policy-Scoping
   * macht dann allein der Injector). Default: undefined (alle).
   */
  scopes?: string[];
  /** Optionaler Seed: pro Tabelle eine Zeilenliste. */
  seed?: Record<string, Record<string, unknown>[]>;
}

type Row = Record<string, unknown>;

export class InMemoryDbService implements DbService {
  private readonly tables = new Map<string, Map<string, Row>>();
  private readonly scopes: string[] | undefined;

  constructor(opts: InMemoryDbServiceOptions = {}) {
    this.scopes = opts.scopes;
    if (opts.seed !== undefined) {
      for (const [table, rows] of Object.entries(opts.seed)) {
        const map = this.tableFor(table, true);
        for (const row of rows) map.set(this.keyOf(row), row);
      }
    }
  }

  /** Aktueller Stand einer Tabelle (Test/Diagnose). */
  rows(table: string): Row[] {
    return [...(this.tables.get(table)?.values() ?? [])];
  }

  private assertScope(table: string): void {
    if (this.scopes === undefined) return;
    const ok = this.scopes.some((s) => table === s || table.startsWith(s));
    if (!ok) {
      throw new Error(
        `InMemoryDbService: table "${table}" out of allowed scopes [${this.scopes.join(", ")}]`,
      );
    }
  }

  private tableFor(table: string, _create: boolean): Map<string, Row> {
    this.assertScope(table);
    let t = this.tables.get(table);
    if (t === undefined) {
      t = new Map<string, Row>();
      this.tables.set(table, t);
    }
    return t;
  }

  private keyOf(row: Row): string {
    const id = row["id"];
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
    // Kein id-Feld: stabiler Key aus dem ersten Feldwert (für simple Demos genügt das).
    const first = Object.values(row)[0];
    return first === undefined ? String(Math.random()) : String(first);
  }

  // async, damit jeder synchrone Parse-/Scope-Throw als rejected Promise herauskommt (der Node-Pfad
  // erwartet eine Rejection, kein synchroner Throw aus query()).
  async query(sql: string, params?: unknown[]): Promise<unknown[]> {
    const trimmed = sql.trim();
    const verb = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";

    if (verb === "select") return this.runSelect(trimmed, params);
    if (verb === "insert") return this.runInsert(trimmed, params);
    if (verb === "delete") return this.runDelete(trimmed, params);
    throw new Error(`InMemoryDbService: unsupported statement "${verb}"`);
  }

  private runSelect(sql: string, params?: unknown[]): Row[] {
    const m = /select\s+.*?\s+from\s+([\w.]+)(?:\s+where\s+([\w.]+)\s*=\s*(.+))?/i.exec(sql);
    if (m === null) throw new Error(`InMemoryDbService: cannot parse SELECT: "${sql}"`);
    const table = m[1] as string;
    const rows = [...this.tableFor(table, false).values()];
    if (m[2] === undefined) return rows;
    const col = m[2];
    const val = parseValue(m[3] as string, params);
    return rows.filter((r) => String(r[col]) === String(val));
  }

  private runInsert(sql: string, params?: unknown[]): Row[] {
    const m = /insert\s+into\s+([\w.]+)\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)/i.exec(sql);
    if (m === null) throw new Error(`InMemoryDbService: cannot parse INSERT: "${sql}"`);
    const table = m[1] as string;
    const cols = (m[2] as string).split(",").map((c) => c.trim());
    const rawVals = splitArgs(m[3] as string);
    const row: Row = {};
    cols.forEach((c, i) => {
      row[c] = parseValue(rawVals[i] ?? "null", params, i);
    });
    const t = this.tableFor(table, true);
    t.set(this.keyOf(row), row);
    return [row]; // affected = 1
  }

  private runDelete(sql: string, params?: unknown[]): Row[] {
    const m = /delete\s+from\s+([\w.]+)(?:\s+where\s+([\w.]+)\s*=\s*(.+))?/i.exec(sql);
    if (m === null) throw new Error(`InMemoryDbService: cannot parse DELETE: "${sql}"`);
    const table = m[1] as string;
    const t = this.tableFor(table, false);
    if (m[2] === undefined) {
      const n = t.size;
      t.clear();
      return new Array(n).fill({});
    }
    const col = m[2];
    const val = parseValue(m[3] as string, params);
    const deleted: Row[] = [];
    for (const [k, r] of t) {
      if (String(r[col]) === String(val)) {
        t.delete(k);
        deleted.push(r);
      }
    }
    return deleted;
  }
}

// ───────────────────────────── Mini-SQL-Wert-Parsing ─────────────────────────────

/** Splittet eine VALUES-Argumentliste an Kommas außerhalb von Quotes. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of s) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "," && !inSingle && !inDouble) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

/** Parst einen SQL-Literal-/Platzhalter-Wert: `?`/`$n` -> params; 'quoted' -> string; Zahl -> number. */
function parseValue(raw: string, params?: unknown[], positional?: number): unknown {
  const v = raw.trim();
  if (v === "?") {
    return params?.[positional ?? 0];
  }
  const pos = /^\$(\d+)$/.exec(v);
  if (pos !== null) {
    return params?.[Number(pos[1]) - 1];
  }
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  const q = /^['"](.*)['"]$/.exec(v);
  if (q !== null) return q[1];
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
