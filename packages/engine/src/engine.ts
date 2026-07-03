// ───────────────────────────── EngineService + LocalEngine ─────────────────────────────
// EngineService ist die EINE Oberfläche, die CLI/MCP/Studio treiben (Inv. 2). LocalEngine implementiert
// sie in-process: EIN geteilter Store über alle Features (→ liveStatus/tape/subscribe sehen ALLE Runs),
// EIN zentraler Katalog, zentrale Provider-Profil-Auflösung und — hierher gewandert — die Governance
// (yamlRootPolicy). Das ist die Konsolidierung von cli/features.ts + mcp/registry.ts + studio/runtime.ts.
//
// Pack-Adressierung (Audit): startRun/resumeRun lösen das Feature serverseitig auf (Katalog-id ODER ein
// feature.yaml-Pfad). Die CorrelationId entsteht serverseitig und kommt über die Events zurück; resumeRun
// nutzt sie als Eingang. Aktive Runs werden gecached, sodass ein Suspend→Resume in-process dieselbe
// verdrahtete Runtime (und damit denselben Adapter-/DB-Zustand) nutzt — wie eine CLI-Einzel-Invocation.

import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Artifact,
  CapabilityRequest,
  CorrelationId,
  FeatureDefinition,
  FeaturePack,
  InMemoryRunStore,
  NodeRegistry,
  ResolvedPolicy,
  RunEvent,
  RunInput,
  RunStatus,
  TapeFrame,
} from "@elio/core";
import { InMemoryRunStore as InMemoryRunStoreImpl } from "@elio/core";
import { resolveProviderProfiles } from "@elio/sdk";
import type { ProviderProfilesOptions, ResolvedProviderProfiles, Runtime } from "@elio/sdk";
import { FeatureCatalog, defaultCatalog, yamlProvider } from "./catalog";
import type { FeatureCapabilities, FeatureProvider, FeatureSetupContext } from "./provider";

/** Ein für die Anzeige projizierter Step: id/type + (aus der Registry) klass/requests + suspend/when. */
export interface ProjectedStep {
  id: string;
  type: string;
  klass?: "orchestration" | "intelligence";
  requests?: CapabilityRequest;
  suspend?: string;
  when?: string;
}

/** Die projizierte Graph-Form (nodes + edges) eines statischen/guided Features. */
export interface ProjectedGraph {
  steps: ProjectedStep[];
  edges: { from: string; to: string; when?: string }[];
}

/**
 * Ein Feature, wie der Katalog es nach außen beschreibt (wire-fähig: reine Daten). Trägt die deklarative
 * FeatureDefinition (autonomy/artifact/io/policies/planner/graph), die zentral aufgelösten Node-Details
 * (klass/requests pro Step), die Capabilities und den Dateipfad. Ersetzt die studio-eigene Projektion.
 */
export interface FeatureDescriptor {
  id: string;
  version: string;
  /** Dateipfad (nur bei YAML-/datei-geladenen Packs) — Studio: „wo liegt die Datei". */
  sourcePath?: string;
  owner?: string;
  lifecycle?: string;
  autonomy: FeatureDefinition["autonomy"];
  artifact: FeatureDefinition["artifact"];
  io: FeatureDefinition["io"];
  policies: string[];
  planner?: { node: string };
  graph?: ProjectedGraph;
  capabilities: FeatureCapabilities;
  /** Das volle Pack (für weitergehende Projektion durch Clients). */
  pack: FeaturePack;
}

/**
 * Die EINE Engine-Oberfläche. (S) = streaming. CLI/MCP/Studio treiben ausschließlich diese — sie kennen
 * weder Katalog-Auflösung noch Runtime-Bau noch Governance.
 */
export interface EngineService {
  listFeatures(): Promise<FeatureDescriptor[]>;
  /**
   * `params` sind feature-spezifische Setup-Eingaben (z.B. { sourceCsv }, { outDir, brief }) — sie fließen
   * in den FeatureSetupContext, NICHT in RunInput (das ist der Loop-Input an den ersten Node).
   */
  startRun(
    featureId: string,
    input: RunInput,
    params?: Record<string, unknown>,
  ): AsyncIterable<RunEvent>; // (S)
  resumeRun(
    id: CorrelationId,
    answer: unknown,
    opts?: { expectedPackVersion?: string },
  ): AsyncIterable<RunEvent>; // (S)
  liveStatus(): Promise<RunStatus[]>;
  tape(runId: string): AsyncIterable<TapeFrame>;
  subscribe(filter?: { run?: string }): AsyncIterable<RunEvent>; // (S)
  /** Das finale (oder aktuelle) Artefakt eines Runs — z.B. für MCP, das es als Tool-Ergebnis zurückgibt.
   *  Async, damit ein Remote-EngineClient es über HTTP holen kann. */
  getArtifact(runId: string): Promise<Artifact | undefined>;
  /** Beendet alle Live-Subscriptions (Studio-Shutdown: SSE-Kanäle abräumen). */
  closeSubscriptions(): void;
}

export interface LocalEngineOptions {
  /** Geteilter Run-Store über alle Features (Default: frischer InMemoryRunStore; injizierbar: FileRunStore). */
  store?: InMemoryRunStore;
  /** Feature-Katalog (Default: defaultCatalog() mit allen built-in Providern). */
  catalog?: FeatureCatalog;
  /** Verzeichnis der file-backed CaptureStore (pm.*). Default: <cwd>/.elio/capture bzw. $ELIO_CAPTURE_DIR. */
  captureDir?: string;
  /**
   * Provider-Profil-Optionen (model/ollamaUrl/env/…). Sind `model`/`ollamaUrl` gesetzt, werden für
   * model-Features echte Profile aufgelöst; sonst laufen built-in model-Features offline (MockModel) —
   * exakt die Asymmetrie der bisherigen CLI (resolveFeature sync vs. resolveFeatureAsync).
   */
  profiles?: ProviderProfilesOptions;
}

/** Cache-Eintrag eines aktiven Runs: die verdrahtete Runtime + Pack, damit Resume sie wiederverwendet. */
interface ActiveRun {
  runtime: Runtime;
  pack: FeaturePack;
  featureId: string;
}

export class LocalEngine implements EngineService {
  readonly store: InMemoryRunStore;
  private readonly catalog: FeatureCatalog;
  private readonly captureDir: string;
  private readonly profileOpts: ProviderProfilesOptions;
  private readonly wantsProfiles: boolean;
  private profilesPromise: Promise<ResolvedProviderProfiles> | undefined;
  private readonly active = new Map<string, ActiveRun>();

  constructor(opts: LocalEngineOptions = {}) {
    this.store = opts.store ?? new InMemoryRunStoreImpl();
    this.catalog = opts.catalog ?? defaultCatalog();
    this.captureDir = opts.captureDir ?? join(process.cwd(), ".elio", "capture");
    this.profileOpts = opts.profiles ?? {};
    this.wantsProfiles =
      this.profileOpts.model !== undefined || this.profileOpts.ollamaUrl !== undefined;
  }

  async listFeatures(): Promise<FeatureDescriptor[]> {
    return this.catalog.all().map((p) => this.describe(p));
  }

  async *startRun(
    featureId: string,
    input: RunInput,
    params?: Record<string, unknown>,
  ): AsyncIterable<RunEvent> {
    const { provider, isYaml } = this.resolveProvider(featureId);
    const ctx = await this.contextFor(provider, isYaml);
    if (params !== undefined) ctx.params = params;
    const { runtime, pack } = provider.setup(ctx);
    yield* this.driveAndCache(runtime, pack, featureId, runtime.run(pack, input));
  }

  async *resumeRun(
    id: CorrelationId,
    answer: unknown,
    opts?: { expectedPackVersion?: string },
  ): AsyncIterable<RunEvent> {
    const cached = this.active.get(id.run);
    if (cached !== undefined) {
      // Same-Process Resume: dieselbe Runtime (Adapter-/DB-Zustand bleibt erhalten) — wie eine
      // CLI-Einzel-Invocation, die run + resume auf EINER Runtime fährt.
      const resumeOpts = { pack: cached.pack, ...(opts ?? {}) };
      yield* this.driveAndCache(
        cached.runtime,
        cached.pack,
        cached.featureId,
        cached.runtime.resume(id, answer, resumeOpts),
      );
      return;
    }
    // Cache-Miss (z.B. Engine-Neustart): Feature aus dem Store ableiten + frisch verdrahten. Resume
    // braucht das `pack` (Runner rekonstruiert den RunContext daraus).
    const featureId = await this.featureOfRun(id.run);
    const { provider, isYaml } = this.resolveProvider(featureId);
    const ctx = await this.contextFor(provider, isYaml);
    const { runtime, pack } = provider.setup(ctx);
    const resumeOpts = { pack, ...(opts ?? {}) };
    yield* this.driveAndCache(runtime, pack, featureId, runtime.resume(id, answer, resumeOpts));
  }

  liveStatus(): Promise<RunStatus[]> {
    return this.store.liveStatus();
  }

  tape(runId: string): AsyncIterable<TapeFrame> {
    return this.store.tape(runId);
  }

  subscribe(filter?: { run?: string }): AsyncIterable<RunEvent> {
    return filter !== undefined ? this.store.subscribe(filter) : this.store.subscribe();
  }

  // ── intern ────────────────────────────────────────────────────────────────

  /**
   * Treibt einen Event-Stream durch, pflegt den Active-Run-Cache (runId→Runtime ab run-started, Löschung
   * bei run-completed) und reicht jedes Event durch. So überlebt die verdrahtete Runtime ein Suspend.
   */
  private async *driveAndCache(
    runtime: Runtime,
    pack: FeaturePack,
    featureId: string,
    stream: AsyncIterable<RunEvent>,
  ): AsyncIterable<RunEvent> {
    for await (const ev of stream) {
      // Bei run-started den Active-Run-Cache setzen; nach Completion NICHT löschen — die Runtime hält das
      // finale Artefakt (getArtifact) bereit und ein erneuter Resume bleibt no-op-sicher. Memory-Eviction
      // (Cap/LRU) ist ein Concern des dauerlaufenden EngineHost (Phase 4), nicht des kurzlebigen LocalEngine.
      if (ev.type === "run-started") this.active.set(ev.correlation.run, { runtime, pack, featureId });
      yield ev;
    }
  }

  getArtifact(runId: string): Promise<Artifact | undefined> {
    return Promise.resolve(this.active.get(runId)?.runtime.runner.getArtifact(runId));
  }

  closeSubscriptions(): void {
    this.store.closeSubscriptions();
  }

  /** Anzahl aktiver Live-Subscriber (Diagnose/Tests). Nicht Teil des EngineService-Vertrags. */
  subscriberCount(): number {
    return this.store.subscriberCount();
  }

  /**
   * Projiziert EIN Feature für die Anzeige: die deklarative Definition + pro Step klass/requests, die aus
   * der Registry der (zur Projektion frisch verdrahteten) Feature-Runtime aufgelöst werden. ZENTRAL hier
   * statt in jeder Surface — das Studio liest nur noch das Ergebnis (Inv. 2). Schlägt das Setup eines
   * Features fehl (z.B. fehlende Voraussetzung), bleibt der Graph unprojiziert (Definition trotzdem da).
   */
  private describe(p: FeatureProvider): FeatureDescriptor {
    const f = p.pack.feature;
    const d: FeatureDescriptor = {
      id: p.id,
      version: p.pack.metadata.version,
      autonomy: f.autonomy,
      artifact: f.artifact,
      io: f.io,
      policies: f.policies ?? [],
      capabilities: p.capabilities,
      pack: p.pack,
    };
    if (p.pack.metadata.sourcePath !== undefined) d.sourcePath = p.pack.metadata.sourcePath;
    if (p.pack.metadata.owner !== undefined) d.owner = p.pack.metadata.owner;
    if (p.pack.metadata.lifecycle !== undefined) d.lifecycle = p.pack.metadata.lifecycle;
    if (f.planner !== undefined) d.planner = f.planner;
    if (f.graph !== undefined) {
      const registry = this.projectionRegistry(p);
      d.graph = {
        steps: f.graph.steps.map((s) => projectStep(s.id, s.type, s.suspend, s.when, registry)),
        edges: f.graph.edges.map((e) =>
          e.when !== undefined ? { from: e.from, to: e.to, when: e.when } : { from: e.from, to: e.to },
        ),
      };
    }
    return d;
  }

  /**
   * Verdrahtet das Feature einmal zur PROJEKTION (nicht zur Ausführung) und gibt seine Registry zurück, aus
   * der klass/requests pro Step gelesen werden. Throwaway-Store; skill-outDir auf ein gecachtes Projektions-
   * Verzeichnis, damit nicht pro Aufruf ein temp-Verzeichnis entsteht. Liefert undefined, wenn setup wirft.
   */
  private projectionRegistry(p: FeatureProvider): NodeRegistry | undefined {
    try {
      const { runtime } = p.setup({
        store: new InMemoryRunStoreImpl(),
        params: { outDir: this.projectionDir() },
      });
      return runtime.registry;
    } catch {
      return undefined;
    }
  }

  private projectionDirPath: string | undefined;
  private projectionDir(): string {
    if (this.projectionDirPath === undefined) {
      this.projectionDirPath = mkdtempSync(join(tmpdir(), "elio-engine-proj-"));
    }
    return this.projectionDirPath;
  }

  /** Löst eine Feature-id im Katalog auf ODER (Dateipfad) zu einem on-demand YAML-Provider. */
  private resolveProvider(featureId: string): { provider: FeatureProvider; isYaml: boolean } {
    const known = this.catalog.get(featureId);
    if (known !== undefined) return { provider: known, isYaml: false };
    if (existsSync(featureId)) return { provider: yamlProvider(featureId), isYaml: true };
    throw new Error(
      `Unbekanntes Feature "${featureId}". Erwartet: eine built-in id (${this.catalog
        .ids()
        .join(", ")}) ODER ein Pfad zu einer feature.yaml.`,
    );
  }

  /** Baut den einheitlichen FeatureSetupContext: Store, captureDir, (ggf.) Modelle + (YAML) Root-Policy. */
  private async contextFor(
    provider: FeatureProvider,
    isYaml: boolean,
  ): Promise<FeatureSetupContext> {
    const ctx: FeatureSetupContext = { store: this.store, captureDir: this.captureDir };
    // Profile auflösen, wenn: ein YAML-Feature (löst IMMER auf — bisheriges Verhalten) ODER ein built-in
    // model-Feature UND Profile explizit gewünscht (model/ollamaUrl gesetzt). Sonst offline (MockModel).
    const needsProfiles = isYaml || (provider.capabilities.model && this.wantsProfiles);
    if (needsProfiles) {
      const profiles = await this.resolveProfiles();
      ctx.models = profiles.providers;
      ctx.defaultModel = profiles.defaultModel;
      ctx.allowedModels = profiles.allowedModels;
      ctx.providerCosts = profiles.costs;
      // Governance NUR für YAML-Features zentral bauen (built-in Vertikalen besitzen ihre eigene
      // feature-spezifische Root-Policy in ihrer Fassade — die dürfen wir NICHT überschreiben).
      if (isYaml) ctx.rootPolicy = yamlRootPolicy(profiles.allowedModels, profiles.available);
    }
    return ctx;
  }

  private resolveProfiles(): Promise<ResolvedProviderProfiles> {
    if (this.profilesPromise === undefined) {
      this.profilesPromise = resolveProviderProfiles(this.profileOpts);
    }
    return this.profilesPromise;
  }

  private async featureOfRun(runId: string): Promise<string> {
    const status = (await this.store.liveStatus()).find((s) => s.correlation.run === runId);
    if (status === undefined) {
      throw new Error(`Resume: kein Run "${runId}" im Store bekannt.`);
    }
    return status.feature;
  }
}

/** Projiziert einen Step: id/type aus dem Pack + klass/requests aus der Registry (falls registriert). */
function projectStep(
  id: string,
  type: string,
  suspend: string | undefined,
  when: string | undefined,
  registry: NodeRegistry | undefined,
): ProjectedStep {
  const step: ProjectedStep = { id, type };
  // klass/requests aus der registrierten NodeDefinition (security by absence: fehlt der Typ in der
  // Registry — z.B. ein YAML-Custom-Node, den niemand registriert hat — bleiben die Felder schlicht weg).
  if (registry !== undefined && registry.has(type)) {
    const def = registry.resolve(type);
    step.klass = def.klass;
    if (def.requests !== undefined) step.requests = def.requests;
  }
  if (suspend !== undefined) step.suspend = suspend;
  if (when !== undefined) step.when = when;
  return step;
}

/**
 * Die Root-Governance eines YAML-Laufs aus den aufgelösten Profil-Freigaben. WANDERTE aus cli/features.ts
 * hierher (§1.2: eine Sicherheitsentscheidung gehört NICHT in den UI-Layer). allowCloud nur, wenn ein
 * Cloud-Profil tatsächlich verfügbar ist.
 */
export function yamlRootPolicy(allowedModels: string[], available: string[]): ResolvedPolicy {
  const allowCloud = available.includes("claude") || available.includes("azure-openai");
  return {
    allowedModels,
    allowCloud,
    dataClassification: "internal",
    suspendMode: "optional",
    toolPermissions: [],
    dbScopes: [],
    fsPaths: { read: [], write: [] },
  };
}
