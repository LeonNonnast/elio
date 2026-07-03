// ───────────────────────────── Injector: policy-gescopte DI = Governance (Inv. 14) ─────────────────────────────
// "Governance IST Dependency Injection." Der Injector liest die Policy PRO Node und baut das
// gescopte ctx: NUR die Services, die `resolved = tighten(parent, node.requests)` erlaubt.
// KEIN runtime permission-check — eine Node KANN nicht, was nicht injiziert wurde (security by absence).

import { resolve, sep } from "node:path";
import type { Artifact } from "./artifact";
import type {
  AgentService,
  AuditService,
  CostService,
  Ctx,
  DbService,
  ElicitService,
  FsService,
  HttpService,
  LoggerService,
  MemoryService,
  ModelService,
  SecretsService,
} from "./ctx";
import type { CorrelationId, Elicitation, SuspendMode } from "./elicitation";
import type { Injector, ResolvedPolicy } from "./policy";
import type { NodeDefinition, NodeResult, Suspended } from "./node";
import type { RunStore } from "./run";
import type { AgentEngine, SessionContract, SessionResult } from "./session";
import { maxSuspendMode, tighten } from "./policy-impl";
import { BudgetTracker, TrackerCostService } from "./cost";
import { allowedSecretNames, ScopedSecretsService } from "./secrets";
import type { SecretsProvider } from "./secrets";
import type { Redactor } from "./redaction";
import { allowedTraceScopes, RunStoreTracesService, traceScope } from "./traces";
import type { TapeSource } from "./traces";
import { allowedFeatureStoreScopes } from "./featurestore";
import { allowedScriptScopes } from "./sandbox";
import type { FeatureStoreService, ScriptRunnerService, TracesService } from "./ctx";

/**
 * Ausführungs-Seam für eine Node. v0.1 Default = InProcessSandbox (ruft den Handler direkt).
 * Sicherheit kommt aus *security by absence* — der Injector hängt nur erlaubte Services an `ctx`.
 * Worker/VM-Isolation ist bewusst v0.2; der Seam ist da, damit ein Worker-Impl ohne
 * Runner-Änderung eindockt.
 */
export interface NodeSandbox {
  run(node: NodeDefinition, input: unknown, ctx: Ctx): Promise<NodeResult>;
}

export class InProcessSandbox implements NodeSandbox {
  run(node: NodeDefinition, input: unknown, ctx: Ctx): Promise<NodeResult> {
    return node.handler(input, ctx);
  }
}

// ───────────────────────────── ElicitService-Impl ─────────────────────────────
/** Erzeugt ein Suspended-Result; der Runner propagiert es hoch (Inv. 11). */
export class DefaultElicitService implements ElicitService {
  private readonly floorMode: SuspendMode;

  /** `floorMode` = resolved.suspendMode = die vom Policy-Stack erzwungene, engste erlaubte Suspend-Art. */
  constructor(floorMode: SuspendMode) {
    this.floorMode = floorMode;
  }

  raise(e: Omit<Elicitation, "mode"> & { mode?: SuspendMode }): Suspended {
    const { mode, ...rest } = e;
    // tighten-only (Inv. 13 / §6 Schluss): ein Author/Node darf nur VERSCHÄRFEN, nie lockern.
    // Effektiver Mode = der tightere aus Node-Vorschlag und Policy-Floor (resolved.suspendMode).
    // Ein vorgeschlagenes "optional" unter einer Policy mit Floor "blocking" wird zu "blocking";
    // ein vorgeschlagenes "blocking" über einem Floor "optional" bleibt "blocking". Der Floor
    // kann NIE unterlaufen werden (eine Node kann ein Gate nur enger machen, nie öffnen).
    const proposed = mode ?? this.floorMode;
    const elicitation: Elicitation = { ...rest, mode: maxSuspendMode(proposed, this.floorMode) };
    return { status: "suspended", elicitation };
  }
}

// ───────────────────────────── Scoped Service-Wrapper ─────────────────────────────
/** fs-Wrapper, der jeden Zugriff gegen die resolvten Pfade prüft (defense in depth über DI hinaus). */
class ScopedFsService implements FsService {
  constructor(
    private readonly inner: FsService,
    private readonly paths: { read: string[]; write: string[] },
  ) {}

  read(p: string): Promise<string> {
    if (!underAny(p, this.paths.read)) {
      return Promise.reject(new Error(`fs.read denied for "${p}" (out of scope)`));
    }
    return this.inner.read(p);
  }

  write(p: string, c: string): Promise<void> {
    if (!underAny(p, this.paths.write)) {
      return Promise.reject(new Error(`fs.write denied for "${p}" (out of scope)`));
    }
    return this.inner.write(p, c);
  }
}

/**
 * db-Wrapper, der die erlaubten Scopes mitführt (v0.1: dünne Durchreiche, gating-by-injection).
 *
 * WICHTIG (v0.1-Grenze, §3): das db-Scoping gated in v0.1 nur, OB ctx.db überhaupt injiziert wird
 * (security by absence über den getighteneten dbScopes-Schnitt im PolicyInjector) — NICHT, welche
 * Tabelle/Connection ein einzelnes query() trifft. `query()` reicht das Statement verbatim ans Backend
 * durch; `scopes` wird mitgeführt (Audit/künftige per-statement Enforcement), aber NICHT pro Statement
 * geprüft. Echtes per-Tabellen-Confinement wie beim fs-Layer (defense in depth) ist bewusst späteren
 * Slices vorbehalten; das InMemoryDbService-Backend (SDK) kann zusätzlich auf erlaubte Scopes begrenzt
 * werden. Diese Klasse gated also (wie der Spec-Satz "gescopt auf erlaubte Connections/Tabellen" es
 * meint) auf der Injektions-Ebene, nicht per Statement.
 */
class ScopedDbService implements DbService {
  constructor(
    private readonly inner: DbService,
    private readonly scopes: string[],
  ) {}

  query(q: string, p?: unknown[]): Promise<unknown[]> {
    return this.inner.query(q, p);
  }
}

/**
 * http-Wrapper, der jeden fetch() gegen die resolvten Hosts prüft (defense in depth wie ScopedFsService —
 * NICHT nur gating-by-injection). Anders als db (dessen query() eine bereits gescopte Connection trifft)
 * adressiert ein einzelnes fetch(url) einen BELIEBIGEN Host, also muss die Host-Erlaubnis pro Call geprüft
 * werden. "*" in den Hosts = jeder Host erlaubt. Eine nicht-parsebare URL wird abgelehnt (kein stiller
 * Durchlass). Der Host-Vergleich ist case-insensitive auf `URL.hostname` (ohne Port).
 */
class ScopedHttpService implements HttpService {
  private readonly anyHost: boolean;
  private readonly hosts: Set<string>;

  constructor(
    private readonly inner: HttpService,
    hosts: string[],
  ) {
    this.anyHost = hosts.includes("*");
    this.hosts = new Set(hosts.map((h) => h.toLowerCase()));
  }

  fetch(url: string, init?: unknown): Promise<unknown> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return Promise.reject(new Error(`http.fetch denied for "${url}" (not a valid absolute URL)`));
    }
    if (!this.anyHost && !this.hosts.has(host)) {
      return Promise.reject(new Error(`http.fetch denied for "${host}" (out of scope)`));
    }
    return this.inner.fetch(url, init);
  }
}

/**
 * Normalisiert einen Pfad (kollabiert "..", ".", doppelte Separatoren) und prüft, ob er unter (oder
 * gleich) einem erlaubten Präfix liegt. Spiegelt die Backend-Schicht (SDK ScopedFsService.confine):
 * `resolve()` macht aus "/data/../etc/passwd" -> "/etc/passwd", das NICHT mehr unter "/data" liegt —
 * Path-Traversal/Escape ist damit auch in dieser (policy-bound, engeren) DI-Schicht abgelehnt
 * (Inv. 14/20, §11/#1). Ohne diese Normalisierung würde ein roher `startsWith`-Vergleich ein literal
 * "/data/../etc/passwd" akzeptieren, das auf OS-Ebene aus der Policy-Scope ausbricht.
 */
function underAny(path: string, prefixes: string[]): boolean {
  const abs = resolve(path);
  return prefixes.some((prefix) => {
    const root = resolve(prefix);
    if (abs === root) return true;
    const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
    return abs.startsWith(withSep);
  });
}

/**
 * Konservativer Default-Cloud-Detektor (genutzt, wenn der Injector keinen `isCloudModel` bekommt):
 * bekannte Cloud-Provider-Präfixe gelten als Cloud. Bewusst restriktiv (security by absence auf der
 * cloud-Achse): unbekannte IDs gelten als NICHT-Cloud (lokal), damit ein lokales/mock-Modell nie an
 * der cloud-Achse scheitert; alles, was klar nach einem Hyperscaler-Modell aussieht, ist Cloud und
 * fällt unter `allowCloud`.
 */
const CLOUD_MODEL_PREFIXES = [
  "claude",
  "anthropic",
  "gpt",
  "openai",
  "azure",
  "gemini",
  "google",
  "bedrock",
  "vertex",
  "cohere",
  "mistral-cloud",
];

/** Prädikat: Ob eine Modell-ID auf einen CLOUD-Provider zeigt (provider-Wissen aus dem SDK). */
export type CloudModelPredicate = (modelId: string) => boolean;

export function defaultIsCloudModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return CLOUD_MODEL_PREFIXES.some(
    (p) => id === p || id.startsWith(`${p}-`) || id.startsWith(`${p}/`) || id.startsWith(`${p}:`),
  );
}

/**
 * model-Wrapper, der JEDEN Call gegen die resolvte Policy prüft (defense in depth über die reine
 * gating-by-injection hinaus — analog zu ScopedFsService). Schließt zwei Lecks (Inv. 13/14):
 *  - model-Achse: ein explizit angefordertes `req.model`, das NICHT in `allowedModels` liegt, wird
 *    abgelehnt — auch wenn der dahinterliegende Worker einen Provider dafür registriert hat. So kann
 *    eine Node, die nur ein lokales Modell granted bekam, nicht via `complete({model:"claude"})` ein
 *    Cloud-Modell erreichen. Fehlt `req.model`, fällt der Worker auf SEIN Default-Modell — das ist
 *    erlaubt (die Policy hat die Node ja für Modelle freigegeben; das Default gehört zur erlaubten Menge,
 *    wenn der Betreiber das so verdrahtet — die Injektion erfolgte nur, weil allowedModels nichtleer ist).
 *  - cloud-Achse (Inv. 13): zeigt ein angefordertes Modell auf einen Cloud-Provider und ist
 *    `allowCloud` false, wird der Call abgelehnt — die `allowCloud`-Achse wird damit end-to-end
 *    durchgesetzt (vorher: resolved.allowCloud wurde berechnet, aber nie am Call-Pfad gelesen).
 */
class ScopedModelService implements ModelService {
  constructor(
    private readonly inner: ModelService,
    private readonly allowedModels: string[],
    private readonly allowCloud: boolean,
    private readonly isCloudModel: CloudModelPredicate,
  ) {}

  /** Liest eine optional gesetzte Modell-ID aus einem rohen Request (string | {prompt} | {messages,model}). */
  private requestedModel(req: unknown): string | undefined {
    if (typeof req === "object" && req !== null) {
      const m = (req as { model?: unknown }).model;
      if (typeof m === "string" && m.length > 0) return m;
    }
    return undefined;
  }

  /**
   * Prüft eine kanonische `provider:model`-Spec gegen die erlaubten Modelle. Unterstützt Wildcards:
   *  - "*"            -> jedes Modell erlaubt (eine vertrauenswürdige Runtime, z.B. ein lokaler CLI-Lauf);
   *  - "<provider>:*" -> jedes Modell DIESES Providers (z.B. "ollama:*") — ein Feature darf trotzdem
   *                      exakt pinnen ("ollama:llama3"); das Wildcard ist die runtime-seitige Freigabe.
   * Sonst exaktes Match. So pinnt das feature.yaml reproduzierbar, während die Runtime grob freigibt.
   */
  private modelAllowed(model: string): boolean {
    if (this.allowedModels.includes("*")) return true;
    if (this.allowedModels.includes(model)) return true;
    const ci = model.indexOf(":");
    if (ci > 0) {
      const provider = model.slice(0, ci);
      if (this.allowedModels.includes(`${provider}:*`)) return true;
    }
    return false;
  }

  /** Wirft, wenn das (explizit angeforderte) Modell außerhalb der Policy-Scope liegt (model/cloud). */
  private assertAllowed(req: unknown): void {
    const model = this.requestedModel(req);
    if (model === undefined) return; // kein explizites Modell -> Worker-Default (Injektion war erlaubt)
    if (!this.modelAllowed(model)) {
      throw new Error(
        `model "${model}" denied — not in policy-allowed models [${this.allowedModels.join(", ")}] ` +
          `(security by absence, Inv. 14).`,
      );
    }
    if (!this.allowCloud && this.isCloudModel(model)) {
      throw new Error(`model "${model}" denied — cloud usage not granted (allowCloud=false, Inv. 13).`);
    }
  }

  complete(req: unknown): Promise<{ text: string; cost: import("./common").Cost; confidence: number }> {
    try {
      this.assertAllowed(req);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return this.inner.complete(req);
  }

  stream(
    req: unknown,
  ): AsyncIterable<{ delta: string } | { done: { cost: import("./common").Cost; confidence: number } }> {
    // Synchroner Guard, der bei einem Verstoß einen sofort werfenden Iterator liefert (kein Provider-Call).
    this.assertAllowed(req);
    const inner = this.inner;
    if (inner.stream === undefined) {
      throw new Error("ScopedModelService: underlying ModelService does not support stream()");
    }
    return inner.stream(req);
  }
}

// ───────────────────────────── AgentService an einen Ctx + Engine gebunden (Inv. 17/18) ─────────────────────────────
/**
 * ctx.agent = der Inner-Loop-Pfad (Inv. 17). Der Injector bindet eine pluggable AgentEngine (Vela,
 * in-process, …) an GENAU das ctx, das er gerade baut, und exponiert sie als AgentService.session().
 * `session(contract)` ruft `engine.run(contract, ctx)` — die Engine erbt damit dasselbe gescopte ctx
 * (transparent: ihre Modellaufrufe fließen durch ctx.model -> volle Inv. 14). Das Restbudget reist im
 * SessionContract.budget/depth mit (nie frisch, Inv. 21) — die Engine, nicht der Wrapper, dekrementiert.
 */
class BoundAgentService implements AgentService {
  constructor(
    private readonly engine: AgentEngine,
    private readonly ctx: Ctx,
  ) {}

  session(contract: SessionContract): Promise<SessionResult> {
    return this.engine.run(contract, this.ctx);
  }
}

export interface PolicyInjectorDeps {
  /** Run Store (für künftige Service-Verdrahtung / Audit). Optional in Slice 1. */
  store?: RunStore;
  /**
   * Quelle hinter ctx.traces (Inv. 15). Default = `store` (RunStore erfüllt TapeSource strukturell). Nur
   * relevant, wenn die resolvte Policy einen "traces:*"-toolPermission trägt (security by absence).
   */
  tracesSource?: TapeSource;
  /**
   * Feature-Katalog hinter ctx.featureStore (Inv. 13/14) — die mutierende Capability (promote-candidate).
   * Nur injiziert, wenn die resolvte Policy einen "featurestore:write"-toolPermission trägt.
   */
  featureStore?: FeatureStoreService;
  /**
   * Skript-Runner hinter ctx.scripts (Tier-2, Inv. 20) — führt GENERIERTEN, untrusted Code isoliert aus.
   * Nur injiziert, wenn die resolvte Policy einen "scripts:execute"-toolPermission trägt (security by
   * absence). Bewusst NICHT der NodeSandbox-Seam (der wrappt jede Node); hier wird nur der untrusted
   * Funktions-Body isoliert — eine reine Funktion braucht kein ctx, daher der schmale, harte Boundary.
   */
  scriptRunner?: ScriptRunnerService;
  /** ModelService hinter ctx.model — nur injiziert, wenn resolved.allowedModels nichtleer. */
  model?: ModelService;
  /**
   * Cloud-Detektor (Inv. 13, cloud-Achse). Bestimmt, ob eine Modell-ID auf einen Cloud-Provider zeigt;
   * der ScopedModelService lehnt einen Cloud-Call ab, wenn resolved.allowCloud false ist. Provider-Wissen
   * lebt im SDK (welcher Adapter Cloud ist) und wird hier reingereicht. Fehlt es, greift ein konservativer
   * Default (bekannte Hyperscaler-Präfixe = Cloud; alles andere = lokal).
   */
  isCloudModel?: CloudModelPredicate;
  /**
   * AgentEngine hinter ctx.agent (Inv. 17) — der Inner-Loop-Pfad. Wie ctx.model gegated: nur
   * injiziert, wenn resolved.allowedModels nichtleer (eine Klasse-2-Node muss Modelle fordern, damit
   * sie überhaupt denken darf — die transparente Engine fließt durch ctx.model, Inv. 18) UND eine
   * Engine verdrahtet ist. Fehlt sie, fällt die agent-Node auf ihren in-process ctx.model-Loop zurück.
   */
  agentEngine?: AgentEngine;
  /** Budget-Tracker; CostService wird daran gebunden (Inv. 21). */
  budget?: BudgetTracker;
  /** Logger; ctx.logger wird injiziert, wenn vorhanden (cross-cutting, kein Step). */
  logger?: LoggerService;
  /** Optionaler Audit-Service (cross-cutting). */
  audit?: AuditService;
  /** Optionale konkrete fs/db/http-Backends; gescopt injiziert nur bei erlaubten Pfaden/Scopes/Hosts. */
  fs?: FsService;
  db?: DbService;
  http?: HttpService;
  /**
   * Secret-Provider hinter ctx.secrets (§11/#8). Wie fs/db gegated: ctx.secrets wird NUR injiziert,
   * wenn die resolvte Policy mindestens einen "secret:<name>"-toolPermission trägt (security by
   * absence). Die gescopte SecretsService-Sicht resolved nur die erlaubten Namen.
   */
  secretsProvider?: SecretsProvider;
  /**
   * Tape-Redactor (§11/#9). Wird er übergeben, registriert die gescopte SecretsService jeden
   * aufgelösten Geheimwert hier — der Runner reicht denselben Redactor in appendTape, sodass Werte
   * auto-redacted aus dem Loop Tape verschwinden.
   */
  redactor?: Redactor;
}

/**
 * Baut das gescopte ctx pro Node (Inv. 14). Welche Services am ctx hängen, entscheidet
 * allein `resolved = tighten(parent, node.requests)` — *security by absence*.
 */
export class PolicyInjector implements Injector {
  private readonly deps: PolicyInjectorDeps;

  constructor(deps: PolicyInjectorDeps = {}) {
    this.deps = deps;
  }

  /** Welche Service-Keys ein gegebenes ctx trägt (= was möglich war; Audit/Tape, Inv. 14). */
  static serviceKeys(ctx: Ctx): string[] {
    const keys: string[] = [];
    const candidates: (keyof Ctx)[] = [
      "model",
      "agent",
      "logger",
      "memory",
      "audit",
      "cost",
      "elicit",
      "fs",
      "db",
      "http",
      "secrets",
      "traces",
      "featureStore",
      "scripts",
    ];
    for (const k of candidates) {
      if (ctx[k] !== undefined) keys.push(k);
    }
    return keys;
  }

  buildCtx(
    node: NodeDefinition,
    parent: ResolvedPolicy,
    correlation: CorrelationId,
    artifact: Artifact,
    budget?: BudgetTracker,
  ): Ctx {
    const resolved = tighten(parent, node.requests);
    // Pflicht-Felder: immer present.
    const ctx: {
      correlation: CorrelationId;
      artifact: Artifact;
      policy: ResolvedPolicy;
      model?: ModelService;
      agent?: AgentService;
      logger?: LoggerService;
      memory?: MemoryService;
      audit?: AuditService;
      cost?: CostService;
      elicit?: ElicitService;
      fs?: FsService;
      db?: DbService;
      http?: HttpService;
      secrets?: SecretsService;
      traces?: TracesService;
      featureStore?: FeatureStoreService;
      scripts?: ScriptRunnerService;
    } = {
      correlation,
      artifact,
      policy: resolved,
    };
    // cross-cutting Services (kein Step, Inv. 5) — injiziert, wenn vom Injector bereitgestellt.
    if (this.deps.logger !== undefined) ctx.logger = this.deps.logger;
    if (this.deps.audit !== undefined) ctx.audit = this.deps.audit;
    // ctx.cost (Inv. 21): bevorzugt der per-Iteration Tracker des Runners (echtes Restbudget + Tiefe
    // dieses Branches), sonst der optionale Default-Tracker. Im Runner-Pfad wird eine node-lokale SICHT
    // (`budget.view()`) gebunden: sie liest das echte remaining()/depth()/maxDepth() (so erbt ein
    // delegierter agent-Call das echte Restbudget + die Tiefe, nie ein frisches Infinity), schreibt aber
    // ISOLIERT — der Runner bleibt die EINZIGE autoritative Budget-Senke (er bucht den zurückgegebenen
    // Resolved.cost einmal), sodass node-lokales ctx.cost.charge() das Budget nicht doppelt dekrementiert.
    if (budget !== undefined) {
      ctx.cost = new TrackerCostService(budget.view());
    } else if (this.deps.budget !== undefined) {
      ctx.cost = new TrackerCostService(this.deps.budget);
    }
    // elicit: immer verfügbar (Suspend/Resume nach oben, Inv. 11); Default-Mode = engste erlaubte.
    ctx.elicit = new DefaultElicitService(resolved.suspendMode);
    // model: NUR wenn allowedModels nichtleer UND ein ModelService vorhanden (Inv. 13/14). Der bare
    // Worker wird NICHT direkt angehängt, sondern in einen ScopedModelService gewrappt (analog
    // ScopedFsService/ScopedDbService): jeder Call wird gegen resolved.allowedModels + resolved.allowCloud
    // geprüft, sodass eine Node, die nur ein lokales Modell granted bekam, nicht via
    // complete({model:"claude"}) ein anderes/Cloud-Modell erreicht (security by absence end-to-end).
    if (resolved.allowedModels.length > 0 && this.deps.model !== undefined) {
      ctx.model = new ScopedModelService(
        this.deps.model,
        resolved.allowedModels,
        resolved.allowCloud,
        this.deps.isCloudModel ?? defaultIsCloudModel,
      );
    }
    // agent: NUR wenn allowedModels nichtleer UND eine AgentEngine verdrahtet ist (gleiches Gate wie
    // model — security by absence, Inv. 14). Die gebundene Engine schließt über das BISHER gebaute ctx
    // (inkl. ctx.model/ctx.cost/ctx.elicit), damit ein transparenter Inner Loop durch dieselben
    // gescopten Services fließt (Inv. 18). Wird ZULETZT angehängt, weil sie das ctx referenziert.
    if (resolved.allowedModels.length > 0 && this.deps.agentEngine !== undefined) {
      ctx.agent = new BoundAgentService(this.deps.agentEngine, ctx as Ctx);
    }
    // fs: NUR wenn resolved.fsPaths gesetzt (read/write nichtleer) — gescopter Wrapper.
    if (
      resolved.fsPaths !== undefined &&
      (resolved.fsPaths.read.length > 0 || resolved.fsPaths.write.length > 0) &&
      this.deps.fs !== undefined
    ) {
      ctx.fs = new ScopedFsService(this.deps.fs, resolved.fsPaths);
    }
    // db: NUR wenn resolved.dbScopes gesetzt & nichtleer.
    if (resolved.dbScopes !== undefined && resolved.dbScopes.length > 0 && this.deps.db !== undefined) {
      ctx.db = new ScopedDbService(this.deps.db, resolved.dbScopes);
    }
    // http: NUR wenn resolved.httpHosts gesetzt & nichtleer — gescopter Wrapper (per-Call Host-Check).
    if (resolved.httpHosts !== undefined && resolved.httpHosts.length > 0 && this.deps.http !== undefined) {
      ctx.http = new ScopedHttpService(this.deps.http, resolved.httpHosts);
    }
    // secrets: NUR wenn die resolvte Policy mindestens einen "secret:<name>"-toolPermission trägt
    // UND ein Provider verdrahtet ist (security by absence, §11/#8). Die gescopte Sicht resolved nur
    // die erlaubten Namen und registriert jeden aufgelösten Wert beim Redactor (auto-redacted, §11/#9).
    if (this.deps.secretsProvider !== undefined) {
      const secretNames = allowedSecretNames(resolved.toolPermissions);
      if (secretNames.length > 0) {
        ctx.secrets = new ScopedSecretsService(
          this.deps.secretsProvider,
          secretNames,
          this.deps.redactor,
        );
      }
    }
    // traces: NUR wenn die resolvte Policy mindestens einen "traces:*"-toolPermission trägt UND eine
    // Quelle verdrahtet ist (security by absence, Inv. 14 — analog secrets). Quelle = explizit
    // tracesSource oder der Run Store (erfüllt TapeSource strukturell). v0.1: read-all der getapten Runs
    // (Injektions-Level-Gating; feature-granulares Scoping aufgeschoben, s. ctx.TracesService-Doc).
    const tracesSource = this.deps.tracesSource ?? this.deps.store;
    const traceScopes = allowedTraceScopes(resolved.toolPermissions);
    if (tracesSource !== undefined && traceScopes.length > 0) {
      // Scope durchreichen (6b): "traces:read" → alle Features; "traces:<feature>" → nur diese.
      ctx.traces = new RunStoreTracesService(tracesSource, traceScope(traceScopes));
    }
    // featureStore: NUR wenn die resolvte Policy einen "featurestore:write"-toolPermission trägt UND ein
    // Katalog verdrahtet ist (security by absence, Inv. 14 — analog traces/secrets). Die einzige
    // mutierende Capability; trägt nur das promote-candidate-Feature den Grant.
    if (
      this.deps.featureStore !== undefined &&
      allowedFeatureStoreScopes(resolved.toolPermissions).length > 0
    ) {
      ctx.featureStore = this.deps.featureStore;
    }
    // scripts: NUR wenn die resolvte Policy einen "scripts:execute"-toolPermission trägt UND ein Runner
    // verdrahtet ist (security by absence, Inv. 14 — analog featurestore). Führt GENERIERTEN, untrusted
    // Code isoliert aus (Tier-2, Inv. 20); nur ein Feature mit dem Grant darf das.
    if (
      this.deps.scriptRunner !== undefined &&
      allowedScriptScopes(resolved.toolPermissions).length > 0
    ) {
      ctx.scripts = this.deps.scriptRunner;
    }
    return ctx as Ctx;
  }
}
