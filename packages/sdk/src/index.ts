// @elio/sdk — Public API über @elio/core (Inv. 2: SDK ist der Kern-Einstieg, CLI/MCP/Studio sind Clients).
// Re-exportiert die Kern-Contracts + die Runtime-Fassade (createRuntime, run/resume) + die Demo-Packs.

export * from "@elio/core";

export const ELIO_SDK_VERSION = "0.0.0";

// ───────────────────────────── Runtime-Fassade ─────────────────────────────
export {
  createRuntime,
  getDefaultRuntime,
  setDefaultRuntime,
  run,
  resume,
  collectEvents,
} from "./runtime";
export type { Runtime, RuntimeOptions } from "./runtime";

// ───────────────────────────── Feature-Pack-YAML-Loader (§3, §11/#14) ─────────────────────────────
export { loadFeaturePack, loadFeaturePackFromFile, computeContentHash, FeaturePackError } from "./loader";
export type { LoadFeaturePackInput } from "./loader";

// ───────────────────────────── Demo-Feature-Packs ─────────────────────────────
export {
  draftUntilGoodPack,
  minLengthGate,
  setupDraftUntilGood,
  TEXT_DOC_TYPE,
  DRAFT_CHUNK,
  MIN_LENGTH,
} from "./demo/draft-until-good";
export {
  retryThenPassPack,
  flakyOnceNode,
  alwaysPassGate,
  setupRetryThenPass,
  createDemoRuntime,
  NOTE_TYPE,
} from "./demo/retry-then-pass";
export {
  helloPack,
  polishGreetingNode,
  greetingReadyGate,
  setupHello,
  polishGreeting,
  greetingFailures,
} from "./demo/hello";
export {
  localAgentPack,
  localMinLengthGate,
  setupLocalAgent,
  createLocalAgentRuntime,
  LOCAL_AGENT_PROVIDER,
  LOCAL_AGENT_MODEL,
  LOCAL_AGENT_SPEC,
  LOCAL_AGENT_POLICY,
  LOCAL_MIN_LENGTH,
} from "./demo/local-agent";
export type { LocalAgentRuntimeOptions } from "./demo/local-agent";

// ───────────────────────────── ModelService-Adapter + LLM-Worker (Slice 3, Inv. 17) ─────────────────────────────
export { MockModel } from "./models/mock";
export type { MockModelOptions } from "./models/mock";
export { OllamaModel } from "./models/ollama";
export type { OllamaModelOptions } from "./models/ollama";
export { ClaudeModel, DEFAULT_CLAUDE_MODEL } from "./models/claude";
export type { ClaudeModelOptions } from "./models/claude";
export { AzureOpenAiModel } from "./models/azure-openai";
export type { AzureOpenAiModelOptions } from "./models/azure-openai";
export { LlmWorker } from "./models/worker";
export type { LlmWorkerOptions, ProviderMap } from "./models/worker";
export {
  resolveProviderProfiles,
  providerOf,
  KNOWN_PROFILES,
  DEFAULT_OLLAMA_URL,
} from "./models/profiles";
export type {
  ProviderProfilesOptions,
  ResolvedProviderProfiles,
  KnownProfile,
} from "./models/profiles";
export {
  registerProfile,
  registerProfiles,
  clearRegisteredProfiles,
  listRegisteredProfiles,
  loadProfilesFromFile,
  findProfilesFile,
  collectProfiles,
  validateProfile,
  PROFILE_KINDS,
  COST_TIERS,
  PROFILE_FILE_NAMES,
} from "./models/profile-config";
export type {
  ProviderProfile,
  ProfileKind,
  CostTier,
  ProfileCost,
} from "./models/profile-config";
export {
  preflightFeature,
  collectModelRefs,
  assertPreflight,
} from "./preflight";
export type { PreflightReport, PreflightOptions, ModelRef } from "./preflight";
export {
  InProcessAgentEngine,
  InProcessAgentService,
  boundAgentService,
} from "./models/agent-engine";
export type { InProcessAgentEngineOptions } from "./models/agent-engine";
export {
  PRICE_PER_MTOK,
  usdFromTokens,
  normalizeRequest,
  lastUserContent,
} from "./models/types";
export type {
  CompletionRequest,
  CompletionMessage,
  CompletionResult,
  CompletionChunk,
} from "./models/types";

// ───────────────────────────── Services: Secrets (§11/#8) ─────────────────────────────
export { EnvSecretsProvider } from "./services/secrets";
export type { EnvSecretsProviderOptions } from "./services/secrets";

// ───────────────────────────── Services: fs + db (Inv. 14, §11/#1/#11) ─────────────────────────────
export { ScopedFsService } from "./services/fs";
export type { ScopedFsServiceOptions } from "./services/fs";
export { InMemoryDbService } from "./services/db";
export type { InMemoryDbServiceOptions } from "./services/db";
export { ScopedHttpService } from "./services/http";
export type { ScopedHttpServiceOptions } from "./services/http";

// ───────────────────────────── Process-Mining: pm.discover Setup-Fassade (Doc §3.3, Slice 3a) ─────────────────────────────
export { setupProcessMining, registerProcessMining } from "./setup-process-mining";
export type {
  SetupProcessMiningOptions,
  ProcessMiningSetup,
  RegisterProcessMiningOptions,
} from "./setup-process-mining";

// ───────────────────────────── Process-Mining: pm.event-log + pm.session-summary Fassaden (Doc §3.1/§3.2, Slice 3b) ─────────────────────────────
export { setupEventLog, setupSessionSummary } from "./setup-pm-capture";
export type {
  SetupEventLogOptions,
  EventLogSetup,
  SetupSessionSummaryOptions,
  SessionSummarySetup,
} from "./setup-pm-capture";
