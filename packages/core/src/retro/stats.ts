// ───────────────────────────── Retro-Toolkit: Determinismus-Statistik + Cost-Aggregation ─────────────────────────────
// Die Kennzahlen, aus denen Miner ihre Schwellwert-Entscheidungen ableiten. Rein und deterministisch —
// operiert auf TapeFrame[] (typisch eine Call-Site-Gruppe aus `groupByCallSite`).

import type { Cost } from "../common";
import type { Failed, Resolved } from "../node";
import type { TapeFrame } from "../run";
import { hashValue } from "./canon";

/** Frame mit einem `resolved`-Result (eng typisiert), das den Output trägt. */
export type ResolvedFrame = TapeFrame & { result: Resolved };
/** Frame mit einem `failed`-Result (eng typisiert), das retryable/attempts/error trägt. */
export type FailedFrame = TapeFrame & { result: Failed };

/** Nur die `resolved` Frames (mit Output) — geteilter Filter mehrerer Miner. */
export function resolvedFrames(frames: readonly TapeFrame[]): ResolvedFrame[] {
  return frames.filter((f): f is ResolvedFrame => f.result.status === "resolved");
}

/** Nur die `failed` Frames (mit retryable/attempts) — geteilter Filter (flaky-retry-miner). */
export function failedFrames(frames: readonly TapeFrame[]): FailedFrame[] {
  return frames.filter((f): f is FailedFrame => f.result.status === "failed");
}

/** Pro Input-Hash gesehene Outputs + ein Beispiel-Paar (Diagnose / Lookup-Tabelle). */
export interface InputBucket {
  /** Distinkte Output-Hashes, die für diesen Input gesehen wurden (Größe 1 = deterministisch). */
  outputs: Set<string>;
  /** Wie oft dieser Input beobachtet wurde. */
  count: number;
  /** Erstes gesehenes (Input, Output)-Paar — Roh-Werte für Synthese/Lookup. */
  sample: { input: unknown; output: unknown };
}

/** Determinismus-Kennzahlen einer Aufrufstelle (über ihre `resolved` Frames). */
export interface DeterminismStats {
  /** # ausgewertete (resolved) Beobachtungen. */
  support: number;
  /** # distinkte Input-Hashes. */
  distinctInputs: number;
  /**
   * Determinismus-Quote in [0,1]: Anteil der Input-Hashes, deren Output über alle Beobachtungen
   * EINDEUTIG ist (genau 1 distinkter Output-Hash). 1 = jede gesehene Eingabe bildet stabil ab;
   * 0 = keine. `distinctInputs == 0` (keine resolved Frames) → 0.
   */
  determinism: number;
  /** Input-Hashes mit eindeutigem Output = die Domäne, in der ein gelerntes Skript sicher antworten darf. */
  domain: string[];
  /** Pro Input-Hash: Outputs + count + Beispiel-Paar (Reihenfolge = erste Sichtung). */
  perInput: Map<string, InputBucket>;
}

/**
 * Berechnet Determinismus-Kennzahlen über die resolved Frames einer (typisch nach Call-Site gruppierten)
 * Frame-Menge. Bucketiert nach kanonischem Input-Hash; pro Bucket die Menge gesehener Output-Hashes.
 */
export function determinismStats(frames: readonly TapeFrame[]): DeterminismStats {
  const resolved = resolvedFrames(frames);
  const perInput = new Map<string, InputBucket>();
  for (const f of resolved) {
    const ih = hashValue(f.input);
    const oh = hashValue(f.result.output);
    const rec = perInput.get(ih);
    if (rec === undefined) {
      perInput.set(ih, {
        outputs: new Set([oh]),
        count: 1,
        sample: { input: f.input, output: f.result.output },
      });
    } else {
      rec.outputs.add(oh);
      rec.count += 1;
    }
  }
  const distinctInputs = perInput.size;
  const domain: string[] = [];
  for (const [ih, rec] of perInput) {
    if (rec.outputs.size === 1) domain.push(ih);
  }
  // Stabil sortieren: die Domäne speist (über das proposal) die Kandidaten-id — ihre Reihenfolge muss
  // unabhängig von der Frame-/Insertion-Reihenfolge sein, damit re-mining idempotent dedupliziert (Doc §5).
  domain.sort();
  const determinism = distinctInputs === 0 ? 0 : domain.length / distinctInputs;
  return { support: resolved.length, distinctInputs, determinism, domain, perInput };
}

/**
 * Summiert Cost-Werte (usd + tokensIn/Out), nur gesetzte Felder — der kanonische Aggregator (Inv. 21).
 * `model` übernimmt den letzten gesetzten Wert. Leeres Array → `{}` (kein Feld gesetzt).
 *
 * (Hinweis: `nodes/agent.ts` trägt eine lokale `addCost`-Variante für Zwei-Operanden-Summen; dieser
 *  Aggregator ist die wiederverwertbare n-stellige Form für die Miner — Konvergenz wäre ein späterer Cleanup.)
 */
export function aggregateCost(costs: readonly Cost[]): Cost {
  const out: Cost = {};
  let usd = 0;
  let hasUsd = false;
  let tokensIn = 0;
  let tokensOut = 0;
  let model: string | undefined;
  for (const c of costs) {
    if (c.usd !== undefined) {
      usd += c.usd;
      hasUsd = true;
    }
    if (c.tokensIn !== undefined) tokensIn += c.tokensIn;
    if (c.tokensOut !== undefined) tokensOut += c.tokensOut;
    if (c.model !== undefined) model = c.model;
  }
  if (hasUsd) out.usd = usd;
  if (tokensIn !== 0) out.tokensIn = tokensIn;
  if (tokensOut !== 0) out.tokensOut = tokensOut;
  if (model !== undefined) out.model = model;
  return out;
}

/** Distinkte Run-IDs einer Frame-Menge (Provenance für Kandidaten: aus welchen Runs stammt die Aussage). */
export function uniqueRuns(frames: readonly TapeFrame[]): string[] {
  const runs = new Set<string>();
  for (const f of frames) runs.add(f.correlation.run);
  return [...runs];
}

/**
 * Gruppiert Frames nach `correlation.run`, Reihenfolge innerhalb eines Runs erhalten (= Tape-Reihenfolge =
 * zeitliche Abfolge). Für Miner, die eine PRO-RUN-Sequenz brauchen (loop-bound zählt Iterationen je Run;
 * fail-fast prüft die Step-Abfolge innerhalb eines Runs). Einfügereihenfolge der Runs bleibt erhalten.
 */
export function groupByRun(frames: readonly TapeFrame[]): Map<string, TapeFrame[]> {
  const byRun = new Map<string, TapeFrame[]>();
  for (const f of frames) {
    const existing = byRun.get(f.correlation.run);
    if (existing === undefined) byRun.set(f.correlation.run, [f]);
    else existing.push(f);
  }
  return byRun;
}
