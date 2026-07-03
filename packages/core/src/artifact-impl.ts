// ───────────────────────────── Artefakt-Impl: Data-Holder + createArtifact/applyTo/reDerive (Inv. 1/4/22, §11/#5/#6) ─────────────────────────────
// Das Artefakt ist das durable Ziel; sein Stand lebt in pluggable Data-Holdern.
// Pack-Invariante: serialize -> reDerive -> identisch (Round-Trip).

import { newBranchId } from "./ids";
import type { Artifact, ArtifactType, DataHolder, DataHolderKind } from "./artifact";

// ───────────────────────────── Data-Holder-Implementierungen (§11/#6) ─────────────────────────────

/**
 * MemoryHolder — append-only (konfliktfrei, Inv. 22 / §11/#6).
 * Episodic/Layered-Memory: write() hängt an, überschreibt nie. read() liefert die Liste.
 */
export class MemoryHolder<E = unknown> implements DataHolder<E[]> {
  readonly kind: DataHolderKind = "memory";
  readonly concurrency = "append-only" as const;
  private entries: E[];
  private ver: number;

  constructor(initial: E[] = []) {
    this.entries = [...initial];
    this.ver = initial.length;
  }

  read(): Promise<E[]> {
    return Promise.resolve([...this.entries]);
  }

  /** Append-only: jeder write hängt die übergebenen Einträge an (überschreibt nie). */
  write(s: E[]): Promise<void> {
    for (const e of s) {
      this.entries.push(e);
      this.ver += 1;
    }
    return Promise.resolve();
  }

  /** Bequemes Append eines einzelnen Eintrags. */
  append(e: E): Promise<void> {
    this.entries.push(e);
    this.ver += 1;
    return Promise.resolve();
  }

  version(): Promise<number> {
    return Promise.resolve(this.ver);
  }
}

/**
 * ProgressMdHolder — single-writer (via Outer Loop, §11/#6).
 * Laufendes Stand-/Entscheidungs-Scratchpad als ein String. write() ersetzt vollständig.
 */
export class ProgressMdHolder implements DataHolder<string> {
  readonly kind: DataHolderKind = "progress.md";
  readonly concurrency = "single-writer" as const;
  private text: string;
  private ver: number;

  constructor(initial = "") {
    this.text = initial;
    this.ver = 0;
  }

  read(): Promise<string> {
    return Promise.resolve(this.text);
  }

  write(s: string): Promise<void> {
    this.text = s;
    this.ver += 1;
    return Promise.resolve();
  }

  version(): Promise<number> {
    return Promise.resolve(this.ver);
  }
}

/**
 * DbStateHolder — disjoint-key (per-record `id` kollidiert nie, §11/#6/#11).
 * Strukturierter/abfragbarer Stand als Map record.id -> record. Dient zugleich als
 * Effect-Ledger (applied record.ids) für Idempotenz (§11/#11).
 */
export class DbStateHolder<R extends { id: string } = { id: string }>
  implements DataHolder<R[]>
{
  readonly kind: DataHolderKind = "db-state";
  readonly concurrency = "disjoint-key" as const;
  private records: Map<string, R>;
  private ver: number;

  constructor(initial: R[] = []) {
    this.records = new Map(initial.map((r) => [r.id, r]));
    this.ver = this.records.size;
  }

  /** Stabile, deterministische Reihenfolge (Insertion-Order der Map). */
  read(): Promise<R[]> {
    return Promise.resolve([...this.records.values()]);
  }

  /** Disjoint-key upsert: setzt/überschreibt pro record.id; Keys kollidieren nie. */
  write(s: R[]): Promise<void> {
    for (const r of s) {
      this.records.set(r.id, r);
      this.ver += 1;
    }
    return Promise.resolve();
  }

  /** Idempotenz-Check: wurde dieser record.id schon angewandt? (§11/#11) */
  has(id: string): boolean {
    return this.records.has(id);
  }

  version(): Promise<number> {
    return Promise.resolve(this.ver);
  }
}

// ───────────────────────────── Holder-Factory pro Holder-Kind ─────────────────────────────

/** Baut den passenden Holder zu einem deklarierten Holder-Kind (Inv. 22). */
export function createHolder(kind: DataHolderKind): DataHolder {
  switch (kind) {
    case "memory":
      return new MemoryHolder() as DataHolder;
    case "progress.md":
      return new ProgressMdHolder() as DataHolder;
    case "db-state":
      return new DbStateHolder() as DataHolder;
    case "sidecar":
      // Sidecar (z.B. decisions.md) = single-writer String; v0.1 wie progress.md.
      return new ProgressMdHolder() as DataHolder;
    default:
      // Erweiterbar: unbekannter Kind -> append-only Memory als sicherer Default.
      return new MemoryHolder() as DataHolder;
  }
}

// ───────────────────────────── createArtifact / applyTo / reDerive ─────────────────────────────

/**
 * Baut ein frisches Artefakt eines Typs mit den vom Typ deklarierten Holdern (Inv. 22).
 * `content` ist der initiale komprimierte State; jede Session re-deriviert hieraus.
 */
export function createArtifact<T>(type: ArtifactType, content: T): Artifact<T> {
  const holders: Record<string, DataHolder> = {};
  for (const kind of type.holders) {
    holders[kind] = createHolder(kind);
  }
  return {
    ref: { id: newBranchId().replace(/^branch_/, "artifact_"), version: 0, kind: type.kind },
    type,
    content,
    holders,
  };
}

/**
 * Wächst das Artefakt um `output` (Inv. 1) und bumpt `ref.version`.
 * - `content` wird flach gemerged (Objekt) bzw. ersetzt (primitive/array).
 * - Holder werden mit dem für ihren Kind passenden Teil des Outputs gespeist
 *   (Round-Trip-Quelle): db-state <- output.records, memory <- output.memory,
 *   progress.md <- output.progress; sonst der ganze Output unter dem Kind-Key.
 *
 * Mutiert das Artefakt in-place (single artifact state, Inv. 1/4) und gibt es zurück.
 */
export async function applyTo<T>(artifact: Artifact<T>, output: unknown): Promise<Artifact<T>> {
  // 1) content wachsen lassen. `__`-präfixierte Felder sind Control-/Routing-Werte (z.B. der memo-lookup
  //    Hit-Flag), KEIN Artefakt-Inhalt — sie reisen via outputs-Mapping in den state (Edges routen darauf),
  //    dürfen aber das durable content nicht verändern (sonst bricht ein Graph-Rewrite die Shape-Parität
  //    zum Original, §11/#5 — Promotion soll verhaltenstreu sein).
  if (isPlainObject(artifact.content) && isPlainObject(output)) {
    artifact.content = { ...artifact.content, ...stripControlFields(output) } as T;
  } else if (output !== undefined) {
    artifact.content = output as T;
  }

  // 2) Holder speisen (so dass reDerive den content rekonstruieren kann)
  if (isPlainObject(output)) {
    const out = output as Record<string, unknown>;
    for (const holder of Object.values(artifact.holders)) {
      const slice = holderSlice(holder.kind, out);
      if (slice !== undefined) {
        await holder.write(slice as never);
      }
    }
  }

  // 3) Version bumpen (Inv. 1)
  artifact.ref = { ...artifact.ref, version: artifact.ref.version + 1 };
  return artifact;
}

/**
 * Liest den Stand aus den Holdern zurück und rekonstruiert `content` (Inv. 4/22).
 * Pack-Invariante: serialize -> reDerive -> identisch.
 * Nicht-mutierend: gibt ein neues Artefakt mit re-deriviertem content zurück.
 */
export async function reDerive<T>(artifact: Artifact<T>): Promise<Artifact<T>> {
  const derived: Record<string, unknown> = isPlainObject(artifact.content)
    ? { ...(artifact.content as Record<string, unknown>) }
    : {};

  for (const holder of Object.values(artifact.holders)) {
    const state = await holder.read();
    const fieldKey = holderField(holder.kind);
    if (fieldKey !== undefined) {
      // Nur überschreiben, wenn der Holder tatsächlich Stand trägt — sonst content-Wert behalten.
      if (holderHasState(state)) {
        derived[fieldKey] = state;
      }
    }
  }

  const content = (isPlainObject(artifact.content) ? derived : artifact.content) as T;
  return {
    ...artifact,
    content,
  };
}

/**
 * Serialisiert ein Artefakt in einen JSON-fähigen Snapshot (Holder-Stand wird mit-serialisiert).
 * Gegenstück zu deserialize(); zusammen mit reDerive die Round-Trip-Kette.
 */
export interface SerializedArtifact {
  ref: Artifact["ref"];
  type: ArtifactType;
  content: unknown;
  holders: Record<string, { kind: DataHolderKind; concurrency: DataHolder["concurrency"]; state: unknown }>;
  evalState?: Artifact["evalState"];
}

export async function serializeArtifact<T>(artifact: Artifact<T>): Promise<SerializedArtifact> {
  const holders: SerializedArtifact["holders"] = {};
  for (const [key, holder] of Object.entries(artifact.holders)) {
    holders[key] = {
      kind: holder.kind,
      concurrency: holder.concurrency,
      state: await holder.read(),
    };
  }
  const out: SerializedArtifact = {
    ref: { ...artifact.ref },
    type: { kind: artifact.type.kind, holders: [...artifact.type.holders] },
    content: artifact.content,
    holders,
  };
  if (artifact.evalState !== undefined) {
    out.evalState = { ...artifact.evalState };
  }
  return out;
}

/** Rehydriert ein Artefakt aus einem Snapshot; Holder werden mit ihrem Stand befüllt. */
export function deserializeArtifact<T = unknown>(snap: SerializedArtifact): Artifact<T> {
  const holders: Record<string, DataHolder> = {};
  for (const [key, h] of Object.entries(snap.holders)) {
    holders[key] = rebuildHolder(h.kind, h.state);
  }
  const artifact: Artifact<T> = {
    ref: { ...snap.ref },
    type: { kind: snap.type.kind, holders: [...snap.type.holders] },
    content: snap.content as T,
    holders,
  };
  if (snap.evalState !== undefined) {
    artifact.evalState = { ...snap.evalState };
  }
  return artifact;
}

// ───────────────────────────── Helpers ─────────────────────────────

function rebuildHolder(kind: DataHolderKind, state: unknown): DataHolder {
  switch (kind) {
    case "memory":
      return new MemoryHolder(Array.isArray(state) ? state : []) as DataHolder;
    case "db-state":
      return new DbStateHolder(
        Array.isArray(state) ? (state as { id: string }[]) : [],
      ) as DataHolder;
    case "progress.md":
    case "sidecar":
      return new ProgressMdHolder(typeof state === "string" ? state : "") as DataHolder;
    default:
      return new MemoryHolder(Array.isArray(state) ? state : []) as DataHolder;
  }
}

/** Welcher content-Feld-Key gehört zu einem Holder-Kind (Round-Trip-Brücke). */
function holderField(kind: DataHolderKind): string | undefined {
  switch (kind) {
    case "memory":
      return "memory";
    case "db-state":
      return "records";
    case "progress.md":
      return "progress";
    case "sidecar":
      return "sidecar";
    default:
      return undefined;
  }
}

/** Aus einem Output-Objekt den für den Holder relevanten Slice ziehen. */
function holderSlice(kind: DataHolderKind, out: Record<string, unknown>): unknown {
  const field = holderField(kind);
  if (field === undefined) return undefined;
  return out[field];
}

function holderHasState(state: unknown): boolean {
  if (Array.isArray(state)) return state.length > 0;
  if (typeof state === "string") return state.length > 0;
  return state !== undefined && state !== null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Entfernt Control-/Routing-Felder (`__`-Präfix) aus einem Node-Output, bevor er ins Artefakt-content
 * gefaltet wird. Solche Felder (z.B. der memo-lookup Hit-Flag) steuern nur das Graph-Routing über den
 * state und gehören nicht in den durable Inhalt. Kein built-in Node außer memo-lookup nutzt `__`-Keys.
 */
function stripControlFields(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("__")) continue;
    out[k] = v;
  }
  return out;
}
