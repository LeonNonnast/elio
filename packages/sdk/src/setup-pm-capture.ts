// ───────────────────────────── pm.event-log + pm.session-summary — Setup-Fassaden (Doc §3.1/§3.2, Slice 3b) ─────────────────────────────
// Zwei Capture-Vertikalen-Fassaden (mirror von setupProcessMining):
//
//  - setupEventLog: der Logger (AI-frei). Baut eine Runtime mit EPHEMEREM In-Memory-Run-Store (KEIN `store`-Opt
//    → das eigene Tape verdunstet, Doc §3.4) + einer per Closure gebundenen file-backed CaptureStore (der
//    durable Output ist allein die events-Zeile). Root-Policy gewährt NUR `capture:write` (security by absence).
//
//  - setupSessionSummary: der Summarizer (LLM, 1×/Session). ctx.traces sitzt auf einer TableTapeSource über der
//    (read) CaptureStore; der durable Output ist die file-backed SummaryStore-Zeile (per Closure gebunden).
//    Offline/deterministisch via MockModel (defaultModel "mock", allowedModels ["mock"]). Root-Policy gewährt
//    traces:read + summaries:write + das mock-Modell. Ephemerer Run-Store (gleiches Self-Mining-Argument wie der
//    Logger). Real swappbar auf claude:claude-haiku-4-5 über die models/defaultModel/allowedModels-Opts.

import {
  CAPTURE_WRITE_PERMISSION,
  InMemoryCaptureStore,
  InMemorySummaryStore,
  registerEventLog,
  registerSessionSummary,
  rootPolicy,
  SUMMARIES_WRITE_PERMISSION,
  TableTapeSource,
  TRACES_READ_PERMISSION,
} from "@elio/core";
import type { CaptureStore, ModelService, ResolvedPolicy, SummaryStore } from "@elio/core";
import { MockModel } from "./models/mock";
import type { ProviderMap } from "./models/worker";
import { createRuntime } from "./runtime";
import type { Runtime } from "./runtime";

// ───────────────────────────── setupEventLog (Logger, AI-frei) ─────────────────────────────

export interface SetupEventLogOptions {
  /** Die durable events-Tabelle (Slice 2), per Closure in die append-Node gebunden. Default: file-backed unter `captureDir`. */
  captureStore?: CaptureStore;
  /** Verzeichnis der file-backed CaptureStore (events.jsonl), falls kein `captureStore` gegeben. Default: in-memory only. */
  captureDir?: string;
  /** Root-Policy-Override. Default: gewährt NUR `capture:write` (sonst fail-closed — security by absence). */
  rootPolicy?: ResolvedPolicy;
}

export interface EventLogSetup {
  runtime: Runtime;
  /** Die (file-backed oder gegebene) CaptureStore — der durable Output des Loggers. */
  captureStore: CaptureStore;
}

/**
 * Baut die vollständig verdrahtete Logger-Runtime (Doc §3.1/§3.4): EPHEMERER In-Memory-Run-Store (kein `store`
 * → das Tape verdunstet), die append-Node closure-gebunden an die file-backed CaptureStore, Root-Policy mit
 * NUR `capture:write`. Der pm.event-log-Pack (`pmEventLogPack`, @elio/core) läuft über `runtime.run(pack, {
 * payload: <roher Hook-Event> })`.
 */
export function setupEventLog(opts: SetupEventLogOptions = {}): EventLogSetup {
  const captureStore: CaptureStore =
    opts.captureStore ??
    new InMemoryCaptureStore(opts.captureDir !== undefined ? { dir: opts.captureDir } : {});

  // KEIN `store`-Opt → die Runtime baut einen frischen, prozess-lokalen InMemoryRunStore: das Logger-Tape
  // verdunstet (Doc §3.4), strukturell kein Self-Mining (der Discoverer liest die events-Tabelle, nicht das Tape).
  const runtime = createRuntime({
    rootPolicy: opts.rootPolicy ?? rootPolicy({ toolPermissions: [CAPTURE_WRITE_PERMISSION] }),
  });
  registerEventLog(runtime.registry, { captureStore });
  return { runtime, captureStore };
}

// ───────────────────────────── setupSessionSummary (Summarizer, LLM) ─────────────────────────────

export interface SetupSessionSummaryOptions {
  /** Die durable events-Tabelle (read), hinter die TableTapeSource. Pflicht. */
  captureStore: CaptureStore;
  /** Die durable summaries-Tabelle (write), per Closure in die persist-Node gebunden. Default: file-backed unter `summaryDir` / in-memory. */
  summaryStore?: SummaryStore;
  /** Verzeichnis der file-backed SummaryStore (summaries.jsonl), falls kein `summaryStore` gegeben. Default: in-memory only. */
  summaryDir?: string;
  /**
   * Modell hinter dem label-Step (ctx.model). Default: ein deterministisches MockModel (offline). Ein
   * Override (z.B. ein capturing MockModel) erlaubt Tests, den an das Modell gereichten Prompt zu prüfen.
   */
  model?: ModelService;
  /** ECHTE Provider-Config (Profil-Key → Adapter), z.B. aus resolveProviderProfiles. Default: offline (mock). */
  models?: ProviderMap;
  /** Default-Modell-Spec des aus `models` gebauten Workers (kanonisch). Default: "mock". */
  defaultModel?: string;
  /** Policy-Freigabe der Modelle (allowedModels). Default: ["mock"] (offline). */
  allowedModels?: string[];
  /** Grobe Kosten-Richtwerte je Profil-Key — an den Worker durchgereicht. */
  providerCosts?: Record<string, { in: number; out: number }>;
  /** Root-Policy-Override. Default: gewährt traces:read + summaries:write + die freigegebenen Modelle. */
  rootPolicy?: ResolvedPolicy;
}

export interface SessionSummarySetup {
  runtime: Runtime;
  /** Die (file-backed oder gegebene) SummaryStore — der durable Output des Summarizers. */
  summaryStore: SummaryStore;
}

/**
 * Baut die vollständig verdrahtete Summarizer-Runtime (Doc §3.2): ctx.traces hinter einer TableTapeSource über
 * der CaptureStore (read), der persist-Node closure-gebunden an die file-backed SummaryStore (write), offline/
 * deterministisch via MockModel, Root-Policy mit traces:read + summaries:write + dem mock-Modell. Ephemerer
 * Run-Store (gleiches Self-Mining-Argument wie der Logger). Der pm.session-summary-Pack
 * (`pmSessionSummaryPack`, @elio/core) läuft über `runtime.run(pack, { payload: <session-id> })`.
 */
export function setupSessionSummary(opts: SetupSessionSummaryOptions): SessionSummarySetup {
  const summaryStore: SummaryStore =
    opts.summaryStore ??
    new InMemorySummaryStore(opts.summaryDir !== undefined ? { dir: opts.summaryDir } : {});

  // Offline-Pfad (Default): MockModel unter "mock", defaultModel "mock", allowedModels ["mock"] — exakt das
  // migrate/skill-builder-Muster. Real swappbar über die models/defaultModel/allowedModels-Opts.
  const usingRealProviders = opts.models !== undefined;
  const models: ProviderMap = opts.models ?? { mock: opts.model ?? new MockModel() };
  const defaultModel = opts.defaultModel ?? "mock";
  const allowedModels = usingRealProviders
    ? (opts.allowedModels ?? Object.keys(models).map((k) => `${k}:*`))
    : ["mock"];

  const policy =
    opts.rootPolicy ??
    rootPolicy({
      allowedModels,
      toolPermissions: [TRACES_READ_PERMISSION, SUMMARIES_WRITE_PERMISSION],
    });

  const runtime = createRuntime({
    models,
    defaultModel,
    ...(opts.providerCosts !== undefined ? { providerCosts: opts.providerCosts } : {}),
    tracesSource: new TableTapeSource(opts.captureStore),
    rootPolicy: policy,
  });
  registerSessionSummary(runtime.registry, { summaryStore });
  return { runtime, summaryStore };
}
