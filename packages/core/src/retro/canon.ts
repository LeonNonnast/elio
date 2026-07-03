// ───────────────────────────── Retro-Toolkit: Kanonisierung + Hashing (Tools als Funktionen) ─────────────────────────────
// Reine, deterministische Bausteine, die JEDER Miner teilt (Inv. 15: das Loop Tape ist der Datensatz).
// Determinismus-Erkennung steht und fällt mit STABILER Kanonisierung: gleiche Bedeutung → gleicher Hash,
// unabhängig von Objekt-Schlüssel-Reihenfolge. Node-Builtins only (node:crypto), keine neuen Deps.
//
// Diese Funktionen sind bewusst frei von Tape-/ctx-Wissen — sie operieren auf rohem `unknown` und sind
// damit über alle Miner (und außerhalb des Retro-Kontexts) wiederverwertbar.

import { createHash } from "node:crypto";

/**
 * Kanonische, ordnungs-stabile Projektion eines JSON-Werts:
 *  - Objekt-Schlüssel werden rekursiv **sortiert** (Reihenfolge ist KEINE Bedeutung bei Objekten).
 *  - Arrays behalten ihre Reihenfolge (bei Arrays IST Reihenfolge Bedeutung).
 *  - `undefined`-Objektfelder fallen weg (JSON-Semantik); ein top-level `undefined` wird zu `null`,
 *    damit `canonicalJson` immer einen String liefert.
 *  - Primitive bleiben unverändert.
 *
 * Nicht für zyklische Strukturen gedacht — Tape-Inputs/-Outputs sind JSON-serialisierbar (persistiert).
 */
export function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // JSON-Semantik: undefined-Felder fallen weg
    out[key] = canonicalize(v);
  }
  return out;
}

/**
 * Deterministischer JSON-String über die kanonische Projektion. Stabil über Objekt-Schlüssel-
 * Reihenfolge — zwei semantisch gleiche Werte liefern denselben String (Grundlage für `hashValue`).
 * Liefert IMMER einen String (top-level undefined → "null").
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Stabiler Hash (sha256, hex, gekürzt) über die kanonische Projektion eines Werts. Gleicher (kanonischer)
 * Wert → gleicher Hash; abweichende Schlüssel-Reihenfolge ändert den Hash NICHT. Default-Länge 16 hex-
 * Zeichen (64 bit) reicht für Determinismus-Bucketing; `length` für Tests/Diagnose justierbar.
 */
export function hashValue(value: unknown, length = 16): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, length);
}
