// ───────────────────────────── Artefakt: kreuzt die Session-Grenze (Inv. 1/4/22) ─────────────────────────────

export interface ArtifactRef {
  id: string;
  version: number;
  kind: string;
}

/** Erweiterbar: bekannte Holder-Arten + beliebige Strings (Inv. 22, §11/#5). */
export type DataHolderKind = "memory" | "sidecar" | "progress.md" | "db-state" | (string & {});

/**
 * Ein Holder trägt einen Teil des Stands/Rationale. Jeder deklariert seine
 * Concurrency-Strategie (Inv. 22, §11/#6) — löst Inv. 12 ↔ Inv. 1/4.
 */
export interface DataHolder<S = unknown> {
  kind: DataHolderKind;
  /** Round-Trip-fähig: serialize→re-derive→identisch (Pack-Invariante, Inv. 22). */
  read(): Promise<S>;
  write(s: S): Promise<void>;
  version(): Promise<number>;
  concurrency: "transactional" | "disjoint-key" | "single-writer" | "append-only";
}

/** Ein Artefakt-Typ deklariert, welche Holder er komponiert. Erweiterbar. */
export interface ArtifactType {
  kind: string; // = ArtifactRef.kind
  holders: DataHolderKind[]; // z.B. ["db-state", "sidecar", "progress.md", "memory"]
}

export interface Artifact<T = unknown> {
  ref: ArtifactRef;
  /** Deklarierter Typ; bestimmt die komponierten Data-Holder (Inv. 22). */
  type: ArtifactType;
  /** Komprimierter State/Memory; jede Session re-deriviert Kontext hieraus. */
  content: T;
  /** Pluggable Data-Holder, in denen Stand + Rationale/"Warum" leben (Inv. 22). */
  holders: Record<string, DataHolder>;
  /** Eval-Gate: ist das Artefakt "gut genug"? (Inv. 1) */
  evalState?: { score?: number; passed?: boolean; gate: string };
}
