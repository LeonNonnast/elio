// ───────────────────────────── Provider-Profile-Resolver (Phase 1) ─────────────────────────────
// Baut die ProviderMap (Profil-Key -> ModelService) aus Umgebung + expliziten Optionen — der eine Ort,
// an dem entschieden wird, WELCHE Provider verfügbar sind und HOW man sie erreicht (Endpoints/Keys aus
// Env, nie aus dem feature.yaml). Das Feature pinnt nur die logische `provider:model`-Spec; dieser
// Resolver liefert die konkrete Verdrahtung. Geteilt von CLI/SDK/MCP (Inv. 2: ein Resolver, viele Clients).
//
// Default-Verhalten = Ollama-Auto-Detect: ohne explizite Wahl wird Ollama auf localhost:11434 geprobt
// (GET /api/tags); erreichbar -> Default-Modell `ollama:<modell>`, sonst `mock`. Abschaltbar
// (ELIO_DISABLE_AUTODETECT=1 oder ELIO_MODEL gesetzt), damit Tests/CI deterministisch bleiben.

import type { SecretsProvider } from "@elio/core";
import { MockModel } from "./mock";
import { OllamaModel } from "./ollama";
import { ClaudeModel } from "./claude";
import { AzureOpenAiModel } from "./azure-openai";
import type { ModelService } from "./types";
import type { ProviderMap } from "./worker";
import { EnvSecretsProvider } from "../services/secrets";
import { collectProfiles } from "./profile-config";
import type { ProviderProfile } from "./profile-config";

type FetchImpl = typeof fetch;
type Env = Record<string, string | undefined>;

/** Die Profil-Keys, die Phase 1 kennt (= Provider-Typen; spätere Versionen: benannte Custom-Profile). */
export const KNOWN_PROFILES = ["mock", "ollama", "claude", "azure-openai"] as const;
export type KnownProfile = (typeof KNOWN_PROFILES)[number];

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export interface ProviderProfilesOptions {
  /** Umgebungsvariablen-Quelle (Default process.env). Tests übergeben ein festes Objekt. */
  env?: Env;
  /** Injizierbares fetch (Ollama-Probe + Adapter). Default global fetch. */
  fetchImpl?: FetchImpl;
  /** Explizite kanonische Default-Spec (z.B. "ollama:llama3", "claude:claude-opus-4-8"). Gewinnt vor Env. */
  model?: string;
  /** Override der Ollama-Basis-URL (sonst OLLAMA_HOST bzw. Default). */
  ollamaUrl?: string;
  /** Auto-Detect (Ollama-Probe) deaktivieren. */
  disableAutoDetect?: boolean;
  /** Timeout der Ollama-Probe in ms (Default 600). */
  probeTimeoutMs?: number;
  /** Explizite benannte Profile (gewinnen vor Datei/Registry). */
  profiles?: ProviderProfile[];
  /** Pfad zur Profil-Datei (sonst $ELIO_PROFILES bzw. cwd-Discovery). */
  profilesFile?: string;
  /** Arbeitsverzeichnis fuer die Datei-Discovery (Default process.cwd()). */
  cwd?: string;
  /** Datei-Discovery ueberspringen (Tests/Isolation). */
  skipProfilesFile?: boolean;
  /** SecretsProvider, um apiKeySecret aufzuloesen (Default: EnvSecretsProvider ueber env). */
  secrets?: SecretsProvider;
}

export interface ResolvedProviderProfiles {
  /** Profil-Key -> ModelService (für createRuntime({ models })). */
  providers: ProviderMap;
  /** Kanonische Default-Spec, falls ein Step/Request kein Modell pinnt. */
  defaultModel: string;
  /** Policy-Freigabe je vorhandenem Profil ("mock", "ollama:*", "prod-azure:*", …) — Wildcards. */
  allowedModels: string[];
  /** Die tatsächlich verfügbaren Profil-Keys (für Diagnose/Preflight). */
  available: string[];
  /** Grobe Kosten-Richtwerte je Profil ($/MTok), gespeist aus profile.cost.usdPerMTok (fuer den Worker). */
  costs: Record<string, { in: number; out: number }>;
  /** Die effektiven benannten Profile (Metadaten fuer Preflight/Anzeige). */
  profiles: ProviderProfile[];
}

/** Baut den ModelService-Adapter fuer ein benanntes Profil (Secret via SecretsProvider aufgeloest). */
function buildAdapter(p: ProviderProfile, fetchImpl: FetchImpl, secrets: SecretsProvider): ModelService {
  const key = p.apiKeySecret !== undefined ? secrets.get(p.apiKeySecret) : undefined;
  switch (p.kind) {
    case "mock":
      return new MockModel(p.defaultModel !== undefined ? { model: p.defaultModel } : {});
    case "ollama":
      return new OllamaModel({
        baseUrl: p.baseUrl ?? DEFAULT_OLLAMA_URL,
        fetchImpl,
        ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
      });
    case "claude":
      return new ClaudeModel({
        fetchImpl,
        ...(key !== undefined ? { apiKey: key } : {}),
        ...(p.defaultModel !== undefined ? { defaultModel: p.defaultModel } : {}),
      });
    case "azure-openai":
      return new AzureOpenAiModel({
        fetchImpl,
        ...(p.endpoint !== undefined ? { endpoint: p.endpoint } : {}),
        ...(key !== undefined ? { apiKey: key } : {}),
        ...(p.deployment !== undefined ? { deployment: p.deployment } : {}),
        ...(p.apiVersion !== undefined ? { apiVersion: p.apiVersion } : {}),
      });
  }
}

/** Liest den Provider-Präfix einer kanonischen Spec ("ollama:llama3" -> "ollama"; "mock" -> "mock"). */
export function providerOf(spec: string): string {
  const ci = spec.indexOf(":");
  return ci > 0 ? spec.slice(0, ci) : spec;
}

/** Probt Ollama (GET {url}/api/tags). Liefert die Modell-Namen oder null (nicht erreichbar). */
async function probeOllama(
  url: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<string[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${url}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: unknown };
    if (!Array.isArray(json.models)) return [];
    return json.models
      .map((m) => (m as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return null;
  }
}

/** Wählt ein Default-Ollama-Modell aus den getaggten Modellen (bevorzugt llama3, sonst das erste). */
function pickOllamaModel(tags: string[]): string {
  const llama = tags.find((t) => t.startsWith("llama3"));
  return llama ?? tags[0] ?? "llama3";
}

/**
 * Löst die verfügbaren Provider-Profile + die Default-Spec auf. Reihenfolge der Default-Wahl:
 *  1. opts.model (explizit)  2. env.ELIO_MODEL  3. Ollama (Auto-Detect/OLLAMA_HOST)  4. "mock".
 * mock ist IMMER verfügbar; claude/azure nur bei vorhandenen Credentials; ollama bei OLLAMA_HOST ODER
 * erfolgreicher Probe (sofern Auto-Detect nicht abgeschaltet ist).
 */
export async function resolveProviderProfiles(
  opts: ProviderProfilesOptions = {},
): Promise<ResolvedProviderProfiles> {
  const env: Env = opts.env ?? process.env;
  const fetchImpl: FetchImpl = opts.fetchImpl ?? fetch;
  const secrets: SecretsProvider = opts.secrets ?? new EnvSecretsProvider({ env });
  const providers: ProviderMap = { mock: new MockModel() };
  const costs: Record<string, { in: number; out: number }> = {};

  // 1) Benannte Profile (Datei + Registry + explizit) — gewinnen vor den Built-in-Defaults.
  const named = collectProfiles({
    ...(opts.profiles !== undefined ? { profiles: opts.profiles } : {}),
    ...(opts.profilesFile !== undefined ? { profilesFile: opts.profilesFile } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env,
    ...(opts.skipProfilesFile === true ? { skipFile: true } : {}),
  });
  for (const p of named) {
    providers[p.name] = buildAdapter(p, fetchImpl, secrets);
    if (p.cost?.usdPerMTok !== undefined) costs[p.name] = p.cost.usdPerMTok;
  }

  // 2) Built-in-Defaults aus Env — nur, wo kein gleichnamiges Profil existiert (Fallback, Backwards-Compat).
  // Claude: nur mit API-Key.
  const claudeKey = env["ANTHROPIC_API_KEY"];
  if (providers["claude"] === undefined && typeof claudeKey === "string" && claudeKey.length > 0) {
    providers["claude"] = new ClaudeModel({ apiKey: claudeKey, fetchImpl });
  }

  // Azure OpenAI: nur mit Endpoint + Key (+ Deployment).
  const azureEndpoint = env["AZURE_OPENAI_ENDPOINT"];
  const azureKey = env["AZURE_OPENAI_API_KEY"];
  if (
    providers["azure-openai"] === undefined &&
    typeof azureEndpoint === "string" &&
    azureEndpoint.length > 0 &&
    typeof azureKey === "string" &&
    azureKey.length > 0
  ) {
    const azure = new AzureOpenAiModel({
      endpoint: azureEndpoint,
      apiKey: azureKey,
      fetchImpl,
      ...(env["AZURE_OPENAI_DEPLOYMENT"] !== undefined
        ? { deployment: env["AZURE_OPENAI_DEPLOYMENT"] }
        : {}),
      ...(env["AZURE_OPENAI_API_VERSION"] !== undefined
        ? { apiVersion: env["AZURE_OPENAI_API_VERSION"] }
        : {}),
    });
    providers["azure-openai"] = azure;
  }

  // Ollama: explizite URL/OLLAMA_HOST registriert ohne Probe; sonst Auto-Detect (sofern erlaubt).
  const explicitUrl = opts.ollamaUrl ?? env["OLLAMA_HOST"];
  const autoDetectOff =
    opts.disableAutoDetect === true ||
    env["ELIO_DISABLE_AUTODETECT"] === "1" ||
    (typeof env["ELIO_MODEL"] === "string" && env["ELIO_MODEL"].length > 0);
  let ollamaModels: string[] | null = null;
  let ollamaUrl: string | undefined;
  // Ein benanntes "ollama"-Profil gewinnt -> kein Built-in-Probe/Override.
  if (providers["ollama"] === undefined) {
    if (typeof explicitUrl === "string" && explicitUrl.length > 0) {
      ollamaUrl = explicitUrl;
      ollamaModels = []; // explizit konfiguriert -> ohne Probe als verfügbar behandeln
    } else if (!autoDetectOff) {
      const probed = await probeOllama(DEFAULT_OLLAMA_URL, fetchImpl, opts.probeTimeoutMs ?? 600);
      if (probed !== null) {
        ollamaUrl = DEFAULT_OLLAMA_URL;
        ollamaModels = probed;
      }
    }
    if (ollamaUrl !== undefined) {
      providers["ollama"] = new OllamaModel({ baseUrl: ollamaUrl, fetchImpl });
    }
  }

  // Default-Spec wählen.
  let defaultModel: string;
  const envModel = env["ELIO_MODEL"];
  if (typeof opts.model === "string" && opts.model.length > 0) {
    defaultModel = opts.model;
  } else if (typeof envModel === "string" && envModel.length > 0) {
    defaultModel = envModel;
  } else if (providers["ollama"] !== undefined) {
    defaultModel = `ollama:${pickOllamaModel(ollamaModels ?? [])}`;
  } else {
    defaultModel = "mock";
  }

  // Falls die gewählte Default-Spec einen (noch) nicht registrierten Provider referenziert, ihn — soweit
  // bekannt — nachziehen (z.B. ELIO_MODEL=ollama:llama3 ohne erreichbare Probe: Provider trotzdem anlegen,
  // der Preflight meldet dann ggf. "nicht erreichbar" sauber).
  const defProvider = providerOf(defaultModel);
  if (providers[defProvider] === undefined && defProvider === "ollama") {
    providers["ollama"] = new OllamaModel({ baseUrl: explicitUrl ?? DEFAULT_OLLAMA_URL, fetchImpl });
  }

  const available = Object.keys(providers);
  const allowedModels = available.map((k) => (k === "mock" ? "mock" : `${k}:*`));

  return { providers, defaultModel, allowedModels, available, costs, profiles: named };
}
