// ───────────────────────────── @elio/skill-builder — Setup-Fassade (Runtime + Feature-Pack + Brief/outDir) ─────────────────────────────
// Verdrahtet die Meta-Vertikale: lädt den feature.yaml-Pack (über den SDK-Loader), baut eine Runtime mit
// dem nötigen Governance-Scope (allowedModels für den Draft-Schritt, fsPaths.write CONFINED auf outDir),
// registriert die Skill-Builder-Nodes + Policy + bindet den injizierten Brief + das outDir (analog §7).
//
// Der Brief + das outDir sind injizierte WERTE, keine Steps: write_skill schreibt über die policy-gescopte
// ctx.fs (ScopedFsService, auf outDir confined — ein outDir-verlassender Pfad wird abgelehnt, Inv. 14).

import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createRuntime, loadFeaturePackFromFile, MockModel, ScopedFsService } from "@elio/sdk";
import type { ArtifactType, FeaturePack, FsService, ModelService, ResolvedPolicy } from "@elio/core";
import type { InMemoryRunStore, ProviderMap, Runtime } from "@elio/sdk";
import { registerSkillBuilder } from "./nodes";
import { registerSkillBuilderPolicies } from "./policies";
import { SKILL_ARTIFACT_KIND, SKILL_BUILDER_MODEL } from "./skill";
import type { SkillBrief } from "./skill";

/** Artefakt-Typ der Meta-Vertikale: das Skill (SKILL.md) IST das Artefakt (Inv. 1). */
export const SKILL_TYPE: ArtifactType = {
  kind: SKILL_ARTIFACT_KIND,
  // sidecar: die SKILL.md + (Entscheidungs-)Stand; progress.md: laufendes Stand-/Entscheidungs-Scratchpad.
  holders: ["sidecar", "progress.md"],
};

/** Absoluter Pfad zur kanonischen feature.yaml (relativ zum Paket aufgelöst). */
export function skillBuilderFeaturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/setup.ts -> ../features/build-skill/feature.yaml
  return join(here, "..", "features", "build-skill", "feature.yaml");
}

/** Lädt + compiliert den kanonischen build-skill-Pack aus der feature.yaml (§3, §11/#14). */
export function loadSkillBuilderFeature(): FeaturePack {
  return loadFeaturePackFromFile(skillBuilderFeaturePath());
}

export interface SetupSkillBuilderOptions {
  /**
   * Der Skill-Brief. Pflichtfelder (name/description/purpose) dürfen fehlen — dann interviewt
   * collect_brief sie nach (Elicitation). Vollständig -> der Lauf geht ohne Interview durch.
   */
  brief?: SkillBrief;
  /**
   * Ausgabe-Verzeichnis. write_skill schreibt <outDir>/<skillName>/SKILL.md hierhin. Der fs-Write-Scope
   * (Root-Policy) ist auf GENAU dieses Verzeichnis confined — security by absence (Inv. 14). Default:
   * brief.outDir, falls gesetzt; sonst muss es hier übergeben werden.
   */
  outDir?: string;
  /** Root-Policy-Override. Default: für den Draft-Modell (mock) + den outDir-Write-Scope freigegeben. */
  rootPolicy?: ResolvedPolicy;
  /** fs-Backend-Override (z.B. ein in-memory/Test-Double). Default: reales node:fs, auf outDir confined. */
  fs?: FsService;
  /**
   * Modell hinter dem Draft-Schritt (ctx.model). Default: ein deterministisches MockModel (offline).
   * Ein Override (z.B. ein capturing MockModel) erlaubt Tests, den AN DAS MODELL gereichten Prompt zu
   * prüfen ODER eine reiche Body-Anreicherung zu liefern.
   */
  model?: ModelService;
  /**
   * ECHTE Provider-Config (Profil-Key -> Adapter), z.B. aus resolveProviderProfiles (CLI --model/--ollama-url).
   * Ist sie gesetzt, baut die Runtime ihren LlmWorker aus DIESER Map (statt des MockModel-Defaults) und der
   * Draft-Schritt reichert über den echten Provider an. Der Worker reicht dem Adapter NUR den reinen
   * Modellnamen — die kanonische `provider:model`-Spec wird über `defaultModel` geroutet. Fehlt sie, bleibt
   * exakt das heutige offline-Verhalten (MockModel unter "mock", allowedModels [SKILL_BUILDER_MODEL]).
   */
  models?: ProviderMap;
  /**
   * Default-Modell-Spec des aus `models` gebauten Workers (kanonisch, z.B. "ollama:llama3"). Nur relevant,
   * wenn `models` gesetzt ist. Default: SKILL_BUILDER_MODEL ("mock") — passend zum offline-Pfad.
   */
  defaultModel?: string;
  /**
   * Policy-Freigabe der Modelle (allowedModels). Wildcards erlaubt ("*", "<provider>:*"). Nur relevant,
   * wenn `models` gesetzt ist. Default: aus den Profil-Keys abgeleitet ("<key>:*" je Key). Ohne `models`
   * bleibt es bei [SKILL_BUILDER_MODEL].
   */
  allowedModels?: string[];
  /** Grobe Kosten-Richtwerte je Profil-Key ($/MTok) — an den Worker durchgereicht (cost.usd-Stamping). */
  providerCosts?: Record<string, { in: number; out: number }>;
  /** Persistenter Run-Store (z.B. FileRunStore) — Default: prozess-lokaler In-Memory-Store. */
  store?: InMemoryRunStore;
}

/** Leitet aus den Profil-Keys einer ProviderMap die "<key>:*"-Wildcards ab (Policy-Freigabe). */
function allowedModelsFromProviders(models: ProviderMap): string[] {
  return Object.keys(models).map((key) => `${key}:*`);
}

export interface SkillBuilderSetup {
  runtime: Runtime;
  pack: FeaturePack;
  /** Das aufgelöste (absolute) Ausgabe-Verzeichnis. */
  outDir: string;
}

/**
 * Default-Root-Policy: gibt das mock-Modell (Draft-Schritt) + den fs-Write-Scope (outDir) frei (Inv. 13/14).
 * KEIN fs-Read-Scope (die Vertikale liest nichts), KEIN db-Scope. suspendMode "optional" — die Policy
 * `skill_write_requires_approval` verschärft das auf "blocking" (tighten-only).
 */
export function skillBuilderRootPolicy(
  outDir: string,
  allowedModels: string[] = [SKILL_BUILDER_MODEL],
): ResolvedPolicy {
  return {
    allowedModels,
    allowCloud: false,
    dataClassification: "internal",
    suspendMode: "optional",
    toolPermissions: [],
    fsPaths: { read: [], write: [resolvePath(outDir)] },
  };
}

/**
 * Baut eine vollständig verdrahtete Skill-Builder-Runtime: Pack geladen, Nodes + Policy registriert,
 * Brief + outDir injiziert, Governance-Scope gesetzt (fs-Write CONFINED auf outDir). Brief/outDir sind
 * injizierte Werte (analog §7) — über Closures gebunden, nicht als Steps deklariert.
 */
export function setupSkillBuilder(opts: SetupSkillBuilderOptions = {}): SkillBuilderSetup {
  const brief: SkillBrief = { ...(opts.brief ?? {}) };
  const rawOutDir = opts.outDir ?? brief.outDir;
  if (rawOutDir === undefined || rawOutDir.trim().length === 0) {
    throw new Error(
      "setupSkillBuilder: `outDir` fehlt — die Vertikale schreibt <outDir>/<skillName>/SKILL.md und " +
        "braucht ein Ausgabe-Verzeichnis (in opts.outDir ODER brief.outDir).",
    );
  }
  const outDir = resolvePath(rawOutDir);
  const pack = loadSkillBuilderFeature();

  // fs-Backend, confined auf outDir (defense in depth über die policy-gescopte DI hinaus).
  const fs: FsService = opts.fs ?? new ScopedFsService({ roots: [outDir] });

  // Modell-Verdrahtung (zwei Modi):
  //  - ECHTE Provider (opts.models gesetzt): die Runtime baut ihren LlmWorker aus DIESER Map; der Default
  //    ist die echte kanonische Spec; die Policy gibt die Provider per Wildcard frei. Der Draft-Schritt
  //    reichert über den echten Provider an (der Worker reicht dem Adapter nur den reinen Modellnamen).
  //  - OFFLINE (kein opts.models): exakt das heutige Verhalten — MockModel unter der mock-id, defaultModel
  //    "mock", allowedModels [SKILL_BUILDER_MODEL]. Ein opts.model-Override (Test) ersetzt nur das MockModel
  //    unter der mock-id, sodass die allowedModels-Policy weiter greift.
  const usingRealProviders = opts.models !== undefined;
  const models: ProviderMap = opts.models ?? { mock: opts.model ?? new MockModel() };
  const defaultModel = usingRealProviders ? (opts.defaultModel ?? SKILL_BUILDER_MODEL) : SKILL_BUILDER_MODEL;
  const allowedModels = usingRealProviders
    ? (opts.allowedModels ?? allowedModelsFromProviders(models))
    : [SKILL_BUILDER_MODEL];

  const runtime = createRuntime({
    // ctx.model hinter dem Draft-Schritt: der gebaute LlmWorker (echte Provider-Map ODER MockModel-Default).
    models,
    defaultModel,
    ...(opts.providerCosts !== undefined ? { providerCosts: opts.providerCosts } : {}),
    ...(opts.store !== undefined ? { store: opts.store } : {}),
    // ctx.fs-Backend für write_skill (auf outDir confined; der Injector wrappt erneut, defense in depth).
    fs,
    artifactTypes: { [SKILL_ARTIFACT_KIND]: SKILL_TYPE },
    rootPolicy: opts.rootPolicy ?? skillBuilderRootPolicy(outDir, allowedModels),
  });

  registerSkillBuilder(runtime, { brief, outDir });
  registerSkillBuilderPolicies(runtime);

  return { runtime, pack, outDir };
}
