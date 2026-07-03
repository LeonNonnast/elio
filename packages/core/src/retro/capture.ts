// ───────────────────────────── Capture Store + table-backed TapeSource (Doc §4, Slice 2) ─────────────────────────────
// Der durable Schreib-/Lese-Speicher der `events`-Tabelle (Doc §4): der Logger (Slice 3) schreibt Zeilen,
// der Discoverer liest sie über eine table-backed `TapeSource` hinter `ctx.traces`. Strukturell == FileRunStore-
// Muster (append-only, eine Zeile == ein Event, dependency-free), aber mit Tabellen-Semantik: der `id`
// (Inhalts-Hash) ist der PK ⇒ idempotenter Insert (Re-Delivery dedupliziert sich, kein Duplikat).
//
// SUBSTRAT (v0.1): ein In-Memory-`Map<id,row>`-Backing-Store (id-keyed Upsert == idempotenter Insert), optional
// gespiegelt auf eine append-only JSONL-Datei im FileRunStore-Stil (`<dir>/events.jsonl`) für Durability über
// Prozessgrenzen. Null neue Deps, node-builtins only. Die `CaptureStore`-Schnittstelle hält das swappbar: ein
// echter DB-Server (sqlite / node:sqlite in v0.2) dockt am SELBEN Contract an, ohne dass TableTapeSource oder
// die Miner sich ändern.
//
// READ-PFAD (Doc §4): `TableTapeSource implements TapeSource` mappt jede Zeile → `TapeFrame` (s. rowToFrame),
// ordnet die Frames eines Runs nach (seq, ts) und reitet — in `RunStoreTracesService` gewickelt — auf demselben
// `traces:read`-Gating wie der RunStore (security by absence, Inv. 14). REIN read-only: kein Schreibpfad über
// ctx.traces. KEIN Hot-Path: weder Runner noch Injector werden berührt (additive Wiring-Seam ist
// `PolicyInjectorDeps.tracesSource`, das diese TapeSource akzeptiert).

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Cost } from "../common";
import type { TapeFrame } from "../run";
import type { TapeSource } from "../traces";
import { hashValue } from "./canon";

/**
 * Eine `events`-Zeile (Doc §4). Der Logger stempelt sie am Boundary; nur Hashes/redacted Vollform überleben
 * (Inv. 23). `id` ist der Inhalts-Hash (PK) — wird er weggelassen, leitet ihn `append` deterministisch aus
 * den inhaltlichen Feldern ab, sodass dasselbe Event zweimal genau eine Zeile ergibt (idempotent).
 */
export interface CaptureEvent {
  /** PK = Inhalts-Hash. Optional beim Schreiben — `append` füllt ihn deterministisch, wenn er fehlt. */
  id?: string;
  /** case id (`session_id`) → mappt auf `correlation.run` (es gibt keine `query.session`-Achse). */
  session: string;
  /** Reihenfolge innerhalb der Session (primärer Sortierschlüssel für `tape(run)`). */
  seq: number;
  /** `received_at`, ISO-8601 (lexikografisch vergleichbar — speist `since`/`until`). */
  ts: string;
  /** `claude-code` | `ollama` | … */
  source: string;
  /** normalisiert: `tool_name`. Invariante (Doc): `activity == nodeType`. */
  activity: string;
  /** redacted/gehasht am Boundary (Inv. 23). */
  inputHash?: string;
  /** redacted/gehasht am Boundary (Inv. 23). */
  outputHash?: string;
  /** `{ model, tokensIn, tokensOut, usd }` — strukturgleich zum core-`Cost`. */
  cost?: Cost;
  /** Provenance (redacted Vollform). Bewusst NICHT teil des Inhalts-Hashes (nur Provenance). */
  raw?: unknown;
}

/** Eine persistierte `events`-Zeile (id ist nach `append` immer gesetzt). */
export type StoredCaptureEvent = CaptureEvent & { id: string };

/**
 * Schreib-/Lese-Contract der `events`-Tabelle. Bewusst minimal + swappbar (ein DB-Server dockt am selben
 * Contract an). `append` ist idempotent über den Inhalts-Hash `id`; die Read-Seite genügt der TapeSource.
 */
export interface CaptureStore {
  /** Idempotenter Insert: gleiches Event (gleicher Inhalts-Hash) zweimal → genau eine Zeile. */
  append(event: CaptureEvent): Promise<StoredCaptureEvent>;
  /** Alle distinkten Session-ids (= run-ids für die TapeSource). */
  sessions(): Promise<string[]>;
  /** Die Zeilen einer Session, geordnet nach (seq, ts). */
  events(session: string): Promise<StoredCaptureEvent[]>;
  /**
   * Nächste monoton-steigende `seq` für eine Session (max bekannter seq + 1, 0 falls leer). Der Logger nutzt
   * sie NUR, wenn der rohe Hook-Payload KEIN `seq` trägt (Slice-4-Hook-Glue zählt es i.d.R. selbst). So
   * kollidieren zwei seq-lose Events derselben Session NICHT auf dem (session, 0)-Slot (sonst würfe `append`
   * und der zweite Event ginge verloren). Mit Hook-gezähltem seq bleibt der Pfad unberührt.
   */
  nextSeq(session: string): Promise<number>;
}

/**
 * Inhalts-Hash-Länge des PK: VOLLE 256 bit (64 hex). Der Default von `hashValue` (16 hex / 64 bit) ist für
 * In-Memory-Determinismus-Bucketing dimensioniert — als durabler, inhalts-adressierter GLOBALER PK über ALLE
 * Sessions (Doc §4: cross-machine/shared) wäre 64 bit zu knapp (Geburtstags-Schranke ~2^32 Zeilen ⇒ Kollision
 * == stilles Überschreiben unter dem id-keyed Upsert). 256 bit hält die Kollisionswahrscheinlichkeit praktisch
 * auf null.
 */
const EVENT_ID_HEX_LEN = 64;

/**
 * Leitet den Inhalts-Hash `id` deterministisch aus den inhaltlichen Feldern ab (NICHT aus `raw`/`id`): zwei
 * inhaltsgleiche Re-Deliveries kollidieren auf demselben `id` ⇒ Upsert dedupliziert.
 *
 * IDEMPOTENZ-VORBEDINGUNG (Schreib-Contract, Doc §4): `seq` MUSS per-Session monoton/eindeutig sein. Der `id`
 * faltet zwar {session, seq, ts, source, activity, inputHash, outputHash, cost} zusammen, aber inputHash/
 * outputHash/cost sind OPTIONAL — lässt der Logger sie weg, tragen NUR (session, seq, ts, source, activity)
 * die Distinktheit. Zwei genuin verschiedene Tool-Calls mit identischem (session, seq, ts, source, activity)
 * würden sonst auf denselben `id` kollabieren und der zweite den ersten still überschreiben (Datenverlust statt
 * Idempotenz). Der Schreibpfad (`InMemoryCaptureStore.append`) setzt diese Vorbedingung daher aktiv durch:
 * ein bereits gesehenes (session, seq) mit ABWEICHENDEM Inhalt ist ein Contract-Bruch und wirft.
 */
export function eventId(event: CaptureEvent): string {
  return hashValue(
    {
      session: event.session,
      seq: event.seq,
      ts: event.ts,
      source: event.source,
      activity: event.activity,
      inputHash: event.inputHash ?? null,
      outputHash: event.outputHash ?? null,
      cost: event.cost ?? null,
    },
    EVENT_ID_HEX_LEN,
  );
}

/** Sicht-Klon mit garantierter `id` (deterministisch, falls beim Schreiben weggelassen). */
function withId(event: CaptureEvent): StoredCaptureEvent {
  return { ...event, id: event.id ?? eventId(event) };
}

/** (seq, ts)-Ordnung der Frames/Zeilen einer Session (ts ISO-8601 ⇒ lexikografischer Tiebreak). */
function bySeqTs(a: CaptureEvent, b: CaptureEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

/**
 * In-Memory `CaptureStore` (`Map<id,row>`, id-keyed Upsert == idempotenter Insert). Optional mit append-only
 * JSONL-Spiegel (`<dir>/events.jsonl`) im FileRunStore-Stil: jede neue Zeile wird angehängt, beim Start wird
 * der Stand re-hydratet — so sieht ein NEUER Prozess die Events eines früheren. Die JSONL-Datei ist NUR ein
 * Durability-Spiegel; die Map ist die Quelle für Reads. Re-Delivery hängt KEINE Zeile an (id schon bekannt).
 */
export class InMemoryCaptureStore implements CaptureStore {
  private readonly rows = new Map<string, StoredCaptureEvent>();
  /** (session, seq) → id, um die Idempotenz-Vorbedingung (seq per-Session eindeutig) durchzusetzen. */
  private readonly slots = new Map<string, string>();
  private readonly file: string | undefined;

  constructor(opts: { dir?: string } = {}) {
    if (opts.dir !== undefined) {
      mkdirSync(opts.dir, { recursive: true });
      this.file = join(opts.dir, "events.jsonl");
      this.hydrate();
    }
  }

  /** Schlüssel des logischen Event-Slots (session + seq) — Träger der Idempotenz-Vorbedingung. */
  private static slotKey(event: CaptureEvent): string {
    return `${event.session} ${String(event.seq)}`;
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
      const row = parsed as Partial<StoredCaptureEvent>;
      // Robustheit (Review): NICHT der persistierten `id` blind vertrauen. Eine hand-editierte oder von einer
      // älteren eventId-Version geschriebene Zeile hätte sonst einen veralteten/fehlenden `id` als Map-Key —
      // ein frischer append() desselben logischen Events berechnete einen NEUEN id, der nicht matcht ⇒ Duplikat
      // (Idempotenz über die Versionsgrenze gebrochen), und eine Zeile OHNE `id` landete unter `undefined` in
      // einem einzigen Müll-Bucket. Wir re-derivieren den `id` IMMER aus dem aktuellen Inhalt und überspringen
      // strukturell unbrauchbare Zeilen.
      if (typeof row.session !== "string" || typeof row.seq !== "number" || typeof row.ts !== "string") continue;
      const { id: _persisted, ...content } = row as StoredCaptureEvent; // persistierten id verwerfen, neu derivieren
      void _persisted;
      const rederived = withId(content);
      // id-keyed: eine wiederholte Zeile (gleicher Inhalt ⇒ gleicher id) überschreibt sich selbst (idempotent).
      this.rows.set(rederived.id, rederived);
      this.slots.set(InMemoryCaptureStore.slotKey(rederived), rederived.id);
    }
  }

  // async, damit der Contract uniform Promise-basiert bleibt (eine echte DB-Impl ist async).
  async append(event: CaptureEvent): Promise<StoredCaptureEvent> {
    await Promise.resolve();
    const row = withId(event);
    // Idempotenz-Vorbedingung durchsetzen (Doc §4, Schreib-Contract): seq MUSS per-Session eindeutig sein.
    // Ein bereits belegter (session, seq)-Slot mit ABWEICHENDEM Inhalts-Hash ist KEINE Re-Delivery, sondern
    // zwei distinkte Events, die denselben logischen Slot beanspruchen — ohne Guard überschriebe der zweite den
    // ersten still (Datenverlust). Fail-fast statt stiller Aliasing-Kollision.
    const slot = InMemoryCaptureStore.slotKey(row);
    const claimed = this.slots.get(slot);
    if (claimed !== undefined && claimed !== row.id) {
      throw new Error(
        `CaptureStore: seq must be unique per session — slot (session=${row.session}, seq=${String(
          row.seq,
        )}) already holds a distinct event. seq is a REQUIRED per-session-unique key on the append path.`,
      );
    }
    const known = this.rows.has(row.id);
    this.rows.set(row.id, row); // Upsert auf id ⇒ idempotent (kein Duplikat).
    this.slots.set(slot, row.id);
    if (!known && this.file !== undefined) {
      // Nur beim ERSTEN Sehen anhängen — Re-Delivery hängt keine Zeile an (sonst wüchse die Datei).
      appendFileSync(this.file, `${JSON.stringify(row)}\n`, "utf8");
    }
    return row;
  }

  async sessions(): Promise<string[]> {
    await Promise.resolve();
    const out = new Set<string>();
    for (const row of this.rows.values()) out.add(row.session);
    return [...out];
  }

  async nextSeq(session: string): Promise<number> {
    await Promise.resolve();
    let max = -1;
    for (const row of this.rows.values()) {
      if (row.session === session && row.seq > max) max = row.seq;
    }
    return max + 1; // leere Session → 0; sonst der nächste freie Slot (monoton).
  }

  async events(session: string): Promise<StoredCaptureEvent[]> {
    await Promise.resolve();
    const out: StoredCaptureEvent[] = [];
    for (const row of this.rows.values()) {
      if (row.session === session) out.push(row);
    }
    return out.sort(bySeqTs);
  }
}

/**
 * Mappt eine `events`-Zeile → `TapeFrame` (Doc §4 Mapping). Felder ohne saubere Quelle werden mit stabilen
 * Sentinels gefüllt (markiert):
 *  - `correlation.run`        ← `session`   (case id; trägt die `runs`-Achse / `runIds()`)
 *  - `correlation.step`       ← `seq`       (stabile per-Session-Ordnung)
 *  - `correlation.branch`     ← "main"      (Events haben kein Branch-Konzept → Sentinel)
 *  - `correlation.checkpoint` ← `id`        (Inhalts-Hash als stabiler Token; kein nativer Checkpoint)
 *  - `nodeType`               ← `activity`  (Invariante: activity == nodeType)
 *  - `feature`                ← undefined   (§4 hat keine feature-Spalte; v0.1 `traces:read`/readAll liest
 *                                            alles. Würde man `feature=source` stempeln, filterte ein
 *                                            traces:<source>-Scope; bewusst NICHT gestempelt, sonst schlösse
 *                                            ein non-readAll-Scope jede Zeile aus.)
 *  - `result`                 ← { resolved, output: outputHash, confidence: 1, cost }
 *                                            (Events haben keine confidence → Default 1)
 *  - `input`                  ← { hash: inputHash }   (redacted-at-boundary; `{ hash }`-Wrapper ist sauber)
 *  - `injected`               ← []          (Events erfassen keine injected service keys → Sentinel)
 *  - `redaction`              ← (ausgelassen) — keine `dataClassification`-Quelle in der Zeile
 *  - `ts`                     ← `ts`        (ISO-8601; `since`/`until` vergleichen lexikografisch)
 */
export function rowToFrame(row: StoredCaptureEvent): TapeFrame {
  return {
    correlation: {
      run: row.session,
      branch: "main",
      step: String(row.seq),
      checkpoint: row.id,
    },
    nodeType: row.activity,
    input: { hash: row.inputHash ?? null },
    result: {
      status: "resolved",
      output: { hash: row.outputHash ?? null },
      confidence: 1,
      cost: row.cost ?? {},
    },
    injected: [],
    ts: row.ts,
  };
}

/**
 * `TapeSource` über einer `CaptureStore` (Doc §4). `runIds()` == die distinkten Sessions; `tape(run)` mappt die
 * (seq, ts)-geordneten Zeilen einer Session → `TapeFrame`. In `RunStoreTracesService` gewickelt liefert sie
 * `collect()` mit voller `TraceQuery`-Filterung (runs/feature/nodeType/since/until) — die Service-Schicht macht
 * das Filtern, die TapeSource nur Enumeration + Mapping. Read-only; gleiches `traces:read`-Gating wie der Store.
 */
export class TableTapeSource implements TapeSource {
  constructor(private readonly store: CaptureStore) {}

  runIds(): Promise<string[]> {
    return this.store.sessions();
  }

  tape(run: string): AsyncIterable<TapeFrame> {
    const store = this.store;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<TapeFrame> {
        const rows = await store.events(run); // schon nach (seq, ts) geordnet
        for (const row of rows) yield rowToFrame(row);
      },
    };
  }
}
