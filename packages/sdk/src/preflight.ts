// ───────────────────────────── Preflight: Provider-Profile validieren, BEVOR der Loop startet ─────────────────────────────
// Bei `elio run featureXY` beschreibt das Feature selbst, welche `provider:model`-Specs seine Steps nutzen.
// Der Preflight sammelt diese Referenzen und prüft VOR dem ersten Step: ist jedes referenzierte Profil
// (a) definiert (in der ProviderMap der Runtime) und (b) erreichbar/credentialed? Fehlt etwas, liefert er
// EINEN aggregierten, klaren Fehler — kein stilles Sterben mitten im Lauf (Inv.: fail fast, klare Fehler).
// Das ist der Dreh- und Angelpunkt der Reproduzierbarkeit: ein Feature, das einmal lief, ist portabel in
// jede Umgebung, die die nötigen Profile bereitstellt — und wenn nicht, sagt ELIO sofort warum.

import type { FeaturePack } from "@elio/core";
import type { ProviderMap } from "./models/worker";
import { OllamaModel } from "./models/ollama";
import { AzureOpenAiModel } from "./models/azure-openai";
import { ClaudeModel } from "./models/claude";

/** Eine in einem Step gepinnte Modell-Referenz. */
export interface ModelRef {
  step: string;
  provider: string;
  model?: string;
}

export interface PreflightReport {
  ok: boolean;
  /** Alle in den Steps referenzierten Profile/Modelle (Diagnose). */
  referenced: ModelRef[];
  /** Klartext-Fehler (Profil nicht definiert / nicht erreichbar). Leer => ok. */
  errors: string[];
}

export interface PreflightOptions {
  /** Die verfügbaren Provider-Profile (= runtime.* models). */
  providers: ProviderMap;
  /** Erreichbarkeit live prüfen (Ollama /api/tags, Azure-Config). Default true. */
  checkReachable?: boolean;
  /** Timeout der Erreichbarkeits-Probe in ms (Default 600). */
  probeTimeoutMs?: number;
}

/** Liest die `with`-Config eines Steps defensiv als Record. */
function stepWith(step: unknown): Record<string, unknown> | undefined {
  if (typeof step !== "object" || step === null) return undefined;
  const w = (step as { with?: unknown }).with;
  return typeof w === "object" && w !== null ? (w as Record<string, unknown>) : undefined;
}

/**
 * Sammelt alle in den Feature-Steps gepinnten Modell-Referenzen: Steps mit `with.provider` (das Profil).
 * Steps, die nur `with.model` ohne `provider` setzen, routen über den Worker-Default/Präfix und werden
 * hier NICHT als profil-pflichtig gewertet (rückwärtskompatibel). Planner-Node wird ebenfalls geprüft.
 */
export function collectModelRefs(pack: FeaturePack): ModelRef[] {
  const refs: ModelRef[] = [];
  const steps = pack.feature.graph?.steps ?? [];
  for (const step of steps) {
    const w = stepWith(step);
    if (w === undefined) continue;
    const provider = w["provider"];
    if (typeof provider !== "string" || provider.length === 0) continue;
    const ref: ModelRef = { step: (step as { id?: string }).id ?? "?", provider };
    if (typeof w["model"] === "string") ref.model = w["model"];
    refs.push(ref);
  }
  return refs;
}

/** Probt einen OllamaModel-Provider auf Erreichbarkeit (GET {baseUrl}/api/tags). */
async function ollamaReachable(model: OllamaModel, timeoutMs: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await model.fetchImpl(`${model.baseUrl}/api/tags`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Validiert die Provider-Profile, die das Feature in seinen Steps pinnt. Prüft je referenziertem Profil:
 * definiert (in `providers`) UND erreichbar (Ollama: /api/tags; Azure: konfiguriert). mock/claude gelten
 * als erreichbar, sobald sie definiert sind (claude trägt seinen Key by construction).
 */
export async function preflightFeature(
  pack: FeaturePack,
  opts: PreflightOptions,
): Promise<PreflightReport> {
  const refs = collectModelRefs(pack);
  const errors: string[] = [];
  const available = Object.keys(opts.providers);
  const checkReachable = opts.checkReachable !== false;
  const timeoutMs = opts.probeTimeoutMs ?? 600;

  // Pro distinct Profil prüfen (nicht pro Step), aber den Step im Fehler nennen.
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.provider)) continue;
    seen.add(ref.provider);

    const svc = opts.providers[ref.provider];
    if (svc === undefined) {
      errors.push(
        `step "${ref.step}" pins provider profile "${ref.provider}", but it is not configured ` +
          `(available: ${available.length > 0 ? available.join(", ") : "none"}). ` +
          `Configure it (env/flags) or change the step.`,
      );
      continue;
    }
    if (!checkReachable) continue;

    if (svc instanceof OllamaModel) {
      const ok = await ollamaReachable(svc, timeoutMs);
      if (!ok) {
        errors.push(
          `provider profile "${ref.provider}" is configured but not reachable at ${svc.baseUrl} ` +
            `(is Ollama running? \`ollama serve\`). Referenced by step "${ref.step}".`,
        );
      }
    } else if (svc instanceof AzureOpenAiModel) {
      if (!svc.isConfigured()) {
        errors.push(
          `provider profile "${ref.provider}" is missing config (endpoint/api-key/deployment). ` +
            `Referenced by step "${ref.step}".`,
        );
      }
    } else if (svc instanceof ClaudeModel) {
      if (!svc.isConfigured()) {
        errors.push(
          `provider profile "${ref.provider}" is missing an API key (apiKeySecret not resolved). ` +
            `Referenced by step "${ref.step}".`,
        );
      }
    }
    // mock: definiert => einsatzbereit.
  }

  return { ok: errors.length === 0, referenced: refs, errors };
}

/** Wirft einen aggregierten Fehler, wenn der Preflight nicht ok ist (für den CLI-/SDK-Run-Pfad). */
export function assertPreflight(report: PreflightReport): void {
  if (report.ok) return;
  throw new Error(
    `Preflight failed — the feature pins provider profiles that are not ready:\n  - ${report.errors.join(
      "\n  - ",
    )}`,
  );
}
