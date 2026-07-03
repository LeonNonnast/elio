// ───────────────────────────── Named Provider Profiles: Schema + Loader + Registry (Phase 3) ─────────────────────────────
// Ein PROFIL ist eine benannte, umgebungs-spezifische Provider-Config: das Feature pinnt logisch
// `provider:model` (z.B. prod-azure:gpt-4o) — der Profilname ist portabel, die Umgebung liefert Endpoint/
// Credentials. So laeuft ein Feature, das einmal funktioniert hat, in jeder Umgebung identisch, die die
// gleichen Profilnamen definiert. Secrets stehen NIE im Klartext im File: `apiKeySecret` referenziert einen
// Namen, der ueber die SecretsProvider-Schicht aufgeloest wird (governance-konsistent, Inv. 14).
//
// Quellen (gemerged, Praezedenz spaeter -> frueher): explizite opts.profiles > programmatische Registry
// (registerProfile) > Config-Datei (elio.profiles.yaml). Built-in-Defaults (mock/ollama/claude/azure aus
// Env) bleiben Fallback im Resolver, damit nichts bricht.

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";

/** Provider-Typ hinter einem Profil. */
export type ProfileKind = "mock" | "ollama" | "claude" | "azure-openai";

export const PROFILE_KINDS: ProfileKind[] = ["mock", "ollama", "claude", "azure-openai"];

/** Grober Kosten-Tier (Schnell-Anzeige/Warnung) — KEINE praezise Pricing-Tabelle. */
export type CostTier = "free" | "low" | "med" | "high";

export const COST_TIERS: CostTier[] = ["free", "low", "med", "high"];

/** Grobe Kosten-Richtwerte pro Profil: Tier (Pflicht-Schaetzung) + optionale grobe $/MTok-Zahl. */
export interface ProfileCost {
  tier: CostTier;
  /** Grobe USD pro 1M Tokens [in, out] — fuer Monitoring/Controlling; bewusst nur Richtwert. */
  usdPerMTok?: { in: number; out: number };
}

/** Eine benannte, umgebungs-spezifische Provider-Config. Secrets via Referenz (apiKeySecret), nie Klartext. */
export interface ProviderProfile {
  /** Profilname = Routing-Key + canonical-Praefix (z.B. "prod-azure" in "prod-azure:gpt-4o"). */
  name: string;
  kind: ProfileKind;
  /** Adapter-Default-Modell, falls ein Call kein Modell pinnt. */
  defaultModel?: string;
  /** ollama: Basis-URL. */
  baseUrl?: string;
  /** azure-openai: Resource-Endpoint. */
  endpoint?: string;
  /** azure-openai: Deployment-Name. */
  deployment?: string;
  /** azure-openai: API-Version. */
  apiVersion?: string;
  /** claude/azure: Name des Secrets (ueber SecretsProvider aufgeloest) — KEIN Klartext-Key. */
  apiKeySecret?: string;
  /** Grobe Kosten-Richtwerte. */
  cost?: ProfileCost;
}

// ───────────────────────────── Programmatische Registry (SDK) ─────────────────────────────

const registry = new Map<string, ProviderProfile>();

/** Registriert (bzw. ueberschreibt) ein Profil programmatisch (SDK-Pfad). */
export function registerProfile(profile: ProviderProfile): void {
  registry.set(profile.name, validateProfile(profile, "registerProfile"));
}

/** Registriert mehrere Profile auf einmal. */
export function registerProfiles(profiles: ProviderProfile[]): void {
  for (const p of profiles) registerProfile(p);
}

/** Leert die programmatische Registry (Tests/Reset). */
export function clearRegisteredProfiles(): void {
  registry.clear();
}

/** Schnappschuss der programmatisch registrierten Profile. */
export function listRegisteredProfiles(): ProviderProfile[] {
  return [...registry.values()];
}

// ───────────────────────────── Validierung + Datei-Loader ─────────────────────────────

/** Wirft bei einem ungueltigen Profil (unbekannter kind, fehlender Name) — frueh & klar. */
export function validateProfile(p: ProviderProfile, source: string): ProviderProfile {
  if (typeof p.name !== "string" || p.name.length === 0) {
    throw new Error(`${source}: profile is missing a non-empty "name".`);
  }
  if (!PROFILE_KINDS.includes(p.kind)) {
    throw new Error(
      `${source}: profile "${p.name}" has unknown kind "${String(p.kind)}" (expected one of ${PROFILE_KINDS.join(", ")}).`,
    );
  }
  if (p.name.includes(":")) {
    throw new Error(`${source}: profile name "${p.name}" must not contain ':' (it is the canonical separator).`);
  }
  return p;
}

/** Default-Dateinamen, in denen nach Profilen gesucht wird (cwd-relativ). */
export const PROFILE_FILE_NAMES = ["elio.profiles.yaml", "elio.profiles.yml", "elio.profiles.json"];

/**
 * Findet die Profil-Datei: explizit ($ELIO_PROFILES bzw. opts.file) gewinnt; sonst der erste Treffer der
 * Default-Namen im cwd (bzw. opts.cwd). Liefert den Pfad oder undefined (keine Datei -> nur Defaults/Registry).
 */
export function findProfilesFile(opts: { file?: string; cwd?: string; env?: Record<string, string | undefined> } = {}): string | undefined {
  const env = opts.env ?? process.env;
  const explicit = opts.file ?? env["ELIO_PROFILES"];
  if (typeof explicit === "string" && explicit.length > 0) {
    return existsSync(explicit) ? resolvePath(explicit) : undefined;
  }
  const cwd = opts.cwd ?? process.cwd();
  for (const name of PROFILE_FILE_NAMES) {
    const candidate = resolvePath(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Laedt + parst eine Profil-Datei (YAML oder JSON). Form: { profiles: { <name>: { kind, ... }, ... } }
 * ODER { profiles: [ { name, kind, ... } ] }. Liefert ein validiertes ProviderProfile[].
 */
export function loadProfilesFromFile(path: string): ProviderProfile[] {
  const raw = readFileSync(path, "utf8");
  const doc = parseYaml(raw) as unknown;
  const profilesNode = isRecord(doc) ? doc["profiles"] : undefined;
  const out: ProviderProfile[] = [];
  if (Array.isArray(profilesNode)) {
    for (const entry of profilesNode) {
      if (isRecord(entry)) out.push(validateProfile(entry as unknown as ProviderProfile, `profiles file ${path}`));
    }
  } else if (isRecord(profilesNode)) {
    for (const [name, cfg] of Object.entries(profilesNode)) {
      if (isRecord(cfg)) {
        out.push(validateProfile({ ...(cfg as object), name } as ProviderProfile, `profiles file ${path}`));
      }
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Sammelt die effektiven benannten Profile aus allen Quellen (Datei + Registry + explizit), keyed by Name.
 * Praezedenz (spaeter ueberschreibt): Datei -> Registry -> opts.profiles. Reine Datensammlung; der Resolver
 * baut daraus die Adapter (mit Secret-Aufloesung).
 */
export function collectProfiles(
  opts: {
    profiles?: ProviderProfile[];
    profilesFile?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
    /** Datei-Discovery ueberspringen (Tests/Isolation). */
    skipFile?: boolean;
  } = {},
): ProviderProfile[] {
  const byName = new Map<string, ProviderProfile>();
  if (opts.skipFile !== true) {
    const file = findProfilesFile({
      ...(opts.profilesFile !== undefined ? { file: opts.profilesFile } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    if (file !== undefined) {
      for (const p of loadProfilesFromFile(file)) byName.set(p.name, p);
    }
  }
  for (const p of registry.values()) byName.set(p.name, p);
  if (opts.profiles !== undefined) {
    for (const p of opts.profiles) byName.set(p.name, validateProfile(p, "opts.profiles"));
  }
  return [...byName.values()];
}
