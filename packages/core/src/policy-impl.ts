// ───────────────────────────── Policy-Impl: tighten-only Halbordnungen (Inv. 13/14, §11/#15) ─────────────────────────────
// "Author proposes, Policy disposes — Policy kann nur verschärfen (tighten), nie lockern (loosen)."
// Maschinell prüfbar: pro Achse eine explizite Halbordnung; tighten = Richtung restriktiver.

import { resolve, sep } from "node:path";
import type { CapabilityRequest, Policy, ResolvedPolicy } from "./policy";
import type { SuspendMode } from "./elicitation";

export type DataClassification = ResolvedPolicy["dataClassification"];

/** data-class: public(0) < internal(1) < confidential(2) < private(3) < regulated(4). Restriktiver = höher. */
export const DATA_CLASSIFICATION_ORDER: readonly DataClassification[] = [
  "public",
  "internal",
  "confidential",
  "private",
  "regulated",
];

/** suspend-mode: optional ⊑ timeout ⊑ parked ⊑ blocking. Mehr Oversight = tighter = höher. */
export const SUSPEND_MODE_ORDER: readonly SuspendMode[] = [
  "optional",
  "timeout",
  "parked",
  "blocking",
];

export function dataClassRank(c: DataClassification): number {
  const i = DATA_CLASSIFICATION_ORDER.indexOf(c);
  return i < 0 ? 0 : i;
}

export function suspendModeRank(m: SuspendMode): number {
  const i = SUSPEND_MODE_ORDER.indexOf(m);
  return i < 0 ? 0 : i;
}

/** max = restriktiver gewinnt (für data-class & suspend-mode). */
export function maxDataClass(a: DataClassification, b: DataClassification): DataClassification {
  return dataClassRank(a) >= dataClassRank(b) ? a : b;
}

export function maxSuspendMode(a: SuspendMode, b: SuspendMode): SuspendMode {
  return suspendModeRank(a) >= suspendModeRank(b) ? a : b;
}

// ───────────────────────────── Root-Policy: permissiv-by-default ─────────────────────────────
/**
 * Permissive-by-default Root (Inv. 23: Plattform liefert Mechanismus, Policy entscheidet).
 * - allowCloud:false (cloud erst per expliziter Request + jede Policy-Ebene erlaubt)
 * - dataClassification:"internal" (Default-Klasse; Hard-Cap-Diskussion §11/#2)
 * - suspendMode:"optional" als loosester Root (mehr Oversight kann nur dazukommen)
 * - allowedModels:[], toolPermissions:[] (security by absence: leer = kein Service injiziert)
 *
 * Overrides erlauben Tests/Features, einen anderen Root zu setzen (z.B. ein Modell freizugeben),
 * gegen den `tighten` dann nur verschärfen kann.
 */
export function rootPolicy(overrides?: Partial<ResolvedPolicy>): ResolvedPolicy {
  const base: ResolvedPolicy = {
    allowedModels: [],
    allowCloud: false,
    dataClassification: "internal",
    suspendMode: "optional",
    toolPermissions: [],
  };
  const merged: ResolvedPolicy = { ...base, ...(overrides ?? {}) };
  // Defensive Kopien der Mengen-Achsen, damit overrides den Caller-State nicht teilen.
  merged.allowedModels = [...merged.allowedModels];
  merged.toolPermissions = [...merged.toolPermissions];
  if (merged.dbScopes !== undefined) merged.dbScopes = [...merged.dbScopes];
  if (merged.httpHosts !== undefined) merged.httpHosts = [...merged.httpHosts];
  if (merged.fsPaths !== undefined) {
    merged.fsPaths = { read: [...merged.fsPaths.read], write: [...merged.fsPaths.write] };
  }
  return merged;
}

// ───────────────────────────── tighten(parent, req) — nur verschärfen ─────────────────────────────
/**
 * Mengen-Schnitt erhaltend der Reihenfolge von `parent` (deterministisch). Tighten-only (Inv. 13):
 * das Ergebnis ist immer eine TEILMENGE von `parent` — eine Node kann nie etwas erhalten, das der
 * Parent nicht erlaubt.
 *
 * Wildcard "*" im REQUEST: ein Request, der "*" enthält, bedeutet "alles, was der Parent erlaubt"
 * (= `parent` unverändert). Das ist KEINE Lockerung — "*" expandiert ausschließlich auf die bereits
 * erlaubte Parent-Menge (leerer Parent -> leeres Ergebnis), und jede Policy, die `allowedModels`
 * verengt, verengt damit automatisch, was eine "*"-anfordernde Node bekommt. Genutzt von den
 * built-in Klasse-2-Nodes (llm/agent), die "gib mir die erlaubten Modelle" ausdrücken, ohne konkrete
 * IDs zu pinnen (die Policy entscheidet, Inv. 14). Im PARENT (allowedModels) hat "*" keine
 * Sonderbedeutung — dort sind es konkrete IDs.
 */
function intersect(parent: string[], req: string[]): string[] {
  if (req.includes("*")) return [...parent];
  const reqSet = new Set(req);
  return parent.filter((x) => reqSet.has(x));
}

/**
 * Pfad-Präfix-Schnitt: ein gewünschter Pfad ist erlaubt, wenn er unter (oder gleich)
 * einem erlaubten Präfix liegt. Ergebnis = die gewünschten Pfade, die ein Präfix matchen.
 *
 * Wildcard "*" im WANTED (analog zu intersect()): bedeutet "alle Pfade, die der Parent erlaubt"
 * (= `allowed` unverändert). KEINE Lockerung — "*" expandiert ausschließlich auf die bereits
 * erlaubten Parent-Präfixe (leerer Parent -> leeres Ergebnis); genutzt von der built-in file-Node,
 * die "gib mir die erlaubten fs-Pfade" ausdrückt, ohne konkrete Pfade zu pinnen (die Policy
 * entscheidet, Inv. 14). Im PARENT (allowed) hat "*" keine Sonderbedeutung — dort sind es Präfixe.
 */
function intersectPaths(allowed: string[], wanted: string[]): string[] {
  if (wanted.includes("*")) return [...allowed];
  return wanted.filter((w) => allowed.some((p) => isUnderPrefix(w, p)));
}

/**
 * Ob ein gewünschter Pfad unter (oder gleich) einem erlaubten Präfix liegt — NACH Normalisierung mit
 * path.resolve() (kollabiert "..", ".", absolute Sprünge), damit ein traversal-tragender Wunsch wie
 * "/data/../etc" auf "/etc" kollabiert und NICHT unter "/data" durchrutscht (§11/#1, Inv. 13). Ohne die
 * Normalisierung würde tighten()/enforceTightenOnly() ein "/data/../etc" gegen einen "/data"-Parent
 * akzeptieren und damit ein escaping Präfix in die resolvte Policy aufnehmen (Widening — verbotener
 * tighten-Verstoß). Spiegelt die injector/Backend-fs-Normalisierung (eine Quelle der Wahrheit).
 */
function isUnderPrefix(path: string, prefix: string): boolean {
  const absPath = resolve(path);
  const absPrefix = resolve(prefix);
  if (absPath === absPrefix) return true;
  const withSep = absPrefix.endsWith(sep) ? absPrefix : `${absPrefix}${sep}`;
  return absPath.startsWith(withSep);
}

/**
 * tighten(parent, req): leitet die ResolvedPolicy für eine Node aus dem Parent + ihrem
 * CapabilityRequest ab. Verschärft ausschließlich (Inv. 13):
 *  - dataClassification: max (restriktiver gewinnt) — Policy kann nur RAISEn (req kann nicht senken).
 *  - suspendMode: max (mehr Oversight = tighter).
 *  - allowedModels / toolPermissions / dbScopes: Mengen-SCHNITT (req ∩ parent), nie Hinzufügen.
 *  - allowCloud: parent.allowCloud && !!req.cloud.
 *  - fsPaths.read/write: gewünschte Pfade ∩ erlaubte Präfixe.
 *  - maxCostUsd: min(parent, req/policy).
 *
 * Wichtig (security by absence): das Ergebnis listet NUR, was die Node angefordert UND der
 * Parent erlaubt hat. Eine nicht-angeforderte Capability kann NIE auftauchen.
 */
export function tighten(parent: ResolvedPolicy, req?: CapabilityRequest): ResolvedPolicy {
  const r = req ?? {};
  // Modelle: nur die angeforderten, geschnitten mit den erlaubten.
  const allowedModels = r.models === undefined ? [] : intersect(parent.allowedModels, r.models);
  // Tools: dito.
  const toolPermissions = r.tools === undefined ? [] : intersect(parent.toolPermissions, r.tools);
  // DB-Scopes: dito (parent kann undefined sein = nichts erlaubt).
  const parentDb = parent.dbScopes ?? [];
  const dbScopes = r.db === undefined ? undefined : intersect(parentDb, r.db);
  // HTTP-Hosts: dito (Host-Mengen-Schnitt mit "*"-Semantik, analog db). Parent leer = kein Netz.
  const parentHttp = parent.httpHosts ?? [];
  const httpHosts = r.http === undefined ? undefined : intersect(parentHttp, r.http);
  // fs: gewünschte Pfade ∩ erlaubte Präfixe.
  const parentFs = parent.fsPaths ?? { read: [], write: [] };
  let fsPaths: ResolvedPolicy["fsPaths"];
  if (r.fs !== undefined) {
    fsPaths = {
      read: intersectPaths(parentFs.read, r.fs.read ?? []),
      write: intersectPaths(parentFs.write, r.fs.write ?? []),
    };
  }
  const resolved: ResolvedPolicy = {
    allowedModels,
    allowCloud: parent.allowCloud && !!r.cloud,
    dataClassification: parent.dataClassification, // req kann data-class nie senken
    suspendMode: parent.suspendMode, // Node-req lockert nie; Policy.scope kann RAISEn
    toolPermissions,
  };
  if (dbScopes !== undefined) resolved.dbScopes = dbScopes;
  if (httpHosts !== undefined) resolved.httpHosts = httpHosts;
  if (fsPaths !== undefined) resolved.fsPaths = fsPaths;
  // maxCostUsd: min(parent, req/policy) — RESOLVED, aber in v0.1 NICHT enforced (siehe ResolvedPolicy-
  // Doc). Die harte Budget-Durchsetzung läuft run-weit über den BudgetTracker (Inv. 21); ein
  // per-Node/per-Policy maxCostUsd-Cap ist späteren Slices vorbehalten. Hier nur korrekt durchgereicht,
  // damit ein künftiger node-lokaler Cost-View ihn lesen kann.
  if (parent.maxCostUsd !== undefined) resolved.maxCostUsd = parent.maxCostUsd;
  return resolved;
}

/**
 * Wendet eine Policy auf eine bereits resolvte Policy an (Interceptor-Stack, Inv. 13).
 * Vertrag: Policy.scope darf NUR verschärfen. Wir rufen scope() und erzwingen danach
 * defensiv die Halbordnung (das Ergebnis darf nie loosere Werte als der Input haben).
 */
export function applyPolicy(resolved: ResolvedPolicy, policy: Policy): ResolvedPolicy {
  // Policy.scope erwartet (req, parent). Auf dieser Ebene gibt es keinen neuen Node-req mehr;
  // wir reichen einen leeren Request durch und lassen die Policy gegen `resolved` verschärfen.
  const out = policy.scope({}, resolved);
  return enforceTightenOnly(resolved, out);
}

/**
 * Erzwingt defensiv, dass `candidate` nie loosere Werte als `from` hat (Inv. 13).
 * Schützt vor fehlerhaften Policies, die versehentlich lockern wollen.
 */
export function enforceTightenOnly(from: ResolvedPolicy, candidate: ResolvedPolicy): ResolvedPolicy {
  const fromModels = new Set(from.allowedModels);
  const fromTools = new Set(from.toolPermissions);
  const fromDb = new Set(from.dbScopes ?? []);
  const fromHttp = new Set(from.httpHosts ?? []);
  const result: ResolvedPolicy = {
    // Mengen können nur schrumpfen: behalte nur, was schon in `from` war.
    allowedModels: candidate.allowedModels.filter((m) => fromModels.has(m)),
    toolPermissions: candidate.toolPermissions.filter((t) => fromTools.has(t)),
    // allowCloud kann nur ab-, nie zugeschaltet werden.
    allowCloud: from.allowCloud && candidate.allowCloud,
    // data-class & suspend-mode: restriktiver gewinnt.
    dataClassification: maxDataClass(from.dataClassification, candidate.dataClassification),
    suspendMode: maxSuspendMode(from.suspendMode, candidate.suspendMode),
  };
  // db: nur Schnitt mit erlaubten.
  if (candidate.dbScopes !== undefined || from.dbScopes !== undefined) {
    result.dbScopes = (candidate.dbScopes ?? []).filter((d) => fromDb.has(d));
  }
  // http: nur Schnitt mit erlaubten Hosts.
  if (candidate.httpHosts !== undefined || from.httpHosts !== undefined) {
    result.httpHosts = (candidate.httpHosts ?? []).filter((h) => fromHttp.has(h));
  }
  // fs: gewünschte Pfade müssen unter den vorherigen Präfixen liegen.
  if (candidate.fsPaths !== undefined || from.fsPaths !== undefined) {
    const fromFs = from.fsPaths ?? { read: [], write: [] };
    const cand = candidate.fsPaths ?? { read: [], write: [] };
    result.fsPaths = {
      read: intersectPaths(fromFs.read, cand.read),
      write: intersectPaths(fromFs.write, cand.write),
    };
  }
  // maxCostUsd: min gewinnt.
  const costs = [from.maxCostUsd, candidate.maxCostUsd].filter(
    (c): c is number => typeof c === "number",
  );
  if (costs.length > 0) result.maxCostUsd = Math.min(...costs);
  return result;
}
