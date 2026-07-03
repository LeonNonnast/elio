// ───────────────────────────── Built-in: script-eval (Inv. 6, klass "orchestration") — Tier-2 ─────────────────────────────
// Die deterministische Node, die eine promotete LLM-Aufrufstelle über GENERIERTEN Code statt das LLM löst
// (Tier-2). Sie führt eine vom LLM generierte reine Funktion (input)=>output ISOLIERT aus (ctx.scripts,
// Worker/VM, Inv. 20). HIT (Skript liefert Output) → die Ausgabe + hit-Flag true; MISS (Wurf/Timeout/OOD →
// ScriptRunResult.ok=false) → nur der (false-)Flag, woraufhin der vom applyCandidate-Rewrite gelegte Edge
// auf den LLM-Step zurückfällt (OOD-Sicherheit; der LLM-Fallback wird nie gekappt, Doc §8).
//
// Anders als memo-lookup (Tier-0, reine Funktion ~gratis, kein ctx) BRAUCHT script-eval ctx.scripts
// (gegated via "scripts:execute"): ohne Grant ist ctx.scripts nicht injiziert → die Node wirft klar
// (security by absence, Inv. 14). Ein promotetes Tier-2-Feature MUSS also zur Laufzeit scripts:execute
// gewähren (ehrliche Grenze ggü. Tier-0, das gar keinen Grant braucht — Doc §9.x).

import type { Node, NodeDefinition, Resolved } from "../node";

export interface ScriptEvalWith {
  /** Der an die generierte Funktion übergebene Input — im Rewrite das `with` des ersetzten LLM-Steps. */
  probe?: unknown;
  /** Der generierte Funktions-Ausdruck direkt (v.a. Tests), z.B. "function (input) { … }". */
  source?: string;
  /**
   * base64(source) — vom applyCandidate-Rewrite genutzt, damit der Runner den Code NICHT template-auflöst
   * (JS-Code enthält "{", würde sonst als "{{…}}" misinterpretiert). Vorrang vor `source`.
   */
  sourceB64?: string;
  /** Hartes Zeitlimit (ms) der Ausführung; an ctx.scripts.run durchgereicht. */
  timeoutMs?: number;
  /** state-Flag-Key, der HIT/MISS signalisiert (Default "__scriptHit") — die Edges routen darauf. */
  hitFlag?: string;
}

/**
 * Dekodiert die base64-Source. leer/fehlend → undefined (die Node wirft dann klar "kein Source"). Eine
 * MALFORMED (nicht-leere) base64 wirft NICHT — Buffer.from dekodiert sie zu (ungültigem) Text, der als
 * Syntaxfehler im vm landet → ScriptRunResult.ok=false → MISS (LLM-Fallback). Die Source stammt im
 * Normalfall aus applyCandidate (encodeSource), ist also wohlgeformt; eine Korruption degradiert sicher
 * auf den Fallback (statt hart zu fehlen).
 */
function decodeSource(b64?: string): string | undefined {
  if (b64 === undefined || b64.length === 0) return undefined;
  return Buffer.from(b64, "base64").toString("utf8");
}

export const scriptEvalHandler: Node<ScriptEvalWith, Record<string, unknown>> = async (input, ctx) => {
  const cfg = (input ?? {}) as ScriptEvalWith;
  const hitFlag = cfg.hitFlag ?? "__scriptHit";
  // security by absence (Inv. 14): ohne scripts:execute-Grant ist ctx.scripts nicht injiziert.
  if (ctx.scripts === undefined) {
    throw new Error(
      "script-eval: ctx.scripts nicht injiziert — security by absence (Inv. 14): diese Node wurde nicht " +
        "für Skript-Ausführung freigegeben (Policy gewährt kein scripts:execute ODER kein Runner verdrahtet).",
    );
  }
  const source = cfg.sourceB64 !== undefined ? decodeSource(cfg.sourceB64) : cfg.source;
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("script-eval: kein Skript-Source (erwartet `source` ODER `sourceB64` in `with`).");
  }

  const opts = cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {};
  const r = await ctx.scripts.run(source, cfg.probe, opts);

  let output: Record<string, unknown>;
  if (r.ok) {
    // Die Skript-Ausgabe wird (wie bei memo) gespreizt, sodass das outputs-Mapping sie auf dieselben
    // state-Felder legt wie der LLM-Step (downstream identisch). Ein nicht-Objekt-Wert → defensiv {value}.
    const out = r.output;
    const obj =
      typeof out === "object" && out !== null && !Array.isArray(out)
        ? (out as Record<string, unknown>)
        : { value: out };
    output = { ...obj, [hitFlag]: true };
  } else {
    output = { [hitFlag]: false };
  }

  const result: Resolved<Record<string, unknown>> = {
    status: "resolved",
    output,
    confidence: 1,
    cost: {},
  };
  return result;
};

export const scriptEvalNode: NodeDefinition<ScriptEvalWith, Record<string, unknown>> = {
  type: "script-eval",
  klass: "orchestration",
  handler: scriptEvalHandler,
  requests: { tools: ["scripts:execute"] },
};
