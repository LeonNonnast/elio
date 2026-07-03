// ───────────────────────────── @elio/migrate — Setup-Fassade (Runtime + Feature-Pack + Adapter) ─────────────────────────────
// Verdrahtet die Migrations-Vertikale: lädt den feature.yaml-Pack (über den SDK-Loader), baut eine
// Runtime mit dem nötigen Governance-Scope (allowedModels für den Mapping-Agent, dbScopes fürs Ziel),
// registriert die Migrate-Nodes + Policy + bindet die injizierten Quell-/Ziel-Adapter (§7).
//
// Die Quelle/das Ziel sind injizierte ADAPTER-SERVICES, keine Steps (§7):
//  - source: SourceCsvAdapter (liest CSV-Zeilen; Fixture-String oder Datei über ctx.fs).
//  - target: TargetDbAdapter (schreibt über ctx.db; durable Effect-Ledger über Run-Grenzen).

import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createRuntime, loadFeaturePackFromFile, MockModel, ScopedFsService } from "@elio/sdk";
import type { ArtifactType, FeaturePack, FsService, ModelService, ResolvedPolicy } from "@elio/core";
import type { InMemoryRunStore, ProviderMap, Runtime } from "@elio/sdk";
import { SourceCsvAdapter } from "./adapters/source-csv";
import type { SourceCsvOptions } from "./adapters/source-csv";
import { TargetDbAdapter } from "./adapters/target-db";
import type { TargetDbOptions } from "./adapters/target-db";
import { registerMigrate } from "./nodes";
import { registerMigratePolicies } from "./policies";

/** Artefakt-Typ der Migrations-Vertikale: das Skript IST das Artefakt (Inv. 1). */
export const MIGRATION_SCRIPT_TYPE: ArtifactType = {
  kind: "migration-script",
  // db-state: per-record Effect-Ledger / disjoint-key Sample-Ergebnisse (§11/#6/#11).
  // progress.md: laufendes Stand-/Entscheidungs-Scratchpad (Inv. 22).
  holders: ["db-state", "progress.md"],
};

/** Default-Modell-id des Mapping-Agents (MockModel -> deterministisch offline). */
export const MIGRATE_MODEL = "mock";

/** Absoluter Pfad zur kanonischen feature.yaml (relativ zum Paket aufgelöst). */
export function migrateFeaturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/setup.ts -> ../features/migrate.csv-to-db/feature.yaml
  return join(here, "..", "features", "migrate.csv-to-db", "feature.yaml");
}

/** Lädt + compiliert den kanonischen migrate.csv-to-db-Pack aus der feature.yaml (§3, §11/#14). */
export function loadMigrateFeature(): FeaturePack {
  return loadFeaturePackFromFile(migrateFeaturePath());
}

export interface SetupMigrateOptions {
  /** Quelle: CSV-Inhalt (Fixture) ODER Pfad. Mind. eines nötig (oder ein fertiger `source`). */
  source?: SourceCsvOptions | SourceCsvAdapter;
  /** Ziel-DB-Optionen ODER ein fertiger `target`-Adapter. */
  target?: TargetDbOptions | TargetDbAdapter;
  /**
   * Menge von record.ids, deren Commit (simuliert) fehlschlägt — für den Re-Run-Idempotenz-Test.
   * Wird zwischen Runs mutierbar geteilt (an die commit-Node durchgereicht).
   */
  failCommitIds?: Set<string>;
  /** Root-Policy-Override. Default: für Mapping-Agent (mock) + Ziel-DB-Scope freigegeben. */
  rootPolicy?: ResolvedPolicy;
  /**
   * fs-Read-Scope für die path-basierte Quelle (read_source). Default: das Verzeichnis der Quell-Datei
   * (falls source.path gesetzt) — so liest read_source real über die policy-gescopte ctx.fs (§7, Inv. 14).
   * Eine content-basierte Quelle braucht keinen fs-Scope (ctx.fs wird dann gar nicht angefragt/genutzt).
   */
  fsRoot?: string;
  /** fs-Backend-Override (z.B. ein in-memory/Test-Double). Default: reales node:fs, auf fsRoot confined. */
  fs?: FsService;
  /**
   * Modell hinter dem Mapping-Agent (ctx.model). Default: ein deterministisches MockModel (offline).
   * Ein Override (z.B. ein capturing MockModel) erlaubt Tests, den AN DAS MODELL gereichten System-/
   * User-Prompt zu prüfen — der Beweis, dass der inlined Prompt-INHALT (nicht der Pfad) ankommt (§7).
   */
  model?: ModelService;
  /**
   * ECHTE Provider-Config (Profil-Key -> Adapter), z.B. aus resolveProviderProfiles (CLI --model/--ollama-url).
   * Ist sie gesetzt, baut die Runtime ihren LlmWorker aus DIESER Map (statt des MockModel-Defaults) und
   * der Mapping-Agent läuft auf dem echten Provider. Der Worker reicht dem Adapter NUR den reinen
   * Modellnamen — die kanonische `provider:model`-Spec wird über den `defaultModel` geroutet. Fehlt sie,
   * bleibt exakt das heutige offline-Verhalten (MockModel unter "mock", allowedModels ["mock"]).
   */
  models?: ProviderMap;
  /**
   * Default-Modell-Spec des aus `models` gebauten Workers (kanonisch, z.B. "ollama:llama3"). Nur relevant,
   * wenn `models` gesetzt ist. Default: MIGRATE_MODEL ("mock") — passend zum offline-Pfad.
   */
  defaultModel?: string;
  /**
   * Policy-Freigabe der Modelle (allowedModels). Wildcards erlaubt ("*", "<provider>:*"). Nur relevant,
   * wenn `models` gesetzt ist. Default: aus den Profil-Keys abgeleitet ("<key>:*" je Key). Ohne `models`
   * bleibt es bei [MIGRATE_MODEL].
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

export interface MigrateSetup {
  runtime: Runtime;
  pack: FeaturePack;
  source: SourceCsvAdapter;
  target: TargetDbAdapter;
  /** Geteilte (mutierbare) Menge fehlschlagender Commit-ids (s.o.). */
  failCommitIds: Set<string>;
}

function asSource(s: SetupMigrateOptions["source"]): SourceCsvAdapter {
  if (s instanceof SourceCsvAdapter) return s;
  return new SourceCsvAdapter(s ?? {});
}

function asTarget(t: SetupMigrateOptions["target"]): TargetDbAdapter {
  if (t instanceof TargetDbAdapter) return t;
  return new TargetDbAdapter(t ?? {});
}

/**
 * Default-Root-Policy: gibt das mock-Modell (Mapping-Agent) + den Ziel-DB-Scope frei (Inv. 13/14).
 * `fsReadRoots` (optional) gibt zusätzlich Datei-Lese-Pfade für die path-basierte Quelle frei (read_source);
 * ohne sie bleibt fs gänzlich ungescopt (content-basierte Quelle braucht keinen fs-Zugriff).
 */
export function migrateRootPolicy(
  targetTable: string,
  fsReadRoots: string[] = [],
  allowedModels: string[] = [MIGRATE_MODEL],
): ResolvedPolicy {
  const policy: ResolvedPolicy = {
    allowedModels,
    allowCloud: false,
    dataClassification: "internal",
    suspendMode: "optional", // commit_requires_approval verschärft auf blocking (tighten-only)
    toolPermissions: [],
    dbScopes: [targetTable],
  };
  if (fsReadRoots.length > 0) {
    policy.fsPaths = { read: [...fsReadRoots], write: [] };
  }
  return policy;
}

/**
 * Baut eine vollständig verdrahtete Migrations-Runtime: Pack geladen, Nodes + Policy registriert,
 * Quell-/Ziel-Adapter injiziert, Governance-Scope gesetzt. Quelle/Ziel sind injizierte Services (§7).
 */
export function setupMigrate(opts: SetupMigrateOptions = {}): MigrateSetup {
  const source = asSource(opts.source);
  const target = asTarget(opts.target);
  const failCommitIds = opts.failCommitIds ?? new Set<string>();
  const pack = loadMigrateFeature();

  // fs-Scope für die path-basierte Quelle (§7): Default = das Verzeichnis der Quell-Datei. So liest
  // read_source real über die policy-gescopte ctx.fs (Inv. 14). Ein expliziter fsRoot überschreibt das;
  // eine content-basierte Quelle (kein source.path) bekommt KEINEN fs-Scope (security by absence).
  const fsRoot =
    opts.fsRoot ?? (source.sourcePath !== undefined ? dirname(resolvePath(source.sourcePath)) : undefined);
  const fsReadRoots = fsRoot !== undefined ? [fsRoot] : [];
  // fs-Backend nur verdrahten, wenn ein Scope existiert (sonst kein ctx.fs — security by absence).
  const fs: FsService | undefined =
    fsReadRoots.length > 0 ? (opts.fs ?? new ScopedFsService({ roots: fsReadRoots })) : undefined;

  // Modell-Verdrahtung (zwei Modi):
  //  - ECHTE Provider (opts.models gesetzt): die Runtime baut ihren LlmWorker aus DIESER Map; der Default
  //    ist die echte kanonische Spec; die Policy gibt die Provider per Wildcard frei. Der Mapping-Agent
  //    läuft damit auf dem echten Provider (der Worker reicht dem Adapter nur den reinen Modellnamen).
  //  - OFFLINE (kein opts.models): exakt das heutige Verhalten — MockModel unter der mock-id, defaultModel
  //    "mock", allowedModels [MIGRATE_MODEL]. Ein opts.model-Override (Test) ersetzt nur das MockModel
  //    unter der mock-id, sodass die allowedModels-Policy weiter greift.
  const usingRealProviders = opts.models !== undefined;
  const models: ProviderMap = opts.models ?? { mock: opts.model ?? new MockModel() };
  const defaultModel = usingRealProviders ? (opts.defaultModel ?? MIGRATE_MODEL) : MIGRATE_MODEL;
  const allowedModels = usingRealProviders
    ? (opts.allowedModels ?? allowedModelsFromProviders(models))
    : [MIGRATE_MODEL];

  const runtime = createRuntime({
    // ctx.model hinter dem Mapping-Agent: der gebaute LlmWorker (echte Provider-Map ODER MockModel-Default).
    models,
    defaultModel,
    ...(opts.providerCosts !== undefined ? { providerCosts: opts.providerCosts } : {}),
    ...(opts.store !== undefined ? { store: opts.store } : {}),
    // ctx.db-Backend = das durable Ziel (injizierter Target-Adapter, side-effect-gescopt, §7).
    db: target.backend,
    // ctx.fs-Backend für die path-basierte Quelle (auf fsReadRoots confined; Injector wrappt erneut).
    ...(fs !== undefined ? { fs } : {}),
    artifactTypes: { "migration-script": MIGRATION_SCRIPT_TYPE },
    rootPolicy: opts.rootPolicy ?? migrateRootPolicy(target.table, fsReadRoots, allowedModels),
  });

  registerMigrate(runtime, { source, target, failCommitIds });
  registerMigratePolicies(runtime);

  return { runtime, pack, source, target, failCommitIds };
}
