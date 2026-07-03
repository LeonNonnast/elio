// ───────────────────────────── createRuntime: SDK-Fassade über @elio/core (Inv. 2) ─────────────────────────────
// Verdrahtet NodeRegistry(+registerBuiltins) + PolicyInjector + InMemoryRunStore + OuterLoopRunner.
// run()/resume() sind der primäre programmatische Einstieg; eine Default-Runtime stellt
// Top-Level run()/resume() bereit. Die CLI/MCP/Studio sind nur weitere Clients dieser Runtime.

import {
  InMemoryRunStore,
  NodeRegistry,
  OuterLoopRunner,
  PolicyInjector,
  PolicyRegistry,
  registerBuiltins,
  TapeRedactor,
} from "@elio/core";
import type {
  AgentEngine,
  ArtifactType,
  CorrelationId,
  DbService,
  FeaturePack,
  FeatureResolver,
  FsService,
  HttpService,
  Injector,
  ModelService,
  Redactor,
  ResolvedPolicy,
  RunEvent,
  RunInput,
  SecretsProvider,
  TapeSource,
} from "@elio/core";
import { MockModel } from "./models/mock";
import { LlmWorker } from "./models/worker";
import type { ProviderMap } from "./models/worker";
import { InProcessAgentEngine } from "./models/agent-engine";

export interface RuntimeOptions {
  /** Eigener Run Store (Default: InMemoryRunStore). */
  store?: InMemoryRunStore;
  /** Vorbefüllte Registry (Default: frische Registry mit registerBuiltins). */
  registry?: NodeRegistry;
  /**
   * ModelService hinter ctx.model (Slice 3). KEINER von diesen drei ist nötig — fehlen alle, baut die
   * Runtime einen LlmWorker mit Default-Provider { "mock": MockModel } und Default-Modell "mock".
   *
   * Priorität: `model` (fertiger ModelService, z.B. ein eigener Worker) > `models` (Provider-Map, aus
   * der die Runtime einen LlmWorker baut) > Default-Worker.
   */
  model?: ModelService;
  /** Provider-Map (Modell-/Präfix -> Adapter). Die Runtime baut daraus einen concurrency-gated LlmWorker. */
  models?: ProviderMap;
  /**
   * Grobe Kosten-Richtwerte je Profil-Key ($/MTok in/out) — an den gebauten LlmWorker durchgereicht, der
   * daraus cost.usd stempelt. Stammt i.d.R. aus resolveProviderProfiles().costs. Nur relevant, wenn die
   * Runtime den Worker aus `models` baut (nicht bei vorgefertigtem `model`).
   */
  providerCosts?: Record<string, { in: number; out: number }>;
  /**
   * AgentEngine hinter ctx.agent (Inv. 17). Default = InProcessAgentEngine (transparent, fließt durch
   * ctx.model). Wie ctx.model gegated: der Injector hängt ctx.agent nur an, wenn die Policy ein Modell
   * erlaubt. `null` deaktiviert ctx.agent komplett (die agent-Node fällt dann auf ihren in-process
   * ctx.model-Loop zurück — funktional identisch zur Default-Engine, aber ohne den Engine-Seam).
   */
  agentEngine?: AgentEngine | null;
  /** Default-Modell des gebauten Workers (Default "mock"). Nur relevant, wenn `models`/Default greift. */
  defaultModel?: string;
  /** Max. gleichzeitige Calls pro Provider im gebauten Worker (Default 4). */
  concurrency?: number;
  /** Root-Policy-Override (z.B. um Modelle/fs für ein Feature freizugeben). */
  rootPolicy?: ResolvedPolicy;
  /**
   * Policy-Registry (Inv. 13). Löst pack.feature.policies per id auf (Default: frische, leere
   * Registry). Registriere Policies daran, bevor ein Feature mit deklarierten Policies läuft.
   */
  policyRegistry?: PolicyRegistry;
  /** Artefakt-Typ pro `kind` (bestimmt die Data-Holder, Inv. 22). */
  artifactTypes?: Record<string, ArtifactType>;
  /**
   * Secret-Provider hinter ctx.secrets (§11/#8). Wird er gesetzt, hängt der Injector ctx.secrets an
   * eine Node NUR, wenn deren resolvte Policy einen "secret:<name>"-toolPermission trägt (security by
   * absence). Fehlt er, gibt es kein ctx.secrets (Default — eine Node kann ohne Provider keine Secrets).
   */
  secretsProvider?: SecretsProvider;
  /**
   * FsService-Backend hinter ctx.fs (Inv. 14, §11/#1). Wird er gesetzt, hängt der Injector ctx.fs an
   * eine Node NUR, wenn deren resolvte Policy nichtleere fsPaths trägt (security by absence). Der
   * Injector wrappt das Backend zusätzlich in seinen policy-gescopten ScopedFsService (defense in depth).
   * Default: kein Backend -> kein ctx.fs (eine Node kann ohne Backend nicht auf das Dateisystem).
   */
  fs?: FsService;
  /**
   * DbService-Backend hinter ctx.db (Inv. 14, §11/#11). Wie fs gegated: ctx.db nur bei nichtleeren
   * dbScopes. Default: kein Backend -> kein ctx.db.
   */
  db?: DbService;
  /**
   * HttpService-Backend hinter ctx.http (Inv. 14, §v0.2). Wie fs/db gegated: ctx.http nur bei
   * nichtleeren httpHosts. Der Injector wrappt das Backend zusätzlich in seinen policy-gescopten
   * ScopedHttpService (per-Call Host-Check, defense in depth). Default: kein Backend -> kein ctx.http.
   */
  http?: HttpService;
  /**
   * Tape-Redactor (§11/#9). Default = ein frischer TapeRedactor, der mit dem Injector geteilt wird:
   * jeder von ctx.secrets aufgelöste Wert wird hier registriert und auto-redacted aus dem Loop Tape.
   * `null` deaktiviert die Redaction (Frames unverändert).
   */
  redactor?: Redactor | null;
  /**
   * Quelle hinter ctx.traces (Inv. 15). Default = der `store` (RunStore erfüllt TapeSource strukturell).
   * Eine eigene TapeSource (z.B. ein TableTapeSource über einer CaptureStore, Process-Mining) liest dann das
   * Loop Tape statt des Run Stores. Wie alle Capabilities gegated: ctx.traces wird NUR injiziert, wenn die
   * resolvte Policy einen "traces:*"-toolPermission trägt (security by absence, Inv. 14).
   */
  tracesSource?: TapeSource;
  /** Eigener Injector (Default: PolicyInjector mit model/store). */
  injector?: Injector;
  /**
   * Sub-Feature-Katalog (Inv. 6, §3 feature-ref). Wird er gesetzt, reicht ihn der Runner als
   * FeatureResolver durch — die feature-ref-Node kann dann Sub-Features per id als Kind-Branches fahren.
   * Default: keiner (feature-ref ohne Katalog schlägt mit klarer Meldung fehl). Der Engine-Service nutzt
   * dies, um EINE Runtime mit allen bekannten Packs zu verdrahten (zentraler Katalog statt pro-Aufrufer).
   */
  featureRegistry?: FeatureResolver;
  /** Built-ins automatisch registrieren, wenn eine frische Registry gebaut wird (Default: true). */
  registerBuiltins?: boolean;
}

export interface Runtime {
  run(pack: FeaturePack, input: RunInput): AsyncIterable<RunEvent>;
  /**
   * Resume via correlation-id + Antwort (Inv. 12). `opts.expectedPackVersion` (§11/#14): validiert
   * den Checkpoint gegen die erwartete Pack-Version (z.B. den frisch geladenen contentHash); weicht
   * sie vom gepinnten `cp.packVersion` ab, wird der Resume abgelehnt.
   */
  resume(
    id: CorrelationId,
    answer: unknown,
    opts?: { expectedPackVersion?: string; pack?: FeaturePack },
  ): AsyncIterable<RunEvent>;
  readonly registry: NodeRegistry;
  readonly policyRegistry: PolicyRegistry;
  readonly store: InMemoryRunStore;
  readonly runner: OuterLoopRunner;
  /** Der ModelService, der als Injector-Dependency hinter ctx.model hängt (i.d.R. ein LlmWorker). */
  readonly model: ModelService;
  /** Der durchgereichte Sub-Feature-Katalog (falls verdrahtet), z.B. für Engine-Katalog/Fan-out. */
  readonly featureRegistry?: FeatureResolver;
  /**
   * Die ProviderMap (Profil-Key -> Adapter), aus der der Worker gebaut wurde — falls die Runtime ihn aus
   * `models` baute. Bei einem vorgefertigten `model` undefined (die Map ist dann nicht bekannt). Der
   * Preflight liest sie, um die in den Steps gepinnten Profile gegen die verfügbaren zu validieren.
   */
  readonly providers?: ProviderMap;
}

/**
 * Baut eine vollständig verdrahtete Runtime. Eine Registry ohne expliziten Wert bekommt die
 * Built-ins (transform, validate); eine übergebene Registry wird unverändert genutzt (der Caller
 * entscheidet, ob/wann er registerBuiltins ruft).
 */
export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const store = opts.store ?? new InMemoryRunStore();

  let registry: NodeRegistry;
  if (opts.registry !== undefined) {
    registry = opts.registry;
  } else {
    registry = new NodeRegistry();
    if (opts.registerBuiltins !== false) {
      registerBuiltins(registry);
    }
  }

  // Model-Dependency hinter ctx.model bauen (Inv. 17): ctx.model zeigt auf den Worker, nie auf einen
  // rohen Adapter. Priorität: expliziter `model` > Worker aus `models` > Default-Worker {"mock": MockModel}.
  let model: ModelService;
  let providerMap: ProviderMap | undefined;
  if (opts.model !== undefined) {
    model = opts.model;
  } else {
    const providers: ProviderMap = opts.models ?? { mock: new MockModel() };
    providerMap = providers;
    const workerOpts = {
      providers,
      defaultModel: opts.defaultModel ?? "mock",
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.providerCosts !== undefined ? { costs: opts.providerCosts } : {}),
    };
    model = new LlmWorker(workerOpts);
  }

  // AgentEngine hinter ctx.agent (Inv. 17). Default = InProcessAgentEngine; `null` deaktiviert sie.
  const agentEngine: AgentEngine | undefined =
    opts.agentEngine === null ? undefined : (opts.agentEngine ?? new InProcessAgentEngine());

  // Tape-Redactor (§11/#9): EIN geteilter Redactor zwischen Injector (registriert aufgelöste Secrets)
  // und Runner (scrubbt Frames vor dem Append). `null` deaktiviert ihn; Default = frischer Redactor.
  const redactor: Redactor | undefined =
    opts.redactor === null ? undefined : (opts.redactor ?? new TapeRedactor());

  const injector =
    opts.injector ??
    new PolicyInjector({
      store,
      model,
      ...(opts.tracesSource !== undefined ? { tracesSource: opts.tracesSource } : {}),
      ...(agentEngine !== undefined ? { agentEngine } : {}),
      ...(opts.secretsProvider !== undefined ? { secretsProvider: opts.secretsProvider } : {}),
      ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
      ...(opts.db !== undefined ? { db: opts.db } : {}),
      ...(opts.http !== undefined ? { http: opts.http } : {}),
      ...(redactor !== undefined ? { redactor } : {}),
    });

  const policyRegistry = opts.policyRegistry ?? new PolicyRegistry();

  const runner = new OuterLoopRunner({
    registry,
    store,
    injector,
    policyRegistry,
    ...(opts.rootPolicy !== undefined ? { rootPolicy: opts.rootPolicy } : {}),
    ...(opts.artifactTypes !== undefined ? { artifactTypes: opts.artifactTypes } : {}),
    ...(opts.featureRegistry !== undefined ? { featureRegistry: opts.featureRegistry } : {}),
    ...(redactor !== undefined ? { redactor } : {}),
  });

  return {
    run: (pack, input) => runner.run(pack, input),
    resume: (id, answer, opts) =>
      opts === undefined ? runner.resume(id, answer) : runner.resume(id, answer, opts),
    registry,
    policyRegistry,
    store,
    runner,
    model,
    ...(opts.featureRegistry !== undefined ? { featureRegistry: opts.featureRegistry } : {}),
    ...(providerMap !== undefined ? { providers: providerMap } : {}),
  };
}

// ───────────────────────────── Default-Runtime + Top-Level Fassade ─────────────────────────────

let defaultRuntime: Runtime | undefined;

/** Lazy Default-Runtime (Built-ins registriert). Genutzt von den Top-Level run()/resume(). */
export function getDefaultRuntime(): Runtime {
  if (defaultRuntime === undefined) {
    defaultRuntime = createRuntime();
  }
  return defaultRuntime;
}

/** Ersetzt die Default-Runtime (Tests/Custom-Setups). */
export function setDefaultRuntime(rt: Runtime): void {
  defaultRuntime = rt;
}

/** Top-Level run() gegen die Default-Runtime. */
export function run(pack: FeaturePack, input: RunInput): AsyncIterable<RunEvent> {
  return getDefaultRuntime().run(pack, input);
}

/** Top-Level resume() gegen die Default-Runtime. */
export function resume(
  id: CorrelationId,
  answer: unknown,
  opts?: { expectedPackVersion?: string; pack?: FeaturePack },
): AsyncIterable<RunEvent> {
  return getDefaultRuntime().resume(id, answer, opts);
}

/** Sammelt alle RunEvents eines Streams in ein Array (Test/CLI-Komfort). */
export async function collectEvents(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}
