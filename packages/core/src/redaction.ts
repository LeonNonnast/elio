// ───────────────────────────── Tape-Redaction (Inv. 16/23, §11/#8/#9, Inv. 15) ─────────────────────────────
// Das Loop Tape darf (a) Secret-Werte NIE roh enthalten (§11/#8: ctx.secrets-Werte sind auto-redacted)
// und (b) Nutzdaten ÜBER der konfigurierten Datenklasse nicht roh speichern (§11/#9: roh nur ≤ Datenklasse,
// darüber Hash/Ref/redacted). Der Redactor ist die zentrale Schnittstelle für beides:
//  - register(value): meldet einen Geheimwert an (vom scoped SecretsService, security by absence).
//  - redactFrame(frame): liefert eine redaktierte Kopie. Reihenfolge: erst die Datenklassen-Projektion
//    (Felder über der Schwelle -> Hash/Ref-Platzhalter), dann das Secret-Masking. Registrierte Secrets
//    werden IMMER maskiert, unabhängig von der Datenklasse.
// So ist Redaction *by construction* — eine Node muss nichts tun.

import { createHash } from "node:crypto";
import { dataClassRank } from "./policy-impl";
import type { DataClassification } from "./policy-impl";
import type { TapeFrame } from "./run";

const PLACEHOLDER = "[redacted:secret]";

/** Stabiler, kurzer Inhalts-Hash (sha256, 12 hex chars) als Ref über der Datenklassen-Schwelle. */
export function refHash(value: unknown): string {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  const digest = createHash("sha256").update(serialized).digest("hex").slice(0, 12);
  return `[redacted:${digest}]`;
}

/**
 * Klassifiziert ein Feld (per Pfad + Wert) auf eine Datenklasse. Default-Konvention (siehe
 * defaultClassifier): der Feld-/Pfadname trägt die Klasse. Ein Feature kann einen eigenen Classifier
 * injizieren (z.B. aus einem Schema), ohne den Redactor-Contract zu brechen.
 */
export type DataClassifier = (path: string, value: unknown) => DataClassification | undefined;

// ───────────────────────────── redact(value, threshold, classify) (§11/#9) ─────────────────────────────

export interface RedactProjection {
  /** Der projizierte Wert: Felder über der Schwelle sind durch Hash/Ref-Platzhalter ersetzt. */
  value: unknown;
  /** Pfade der projizierten (über-der-Schwelle) Felder. */
  redactedFields: string[];
}

/**
 * Projiziert einen Wert für das Tape (§11/#9, Inv. 16/23): jedes Feld, dessen klassifizierte
 * Datenklasse RESTRIKTIVER ist als `threshold`, wird durch einen stabilen Hash/Ref-Platzhalter
 * ersetzt; Felder ≤ threshold bleiben roh. `classify` liefert die Klasse eines Feldes (default:
 * Pfad-/Key-Namens-Konvention). Nicht-mutierend.
 *
 * Wichtig: die Klassifikation eines Containers (Objekt/Array) deckt seinen GANZEN Teilbaum ab — ist
 * ein Objekt-Feld z.B. "confidential" markiert, wird der ganze Teilwert als ein Ref projiziert (nicht
 * Feld für Feld), damit kein Roh-Sub-Feld durchsickert.
 */
export function redact(
  value: unknown,
  threshold: DataClassification,
  classify: DataClassifier = defaultClassifier,
): RedactProjection {
  const redactedFields: string[] = [];
  const thresholdRank = dataClassRank(threshold);

  const walk = (v: unknown, path: string, inheritedClass: DataClassification | undefined): unknown => {
    // Eigene Klasse dieses Feldes (oder die vom Container geerbte).
    const own = classify(path, v) ?? inheritedClass;
    if (own !== undefined && dataClassRank(own) > thresholdRank) {
      redactedFields.push(path === "" ? "(root)" : path);
      return refHash(v);
    }
    if (Array.isArray(v)) {
      return v.map((el, i) => walk(el, path === "" ? `[${i}]` : `${path}[${i}]`, own));
    }
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(sub, path === "" ? k : `${path}.${k}`, own);
      }
      return out;
    }
    return v;
  };

  return { value: walk(value, "", undefined), redactedFields };
}

// ───────────────────────────── Default-Classifier (Key-Namens-Konvention) ─────────────────────────────
// v0.1: ein Feld trägt seine Datenklasse über den Schlüssel-/Pfadnamen. Reicht für die Demos +
// macht "ein confidential Feld wird gehasht, ein public Feld bleibt roh" testbar, ohne einen
// schwergewichtigen Schema-Annotations-Mechanismus. Erweiterbar: ein Feature kann einen eigenen
// DataClassifier (z.B. schema-getrieben) übergeben.

const CLASS_KEYWORDS: ReadonlyArray<readonly [DataClassification, readonly string[]]> = [
  ["regulated", ["regulated", "ssn", "pii", "creditcard", "credit_card"]],
  ["private", ["private", "secret", "password", "token", "apikey", "api_key", "credential"]],
  ["confidential", ["confidential", "salary", "sensitive"]],
  ["internal", ["internal"]],
  ["public", ["public"]],
];

/** Leitet die Datenklasse eines Feldes aus dem letzten Pfad-Segment ab (case-insensitive substring). */
export function defaultClassifier(path: string): DataClassification | undefined {
  if (path === "") return undefined;
  const segment = String(path.split(/[.[]/).pop() ?? "").toLowerCase();
  if (segment === "") return undefined;
  for (const [cls, keywords] of CLASS_KEYWORDS) {
    if (keywords.some((kw) => segment.includes(kw))) return cls;
  }
  return undefined;
}

// ───────────────────────────── Redactor-Schnittstelle ─────────────────────────────

/**
 * Zentrale Redaction-Schnittstelle. `register(value)` meldet einen Geheimwert an (idempotent;
 * leere/triviale Werte werden ignoriert, damit nicht versehentlich `""` jeden String zerstört).
 * `redactFrame(frame)` liefert eine redaktierte Kopie des Frames (Original unverändert): erst die
 * Datenklassen-Projektion (§11/#9), dann das Secret-Masking (§11/#8).
 */
export interface Redactor {
  register(value: string): void;
  /** Ob ein Wert registriert ist (Test/Audit-Komfort). */
  has(value: string): boolean;
  /** Redaktiert einen Tape-Frame: Datenklassen-Projektion + Secret-Masking in input/result. */
  redactFrame(frame: TapeFrame): TapeFrame;
  /** Redaktiert einen beliebigen String (z.B. für Logs/Errors). */
  redactString(s: string): string;
}

export interface TapeRedactorOptions {
  /**
   * Schwelle der Datenklassen-Projektion (§11/#9): Felder über dieser Klasse werden im Tape durch
   * Hash/Ref-Platzhalter ersetzt; Felder ≤ threshold bleiben roh. Fehlt sie, ist die Datenklassen-
   * Projektion AUS (nur Secret-Masking aktiv) — abwärtskompatibel zum reinen Secret-Redactor.
   */
  dataClassification?: DataClassification;
  /** Eigener Classifier (Default: Key-Namens-Konvention). */
  classify?: DataClassifier;
}

/**
 * In-Memory-Redactor (v0.1-Default). Hält die registrierten Geheimwerte in einem Set und (optional)
 * eine Datenklassen-Schwelle. Scrubbt beides tief aus jedem Frame, bevor er ins Tape geht.
 */
export class TapeRedactor implements Redactor {
  private readonly secrets = new Set<string>();
  private readonly threshold: DataClassification | undefined;
  private readonly classify: DataClassifier;

  constructor(opts: TapeRedactorOptions = {}) {
    this.threshold = opts.dataClassification;
    this.classify = opts.classify ?? defaultClassifier;
  }

  register(value: string): void {
    // Triviale Werte (leer / 1 Zeichen) NICHT registrieren: ein "" oder " " würde sonst jeden String
    // im Tape vollständig zerstören. Echte Secrets sind länger; das ist eine pragmatische Untergrenze.
    if (typeof value === "string" && value.length > 1) {
      this.secrets.add(value);
    }
  }

  has(value: string): boolean {
    return this.secrets.has(value);
  }

  redactString(s: string): string {
    let out = s;
    for (const secret of this.secrets) {
      if (out.includes(secret)) {
        out = out.split(secret).join(PLACEHOLDER);
      }
    }
    return out;
  }

  redactFrame(frame: TapeFrame): TapeFrame {
    const projectFields: string[] = [];
    let level: DataClassification | undefined = frame.redaction?.level;

    // 1) Datenklassen-Projektion (§11/#9): Felder über der Schwelle -> Hash/Ref. Schwelle = der explizit
    //    konfigurierte `threshold` ODER (sonst) die vom Runner gestempelte `frame.redaction.level` (=
    //    die resolvte Datenklasse des Runs). Ist KEINE Schwelle bestimmbar, bleibt die Projektion AUS
    //    (reines Secret-Masking, abwärtskompatibel).
    const threshold = this.threshold ?? frame.redaction?.level;
    let input = frame.input;
    let result: TapeFrame["result"] = frame.result;
    if (threshold !== undefined) {
      const pIn = redact(input, threshold, this.classify);
      const pRes = redact(result, threshold, this.classify);
      input = pIn.value;
      result = pRes.value as TapeFrame["result"];
      for (const f of pIn.redactedFields) projectFields.push(`input.${f}`);
      for (const f of pRes.redactedFields) projectFields.push(`result.${f}`);
      level = threshold;
    }

    // 2) Secret-Masking (§11/#8): registrierte Werte IMMER maskieren, unabhängig von der Datenklasse.
    const secretFields: string[] = [];
    if (this.secrets.size > 0) {
      input = this.deepRedact(input, "input", secretFields);
      result = this.deepRedact(result, "result", secretFields) as TapeFrame["result"];
    }

    const redactedFields = [...projectFields, ...secretFields];
    if (redactedFields.length === 0) return frame;

    const out: TapeFrame = { ...frame, input, result };
    out.redaction = { level: level ?? "confidential", redactedFields };
    return out;
  }

  /** Rekursiv: ersetzt registrierte Werte in Strings; merkt sich den Pfad jedes Treffers. */
  private deepRedact(value: unknown, path: string, hits: string[]): unknown {
    if (typeof value === "string") {
      const r = this.redactString(value);
      if (r !== value) hits.push(path);
      return r;
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => this.deepRedact(v, `${path}[${i}]`, hits));
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.deepRedact(v, `${path}.${k}`, hits);
      }
      return out;
    }
    return value;
  }
}

// ───────────────────────────── scrub: Tape zu Step N zurückspulen (Inv. 15) ─────────────────────────────

/**
 * Spult ein Loop Tape zu Step N zurück (Inv. 15: "scrubben, zu Step N zurückspulen"). Gibt die ERSTEN
 * `n` Frames zurück (die Vorgeschichte bis einschließlich Step n-1) — die Grundlage für "Modell tauschen,
 * vorwärts neu rechnen". Nicht-mutierend (gibt eine Kopie); `n <= 0` -> [], `n >= length` -> alle Frames.
 *
 * Bewusst frame-index-basiert (jeder Frame = ein ausgeführter Step inkl. Gate-Frames), passend zum
 * persistierten Tape (RunStore.tape / getTape). Ein selektiveres "zu correlation X" baut darauf auf.
 */
export function scrubTape(frames: readonly TapeFrame[], n: number): TapeFrame[] {
  if (n <= 0) return [];
  return frames.slice(0, n);
}
