# ELIO — Enterprise Loop Intelligence Orchestrator · v0.1 Walking Skeleton

> **These (ein Absatz):** ELIO ist eine **artifact-centric Loop-Engine**, keine Workflow-Engine. Das **Artefakt** ist das durable Ziel (iterativ erweitert), **Context/Session** ist das Problem, **dynamische Loops** sind die Lösung. Ein Loop ist nicht fertig, wenn seine Steps abgearbeitet sind, sondern wenn das Artefakt *gut genug* ist (Eval-Gate). Der **Kern ist ein SDK** (Runner + policy-gescopter Injector + Node-Funktionen + `ctx`); die CLI ist nur ein Client. **Vela** ist der **Inner Loop** (intra-session: liefert Kontext zur richtigen Zeit *innerhalb* einer Session); **ELIO** ist der **Outer Loop** (inter-session: Loop über *mehrere* Agent-Sessions). Was die Session-Grenze kreuzt, ist immer das **Artefakt** — nicht das Transcript. Dieses Dokument löst das grobe Brainstorm-Basisdokument als konkretes v0.1-Skelett ab.

---

## 1. Architektur-Invarianten (das Rückgrat)

Diese nummerierten Leitplanken sind verbindlich. Alles in diesem Dokument leitet sich daraus ab.

1. **Artifact-centric, nicht workflow-centric.** Das Artefakt ist das Ziel: durable, iterativ erweitert, komprimierter State/Memory. Exit-Condition eines Loops = "Artefakt gut genug" (Eval-Gate), **nicht** "Steps fertig".
2. **SDK ist der Kern, CLI ist nur ein Client.** Runner + Injector + Node-Funktionen + `ctx` leben im SDK. CLI, künftige API, Cron, n8n, Agent — alle Clients teilen dieselbe Runtime, damit Policy/Logging/Routing/Cost nicht dupliziert oder umgangen werden.
3. **Vela = Inner Loop (intra-session), ELIO = Outer Loop (inter-session).** Boundary-Objekt = **Session Contract**: runter = `input + routing + memory-slice + budget`; hoch = `result` ODER `elicitation`. Die Memory-Grenze IST die Session-Grenze.
4. **Was die Session-Grenze kreuzt, ist das ARTEFAKT, nicht das Transcript.** Jede Session re-deriviert ihren Kontext aus dem Artefakt.
5. **Jede Node ist eine reine Funktion `(input, ctx) => NodeResult`.** Cross-cutting concerns (logging, memory, audit, cost) sind **keine** Steps, sondern injizierte Services am `ctx`. → Auditierbarkeit *by construction*, nicht opt-in.
6. **Step-Typen = registrierte Node-Funktionen über demselben `ctx`; built-in == custom.** Es gibt keine privilegierte Step-Klasse; ein Custom-Handler ist genauso eine Node wie `validate`.
7. **Zwei Node-Klassen.** (1) **Deterministische Orchestrierung** (`router`, `condition`, `approval`, `validate`, `file`/`db`, `transform`, `memory`, `http`) — voll von ELIO kontrolliert. (2) **Delegierte Intelligenz** (`llm` = one-shot, `agent` = Multi-Turn-Session, Vela optional). **"ELIO denkt nie"** — Denken passiert ausschließlich in Klasse (2).
8. **Drei Nesting-Mechanismen, sauber getrennt.** `subworkflow` = anderes Feature = nested Outer Loop (Rekursion); `agent` = Inner Loop (Prompt + Arbeitsauftrag, Vela optional); `llm` = single call.
9. **Autonomie-Dial = ein Master-Regler eines gekoppelten Spektrums** (Autonomie ↔ Determinismus ↔ static/dynamic ↔ Governance). Vela attached = statischer Graph / guided; kein Vela = dynamischer Planner / autonom; dazwischen ein Spektrum. **Der dynamische Planner ist selbst nur ein `agent`-Node**, der "nächster Step" statt "output" zurückgibt → "ELIO denkt nie" bleibt intakt; die deterministische Runtime führt nur aus. Dynamische Loops sind **kein** neuer Mechanismus.
10. **Node-Rückgabe-Contract: `resolved {output, confidence, cost}` ODER `suspended {elicitation: what / who-can-answer / schema}`.**
11. **Elicitation = universelles Suspend-Signal.** Approval / fehlender Input / Eskalation sind dasselbe Primitiv. Eine Elicitation propagiert den Loop-Stack **hoch**; jede Ebene kann auto-resolven (Policy oder Parent-State hat die Antwort) oder weiterreichen; Spitze der Kette = Mensch (Approval Inbox). **Policies sitzen als Interceptoren auf dem Propagierungspfad = Governance.**
12. **4 Suspend-Arten, EIN Resume-Mechanismus.** `blocking`, `parked` (async: checkpoint + continue siblings + resume), `timeout` (deadline → `fail` | `default` | `escalate`), `optional` (default-on-no-answer). Resume = **correlation-id** (`run + branch + step + checkpoint`) im Run Store; Antwort adressiert die id → rehydrate → resume. = Velas identity-based Resume hochskaliert; konzeptionell LangGraph interrupt + checkpoint.
13. **System-Invariante: "Author proposes, Policy disposes — Policy kann nur verschärfen (tighten), nie lockern (loosen)."** Gilt identisch für model-routing, suspend-mode, tool-permissions, cloud-usage, data-classification.
14. **Capability = policy-gescopte Dependency Injection.** Der Injector liest die Policy **pro Node** und baut das gescopte `ctx`. **KEIN** runtime permission-check — eine Node KANN nicht, was nicht injiziert wurde (object-capability security / *security by absence*). Audit = log was injiziert wurde = log was möglich war. **Governance IST Dependency Injection.**
15. **Loop Tape.** Zeichnet jeden Run auf (scrubben, zu Step N zurückspulen, Modell tauschen, vorwärts neu rechnen); ist zugleich **Eval-Quelle** ("promote run to eval case") und **Quelle des episodic memory** (am Session-Ende destilliert). Loops erzeugen Evals, Evals härten Loops.
16. **Governance = Zwei-Wege-Ventil am `ctx`.** Runter: policy-gescopte Injection (was eine Node KANN, Inv. 14). Hoch: Elicitation-Propagierung (was gefragt werden MUSS, Inv. 11).
17. **Zwei Injection-Punkte: `ctx.model` vs. `ctx.agent`.** `ctx.model` (`ModelService`) = rohes Completion über den LLM-Worker (Ollama, Azure-Foundry-Modelle, Anthropic-API, OpenAI). `ctx.agent` (`AgentEngine`) = ein *Inner Loop* (Vela, Claude Code, Copilot CLI, Foundry Agents). **Coding-CLIs sind keine Modelle — sie sind Agenten** und hängen am `agent`-Node, nicht am Worker.
18. **Inner-Loop-Engines sind transparent oder opak.** *Transparent* (Vela): Modellaufrufe fließen durch `ctx.model` → volle Inv. 14, per-Call-Audit/Cost. *Opak* (Claude Code/Copilot): Black Box (eigenes Modell/Tools/Loop) → Governance degradiert graceful auf die **Hülle** (cwd, injizierte Credentials/Scopes, Task-Prompt, Sandbox, Budget, Output-Gate). Per-Call-Governance wird bewusst gegen die Mächtigkeit eines fertigen Agenten getauscht.
19. **ELIO ist bidirektional — und genau das erzeugt Rekursion + maximale Loop-Flexibilität.** Richtung A: ELIO umschließt eine Coding-CLI als opaken `agent`-Node (Autonomie-Story). Richtung B: die Coding-CLI ruft ELIO via `@elio/mcp` (Adoptions-Keil; governte Insel in der opaken CLI). Beide auf derselben Engine. Erst im Zusammenspiel entsteht **Rekursion über die Mensch/Tool-Grenze** (B→A→B…) — und damit ist jeder Loop in Begriffen jedes anderen definierbar (Meta-Orchestrierung).
20. **Object-capability by sandbox.** Jede Node läuft isoliert (Worker/VM) **ohne Ambient Authority**; die einzige Außenverbindung ist das per Message-Passing/RPC übergebene `ctx`. `Node = (input, ctx) => NodeResult` ist serialisierungs-/RPC-fähig; es gibt keinen `require('fs')`-Bypass. Sandbox ist die *Durchsetzungsschicht* von Inv. 14 (security by absence), nicht nur DI-Konvention. *(siehe §11)*
21. **Budget + Tiefe sind Pflicht und propagieren über jede Grenze.** `budget` und `maxDepth` sind verpflichtender Teil jedes Session Contract und werden über JEDE Loop-/Session-/MCP-Grenze (inkl. Richtung B→A) **dekrementiert** — ein verschachtelter Call erbt das Restbudget, nie ein frisches. Erschöpfung → `suspend{elicitation}` an den Menschen ("mehr freigeben?"), kein hartes Sterben. Präzisiert Inv. 11/12. *(siehe §11)*
22. **Artefakt = Typ + pluggable Data-Holder; `re-derive` ist round-trip-testbar.** Ein `Artifact` hat einen `type` und komponiert ein oder mehrere Data-Holder (`memory` · `sidecar` · `progress.md` · `db-state` · erweiterbar); Rationale/"Warum" lebt in den vom Typ deklarierten Holdern. `re-derive(artifact)` liest den Stand aus den Holdern zurück; **serialize→re-derive→identisch** ist Pack-Invariante. Subsumiert Layered-Memory. Präzisiert Inv. 4. *(siehe §11)*
23. **Plattform liefert Mechanismus, Policy entscheidet.** Default ist permissiv + auditiert (warn + log + audit, kein Hard-Block); jede Node deklariert ihre Datenklasse, die Plattform erkennt & meldet an der Grenze. Policy kann nur **verschärfen** (tighten-only, Inv. 13) — bis zu Hard-Cap (`≤ internal`) oder Egress-Sandbox; der Betreiber trägt die Risikoentscheidung. Präzisiert Inv. 13/18. *(siehe §11)*

---

## 2. Paket-/Modul-Struktur

Konsistent mit der `@org/ai-runtime`-Idee des Basisdokuments, aber unter dem ELIO-Namen und mit dem **SDK als Kern** (Inv. 2).

| Paket | Rolle | Verantwortlichkeiten |
|-------|-------|----------------------|
| `@elio/core` | **Kern-Engine** | Runner / Outer Loop (State-Machine), Injector (policy-gescopte DI), `ctx`-Service-Contracts, Node-Registry (built-in == custom), `NodeResult`/Elicitation-Primitive, Run Store + Checkpoint + correlation-id, Loop Tape (record + scrub), Policy-Interceptor-Stack. **Kennt keine Fachlichkeit, nur Primitives.** |
| `@elio/sdk` | **TypeScript-SDK** | Public API über `@elio/core`: `run()`, `resume()`, Feature-Pack-Loader + Compiler (YAML → typisierte Definition), Node-Registrierung, Service-Implementierungen (model, memory, fs, db, …). Der primäre Einstieg für Programme. |
| `elio` (CLI) | **CLI-Client** | Dünner Client über `@elio/sdk`: `npx elio init`, `elio run`, `elio runs …`, `elio eval`, Approval Inbox als CLI-Prompt, Feature-Discovery → dynamische Commands. **Enthält keine Engine-Logik.** |
| `@elio/vela-adapter` | **Vela-Integration** | Bindet Vela als `agent`-Node-Engine (Inner Loop). Übersetzt Session Contract ↔ Vela-Workflow-Start/-Resume; mappt Velas identity-based Resume auf ELIOs correlation-id. Vela bleibt eigenständiges OSS. |
| `@elio/migrate` | **Dogfood-Vertikale** | Datenmigrations-Feature-Pack(s) + injizierte Source/Target-Adapter (CSV/DB) als Services. Erste reale Last für den Kern (siehe §8). |
| `@elio/studio` *(COULD)* | **Lokaler Studio-Client** | Read-mostly Client über `@elio/sdk`: Loop-Tape-Scrubber, **Live-Run-Status & Live-Updates** (abonniert den `RunEvent`-Stream via `RunStore.subscribe`/`liveStatus`), Approval Inbox (parked Elicitations). Start: `elio studio`. UI lebt NIE im SDK (Inv. 2); Schreibzugriff ausschließlich = Elicitations beantworten über den correlation-id-Resume-Pfad. |
| `@elio/mcp` | **MCP-Server-Surface** | Exponiert Feature-Packs/Loops als MCP-Tools & -Workflows (nutzt Velas MCP-Fundament). *Außen* MCP-Server (Claude Code = MCP-Client), *intern* ein Client von `@elio/sdk` — Peer zu CLI & Studio. Eintrittsrichtung B (Inv. 19): die Coding-CLI ruft governte ELIO-Loops on demand. |
| `@elio/server` *(COULD)* | HTTP-API | Später; teilt dieselbe Runtime; hostet u. a. den Event-Stream-Endpoint für entfernte Studios. |

**Abhängigkeitsrichtung:** `elio`, `@elio/studio` und `@elio/mcp` → `@elio/sdk` → `@elio/core`. `@elio/vela-adapter` und `@elio/migrate` registrieren Nodes/Services am `@elio/sdk`. Niemand greift unter `@elio/sdk` hindurch direkt in den Kern — so bleibt Inv. 2 erhalten. **`@elio/studio` ist ein reiner Client** (kein Engine-Code): es konsumiert `RunStore.subscribe`/`liveStatus` (live) + `tape` (fertige Runs) über einen schlanken lokalen Push-Endpoint (SSE/WebSocket; v0.1 minimal in `@elio/studio`, später `@elio/server`) und schreibt nur via Elicitation-Antworten auf dem correlation-id-Resume-Pfad zurück.

---

## 3. Kern-Typen / TypeScript-Interface-Skelett

Kompilierbare Stubs (keine Implementierung). Baut auf den Interface-Stubs des Basisdokuments auf, angepasst an die Session-Entscheidungen: **Node = reine Funktion** (Inv. 5), **`NodeResult`-Union** (Inv. 10), **policy-gescopter `ctx`** (Inv. 14).

```ts
// ───────────────────────────── Node = reine Funktion (Inv. 5) ─────────────────────────────
export type Node<I = unknown, O = unknown> = (input: I, ctx: Ctx) => Promise<NodeResult<O>>;

/** Eine registrierte Node-Definition. built-in == custom (Inv. 6). */
export interface NodeDefinition<I = unknown, O = unknown> {
  type: string;                 // "router" | "validate" | "llm" | "agent" | "@org/foo#bar" ...
  klass: "orchestration" | "intelligence"; // Inv. 7
  handler: Node<I, O>;
  /** Welche ctx-Capabilities diese Node *anfordert*. Die Policy verschärft (Inv. 13/14). */
  requests?: CapabilityRequest;
  /** Per-Node Retry-Policy für den Failed-Pfad (§11/#7). Feature kann überschreiben. */
  retry?: RetryPolicy;
}

// ───────────────────────────── Node-Rückgabe-Contract (Inv. 10, +Failed §11/#7) ─────────────────────────────
export type NodeResult<O = unknown> = Resolved<O> | Suspended | Failed;

export interface Resolved<O = unknown> {
  status: "resolved";
  output: O;
  confidence: number; // 0..1
  cost: Cost;
}

export interface Suspended {
  status: "suspended";
  elicitation: Elicitation;
}

/** Fehlerpfad (§11/#7). Runner entscheidet via RetryPolicy: retry | Eskalation (Elicitation) | Dead-Letter. */
export interface Failed {
  status: "failed";
  error: { message: string; code?: string };
  retryable: boolean;
  attempts: number;
}

/** Per-Node/Feature deklarierte Retry-Policy (§11/#7). */
export interface RetryPolicy {
  maxAttempts: number;
  backoff?: "none" | "fixed" | "exponential";
  baseDelayMs?: number;
  /** nach Erschöpfung: als Elicitation eskalieren (Inv. 11) ODER hart fehlschlagen. */
  onExhausted: "escalate" | "fail";
}

export interface Cost {
  usd?: number;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
}

// ───────────────────────────── Elicitation = universelles Suspend-Signal (Inv. 11) ─────────────────────────────
export interface Elicitation {
  what: string;                       // was wird gebraucht / wofür Freigabe
  whoCanAnswer: Answerer;             // role | user | policy | parent-state
  schema?: JsonSchema;                // erwartete Form der Antwort
  mode: SuspendMode;                  // Inv. 12
  /** Optional: Default, falls mode = optional / timeout-default. */
  default?: unknown;
  deadline?: string;                  // ISO; nur für mode = timeout
  onTimeout?: "fail" | "default" | "escalate";
}

export interface Answerer {
  roles?: string[];
  users?: string[];
  /** Reine Maschinen-Antwort: Policy oder Parent-State kann auto-resolven. */
  machine?: boolean;
}

export type SuspendMode = "blocking" | "parked" | "timeout" | "optional"; // Inv. 12

// ───────────────────────────── Resume via correlation-id (Inv. 12) ─────────────────────────────
export interface CorrelationId {
  run: string;
  branch: string;
  step: string;
  checkpoint: string;
}

export interface Checkpoint {
  id: string;                 // = CorrelationId.checkpoint
  correlation: CorrelationId;
  /** Rehydrierbarer, komprimierter State (Artefakt-Referenz + Branch-lokaler State). */
  state: SerializedState;
  artifactRef: ArtifactRef;   // was die Session-Grenze kreuzt (Inv. 4)
  /** Gepinnte Pack-Version (content-hash); Resume gegen geänderten Pack → reject/Migration (§11/#14). */
  packVersion: string;
  pendingElicitation?: Elicitation;
  createdAt: string;
}

export interface RunStore {
  createRun(input: RunInput): Promise<RunRecord>;
  saveCheckpoint(cp: Checkpoint): Promise<void>;
  loadCheckpoint(id: CorrelationId): Promise<Checkpoint | null>;
  /** Antwort adressiert die correlation-id -> rehydrate -> resume. */
  resolveElicitation(id: CorrelationId, answer: unknown): Promise<void>;
  appendTape(run: string, frame: TapeFrame): Promise<void>;
  tape(run: string): AsyncIterable<TapeFrame>;                       // persistiert (fertige Runs)
  /** Live-Stream laufender Runs — speist Studio-Live-Status & Live-Updates (gleiche Events wie das Tape). */
  subscribe(filter?: { run?: string; active?: boolean }): AsyncIterable<RunEvent>;
  /** Momentaufnahme: welche Runs/Branches laufen, worauf warten sie. */
  liveStatus(): Promise<RunStatus[]>;
}

// ───────────────────────────── Loop Tape (Inv. 15) ─────────────────────────────
export interface TapeFrame {
  correlation: CorrelationId;
  nodeType: string;
  input: unknown;             // roh nur bis zur konfigurierten Datenklasse; darüber Hash/Ref/redacted (§11/#9)
  result: NodeResult;
  injected: string[];         // welche Capabilities injiziert waren = was möglich war (Audit, Inv. 14)
  /** Redaction-Projektion: über der Schwelle stehen hier Hashes/Refs statt Roh-Nutzdaten (§11/#9). */
  redaction?: { level: ResolvedPolicy["dataClassification"]; redactedFields: string[] };
  ts: string;
}

// ───────────────────────────── Artefakt: kreuzt die Session-Grenze (Inv. 1/4) ─────────────────────────────
export interface ArtifactRef { id: string; version: number; kind: string; }

export interface Artifact<T = unknown> {
  ref: ArtifactRef;
  /** Deklarierter Typ; bestimmt die komponierten Data-Holder (Inv. 22, §11/#5). */
  type: ArtifactType;
  /** Komprimierter State/Memory; jede Session re-deriviert Kontext hieraus. */
  content: T;
  /** Pluggable Data-Holder, in denen Stand + Rationale/"Warum" leben (Inv. 22). */
  holders: Record<string, DataHolder>;
  /** Eval-Gate: ist das Artefakt "gut genug"? (Inv. 1) */
  evalState?: { score?: number; passed?: boolean; gate: string };
}

// ───────────────────────────── Artefakt-Typ + pluggable Data-Holder (Inv. 22, §11/#5/#6) ─────────────────────────────
/** Ein Artefakt-Typ deklariert, welche Holder er komponiert. Erweiterbar. */
export interface ArtifactType {
  kind: string;                                  // = ArtifactRef.kind
  holders: DataHolderKind[];                     // z.B. ["db-state", "sidecar", "progress.md", "memory"]
}

export type DataHolderKind = "memory" | "sidecar" | "progress.md" | "db-state" | string;

/**
 * Ein Holder trägt einen Teil des Stands/Rationale. Jeder deklariert seine
 * Concurrency-Strategie (Inv. 22, §11/#6) — löst Inv. 12 ↔ Inv. 1/4.
 */
export interface DataHolder<S = unknown> {
  kind: DataHolderKind;
  /** Round-Trip-fähig: serialize→re-derive→identisch (Pack-Invariante, Inv. 22). */
  read(): Promise<S>;
  write(s: S): Promise<void>;
  version(): Promise<number>;
  concurrency: "transactional" | "disjoint-key" | "single-writer" | "append-only";
}

// ───────────────────────────── Eval-Gate als Node-Verdikt (Inv. 1/6, §11/#4) ─────────────────────────────
/** Dünnes Verdikt, das der Runner liest. Erzeugt von validate-/judge-/hybrid-Node — kein Sonder-Primitiv. */
export interface GateVerdict {
  passed: boolean;
  score?: number;
  failures: string[];
}

// ───────────────────────────── Planner-Output-Contract (Inv. 9, §11/#10) ─────────────────────────────
/** Validiert gegen Step-Whitelist + maxDepth; rationale ist Pflicht im Tape. */
export interface PlanDecision {
  nextStep: StepRef | "DONE";
  rationale: string;                              // Pflichtfeld im Tape
}

// ───────────────────────────── ctx: injizierte, policy-gescopte Services (Inv. 5/14) ─────────────────────────────
/**
 * Jeder Service ist optional: Was nicht injiziert wurde, KANN die Node nicht (security by absence).
 * Es gibt KEINEN runtime permission-check.
 */
export interface Ctx {
  readonly correlation: CorrelationId;
  readonly artifact: Artifact;          // immer present: das Ziel

  // delegierte Intelligenz (Inv. 7, Klasse 2) — gescopt auf erlaubte Modelle (Inv. 13)
  readonly model?: ModelService;
  readonly agent?: AgentService;        // Vela optional als Inner Loop (Inv. 8)

  // cross-cutting, NIE als Step (Inv. 5)
  readonly logger?: LoggerService;
  readonly memory?: MemoryService;      // gescopt auf erlaubten memory-slice (Inv. 3)
  readonly audit?: AuditService;
  readonly cost?: CostService;          // gescopt auf Budget (Inv. 3)

  // Suspend/Resume nach oben (Inv. 11)
  readonly elicit?: ElicitService;

  // side-effecting capabilities — nur wenn Policy sie injiziert (Inv. 14)
  readonly fs?: FsService;              // gescopt auf erlaubte Pfade
  readonly db?: DbService;              // gescopt auf erlaubte Connections/Tabellen
  readonly http?: HttpService;
  readonly secrets?: SecretsService;    // policy-gescopte Secret-Handles (§11/#8); NIE inline, auto-redacted

  // read-only Sicht der für diese Node geltenden Policy (Inv. 13)
  readonly policy: ResolvedPolicy;
}

export interface ElicitService {
  /** Erzeugt ein Suspended-Result; der Runner propagiert es hoch. */
  raise(e: Omit<Elicitation, "mode"> & { mode?: SuspendMode }): Suspended;
}

// ───────────────────────────── Policy: tighten-only (Inv. 13) ─────────────────────────────
export interface Policy {
  id: string;
  /**
   * Interceptor auf dem Injection-Pfad (runter) und dem Elicitation-Pfad (hoch).
   * Vertrag: darf NUR verschärfen. Eine Policy kann eine angeforderte Capability
   * entziehen/einschränken, niemals eine nicht-angeforderte hinzufügen.
   */
  scope(req: CapabilityRequest, parent: ResolvedPolicy): ResolvedPolicy;
  /** Kann eine hochpropagierende Elicitation auto-resolven (Inv. 11). */
  intercept?(e: Elicitation, ctxState: unknown): { resolved: true; answer: unknown } | { resolved: false };
}

export interface ResolvedPolicy {
  allowedModels: string[];
  allowCloud: boolean;
  dataClassification: "public" | "internal" | "confidential" | "private" | "regulated";
  maxCostUsd?: number;
  suspendMode: SuspendMode;        // engste erlaubte Suspend-Art
  fsPaths?: { read: string[]; write: string[] };
  dbScopes?: string[];
  toolPermissions: string[];
}

export interface CapabilityRequest {
  models?: string[];
  cloud?: boolean;
  fs?: { read?: string[]; write?: string[] };
  db?: string[];
  http?: boolean;
  tools?: string[];
}

// ───────────────────────────── Injector: liest Policy PRO Node (Inv. 14) ─────────────────────────────
export interface Injector {
  /**
   * Baut das gescopte ctx für genau diese Node:
   *  resolved = tighten(parentPolicy, node.requests)   // Inv. 13
   *  ctx      = nur die Services, die `resolved` erlaubt  // Inv. 14: security by absence
   */
  buildCtx(node: NodeDefinition, parent: ResolvedPolicy, correlation: CorrelationId, artifact: Artifact): Ctx;
}

// ───────────────────────────── Feature Pack / Definition ─────────────────────────────
export interface FeaturePack {
  apiVersion: "elio/v1";
  kind: "Feature";
  metadata: { id: string; version: string; owner?: string; lifecycle?: string };
  /** content-hash über Pack + content-addressed Prompts → reproduzierbare Evals + Resume-Pinning (§11/#14). */
  contentHash?: string;
  feature: FeatureDefinition;
}

export interface FeatureDefinition {
  /** Wo das Feature auf dem Autonomie-Dial liegt (Inv. 9). */
  autonomy: "static" | "guided" | "dynamic";
  /** Statischer Graph (autonomy=static/guided) ODER Planner-Node (autonomy=dynamic). */
  graph?: GraphDefinition;
  planner?: { node: string };           // ein agent-Node, der "nächster Step" zurückgibt (Inv. 9)
  artifact: { kind: string; evalGate: string };  // Exit-Condition = Artefakt gut genug (Inv. 1)
  policies?: string[];
  io: { input: JsonSchema; output: JsonSchema };
}

export interface GraphDefinition {
  state?: Record<string, unknown>;
  steps: StepRef[];                     // jede StepRef referenziert eine registrierte NodeDefinition (Inv. 6)
  edges: { from: string; to: string; when?: string }[];
}

export interface StepRef {
  id: string;
  type: string;                         // built-in == custom (Inv. 6)
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  suspend?: SuspendMode;
  when?: string;
}

// ───────────────────────────── Runner / Outer Loop ─────────────────────────────
export interface Runner {
  /** Outer Loop über mehrere Sessions; konvergiert gegen das Eval-Gate des Artefakts (Inv. 1). */
  run(pack: FeaturePack, input: RunInput): AsyncIterable<RunEvent>;
  /** Resume via correlation-id + Antwort (Inv. 12). */
  resume(id: CorrelationId, answer: unknown): AsyncIterable<RunEvent>;
}

// Typ-Platzhalter (in @elio/core konkretisiert)
export type JsonSchema = object;
export type SerializedState = unknown;
export interface RunInput {
  artifact?: ArtifactRef;
  payload: unknown;
  budget: number;    // PFLICHT (Inv. 21) — propagiert + dekrementiert über jede Grenze
  maxDepth: number;  // PFLICHT (Inv. 21) — Rekursions-Stopp; gegen Step-Whitelist validiert (§11/#10)
}
export interface RunRecord { id: string; }
export interface RunStatus {
  correlation: CorrelationId; feature: string; phase: "running" | "suspended" | "done";
  step?: string; waitingOn?: Elicitation;     // suspended -> genau das zeigt die Approval Inbox
  cost: Cost; artifact?: ArtifactRef;
}
/** Pro Schritt emittiert. Persistiert = Loop Tape; live abonniert = Live-Status — derselbe Stream (Inv. 15). */
export type RunEvent =
  | { type: "run-started";          correlation: CorrelationId; feature: string }
  | { type: "step-started";         correlation: CorrelationId; nodeType: string }
  | { type: "node-resolved";        correlation: CorrelationId; confidence?: number; cost?: Cost }
  | { type: "node-suspended";       correlation: CorrelationId; elicitation: Elicitation; mode: SuspendMode }
  | { type: "elicitation-resolved"; correlation: CorrelationId; by: "policy" | "parent" | "human" }
  | { type: "artifact-updated";     correlation: CorrelationId; artifact: ArtifactRef }
  | { type: "cost-delta";           correlation: CorrelationId; delta: Cost; total: Cost }
  | { type: "run-completed";        correlation: CorrelationId; artifact: ArtifactRef; gate: "passed" | "stopped" };
// ctx.model = roher Completion-Pfad; dahinter der LLM-Worker (concurrency-gated, pro Provider). Inv. 17.
export interface ModelService {
  complete(req: unknown): Promise<{ text: string; cost: Cost; confidence: number }>;
  /** Streaming speist RunEvents → Studio-Live-Status (Inv. 15). */
  stream?(req: unknown): AsyncIterable<{ delta: string } | { done: { cost: Cost; confidence: number } }>;
}

// ctx.agent = Inner-Loop-Pfad. Pluggable Engine: Vela, Claude Code, Copilot CLI, Foundry Agents (Inv. 17/18).
export interface AgentService { session(contract: SessionContract): Promise<SessionResult>; } // typisiert (Inv. 3, §11/#12)
export interface AgentEngine {
  readonly id: string;                            // "vela" | "claude-code" | "copilot-cli" | …
  readonly governance: "transparent" | "opaque";  // transparent: Calls durch ctx.model (Inv. 14)
                                                   // opaque: nur Hüllen-Governance (cwd/creds/prompt/sandbox/budget/gate)
  run(contract: SessionContract, ctx: Ctx): Promise<SessionResult>;  // erbt Restbudget, nie frisch (Inv. 21)
}
export interface MemoryService { slice(): Promise<unknown>; write(x: unknown): Promise<void>; }
export interface LoggerService { log(x: unknown): void; }
export interface AuditService { record(x: unknown): void; }
export interface CostService { charge(c: Cost): void; remaining(): number; }
export interface FsService { read(p: string): Promise<string>; write(p: string, c: string): Promise<void>; }
export interface DbService { query(q: string, p?: unknown[]): Promise<unknown[]>; }
export interface HttpService { fetch(url: string, init?: unknown): Promise<unknown>; }

// ───────────────────────────── Secrets: policy-gescopte Handles (§11/#8) ─────────────────────────────
/** Referenziert ein Secret per Name — NIE inline. Auflösung erst im (gesandboxten) Injector. */
export interface SecretRef { name: string; }
/**
 * Löst SecretRefs über pluggable Provider (env/Vault). Nur policy-erlaubte Namen sind sichtbar
 * (security by absence). Werte werden auto-redacted aus dem Loop Tape (§11/#9).
 */
export interface SecretsService {
  resolve(ref: SecretRef): Promise<string>;
  has(name: string): boolean;
}

// ───────────────────────────── Session Contract = Boundary-Objekt (Inv. 3, §11/#12) ─────────────────────────────
/** Typisiert die Session-Grenze; ersetzt `unknown` an AgentService.session / AgentEngine.run. */
export interface SessionContract {
  // runter
  input: unknown;
  routing?: { models?: string[]; agentEngine?: string };
  memorySlice?: unknown;
  budget: number;                       // PFLICHT, propagiert + dekrementiert (Inv. 21)
  depth: number;                        // aktuelle Tiefe; gegen maxDepth geprüft (Inv. 21)
}
/** hoch: Ergebnis ODER Elicitation. */
export type SessionResult = { result: NodeResult } | { elicitation: Elicitation };
```

---

## 4. Der Runner-Loop (Outer Loop)

Orientiert an der "Runner-Schleife" des Basisdokuments, erweitert um Artefakt-Re-Derivation, per-Node-Injection (gesandboxt, Inv. 20), `NodeResult`-Prüfung inkl. `Failed`-Pfad + Retry (§11/#7), Budget/Tiefe-Dekrement mit Elicitation bei Erschöpfung (Inv. 21), Elicitation-Propagierung + Checkpoint, node-basiertes Eval-Gate (`GateVerdict`) + Stagnations-Detektor und Step-Auswahl via statischem Graph ODER Planner-Agent-Node (`PlanDecision`, gegen Step-Whitelist validiert).

```text
run(pack, input):
  1. artifact = loadOrCreate(input.artifact, pack.feature.artifact.kind)
  2. policyRoot = resolvePolicies(pack.feature.policies)          // tighten-only (Inv. 13)
  3. run = RunStore.createRun(input)
  4. branchState = re-derive(artifact)                            // Kontext aus Artefakt, nicht Transcript (Inv. 4)

  loop (Outer Loop, bis Eval-Gate erfüllt):                       // Inv. 1
    4a. if (budget exhausted || depth >= input.maxDepth):         // Pflicht + propagiert (Inv. 21, §11/#3)
          raise suspend{elicitation:"mehr Budget/Tiefe freigeben?"} -> goto 11   // nicht hart sterben

    5. plan =
         feature.autonomy == "dynamic"
           ? runPlannerNode(pack.planner, branchState)            // PlanDecision{nextStep|"DONE", rationale} (Inv. 9, §11/#10)
           : { nextStep: nextEdge(pack.graph, lastStep, branchState) }  // statischer Graph
       assert plan.nextStep in stepWhitelist(pack) && depth <= maxDepth   // Planner kann Caps nicht erweitern (§11/#10)
       nextStep = plan.nextStep
       if (nextStep == DONE) break

    6. node = Registry.resolve(nextStep.type)                     // built-in == custom (Inv. 6)
    7. ctx  = Injector.buildCtx(node, policyRoot, correlation(run, branch, step), artifact)  // Inv. 14 (gesandboxt, Inv. 20)
                                                                  // = nur erlaubte Services; security by absence
    8. result = await tryWithRetry(node):                         // §11/#7
          attempt:  return await node.handler(resolveInput(nextStep, branchState), ctx)   // reine Funktion (Inv. 5)
          on throw / Failed{retryable}: backoff & retry bis node.retry.maxAttempts

    9. Tape.append({ correlation, nodeType, input, result, injected: ctx.serviceKeys,
                     redaction: redact(input, policyRoot.dataClassification) })   // Inv. 15 + Audit + Redaction (§11/#9)

    9b. budget.decrement(result.cost); depth = childDepth         // dekrementiert über jede Grenze (Inv. 21)

    10. if (result.status == "resolved"):
          branchState = merge(branchState, nextStep.outputs, result.output)
          cost.charge(result.cost)
          artifact = applyTo(artifact, result.output)            // Artefakt wächst (Inv. 1)
          continue

    10b. if (result.status == "failed"):                          // §11/#7
          if (node.retry.onExhausted == "escalate"):
            raise suspend{elicitation:"Node failed — retry/skip/abbrechen?"} -> goto 11
          else: writeDeadLetter(RunStore, correlation, result); halt branch

    11. if (result.status == "suspended"):                       // Elicitation hoch (Inv. 11/12)
          cp = Checkpoint(correlation, branchState, artifact.ref, result.elicitation)
          RunStore.saveCheckpoint(cp)
          propagate(result.elicitation):
            for policy in policyStack (von innen nach außen):    // Interceptoren = Governance (Inv. 11)
              if policy.intercept(e) resolves -> resume(correlation, answer); break
            else if parentState has answer  -> resume(...)        // auto-resolve
            else by mode:                                         // Inv. 12
              blocking -> halt branch, warte auf Antwort an correlation-id
              parked   -> checkpoint, continue siblings, später resume
              timeout  -> deadline -> fail | default | escalate
              optional -> wende default an -> continue
          // Spitze der Kette = Mensch (Approval Inbox / CLI-Prompt)

    12. Eval-Gate: verdict: GateVerdict = runGateNode(pack.feature.artifact.evalGate, artifact)  // node-basiert (Inv. 1/6, §11/#4)
        if (verdict.passed) break
        // Stagnations-Detektor (§11/#4): Score-Delta < ε über N Iterationen → Eskalation
        if (scoreDelta(verdict.score, history) < EPS for N iters):
          raise suspend{elicitation:"Konvergenz stagniert — eingreifen?"} -> goto 11

  13. atSessionEnd: distill(Tape) -> episodic memory                          // Inv. 15
  14. return artifact (kreuzt die Session-Grenze; Transcript bleibt zurück)   // Inv. 4

resume(correlationId, answer):
  cp = RunStore.loadCheckpoint(correlationId)        // rehydrate (Inv. 12)
  branchState = rehydrate(cp.state, cp.artifactRef)
  feed(answer into cp.pendingElicitation) -> weiter ab loop bei Schritt 5
```

---

## 5. Static vs. Dynamic, gekoppelt an den Autonomie-Dial

Ein Feature deklariert **eine** Position auf dem gekoppelten Spektrum (Inv. 9). Der Dial koppelt vier Achsen, die nicht unabhängig gewählt werden — ein Regler bewegt alle.

| Achse | links (statisch) | rechts (dynamisch) |
|-------|------------------|--------------------|
| Autonomie | guided, eng | selbststeuernd |
| Determinismus | hoch | niedrig |
| Graph | fix deklariert (`graph.steps/edges`) | zur Laufzeit vom Planner erzeugt |
| Governance | maximal (jeder Step deklariert) | über `ctx`-Scoping + Elicitation gehalten |

```yaml
# Variante A — statisch / guided: Vela attached, fixer Graph
feature:
  autonomy: static          # oder: guided
  graph:
    steps: [ ... ]          # deterministisch, voll deklariert
    edges: [ ... ]

# Variante B — dynamisch / autonom: kein fixer Graph, Planner-Agent-Node
feature:
  autonomy: dynamic
  planner:
    node: agent             # ein agent-Node OHNE Vela, gibt "nächster Step" statt "output" zurück (Inv. 9)
  # -> "ELIO denkt nie": die Runtime führt nur aus, was der Planner zurückgibt
```

Schlüssel-Punkt: **Variante B fügt keinen neuen Mechanismus hinzu.** Der Planner ist eine ganz normale `agent`-Node der Klasse "delegierte Intelligenz" (Inv. 7); ihr Output ist ein Step-Deskriptor statt eines Ergebnisses. Damit bleibt der deterministische Runner-Kern identisch — er bekommt seinen "nächsten Step" lediglich aus einer anderen Quelle (Graph-Edge vs. Planner-Output). "Vela attachen" = die Freiheit eines `agent`-Nodes constrainen = den Dial nach links drehen.

---

## 6. Elicitation-Propagierung + Suspend/Resume

**Ein Primitiv, vier Modi, ein Resume-Weg.** Approval, fehlender Input und Eskalation sind *dieselbe* Elicitation (Inv. 11).

**Propagierungspfad (hoch):**

```text
Node raises Suspended{elicitation}
        │
        ▼
Policy-Interceptor-Stack  (innen → außen)         ← Governance sitzt HIER (Inv. 11)
   jede Ebene:  policy.intercept(e)?  -> auto-resolve & resume
                parentState hat Antwort? -> auto-resolve & resume
                sonst: weiterreichen
        │
        ▼
Spitze der Kette = Mensch  ->  Approval Inbox (v0.1: CLI-Prompt)
```

**Die 4 Suspend-Arten (alle teilen den correlation-id-Resume, Inv. 12):**

| Modus | Verhalten | Resume-Trigger |
|-------|-----------|----------------|
| `blocking` | Branch hält an, wartet | Antwort an correlation-id |
| `parked` | Checkpoint, Geschwister-Branches laufen weiter (async) | spätere Antwort an correlation-id |
| `timeout` | Deadline; danach `fail` \| `default` \| `escalate` | Antwort *oder* Deadline-Ablauf |
| `optional` | wendet `default` sofort an, läuft weiter | (keiner nötig; Antwort optional) |

**correlation-id = `run + branch + step + checkpoint`.** Antwort adressiert die id → `loadCheckpoint` → `rehydrate` → resume. Das ist Velas identity-based Resume hochskaliert und konzeptionell identisch zu LangGraph interrupt + checkpoint. **tighten-only (Inv. 13):** Ein Author darf z. B. `optional` vorschlagen; eine Policy darf das zu `blocking` verschärfen, aber niemals ein `blocking` zu `optional` lockern.

---

## 7. Migrations-Vertikale als Dogfood

Erste reale Vertikale (Inv.-Beweis): **Datenmigrations-Skripte**. Persona = Solo-Entwickler, `npx elio init`. **Das Migrationsskript IST das Artefakt** (Inv. 1); es konvergiert, wenn das Sample sauber durchläuft (Eval-Gate). First-5-min: `init` → "was migrierst du?" → Quelle (CSV/DB) + Ziel-Schema → sample N Zeilen → `agent`-Step schlägt Mapping/Transform vor → läuft auf Sample → per-record Loop Tape → scrubben / fixen / re-run.

**Verzeichnisbaum eines Migrations-Feature-Packs:**

```text
features/
  migrate.csv-to-db/
    feature.yaml
    prompts/
      mapping.system.md          # mapping-agent (Vela optional)
      mapping.user.md
    schemas/
      target.schema.json         # Ziel-Schema
      mapping.schema.json
    adapters/
      source.csv.ts              # injizierter Service (fs), NICHT als Step
      target.db.ts               # injizierter Service (db), side-effect-gescopt
    evals/
      from-fixed-bugs.yaml        # gefixter Bug -> eval-case (Inv. 15)
    README.md
```

**Beispiel `feature.yaml`** (Stil des Basisdokuments, erweitert um per-record-Loop, sample-first, dry-run/commit-Gate):

```yaml
apiVersion: elio/v1
kind: Feature
metadata:
  id: migrate.csv-to-db
  version: 0.1.0
  owner: solo-dev
  lifecycle: draft

feature:
  autonomy: guided               # Mapping-Agent guided; Runtime deterministisch (Inv. 9)
  artifact:
    kind: migration-script       # das Skript IST das Artefakt (Inv. 1)
    evalGate: sample_passes      # Exit-Condition: Sample läuft sauber durch

  io:
    input:  { type: object, properties: { source: {}, targetSchema: {} } }
    output: { $ref: ./schemas/target.schema.json }

  policies:
    - no_cloud_for_private_data  # tighten-only (Inv. 13)
    - commit_requires_approval   # side-effect-Gate

  graph:
    state: { sampleRows: [], mapping: null, records: [] }
    steps:
      - id: read_source           # injizierter fs/db-Service, kein Denken
        type: file_read
        with: { adapter: ./adapters/source.csv.ts }
        outputs: { rows: state.sampleRows }

      - id: sample                # sample-first statt Blind-Run
        type: transform
        with: { take: 20 }
        outputs: { rows: state.sampleRows }

      - id: propose_mapping       # Klasse 2: delegierte Intelligenz (Vela optional)
        type: agent
        with:
          prompt: { system: ./prompts/mapping.system.md, user: ./prompts/mapping.user.md }
          vela: optional
        outputs: { mapping: state.mapping }
        # liefert resolved{output,confidence,cost} ODER suspended{elicitation} (Inv. 10)

      - id: run_on_sample         # per-record Loop; jede Zeile = eigene correlation-id
        type: subworkflow         # per-record = nested Outer Loop (Rekursion, Inv. 8)
        with:
          forEach: state.sampleRows
          correlationKey: record.id   # per-record correlation-id = Resume/Idempotenz
          # -> nur fehlgeschlagene/neue Zeilen werden re-gerunnt
          steps:
            - id: transform_record
              type: transform
              with: { mapping: "{{state.mapping}}" }
            - id: validate_record   # validation-gate
              type: validate
              with: { schema: ./schemas/target.schema.json }

      - id: dry_run               # dry-run zuerst, kein Prod-Write
        type: transform
        with: { mode: dry-run }

      - id: commit                # side-effect-Approval-Gate (Inv. 11/12)
        type: approval
        suspend: blocking
        with:
          reason: "Commit ins Prod-Ziel"
        # nach Approval: db-Service schreibt; ohne Approval bleibt es dry-run

    edges:
      - { from: read_source,     to: sample }
      - { from: sample,          to: propose_mapping }
      - { from: propose_mapping, to: run_on_sample }
      - { from: run_on_sample,   to: dry_run }
      - { from: dry_run,         to: commit }
```

**Wie das Artefakt iterativ wächst:** Jeder Run hängt an das Loop Tape an. Schlägt ein Record fehl, scrubbt der Entwickler im Tape zu `transform_record`, fixt das Mapping (oder tauscht das Modell), rechnet vorwärts neu — nur die fehlgeschlagenen/neuen Records (per-record correlation-id = Idempotenz). Der gefixte Bug wird via "promote run to eval case" zu `evals/from-fixed-bugs.yaml` (Inv. 15). Das Mapping-Artefakt verdichtet sich Run für Run, bis das Sample das Eval-Gate (`sample_passes`) erfüllt — dann ist das Migrationsskript "gut genug" und das Commit-Gate gibt den Prod-Write frei.

---

## 8. v0.1 Build-Plan (MoSCoW)

| Prio | Item | Realisiert durch |
|------|------|------------------|
| **MUST** | Generischer Runner (`Node=(input,ctx)=>output`, führt Graph aus) | `@elio/core` Runner (§4) |
| **MUST** | Policy-gescopter DI-Injector (Capability-Modell, security by absence) | `Injector` (Inv. 14) |
| **MUST** | Step-Typen: `agent` (Vela optional), `validate`, `file`+`db` read+write, `approval` | Node-Registry (Inv. 6/7) |
| **MUST** | Suspend + Resume via correlation-id + checkpoint (erst `blocking` + `parked`) | `RunStore`/`Checkpoint` (Inv. 12) |
| **MUST** | Elicitation-Propagierung + minimale Approval (CLI-Prompt als Inbox) | §6, `elio` CLI |
| **MUST** | Loop Tape (record + scrub) | `TapeFrame`/`RunStore.tape` (Inv. 15) |
| **MUST** | Feature-Pack-YAML + Loader | `@elio/sdk` Loader/Compiler |
| **MUST** | Vela als `agent`-Node-Engine | `@elio/vela-adapter` |
| **MUST** | Modelle: ollama + claude | `ModelService`-Adapter |
| **MUST** | **LLM-Worker** — concurrency-gated Dispatcher pro Provider, streaming → `RunEvent`s; Vela/`agent` routen MIT durch | hinter `ctx.model` (Inv. 14/17) |
| **MUST** | Artifact-centric State (Artefakt kreuzt Session-Grenze) | `Artifact`/`ArtifactRef` (Inv. 1/4) |
| **MUST** | Migrations-Dogfood (sample-first, mapping-agent, per-record-Idempotenz) | `@elio/migrate` (§7) |
| **MUST** | **Sandbox-Node-Execution (object-capability)** — jede Node im Worker/VM, `ctx` einzige Authority | Inv. 20, §11/#1 |
| **MUST** | **Budget + Tiefe-Enforcement** — Pflicht, propagiert/dekrementiert, Erschöpfung → Elicitation | Inv. 21, §11/#3 |
| **MUST** | **Secrets-Handling** — policy-gescopte `SecretRef`-Handles, pluggable Provider (env/Vault) | `SecretsService` (§11/#8) |
| **MUST** | **Tape-Redaction** — roh nur ≤ Datenklasse, darüber Hash/Ref/redacted | `TapeFrame.redaction` (§11/#9) |
| **MUST** | **`NodeResult.Failed` + Retry** — Retry-Policy, Eskalation/Dead-Letter | `Failed`/`RetryPolicy` (§11/#7) |
| **MUST** | **Batch-Node-Klasse für Massen-I/O** — kein Sandbox/Checkpoint pro Record | §11/#1/#11 |
| **MUST** | **Kern-Test-Strategie** — Ctx/Injector-Doubles, Race-Tests Suspend/Resume, re-derive Round-Trip | §11/#17 |
| **SHOULD** | `timeout`/`optional`-Suspend | `SuspendMode` erweitern |
| **SHOULD** | promote-to-eval + `elio eval` | Tape → Eval-Case (Inv. 15) |
| **SHOULD** | Dynamischer Planner-Agent-Node | `feature.planner` (Inv. 9) |
| **SHOULD** | dry-run vs. commit-Gate | `approval`-Step (§7) |
| **SHOULD** | Live-Event-Stream (`RunStore.subscribe`/`liveStatus`) — Basis für Studio-Live-Status | derselbe `RunEvent`-Strom wie das Loop Tape (Inv. 15) |
| **SHOULD** | `@elio/mcp` — ELIO als MCP-Server (Feature-Packs als MCP-Tools); Richtung B / Adoptions-Keil | nutzt Vela-MCP-Fundament (Inv. 19) |
| **COULD** | Pack-Registry (public/private) + `elio add` | — |
| **COULD** | `@elio/studio` — lokaler Studio-Client: Loop-Tape-Scrubber, **Live-Run-Status & Live-Updates**, Approval Inbox | `RunStore.subscribe`/`liveStatus` + `RunEvent` (§3); SSE/WS-Transport |
| **COULD** | HTTP-API/Server | `@elio/server` |
| **COULD** | Claude Code / Copilot CLI als *opaker* `agent`-Engine; Richtung A | `AgentEngine` `governance:"opaque"` + Sandbox (Inv. 18) |
| **COULD** | Azure-Foundry-Modelle + OpenAI als `ctx.model`-Adapter | gleiche Form wie ollama/anthropic (Inv. 17) |
| **WON'T (jetzt)** | Voll-RBAC/Multi-Tenant; **gehostete Enterprise-Console** (Multi-User, Rollen-Approval, Cost-Dashboards); new-work/Produkt-GTM; OSS-Launch-Politur | — |

---

## 9. Offene Entscheidungen

*(Nicht erfunden — explizit offen gelassen. Die Hardening-/Reviewer-Gaps sind jetzt **[GELÖST → §11]** und nicht mehr hier offen.)*

1. **Exaktes Feature-Pack-Format** — tiefe YAML-Deklaration vs. Code-Handler. Wie viel Workflow steckt deklarativ im `feature.yaml`, wie viel in registrierten Custom-Nodes? (Spannung: Auditierbarkeit vs. Ausdruckskraft.) *(nur das Format-Detail offen; Versionierung/Pinning gelöst → §11/#14.)*
2. **`new-work` — Rolle ungeklärt.** Zielkunde? Use-Case-Quelle? Vertriebskanal? Noch nicht entschieden.
3. **Produkt/OSS-Open-Core-Schnitt.** Was bleibt Vela-OSS (MIT), was wird ELIO-Enterprise? Grenze zwischen frei und kommerziell noch offen.

---

## 10. Verhältnis zu Vela & LangGraph

**Vela** ist der existierende **Inner Loop** (intra-session): ein OSS-SDK (TS + Python, MIT) für YAML-definierte, stateful, pausier-/resumebare Workflows in MCP-Servern, mit State-Machine, pluggable Storage, Sub-Workflows, Agent-Personas, MCP-Elicitation und identity-based Resume. In ELIO wird Vela über `@elio/vela-adapter` als Engine *eines* `agent`-Nodes eingehängt — es liefert just-in-time Kontext und Rails *innerhalb* einer Session und constraint damit die Autonomie dieses Nodes (Dial nach links, Inv. 9). **ELIO** ist der **Outer Loop** (inter-session): der Loop über *mehrere* Agent-Sessions, dessen Boundary-Objekt das Artefakt ist (Inv. 4), nicht das Transcript. **LangGraph** dient als Denkmodell, nicht als harte Runtime-Abhängigkeit: ELIOs Suspend/Resume via correlation-id + checkpoint ist konzeptionell `interrupt` + `checkpoint`, und der dynamische Planner-Agent-Node entspricht einem graph-erzeugenden Knoten — wobei ELIO bewusst engine-unabhängig bleibt (Inv. 2) und das Produktmodell (Artefakt, Policy-as-Injection, Loop Tape) den eigentlichen Unterschied trägt.

---

## 11. Hardening & Gap-Resolutions (v0.2)

Zwei-Reviewer-Pass: **6 BLOCKER + 7 WICHTIG** mit dem Owner durchentschieden. Jeder Punkt: **Problem → Entscheidung → betroffene Interfaces/Invarianten.**

### BLOCKER

**#1 — Capability-Scoping → Voll-Sandbox (object-capability).**
*Problem:* DI allein verhindert keinen `require('fs')`-Bypass innerhalb der Node.
*Entscheidung:* Jede Node läuft in Worker/VM **ohne Ambient Authority**; einzige Außenverbindung = das per Message-Passing/RPC übergebene `ctx`. `Node = (input, ctx) => NodeResult` wird serialisierungs-/RPC-fähig. Konsequenz: Massen-I/O ist NICHT sinnvoll Sandbox-pro-Record → eigene **Batch-Node-Klasse** (siehe #11, §7).
*Betrifft:* **Inv. 14 verschärft → neue Inv. 20**; `Node`-Signatur RPC-fähig; Injector baut gesandboxtes `ctx`.

**#2 — Opaque-Engine-Leak → Plattform = Mechanismus, nicht Policy.**
*Problem:* Ein opaker Agent (Claude Code/Copilot) könnte Sensibles anfassen, ohne dass ELIO es per-Call sieht.
*Entscheidung:* Kein Hard-Block per Default — **warn + log + audit**; jede Node deklariert ihre Datenklasse, die Plattform erkennt & meldet an der Grenze. Policy kann VERSCHÄRFEN (tighten-only) bis Hard-Cap (`≤ internal`) oder Egress-Sandbox. Default permissiv + auditiert; der Betreiber trägt die Risikoentscheidung.
*Betrifft:* **Inv. 18 präzisiert → neue Inv. 23**; `ResolvedPolicy.dataClassification`; Audit-Pfad an der opaken Hülle.

**#3 — Rekursions-Stopp → Budget + Tiefe Pflicht, propagiert.**
*Problem:* B→A→B-Rekursion (Inv. 19) hat keine harte Abbruchgarantie.
*Entscheidung:* `budget` und `maxDepth` sind **PFLICHT** in jedem Session Contract und werden über JEDE Grenze (inkl. MCP, B→A) dekrementiert; ein MCP-/Sub-Call erbt das Restbudget, kein frisches. Erschöpfung → `suspend{elicitation}` ("mehr freigeben?"), nicht hartes Sterben.
*Betrifft:* `RunInput.budget`+`maxDepth` non-optional; `SessionContract.budget`/`depth`; neuer Enforcement-Punkt §4 (4a, 9b). **Inv. 11/12/19 → neue Inv. 21.**

**#4 — Eval-Gate → Teil des Loops, node-basiert (kein Sonder-Primitiv).**
*Problem:* "Gut genug" brauchte ein Gate, ohne ein privilegiertes Step-Primitiv einzuführen.
*Entscheidung:* Das Gate ist eine **Rolle gewöhnlicher Nodes** (Inv. 6): deterministisch (`validate`/UnitTest) ∨ LLM-Judge ∨ hybrid — pro Feature deklariert. Dünner `GateVerdict {passed, score?, failures[]}`, den der Runner liest. Plus **Stagnations-Detektor**: Score-Delta < ε über N Iterationen → Eskalation als Elicitation.
*Betrifft:* `GateVerdict` (§3); §4 Schritt 12; Inv. 1/6.

```ts
interface GateVerdict { passed: boolean; score?: number; failures: string[]; }
```

**#5 — Artefakt-Warum → typisierte Artefakte + pluggable Data-Holder.**
*Problem:* Rationale/"Warum" hatte keinen Ort; Layered-Memory war ungeklärt.
*Entscheidung:* `Artifact` hat einen `type` und komponiert ≥1 **Data-Holder**: `memory` (episodic/vector) · `sidecar` (z.B. `decisions.md`, co-versioniert) · `progress.md` (laufendes Stand-/Entscheidungs-Scratchpad) · `db-state` (strukturiert/abfragbar) — erweiterbar. Das "Warum" lebt in den vom Typ deklarierten Holdern. `re-derive(artifact)` = Stand zurücklesen; **Round-Trip-Test (serialize→re-derive→identisch) als Pack-Invariante**. Subsumiert Layered-Memory.
*Betrifft:* `Artifact.type`/`holders`, `ArtifactType`, `DataHolder` (§3); **Inv. 4 → neue Inv. 22.**

**#6 — Concurrency → pro Holder deklarierte Strategie.**
*Problem:* Parallele `parked`-Branches (Inv. 12) widersprachen single-artifact-State (Inv. 1/4).
*Entscheidung:* Strategie **pro Holder**: `db-state` → transaktional / disjoint key (per-record `record.id` kollidiert nie); `sidecar`/`progress.md` → single-writer via Outer Loop; `memory` → append-only (konfliktfrei).
*Betrifft:* `DataHolder.concurrency` (§3); löst Widerspruch **Inv. 12 ↔ Inv. 1/4**.

### WICHTIG

**#7 — Error/Retry.**
*Problem:* Es gab keinen Fehlerpfad — nur `resolved`/`suspended`.
*Entscheidung:* `NodeResult = Resolved | Suspended | Failed`; `Failed {error, retryable, attempts}`. Per-Node/Feature `RetryPolicy` (maxAttempts + Backoff); non-retryable/erschöpft → Eskalation als Elicitation (wiederverwendet #3) ODER fail per Policy; **Dead-Letter** im Run Store. §4 bekommt try/catch + Retry um den Node-Call.
*Betrifft:* `Failed`, `RetryPolicy`, `NodeDefinition.retry` (§3); §4 Schritt 8/10b.

**#8 — Secrets.**
*Problem:* Credentials drohten inline im Pack/Tape zu landen.
*Entscheidung:* `ctx.secrets`: policy-gescopte **Secret-Handles**, vom (gesandboxten) Injector aus pluggable Provider (env/Vault) aufgelöst; per Name referenziert, NIE inline, **auto-redacted** aus dem Tape.
*Betrifft:* `SecretsService`/`SecretRef`, `Ctx.secrets` (§3).

**#9 — Tape-Redaction.**
*Problem:* Das Tape speicherte Roh-Nutzdaten unabhängig von der Datenklasse.
*Entscheidung:* Tape speichert roh nur **bis zur konfigurierbaren Datenklasse**; darüber Hashes/Refs/redacted Projektionen statt Roh-Nutzdaten. Redaction-Policy ist Teil des Policy-Stacks (tighten-only).
*Betrifft:* `TapeFrame.input`/`redaction` (§3); §4 Schritt 9; Inv. 13.

**#10 — Planner-Output-Contract.**
*Problem:* Der dynamische Planner (Inv. 9) hatte keinen geprüften Output und konnte implizit Caps erweitern.
*Entscheidung:* `PlanDecision {nextStep: StepRef | "DONE"; rationale: string}`; validiert gegen deklarierte **Step-Whitelist + maxDepth**; `rationale` Pflichtfeld im Tape; Vorschlag außerhalb der Whitelist → rejected (Planner kann eigene Capabilities nicht erweitern).
*Betrifft:* `PlanDecision` (§3); §4 Schritt 5; Inv. 9.

```ts
interface PlanDecision { nextStep: StepRef | "DONE"; rationale: string; }
```

**#11 — Idempotenz + Massen-Skalierung.**
*Problem:* Sandbox/Checkpoint pro Record skaliert nicht für Massen-Commits.
*Entscheidung:* Idempotenz = `db-state`-Holder als **Effect-Ledger** (applied `record.id`s, dedupliziert); Re-Run verarbeitet nur fehlende/fehlgeschlagene Records. Massen-Commit über **Batch-Node-Klasse** (kein per-record Checkpoint/Sandbox); per-record-Loop nur fürs Sample.
*Betrifft:* §7 (sample = per-record, commit = Batch); `DataHolder` kind `db-state`.

**#12 — Session Contract typisieren.**
*Problem:* `AgentService.session(req: unknown)` war untypisiert.
*Entscheidung:* Neues `SessionContract` — runter `{ input; routing; memorySlice; budget; depth }`, hoch `{ result } | { elicitation }`. `AgentService.session` / `AgentEngine.run` nehmen `SessionContract` statt `unknown`.
*Betrifft:* `SessionContract`, `SessionResult`, `AgentService`, `AgentEngine` (§3); Inv. 3.

**#14 — Pack/Prompt-Versionierung.**
*Problem:* Resume gegen einen geänderten Pack führte zu stillen Inkonsistenzen; Evals waren nicht reproduzierbar.
*Entscheidung:* Checkpoints **pinnen** die Pack-Version (content-hash); Resume gegen geänderten Pack → reject ODER expliziter Migrationspfad. Prompts content-addressed im Pack → reproduzierbare Evals.
*Betrifft:* `Checkpoint.packVersion`, `FeaturePack.contentHash` (§3).

**#15 — `tighten-only`-Halbordnung (Inv. 13 präzisiert).**
*Problem:* "verschärfen" war nicht maschinell prüfbar definiert.
*Entscheidung:* Pro Achse explizite **Halbordnung**; "tighten" = Richtung restriktiver, prüfbar. Achsen: data-class `public < internal < confidential < regulated`; suspend-mode `optional ⊑ timeout ⊑ parked ⊑ blocking` (mehr Oversight = tighter); tools/models = **Mengen-Restriktion, nie Substitution** (Policy entfernt nur, tauscht nie z.B. ein Cloud-Modell rein). Wo unvergleichbar → nur Restriktion erlaubt.
*Betrifft:* `Policy.scope`, `ResolvedPolicy` (§3); Inv. 13.

**#17 — Kern-Test-Strategie.**
*Problem:* Die load-bearing Mechanismen waren nicht test-abgesichert.
*Entscheidung:* Test-Doubles für `Ctx`/Injector; **Race-Tests** für Suspend/Resume (parallele `parked`-Branches); **Round-Trip-Test** für `re-derive` (#5). Gehört in den MUST-Plan (§8).
*Betrifft:* §8 (MUST: Kern-Test-Strategie); Inv. 20/21/22.
