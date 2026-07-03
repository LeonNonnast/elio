// ───────────────────────────── Built-in: memo-lookup (Inv. 6, klass "orchestration") ─────────────────────────────
// Die deterministische Node, die eine promotete LLM-Aufrufstelle ersetzt: sie hasht ihren (template-
// aufgelösten) `probe`-Input und schlägt ihn in einer Tier-0-Tabelle nach. HIT → liefert die memoisierte
// Node-Ausgabe (identisch zur ursprünglichen LLM-Ausgabe) + einen hit-Flag; MISS → nur der (false-)Flag,
// woraufhin der vom applyCandidate-Rewrite gelegte Edge auf den LLM-Step zurückfällt (OOD-Sicherheit).
// Reine Funktion, ~gratis — kein ctx.model, keine Side-Effects.

import type { Node, NodeDefinition, Resolved } from "../node";
import { hashValue } from "../retro";

export interface MemoLookupWith {
  /** Der zu hashende Input — im Rewrite das `with` des ersetzten LLM-Steps (Templates schon aufgelöst). */
  probe?: unknown;
  /** Tier-0-Tabelle direkt (v.a. Tests): inputHash → memoisierte Node-Ausgabe. */
  lookup?: { inputHash: string; output: unknown }[];
  /**
   * base64(JSON) der Tier-0-Tabelle — vom applyCandidate-Rewrite genutzt, damit der Runner die memoisierten
   * Outputs NICHT template-auflöst (sonst würde "{{…}}" in einer LLM-Ausgabe korrumpiert). Vorrang vor `lookup`.
   */
  lookupB64?: string;
  /** state-Flag-Key, der HIT/MISS signalisiert (Default "__memoHit") — die Edges routen darauf. */
  hitFlag?: string;
}

/** Dekodiert die base64(JSON)-Lookup-Tabelle; defensiv (leer/ungültig → []). */
function decodeLookup(b64?: string): { inputHash: string; output: unknown }[] {
  if (b64 === undefined || b64.length === 0) return [];
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as { inputHash: string; output: unknown }[]) : [];
  } catch {
    return [];
  }
}

export const memoLookupHandler: Node<MemoLookupWith, Record<string, unknown>> = (input) => {
  const cfg = (input ?? {}) as MemoLookupWith;
  const hitFlag = cfg.hitFlag ?? "__memoHit";
  const lookup = cfg.lookup ?? decodeLookup(cfg.lookupB64);
  // Gleiche Kanonisierung/Hash-Länge wie determinismStats (canon hashValue, Default 16) → Hit matcht.
  const h = hashValue(cfg.probe);
  const entry = lookup.find((e) => e.inputHash === h);

  let output: Record<string, unknown>;
  if (entry !== undefined) {
    // Die memoisierte Ausgabe ist die Node-Ausgabe des LLM-Steps (typisch ein Objekt wie {text:"…"}).
    // Sie wird gespreizt, sodass das outputs-Mapping des Memo-Steps sie auf dieselben state-Felder legt
    // wie der LLM-Step. Ein nicht-Objekt-Wert wird defensiv unter {value} gelegt.
    const memo =
      typeof entry.output === "object" && entry.output !== null && !Array.isArray(entry.output)
        ? (entry.output as Record<string, unknown>)
        : { value: entry.output };
    output = { ...memo, [hitFlag]: true };
  } else {
    output = { [hitFlag]: false };
  }

  const result: Resolved<Record<string, unknown>> = {
    status: "resolved",
    output,
    confidence: 1,
    cost: {},
  };
  return Promise.resolve(result);
};

export const memoLookupNode: NodeDefinition<MemoLookupWith, Record<string, unknown>> = {
  type: "memo-lookup",
  klass: "orchestration",
  handler: memoLookupHandler,
};
