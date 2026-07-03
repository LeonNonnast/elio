// @elio/engine — die Engine-Schicht: zentraler Feature-Katalog + (ab Phase 2) EngineService.
// CLI/MCP/Studio sind nur Clients dieser Schicht (Inv. 2). Ersetzt die dreifach duplizierte
// "Feature → verdrahtete Runtime → Run/Resume"-Verantwortung durch EINE Stelle.

export type {
  FeatureProvider,
  FeatureCapabilities,
  FeatureSetupContext,
  FeatureSetupResult,
} from "./provider";
export { modelOptsFrom, storeOptFrom } from "./provider";

export { FeatureCatalog, defaultCatalog, yamlProvider } from "./catalog";

export { createEngineHost } from "./host";
export type { EngineHost, CreateEngineHostOptions } from "./host";

export { EngineClient } from "./client";
export type { EngineClientOptions } from "./client";

export { LocalEngine, yamlRootPolicy } from "./engine";
export type {
  EngineService,
  FeatureDescriptor,
  ProjectedStep,
  ProjectedGraph,
  LocalEngineOptions,
} from "./engine";

// Built-in Provider (für eigene Katalog-Zusammenstellungen / Tests).
export {
  helloProvider,
  draftUntilGoodProvider,
  retryThenPassProvider,
  localAgentProvider,
} from "./providers/demo";
export { migrateProvider, MIGRATE_SAMPLE_CSV } from "./providers/migrate";
export { skillBuilderProvider } from "./providers/skill-builder";
export {
  eventLogProvider,
  sessionSummaryProvider,
  discoverProvider,
} from "./providers/process-mining";
