// ───────────────────────────── Retro-Toolkit: Aufrufstellen-Schlüssel + Gruppierung ─────────────────────────────
// Eine "Call-Site" adressiert eine Stelle im Feature-Graphen über Runs hinweg: (feature, step, nodeType).
// JEDER Miner gruppiert Tape-Frames zuerst nach Call-Site — daher liegt das hier zentral (wiederverwertbar),
// analog zu `corrKey` für CorrelationIds (ids.ts).

import type { TapeFrame } from "../run";

/** Adressiert eine Aufrufstelle über Runs hinweg: (feature, step, nodeType). */
export interface CallSiteKey {
  feature: string;
  step: string;
  nodeType: string;
}

/** Stabiler String-Schlüssel über eine CallSiteKey (fixe Reihenfolge/Trenner, analog `corrKey`). */
export function callSiteKeyString(k: CallSiteKey): string {
  return `${k.feature}::${k.step}::${k.nodeType}`;
}

/**
 * Leitet die CallSiteKey eines Frames ab. `feature` steht NICHT im TapeFrame (es lebt im
 * `run-started`-Event, run.ts) — der Aufrufer reicht es über `featureOf` rein (Default: leer = unbekannt).
 * `step`/`nodeType` kommen direkt aus `correlation.step` bzw. `nodeType`.
 */
export function callSiteKey(frame: TapeFrame, feature = ""): CallSiteKey {
  return { feature, step: frame.correlation.step, nodeType: frame.nodeType };
}

/** Eine gruppierte Aufrufstelle: ihr Schlüssel + alle Frames, die zu ihr gehören (zeitlich geordnet). */
export interface CallSiteGroup {
  key: CallSiteKey;
  frames: TapeFrame[];
}

/**
 * Bucketiert Frames nach Aufrufstelle (feature, step, nodeType). Die Reihenfolge der Frames innerhalb
 * eines Buckets bleibt erhalten (= Tape-Reihenfolge = zeitliche Reihenfolge). `featureOf` bestimmt das
 * Feature pro Frame (z.B. aus einer run→feature-Map des Aufrufers); fehlt es, ist das Feature leer und
 * step+nodeType bilden die Identität. Der Map-Schlüssel ist `callSiteKeyString(key)`.
 */
export function groupByCallSite(
  frames: readonly TapeFrame[],
  // Default: das vom Runner gestempelte `frame.feature` (6b) — Frames beschreiben ihr Feature selbst.
  featureOf: (frame: TapeFrame) => string = (f) => f.feature ?? "",
): Map<string, CallSiteGroup> {
  const groups = new Map<string, CallSiteGroup>();
  for (const frame of frames) {
    const key = callSiteKey(frame, featureOf(frame));
    const ks = callSiteKeyString(key);
    const existing = groups.get(ks);
    if (existing === undefined) {
      groups.set(ks, { key, frames: [frame] });
    } else {
      existing.frames.push(frame);
    }
  }
  return groups;
}
