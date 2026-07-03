// ───────────────────────────── Retro-Toolkit: Prozess-Signaturen + Conformance-Router (Doc §6) ─────────────────────────────
// Reine Ähnlichkeits-Primitive, die der Conformance-Router mit den Discovery-Minern teilt (mineDfg/mineVariants
// berechnen denselben Directly-Follows-Footprint). Eine Session-Signatur = Activity-Sequenz (`variant`) +
// Directly-Follows-Set (`a→b`-Paare). Der Router klassifiziert jede Session gegen einen `processes`-Katalog
// (die schon entdeckten Muster) — exakt über den Fingerprint, fuzzy über Directly-Follows-Jaccard.
//
// REIN/read-only: keine Tape-/ctx-Kenntnis, operiert auf bereits extrahierten nodeType-Sequenzen.

/** Ein entdeckter/promoteter Prozess im Katalog: id + Referenz-Variante + ihr Directly-Follows-Set. */
export interface ProcessSignature {
  id: string;
  /** Referenz-Activity-Sequenz (nodeTypes) dieses Prozesses. */
  variant: string[];
  /** Directly-Follows-Set (`a→b`) der Referenz-Variante (vorberechnet im Katalog). */
  follows: string[];
}

/** Trennzeichen einer Directly-Follows-Kante. Bewusst ein Pfeil — kein nodeType enthält ihn. */
const FOLLOWS_SEP = "→";

/**
 * Directly-Follows-Set einer Variante: jedes konsekutive Paar `(a, b)` der Sequenz wird zu `"a→b"`.
 * Eine Sequenz der Länge n liefert ≤ n-1 distinkte Kanten (ein Set — Wiederholungen kollabieren). Sequenzen
 * der Länge 0/1 haben keine Übergänge → leeres Set.
 */
export function directlyFollows(variant: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < variant.length; i += 1) {
    out.add(`${variant[i] as string}${FOLLOWS_SEP}${variant[i + 1] as string}`);
  }
  return out;
}

/**
 * Jaccard-Ähnlichkeit zweier Mengen: |A ∩ B| / |A ∪ B| in [0,1]. Konvention für den leeren Nenner: sind BEIDE
 * Mengen leer (Vereinigung leer), ist die Ähnlichkeit definitionsgemäß 1 (zwei „leere" Footprints gelten als
 * identisch — eine triviale 1-Schritt-Session matcht eine andere 1-Schritt-Session). Ist nur EINE leer, ist
 * der Schnitt leer und die Ähnlichkeit 0.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // empty ∩ empty: definitionsgemäß identisch
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Router-Kern: klassifiziert eine Session-Signatur gegen den `processes`-Katalog (Doc §6).
 * Fuzzy über Directly-Follows-Jaccard: der beste Match ≥ `theta` → `known` (mit der Katalog-id + Ähnlichkeit),
 * sonst `unknown`. Ein LEERER Katalog → immer `unknown` (Bootstrapping: erste Sessions sind alle unbekannt,
 * Discovery befüllt den Katalog — kein Bug, Doc §5). Die Session-`variant` wird hier nicht gebraucht (der
 * Fingerprint-/Exact-Pfad lebt beim Aufrufer), die Signatur trägt sie aber mit (gemeinsame Form mit den Minern).
 */
export function classifySession(
  sig: { variant: string[]; follows: Set<string> },
  catalog: readonly ProcessSignature[],
  theta = 0.8,
): { classification: "known" | "unknown"; matched?: string; similarity: number } {
  let bestId: string | undefined;
  let bestSim = 0;
  for (const proc of catalog) {
    const sim = jaccard(sig.follows, new Set(proc.follows));
    if (sim > bestSim) {
      bestSim = sim;
      bestId = proc.id;
    }
  }
  if (bestId !== undefined && bestSim >= theta) {
    return { classification: "known", matched: bestId, similarity: bestSim };
  }
  return { classification: "unknown", similarity: bestSim };
}
