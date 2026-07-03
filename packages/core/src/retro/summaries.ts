// ───────────────────────────── Summary Store (Doc §3.2/§5, Slice 3b) ─────────────────────────────
// Der durable Schreib-/Lese-Speicher der `summaries`-Tabelle (Doc §4/§5): der Summarizer (pm.session-summary)
// schreibt EINE `SessionSummary`-Zeile je Session (idempotent über `session`); spätere Clusterung/Router lesen
// sie. Strukturell == InMemoryCaptureStore (capture.ts): ein `Map<session,row>`-Backing-Store (session-keyed
// Upsert == idempotenter Insert pro Session) + optionaler append-only JSONL-Spiegel (`<dir>/summaries.jsonl`)
// im FileRunStore-Stil für Durability über Prozessgrenzen.
//
// BEWUSST eine EIGENE Klasse (NICHT CaptureStore erweitert): CaptureStores Contract (append/sessions/events,
// content-hash-PK, TableTapeSource) ist auf den events-Tape geformt; Summaries haben einen ANDEREN Schlüssel
// (idempotent über `session`, EINE Zeile je Session — Doc §3.2 persist) und ein anderes Read-Muster (nicht
// TapeSource). Der Datei-Spiegel liegt co-lokal in `.elio/capture/summaries.jsonl` (Geschwister von events.jsonl).
//
// SWAPPBAR: der `SummaryStore`-Contract hält die Persistenz austauschbar — ein DB-Server (sqlite/node:sqlite in
// v0.2) dockt am SELBEN Contract an, ohne dass der Summarizer-Pack sich ändert. Null neue Deps, node-builtins only.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Eine `summaries`-Zeile (Doc §5): die zu EINER Session verdichtete Sicht. Der `intent` stammt vom LLM
 * (`label`-Step), `variant`/`fingerprint`/`stats` deterministisch (`stats`-Step). Idempotenz-PK = `session`
 * (Doc §3.2 persist: EINE Zeile je Session).
 */
export interface SessionSummary {
  /** case id (`session_id`) — der idempotente PK (eine Zeile je Session). */
  session: string;
  /** `claude-code` | `ollama` | … */
  source: string;
  /** Zeitfenster der Session (erste/letzte Event-`ts`, ISO-8601). */
  window: { start: string; end: string };
  /** Semantisches Label (LLM `label`-Step) — Clustering-Schlüssel #1. */
  intent: string[];
  /** nodeType-Aktivitätsfolge (deterministisch, `stats`-Step) — Schlüssel #2. */
  variant: string[];
  /** `hashValue(variant)` — exakter Wiederholungs-Schlüssel. */
  fingerprint: string;
  /** Deterministische Kennzahlen (`stats`-Step). */
  stats: {
    steps: number;
    cost: { usd: number; tokens: number };
    durationMs: number;
    toolHistogram: Record<string, number>;
  };
  /** Aus `exit_reason` inferiert (§9); v0.1-Default "passed". */
  outcome: "passed" | "stopped" | "abandoned";
  /** Provenance → die events-Zeilen dieser Session. */
  evidence: { eventRef: string };
}

/**
 * Schreib-/Lese-Contract der `summaries`-Tabelle. Bewusst minimal + swappbar (ein DB-Server dockt am selben
 * Contract an). `upsert` ist idempotent über `session` (Doc §3.2 persist: eine Zeile je Session); `get`/`all`
 * lesen.
 */
export interface SummaryStore {
  /** Idempotenter Upsert über `session`: dieselbe Session zweimal → genau eine (ersetzte) Zeile. */
  upsert(summary: SessionSummary): Promise<SessionSummary>;
  /** Die Summary einer Session (oder null). */
  get(session: string): Promise<SessionSummary | null>;
  /** Alle Summaries (Einfügereihenfolge). */
  all(): Promise<SessionSummary[]>;
}

/**
 * In-Memory `SummaryStore` (`Map<session,row>`, session-keyed Upsert == idempotenter Insert je Session).
 * Optional mit append-only JSONL-Spiegel (`<dir>/summaries.jsonl`) im FileRunStore-/CaptureStore-Stil: jede
 * NEUE oder GEÄNDERTE Session-Summary wird angehängt, beim Start wird der Stand re-hydratet (die letzte Zeile je
 * Session gewinnt) — so sieht ein NEUER Prozess die Summaries eines früheren. Die Map ist die Quelle für Reads.
 */
export class InMemorySummaryStore implements SummaryStore {
  private readonly rows = new Map<string, SessionSummary>();
  private readonly file: string | undefined;

  constructor(opts: { dir?: string } = {}) {
    if (opts.dir !== undefined) {
      mkdirSync(opts.dir, { recursive: true });
      this.file = join(opts.dir, "summaries.jsonl");
      this.hydrate();
    }
  }

  private hydrate(): void {
    if (this.file === undefined || !existsSync(this.file)) return;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // torn last line o.ä. → überspringen (kein harter Start-Crash, FileRunStore-Muster).
        continue;
      }
      const row = parsed as Partial<SessionSummary>;
      if (typeof row.session !== "string") continue; // strukturell unbrauchbare Zeile überspringen
      // session-keyed: eine SPÄTERE Zeile derselben Session überschreibt die frühere (Upsert-Semantik beim
      // Re-Hydrate — die JSONL-Datei ist append-only, also gewinnt der letzte geschriebene Stand).
      this.rows.set(row.session, row as SessionSummary);
    }
  }

  // async, damit der Contract uniform Promise-basiert bleibt (eine echte DB-Impl ist async).
  async upsert(summary: SessionSummary): Promise<SessionSummary> {
    await Promise.resolve();
    this.rows.set(summary.session, summary); // Upsert auf session ⇒ eine Zeile je Session (Doc §3.2).
    if (this.file !== undefined) {
      // Append-only Spiegel: bei jedem Upsert eine Zeile anhängen; der Re-Hydrate nimmt die letzte je Session.
      appendFileSync(this.file, `${JSON.stringify(summary)}\n`, "utf8");
    }
    return summary;
  }

  async get(session: string): Promise<SessionSummary | null> {
    await Promise.resolve();
    return this.rows.get(session) ?? null;
  }

  async all(): Promise<SessionSummary[]> {
    await Promise.resolve();
    return [...this.rows.values()];
  }
}
