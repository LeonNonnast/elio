// ───────────────────────────── OuterLoopRunner: der Outer Loop (Inv. 1, §4) ─────────────────────────────
// Konvergiert gegen das Eval-Gate des Artefakts, nicht gegen "Steps fertig" (Inv. 1).
// v0.1 Slice 1: autonomy "static"/"guided" (statischer Graph). Dynamic-Planner = SHOULD/später.
// run(pack, input) ist ein async generator, der RunEvents yieldet (= Loop Tape = Live-Status, Inv. 15).
//
// Pro Outer-Iteration (§4): nächsten Step holen -> resolveInput -> Injector.buildCtx ->
// tryWithRetry(node) -> Tape append -> Budget charge + depth -> bei resolved: state mergen +
// applyTo(artifact) + artifact-updated; bei failed: RetryPolicy (escalate -> Elicitation /
// fail -> Dead-Letter, halt); bei suspended: Elicitation-Propagierung (§6, Schritt 11) ->
// Policy-Interceptor / Parent-State auto-resolve ODER Checkpoint + node-suspended + halt.
// Nach jedem resolved Step (unabhängig von der Node-Klasse): Eval-Gate gegen {artifact} ->
// passed => run-completed{gate:"passed"}.
// nextStep == DONE -> Gate einmal laufen lassen -> run-completed.
// Budget/Tiefe erschöpft -> run-completed{gate:"stopped"} (kein Infinite-Loop; Slice 4: Elicitation).
import { applyTo, createArtifact, deserializeArtifact, serializeArtifact } from "./artifact-impl";
import type { SerializedArtifact } from "./artifact-impl";
import { corrKey, newBranchId, newStepCheckpointId } from "./ids";
import { InProcessSandbox, PolicyInjector } from "./injector";
import { applyPolicy, rootPolicy } from "./policy-impl";
import { resolvePolicies } from "./policy-registry";
import { BudgetTracker } from "./cost";
import {
  registerChildExecutor,
  unregisterChildExecutor,
  registerFeatureResolver,
  unregisterFeatureResolver,
} from "./branch";
import type { FeatureResolver } from "./branch";
import type { BranchOutcome, ChildBranchExecutor, ChildBranchSpec } from "./branch";
import type { Cost } from "./common";
import type { NodeSandbox } from "./injector";
import type { Artifact, ArtifactType } from "./artifact";
import type { Checkpoint, CorrelationId, Elicitation } from "./elicitation";
import type { FeaturePack, GraphDefinition, StepRef } from "./feature";
import type { Injector, Policy, ResolvedPolicy } from "./policy";
import type { PolicyRegistry } from "./policy-registry";
import type { GateVerdict, NodeDefinition, NodeResult } from "./node";
import type { Redactor } from "./redaction";
import type { NodeRegistry } from "./registry";
import type { RunEvent, RunInput, RunStatus, RunStore, Runner, TapeFrame } from "./run";
// ───────────────────────────── Template-Auflösung {{state.x}} (§3) ─────────────────────────────
const TEMPLATE_RE = /^\{\{\s*state\.([\w.]+)\s*\}\}$/;
const TEMPLATE_INLINE_RE = /\{\{\s*state\.([\w.]+)\s*\}\}/g;
/** Liest einen (ggf. verschachtelten) Pfad aus dem branchState (`a.b.c`). */
function readPath(state: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".");
    let cur: unknown = state;
    for (const p of parts) {
        if (cur === undefined || cur === null || typeof cur !== "object")
            return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}
/** Setzt einen (ggf. verschachtelten) Pfad im branchState (legt Zwischenobjekte an). */
function writePath(state: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split(".");
    let cur: Record<string, unknown> = state;
    for (let i = 0; i < parts.length - 1; i += 1) {
        const key = parts[i] as string;
        const next = cur[key];
        if (typeof next !== "object" || next === null || Array.isArray(next)) {
            cur[key] = {};
        }
        cur = cur[key] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1] as string] = value;
}
/**
 * Löst Templates in einem Wert rekursiv auf:
 *  - "{{state.x}}" als ganzer String -> der rohe Wert von state.x (typ-erhaltend).
 *  - eingebettete "{{state.x}}" in einem längeren String -> als String interpoliert.
 *  - Objekte/Arrays werden rekursiv durchlaufen.
 */
export function resolveTemplates(value: unknown, state: Record<string, unknown>) : unknown {
    if (typeof value === "string") {
        const exact = TEMPLATE_RE.exec(value);
        if (exact !== null) {
            return readPath(state, exact[1] as string);
        }
        if (TEMPLATE_INLINE_RE.test(value)) {
            return value.replace(TEMPLATE_INLINE_RE, (_m, path) => {
                const v = readPath(state, path);
                return v === undefined || v === null ? "" : String(v);
            });
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => resolveTemplates(v, state));
    }
    if (typeof value === "object" && value !== null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = resolveTemplates(v, state);
        }
        return out;
    }
    return value;
}
/** Baut den Node-Input aus `stepRef.with` mit Template-Auflösung gegen den branchState (§3). */
export function resolveInput(step: StepRef, state: Record<string, unknown>) : unknown {
    return resolveTemplates(step.with ?? {}, state);
}
/**
 * Faltet `stepRef.suspend` als `mode` in einen (template-aufgelösten) Plain-Object-Input
 * (z.B. damit die approval-Node `cfg.mode = stepRef.suspend || "blocking"` liest). Ein bereits
 * vorhandenes `mode` (aus step.with) hat Vorrang; nicht-Plain-Object-Inputs bleiben unverändert.
 */
export function withSuspendMode(input: unknown, step: StepRef) : unknown {
    if (step.suspend === undefined)
        return input;
    if (typeof input !== "object" || input === null || Array.isArray(input))
        return input;
    const obj = input as Record<string, unknown>;
    if ("mode" in obj && obj["mode"] !== undefined)
        return input;
    return { ...obj, mode: step.suspend };
}
// ───────────────────────────── State-Merge / Output-Mapping (§3) ─────────────────────────────
/** Strippt ein optionales führendes "state." aus einem outputs-Ziel. */
function stripStatePrefix(target: string): string {
    return target.startsWith("state.") ? target.slice("state.".length) : target;
}
/**
 * Merged ein NodeResult-Output in den branchState (§3):
 *  - Mit `step.outputs`: jeder Eintrag `{ field: "state.path" }` schreibt output[field] -> state.path.
 *  - Ohne `outputs`: output wird flach in den branchState gemerged (nur bei Plain-Object).
 */
export function mergeOutput(state: Record<string, unknown>, step: StepRef, output: unknown) : void {
    if (step.outputs !== undefined && Object.keys(step.outputs).length > 0) {
        const out = (output ?? {}) as Record<string, unknown>;
        for (const [field, target] of Object.entries(step.outputs)) {
            writePath(state, stripStatePrefix(target), out[field]);
        }
        return;
    }
    if (typeof output === "object" && output !== null && !Array.isArray(output)) {
        Object.assign(state, output);
    }
}
// ───────────────────────────── Graph-Navigation: nextEdge (§3) ─────────────────────────────
/** Erststep = Step ohne eingehende Edge (sonst steps[0]). */
function firstStep(graph: GraphDefinition): StepRef | undefined {
    if (graph.steps.length === 0)
        return undefined;
    const hasIncoming = new Set(graph.edges.map((e) => e.to));
    return graph.steps.find((s) => !hasIncoming.has(s.id)) ?? graph.steps[0];
}
/** Findet eine StepRef per id. */
function stepById(graph: GraphDefinition, id: string): StepRef | undefined {
    return graph.steps.find((s) => s.id === id);
}
/**
 * Sichere `when`-Auswertung gegen { state } (kein roher eval, §3). v0.1 unterstützt:
 *  - leeres/ungesetztes when -> true
 *  - "state.x" / "state.a.b" -> truthy-Test des Pfads
 *  - "!state.x" -> negierter truthy-Test
 *  - "state.x == <literal>" / "state.x != <literal>" (literal: number | true | false | "quoted")
 */
function evalWhen(when: string | undefined, state: Record<string, unknown>): boolean {
    if (when === undefined || when.trim() === "")
        return true;
    const expr = when.trim();
    // Gleichheits-/Ungleichheits-Vergleich.
    const cmp = /^(!?)\s*state\.([\w.]+)\s*(==|!=)\s*(.+)$/.exec(expr);
    if (cmp !== null) {
        const negate = cmp[1] === "!";
        const lhs = readPath(state, cmp[2] as string);
        const op = cmp[3];
        const rhs = parseLiteral((cmp[4] as string).trim());
        const eq = lhs === rhs;
        const res = op === "==" ? eq : !eq;
        return negate ? !res : res;
    }
    // Reiner truthy-/negierter Pfad-Test.
    const path = /^(!?)\s*state\.([\w.]+)\s*$/.exec(expr);
    if (path !== null) {
        const v = readPath(state, path[2] as string);
        const truthy = Boolean(v) && !(Array.isArray(v) && v.length === 0);
        return path[1] === "!" ? !truthy : truthy;
    }
    // Unbekannte Syntax -> defensiv false (Edge wird nicht genommen).
    return false;
}
function parseLiteral(raw: string): unknown {
    if (raw === "true")
        return true;
    if (raw === "false")
        return false;
    if (raw === "null")
        return null;
    if (/^-?\d+(\.\d+)?$/.test(raw))
        return Number(raw);
    const q = /^["'](.*)["']$/.exec(raw);
    if (q !== null)
        return q[1];
    return raw;
}
/**
 * Nächster Step im statischen Graph (§3):
 *  - lastStepId undefined -> Erststep.
 *  - sonst erste Edge from===lastStepId, deren `when` truthy ist -> Ziel-Step.
 *  - keine passende Folge-Edge -> "DONE".
 */
export function nextEdge(graph: GraphDefinition, lastStepId: string | undefined, state: Record<string, unknown>) : StepRef | "DONE" {
    if (lastStepId === undefined) {
        return firstStep(graph) ?? "DONE";
    }
    for (const edge of graph.edges) {
        if (edge.from !== lastStepId)
            continue;
        if (evalWhen(edge.when, state)) {
            const target = stepById(graph, edge.to);
            if (target !== undefined)
                return target;
        }
    }
    return "DONE";
}
/**
 * Baut aus einer linearen Step-Liste (subworkflow.with.steps) einen GraphDefinition mit
 * Reihenfolge-Edges steps[i] -> steps[i+1] (Slice 2B, Inv. 8). nextEdge() navigiert ihn wie jeden
 * statischen Graphen; nach dem letzten Step gibt es keine Folge-Edge -> DONE.
 */
export function linearGraph(steps: StepRef[]) : GraphDefinition {
    const edges: GraphDefinition["edges"] = [];
    for (let i = 0; i < steps.length - 1; i += 1) {
        edges.push({ from: (steps[i] as StepRef).id, to: (steps[i + 1] as StepRef).id });
    }
    return { steps: [...steps], edges };
}
// ───────────────────────────── tryWithRetry (§4 Schritt 8, §11/#7) ─────────────────────────────
const DEFAULT_RETRY: NonNullable<NodeDefinition["retry"]> = { maxAttempts: 1, onExhausted: "fail" };
/** Default-Sandbox (Inv. 20): in-process Handler-Call. Worker/VM-Impl dockt am NodeSandbox-Seam an. */
const DEFAULT_SANDBOX = new InProcessSandbox();
function backoffDelay(
    backoff: NonNullable<NodeDefinition["retry"]>["backoff"],
    baseDelayMs: number | undefined,
    attempt: number,
): number {
    const base = baseDelayMs ?? 0;
    switch (backoff) {
        case "fixed":
            return base;
        case "exponential":
            return base * Math.pow(2, attempt - 1);
        case "none":
        default:
            return 0;
    }
}
function sleep(ms: number): Promise<void> {
    if (ms <= 0)
        return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Ruft den Node-Handler DURCH DEN SANDBOX-SEAM (Inv. 20); fängt throw -> Failed{retryable:true};
 * respektiert node.retry (Default {maxAttempts:1,onExhausted:"fail"}); Backoff none|fixed|exponential
 * via baseDelayMs. Ein zurückgegebenes Failed{retryable:false} wird NICHT wiederholt. Ein
 * Suspended/Resolved beendet die Schleife sofort.
 *
 * `sandbox` (Inv. 20, §3): die Ausführungs-Schicht. Default = InProcessSandbox (ruft den Handler direkt;
 * Sicherheit kommt aus security by absence). Ein Worker/VM-Sandbox-Impl kann hier (bzw. über den
 * Runner-Konstruktor) eingehängt werden, OHNE den Runner zu ändern — genau der Sinn des Seams. Vorher
 * rief tryWithRetry node.handler direkt und der Seam war ungenutzt.
 */
export async function tryWithRetry(node: NodeDefinition, input: unknown, ctx: import("./ctx").Ctx, sandbox: NodeSandbox = DEFAULT_SANDBOX) : Promise<NodeResult> {
    const retry = node.retry ?? DEFAULT_RETRY;
    const maxAttempts = Math.max(1, retry.maxAttempts);
    let attempt = 0;
    let last: NodeResult = {
        status: "failed",
        error: { message: "no attempt made" },
        retryable: false,
        attempts: 0,
    };
    while (attempt < maxAttempts) {
        attempt += 1;
        try {
            const res = await sandbox.run(node, input, ctx);
            if (res.status !== "failed") {
                return res;
            }
            // Failed zurückgegeben: attempts hochzählen, ggf. retry.
            last = { ...res, attempts: attempt };
            if (!res.retryable)
                return last;
        }
        catch (e) {
            last = {
                status: "failed",
                error: { message: e instanceof Error ? e.message : String(e) },
                retryable: true,
                attempts: attempt,
            };
        }
        if (attempt < maxAttempts) {
            await sleep(backoffDelay(retry.backoff, retry.baseDelayMs, attempt));
        }
    }
    return last;
}
// ───────────────────────────── Helpers: Cost-Summe / Tape-Frame / Gate-Read ─────────────────────────────
function addCost(a: import("./common").Cost, b: import("./common").Cost): import("./common").Cost {
    const out: import("./common").Cost = {};
    const usd = (a.usd ?? 0) + (b.usd ?? 0);
    if (usd !== 0 || a.usd !== undefined || b.usd !== undefined)
        out.usd = usd;
    const ti = (a.tokensIn ?? 0) + (b.tokensIn ?? 0);
    if (ti !== 0)
        out.tokensIn = ti;
    const to = (a.tokensOut ?? 0) + (b.tokensOut ?? 0);
    if (to !== 0)
        out.tokensOut = to;
    return out;
}
interface LiveStore extends RunStore {
    publish(ev: RunEvent): void;
    setStatus(status: RunStatus): void;
    clearStatus(id: CorrelationId): void;
    clearSuspendedForRun(runId: string): void;
    getRunInput(runId: string): RunInput | undefined;
}
function isInMemoryStore(store: RunStore): store is LiveStore {
    return typeof (store as { publish?: unknown }).publish === "function";
}
/**
 * Interpretiert die Resume-Antwort auf eine Budget/Tiefe-Erschöpfungs-Eskalation (Inv. 21, §4 4a)
 * als ADDITIVEN Grant. Akzeptierte Shapes (alles andere -> kein Grant):
 *  - `number`            -> `{ budget: N, maxDepth: 0 }`  (reine Budget-Freigabe)
 *  - `{ budget?, maxDepth? }` -> die gesetzten Felder (negative/NaN werden auf 0 geklemmt — eine
 *                              Freigabe kann nur ERWEITERN, nie das Restbudget weiter beschneiden).
 * Beide Werte werden additiv auf `RunInput.budget`/`maxDepth` aufgeschlagen, sodass der
 * reconstruierte BudgetTracker wieder Headroom hat.
 */
function parseBudgetGrant(answer: unknown): { budget: number; maxDepth: number } {
    const clampNonNeg = (n: unknown): number =>
        typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
    if (typeof answer === "number") {
        return { budget: clampNonNeg(answer), maxDepth: 0 };
    }
    if (typeof answer === "object" && answer !== null) {
        const a = answer as { budget?: unknown; maxDepth?: unknown };
        return { budget: clampNonNeg(a.budget), maxDepth: clampNonNeg(a.maxDepth) };
    }
    return { budget: 0, maxDepth: 0 };
}
/** Liest ein GateVerdict aus einem Resolved (vom Eval-Gate-Node). */
function asVerdict(result: NodeResult): GateVerdict | undefined {
    if (result.status !== "resolved")
        return undefined;
    const out = result.output;
    if (typeof out === "object" && out !== null && "passed" in out) {
        return out as GateVerdict;
    }
    return undefined;
}
interface RunContext {
    pack: FeaturePack;
    input: RunInput;
    artifact: Artifact;
    branch: string;
}

export interface OuterLoopRunnerDeps {
    registry: NodeRegistry;
    store: RunStore;
    injector?: Injector;
    /**
     * Ausführungs-Sandbox (Inv. 20, §3). Jede Node wird durch sie ausgeführt (statt node.handler direkt) —
     * so dockt ein Worker/VM-Sandbox-Impl OHNE Runner-Änderung ein. Default = InProcessSandbox (ruft den
     * Handler direkt; Sicherheit kommt aus security by absence). v0.1: nur der In-Process-Default; echte
     * Isolation = v0.2 (§7).
     */
    sandbox?: NodeSandbox;
    /** Root-Policy-Override (z.B. um Modelle/fs für ein Feature freizugeben). */
    rootPolicy?: ResolvedPolicy;
    /**
     * Sub-Feature-Katalog (feature-ref subworkflow, §3): wird er verdrahtet, registriert der Runner ihn
     * pro Run als FeatureResolver — die feature-ref-Node löst Sub-Features per id auf und fährt sie als
     * Kind-Branches (registry-driven fan-out). Ohne ihn failt eine feature-ref-Node klar.
     */
    featureRegistry?: FeatureResolver;
    /**
     * Policy-Registry (Inv. 13, §4 Schritt 2). Löst pack.feature.policies per id zu Policy-Objekten
     * auf, die resolveRoot() via applyPolicy/enforceTightenOnly über den Root faltet, und liefert den
     * Interceptor-Stack für die Elicitation-Propagierung (§6). Ohne Registry werden deklarierte
     * Policies abgelehnt (ein Feature darf nicht ungoverned laufen).
     */
    policyRegistry?: PolicyRegistry;
    /**
     * Optionale Artefakt-Typ-Auflösung pro `kind`. Erlaubt einem Feature, die komponierten
     * Data-Holder zu bestimmen (Inv. 22), ohne den fixen FeatureDefinition-Contract zu ändern.
     * Default (kein Eintrag) = Holder ["memory", "progress.md"].
     */
    artifactTypes?: Record<string, ArtifactType>;
    /**
     * Tape-Redactor (§11/#9). Wird er übergeben, scrubbt der Runner jeden Frame durch ihn, bevor er ins
     * Tape geht — so verschwinden registrierte Secret-Werte (vom scoped SecretsService angemeldet)
     * auto-redacted aus dem Loop Tape. Ohne Redactor sind Frames unverändert (Default).
     */
    redactor?: Redactor;
}

/** Rehydrierbarer Branch-State eines Checkpoints (snapshot()). */
interface SerializedBranchState {
    branchState: Record<string, unknown>;
    lastStepId: string | undefined;
    spent: number;
    depth: number;
    iterations: number;
    /** Bei einem Kind-Branch: der synthetische lineare Kind-Graph (subworkflow). */
    childGraph?: GraphDefinition;
}

export class OuterLoopRunner implements Runner {
    private readonly registry: NodeRegistry;
    private readonly store: RunStore;
    private readonly injector: Injector;
    private readonly rootPolicyOverride: ResolvedPolicy | undefined;
    private readonly featureRegistry: FeatureResolver | undefined;
    private readonly policyRegistry: PolicyRegistry | undefined;
    private readonly artifactTypes: Record<string, ArtifactType>;
    private readonly redactor: Redactor | undefined;
    /** Ausführungs-Sandbox (Inv. 20). Jede Node läuft durch sie; Default = InProcessSandbox. */
    private readonly sandbox: NodeSandbox;
    /** Pinnt Pack + Input pro Run, damit resume() denselben Kontext rekonstruiert. */
    private readonly runContexts = new Map<string, RunContext>();
    /**
     * Offene (parked/blocking) Branch-Checkpoints pro Run (Slice 2B). Schlüssel = corrKey. Wird in
     * suspendBranch() befüllt und beim Resume des jeweiligen Branches geleert. liveStatus() ist
     * already branch-granular (jeder parked Branch trägt phase "suspended"); dieser Tracker erlaubt
     * dem Root-Branch zu erkennen, dass NOCH Branches parked sind, und den Run dann NICHT als sauber
     * "done" zu melden, sondern als "suspended" (Inv. 12: "alle Branches parked -> Run suspended").
     */
    private readonly parkedByRun = new Map<string, Set<string>>();
    constructor(deps: OuterLoopRunnerDeps) {
        this.registry = deps.registry;
        this.store = deps.store;
        // Default-Injector bekommt den Store als TapeSource (Inv. 15): so ist ctx.traces auch über den
        // nackten Runner verfügbar (sonst nur über die SDK, die den Injector explizit verdrahtet) — bleibt
        // policy-gegated (nur bei "traces:read"-Grant injiziert, security by absence, Inv. 14).
        this.injector = deps.injector ?? new PolicyInjector({ store: deps.store });
        this.rootPolicyOverride = deps.rootPolicy;
        this.featureRegistry = deps.featureRegistry;
        this.policyRegistry = deps.policyRegistry;
        this.artifactTypes = deps.artifactTypes ?? {};
        this.redactor = deps.redactor;
        this.sandbox = deps.sandbox ?? DEFAULT_SANDBOX;
    }
    /**
     * Das (mutierte) Artefakt eines Runs (kreuzt die Session-Grenze, Inv. 4). Nach run()/resume()
     * verfügbar; v0.1 in-process. Quelle für re-derive-Round-Trip-Checks + Persistenz-Adapter.
     */
    getArtifact(runId: string) : Artifact | undefined {
        return this.runContexts.get(runId)?.artifact;
    }
    /** Outer Loop (Inv. 1). Async generator über RunEvents. */
    async *run(pack: FeaturePack, input: RunInput) : AsyncIterable<RunEvent> {
        const graph = pack.feature.graph;
        if (graph === undefined) {
            throw new Error(`OuterLoopRunner: feature "${pack.metadata.id}" hat keinen graph (autonomy="${pack.feature.autonomy}"). ` +
                `Slice 1 unterstützt nur static/guided mit statischem Graph.`);
        }
        if (pack.feature.autonomy === "dynamic") {
            throw new Error(`OuterLoopRunner: autonomy="dynamic" (Planner) ist v0.1 Slice 1 nicht unterstützt.`);
        }
        const record = await this.store.createRun(input);
        const branch = newBranchId();
        const artifact = this.loadOrCreateArtifact(pack, input);
        this.runContexts.set(record.id, { pack, input, artifact, branch });
        const budget = new BudgetTracker(input.budget, input.maxDepth, 0, 0, 0, input.maxCostUsd);
        const state = structuredClone(graph.state ?? {}) as Record<string, unknown>;
        // Run-spezifischen Input für Nodes zugänglich machen (Slice 1 reichte payload an keinen Node durch):
        // unter `state.input` lesbar via {{state.input...}}. Additiv — bestehende Features nutzen den Key
        // nicht. Persistiert über Suspend/Resume (Teil des Branch-State). Speist u.a. den Kandidaten an
        // promote-candidate.
        state.input = input.payload ?? null;
        yield* this.drive(pack, input, record.id, branch, artifact, budget, state, undefined);
    }
    /**
     * Resume via correlation-id + Antwort (Inv. 12). Lädt Checkpoint, rehydriert, füttert Antwort.
     *
     * `opts.expectedPackVersion` (§11/#14): die Pack-Version (content-hash bzw. metadata.version), gegen
     * die der Checkpoint validiert werden soll. Ein Aufrufer, der den Pack (neu) geladen hat — z.B. eine
     * frische Runtime, die eine editierte YAML re-kompiliert hat — übergibt hier den AKTUELLEN Hash.
     * Stimmt er nicht mit dem im Checkpoint gepinnten `cp.packVersion` überein, wird der Resume mit
     * einem DISTINKTEN "Pack-Version geändert"-Fehler abgelehnt (kein stiller Lauf gegen einen anderen
     * Pack; Migration ist v0.1 nicht implementiert). Ohne `expectedPackVersion` fällt die Validierung
     * auf die im Run-Kontext gepinnte Version zurück (in-process Resume, v0.1-Default).
     */
    async *resume(id: CorrelationId, answer: unknown, opts?: {
        expectedPackVersion?: string;
        pack?: FeaturePack;
    }) : AsyncIterable<RunEvent> {
        const cp = await this.store.loadCheckpoint(id);
        if (cp === null) {
            throw new Error(`OuterLoopRunner.resume: kein Checkpoint für ${JSON.stringify(id)}`);
        }
        let rc = this.runContexts.get(id.run);
        if (rc === undefined) {
            // Cross-process Resume (z.B. `elio resume` in einem NEUEN Prozess): der In-Memory-Run-Kontext
            // fehlt. Ihn aus den DURABLEN Quellen rekonstruieren — Pack vom Aufrufer neu geliefert
            // (opts.pack), Run-Input aus dem persistenten Store (Budget/Tiefe-Totals), Artefakt aus dem
            // Checkpoint-Snapshot deserialisiert. Fehlt eines davon -> klarer Fehler (kein stiller Lauf).
            const pack = opts?.pack;
            const input = isInMemoryStore(this.store) ? this.store.getRunInput(id.run) : undefined;
            if (pack === undefined || input === undefined || cp.artifactSnapshot === undefined) {
                throw new Error(
                    `OuterLoopRunner.resume: kein Run-Kontext für ${id.run} und unvollständige Resume-Daten ` +
                        `(cross-process Resume braucht opts.pack + persistierten Run-Input + cp.artifactSnapshot).`,
                );
            }
            const artifact = deserializeArtifact(cp.artifactSnapshot as SerializedArtifact);
            rc = { pack, input, artifact, branch: id.branch };
            this.runContexts.set(id.run, rc);
        }
        // §11/#14: Resume gegen einen GEÄNDERTEN Pack ablehnen. Quelle der Wahrheit für die erwartete
        // Version ist — wenn der Aufrufer sie liefert — der extern (neu) geladene Pack-Hash; sonst der im
        // Run-Kontext gepinnte. Nur der externe Pfad kann eine echte Änderung erkennen (der gepinnte Pack
        // ist per Konstruktion mit cp.packVersion identisch). Distinkter Fehler, getrennt vom "kein
        // Run-Kontext"-Fehler, damit ein Migrations-Hook hier andocken kann.
        const expectedPackVersion = opts?.expectedPackVersion ?? rc.pack.contentHash ?? rc.pack.metadata.version;
        if (cp.packVersion !== expectedPackVersion) {
            throw new Error(`OuterLoopRunner.resume: Pack-Version geändert — Checkpoint pinnt "${cp.packVersion}", ` +
                `Resume-Ziel ist "${expectedPackVersion}". Reject (§11/#14; Migration v0.1 nicht unterstützt).`);
        }
        const resume = cp.state as SerializedBranchState;
        const state = structuredClone(resume.branchState);
        // Antwort in den State einspeisen — GEZIELT für die pending Elicitation (Inv. 11/12, §6):
        // unter `_answers[pendingElicitation.what]`, NICHT in einen geteilten generischen Slot. So ist die
        // Antwort an GENAU die Elicitation gebunden, die gefragt hat, und kann keine spätere, andere
        // Elicitation im selben Branch fälschlich auto-resolven (Cross-Elicitation-Contamination). Ein
        // generischer `state.answer` bleibt nur als Downstream-Template-Komfort ({{state.answer}}) — er
        // wird vom Parent-State-Auto-Resolve (parentStateAnswer) bewusst NICHT mehr konsultiert.
        if (cp.pendingElicitation !== undefined) {
            this.recordAnswer(state, cp.pendingElicitation.what, answer);
        }
        state["answer"] = answer;
        await this.store.resolveElicitation(id, answer);
        // Dieser Branch ist nicht mehr parked (Slice 2B): aus dem offenen-Branches-Set entfernen und
        // seinen "suspended"-Status-Eintrag löschen (sonst meldet liveStatus() ihn weiter als wartend).
        this.parkedByRun.get(id.run)?.delete(corrKey(id));
        this.clearStatus(id);
        // Budget/Tiefe-Freigabe (Inv. 21, §4 Schritt 4a): wurde dieser Checkpoint von der
        // Outer-Loop-Erschöpfungs-Eskalation gesetzt (__budget__-Step), interpretiert der Resume die
        // Antwort als GRANT und erhöht das Run-Budget/-maxDepth ADDITIV — nur so hat der reconstruierte
        // BudgetTracker wieder Headroom (remaining()>0 bzw. iterations<maxDepth) und der Loop läuft an
        // GENAU der erschöpften Stelle weiter, statt 4a sofort erneut auszulösen. Andere Antwort-Shapes
        // (z.B. eine reine Approval-Antwort) lassen Budget/Tiefe unverändert.
        if (id.step === "__budget__") {
            const grant = parseBudgetGrant(answer);
            rc.input.budget += grant.budget;
            rc.input.maxDepth += grant.maxDepth;
        }
        const budget = new BudgetTracker(rc.input.budget, rc.input.maxDepth, resume.depth, resume.spent, resume.iterations, rc.input.maxCostUsd);
        // Resume rehydriert ab dem letzten RESOLVED Step (resume.lastStepId) — der suspendierte Step wird
        // re-selektiert und re-ausgeführt. Das ist BEWUSST: manche Suspend-Nodes resolven sich beim
        // Re-Run selbst, sobald die Antwort im State liegt (sie lesen `{{state.answer}}`); ein nacktes
        // approval-Gate re-raised stattdessen und wird durch die GEZIELT (per `what`) hinterlegte Antwort
        // aufgelöst (parentStateAnswer matcht NUR `_answers[what]`, nie einen generischen Slot). So ist
        // die Antwort an GENAU die wartende Elicitation gebunden — eine spätere, andere Elicitation im
        // selben Branch wird NICHT mit-aufgelöst (keine Cross-Elicitation-Contamination, Inv. 11/12 / §6).
        // Der Run-Ebene-Resolver bleibt `by:"human"` (drive() emittiert es für die resumeFrom-correlation).
        yield* this.drive(rc.pack, rc.input, id.run, id.branch, rc.artifact, budget, state, resume.lastStepId, id, resume.childGraph, { answer });
    }
    // ───────────────────────────── Root-Branch-Driver ─────────────────────────────
    //
    // drive() treibt den ROOT-Branch eines Runs (Slice 2B). Es registriert den ChildBranchExecutor
    // (den eine subworkflow-Node via ctx.correlation.run abgreift, um Kind-Branches zu fächern),
    // emittiert run-started bzw. (beim Resume) elicitation-resolved{by:"human"}, fährt den Branch über
    // den geteilten Step-Loop runBranchSteps() und mappt dessen BranchOutcome auf die Run-Ebene:
    //  - completed -> run-completed + Live-Status "done".
    //  - suspended -> Live-Status "suspended" (node-suspended wurde bereits im Loop emittiert);
    //                 der Branch ist per correlation-id resumebar (Inv. 12). Geschwister-Branches
    //                 (Kinder einer subworkflow) liefen bereits WEITER (§6) — sie parken NUR ihren
    //                 eigenen Checkpoint; der Run hängt nicht.
    private async *drive(
        pack: FeaturePack,
        input: RunInput,
        runId: string,
        branch: string,
        artifact: Artifact,
        budget: BudgetTracker,
        state: Record<string, unknown>,
        startLastStepId: string | undefined,
        resumeFrom?: CorrelationId,
        /** Bei einem KIND-Branch-Resume: der synthetische Kind-Graph (sonst der Feature-Graph). */
        childGraph?: GraphDefinition,
        /** Resume-Antwort (Inv. 11/12): nur beim Resume gesetzt, wird an den ERSTEN (suspendierten) Step gereicht. */
        resumeAnswer?: { answer: unknown },
    ): AsyncIterable<RunEvent> {
        void input;
        const isChildResume = childGraph !== undefined;
        const graph = childGraph ?? pack.feature.graph;
        if (graph === undefined) {
            throw new Error(
                `OuterLoopRunner.drive: feature "${pack.metadata.id}" hat keinen graph (autonomy="${pack.feature.autonomy}").`,
            );
        }
        // Kind-Branches haben kein eigenes Eval-Gate (sie laufen ihre Steps bis DONE); nur der
        // Root-Branch trägt das Feature-Gate (Inv. 1).
        const gateType = isChildResume ? undefined : pack.feature.artifact.evalGate;
        // ChildBranchExecutor pro Run registrieren (eine subworkflow-Node liest ihn via run id).
        // Idempotent: mehrere subworkflow-Nodes / Resume-Aufrufe desselben Runs teilen einen Executor.
        registerChildExecutor(runId, this.makeChildExecutor(pack, runId, artifact));
        // FeatureResolver pro Run registrieren (feature-ref-Node liest ihn via run id), falls verdrahtet.
        if (this.featureRegistry !== undefined) registerFeatureResolver(runId, this.featureRegistry);
        try {
            if (resumeFrom === undefined) {
                const ev: RunEvent = {
                    type: "run-started",
                    correlation: { run: runId, branch, step: "__start__", checkpoint: "__start__" },
                    feature: pack.metadata.id,
                };
                this.emit(ev);
                yield ev;
            }
            else {
                // Resume: die hochpropagierte Elicitation wurde (vom Menschen) beantwortet (Inv. 11/12).
                const ev: RunEvent = {
                    type: "elicitation-resolved",
                    correlation: resumeFrom,
                    by: "human",
                };
                this.emit(ev);
                yield ev;
            }
            const stepsGen = this.runBranchSteps(pack, runId, branch, artifact, budget, state, graph, gateType, startLastStepId, resumeAnswer);
            const outcome = yield* stepsGen;
            const total = { usd: budget.charged() };
            // Kind-Branch-Resume (Slice 2B): ein parked Kind wurde resumed und lief durch -> seinen
            // disjoint-key Record schreiben (denselben Pfad wie beim First-Pass; identisches Artefakt
            // unabhängig von der Resume-Reihenfolge, §11/#6).
            if (isChildResume && outcome.kind === "completed") {
                await this.writeChildRecord(artifact, branch, state);
            }
            if (outcome.kind === "completed") {
                // Dieser Branch lief durch. Run-weite Entscheidung:
                const parked = this.parkedByRun.get(runId);
                const stillParked = parked !== undefined && parked.size > 0;
                if (stillParked) {
                    // Es gibt NOCH parked Branches in diesem Run (z.B. eine subworkflow hat Kinder geparkt).
                    // Der Run ist NICHT sauber fertig -> als "suspended" melden (Inv. 12: "alle Branches
                    // parked -> Run suspended"), ohne run-completed zu emittieren. Kein Hang/Busy-Spin: die
                    // parked Branches sind per correlation-id resumebar. Den Run selbst tragen bereits die
                    // per-Branch "suspended"-Status-Einträge (jeder parked Branch an seinem approval-Step);
                    // wir setzen daher KEINEN zusätzlichen, NIE-gecleartem __end__:suspended-Eintrag (der hätte
                    // keinen Waiter und bliebe als Phantom-"suspended" neben dem späteren "done" liegen).
                    // Dieser Branch selbst ist done (sein eigener suspended-Status wurde beim Resume gelöscht).
                }
                else {
                    // Keine offenen Branches mehr -> sauberer Run-Abschluss. Auf der FINALEN parked-Child-
                    // Resume (gateType war im Child-Pfad undefined, der Branch lieferte gate:"stopped") MUSS
                    // das Feature-Eval-Gate gegen das geteilte Artefakt RE-evaluiert werden — nur dann kippt
                    // ein Gate, das erst konvergiert, wenn ALLE parked Branches fertig sind (z.B. "alle Records
                    // da"), auf passed (Inv. 1, §4 Schritt 12). Der Root-Pfad hat sein Gate bereits gelaufen
                    // (outcome.gate ist autoritativ); nur der Child-Resume-Pfad braucht das Re-run.
                    yield* this.completeRun(runId, branch, artifact, pack, total, isChildResume, outcome.gate);
                }
            }
            else {
                // suspended: node-suspended ist bereits geflossen; der Live-Status steht auf "suspended"
                // (suspendBranch). Der Branch ist per correlation-id resumebar (Inv. 12). Geschwister
                // (subworkflow-Kinder) liefen bereits WEITER — der Run hängt nicht.
            }
        }
        finally {
            unregisterChildExecutor(runId);
            if (this.featureRegistry !== undefined) unregisterFeatureResolver(runId);
        }
    }
    // ───────────────────────────── Geteilter Step-Loop (§4) — pro Branch, returnt BranchOutcome ─────────────────────────────
    //
    // Der eine, geteilte Outer-Step-Loop (§4) für GENAU EINEN Branch. Root-Branch und jeder von einer
    // subworkflow gefächerte Kind-Branch laufen durch denselben Code (Mechanismus, kein Rewrite). Statt
    // run-completed / Live-Status selbst zu setzen, RETURNT er einen BranchOutcome — der Aufrufer
    // (drive für Root, makeChildExecutor für Kinder) entscheidet, was Run-weit passiert.
    //
    //  - resolved: Budget/Tiefe dekrementieren (Inv. 21), state mergen, Artefakt wachsen (Inv. 1),
    //              danach Eval-Gate prüfen (nur Root; §4 Schritt 12).
    //  - failed:   RetryPolicy — escalate -> Checkpoint + node-suspended + return suspended;
    //              fail -> Dead-Letter + return completed{stopped}.
    //  - suspended: Elicitation-Propagierung HOCH (§6). Policy/Parent auto-resolve -> continue;
    //               optional -> default + continue; blocking/parked/timeout -> Checkpoint +
    //               node-suspended + return suspended (resumebar via correlation-id, Inv. 12).
    private async *runBranchSteps(
        pack: FeaturePack,
        runId: string,
        branch: string,
        artifact: Artifact,
        budget: BudgetTracker,
        state: Record<string, unknown>,
        graph: GraphDefinition,
        gateType: string | undefined,
        startLastStepId: string | undefined,
        resumeAnswer?: { answer: unknown },
    ): AsyncGenerator<RunEvent, BranchOutcome, void> {
        const packVersion = pack.contentHash ?? pack.metadata.version;
        const isChild = branch.includes("/"); // Kind-Branch-id = parentBranch + "/" + itemId
        let lastStepId = startLastStepId;
        // Resume-Antwort wird GENAU an den ersten wieder-ausgeführten (= suspendierten) Step gereicht
        // und danach konsumiert (nachfolgende Steps in dieser Iteration sind Erst-Läufe).
        let pendingResume = resumeAnswer;
        let total: Cost = { usd: budget.charged() };
        const corr = (step: string, checkpoint: string): CorrelationId => ({
            run: runId,
            branch,
            step,
            checkpoint,
        });
        // Gate-Helfer: prüft (nur wenn gateType gesetzt) das Eval-Gate; faltet Gate-Kosten in `total`
        // und yieldet ein cost-delta. Liefert das Verdikt zurück.
        const checkGate = async function* (
            this: OuterLoopRunner,
        ): AsyncGenerator<RunEvent, GateVerdict | undefined, void> {
            if (gateType === undefined)
                return undefined;
            const gate = await this.runGate(gateType, artifact, runId, branch, budget, pack);
            if (gate.cost !== undefined) {
                total = addCost(total, gate.cost);
                const corrEnd = corr(`gate:${gateType}`, newStepCheckpointId());
                const gateCostEv: RunEvent = { type: "cost-delta", correlation: corrEnd, delta: gate.cost, total };
                this.emit(gateCostEv);
                yield gateCostEv;
            }
            this.applyVerdict(artifact, gateType, gate.verdict);
            return gate.verdict;
        }.bind(this);
        // Outer Loop (§4): bis Eval-Gate erfüllt ODER DONE ODER Budget/Tiefe erschöpft.
        const HARD_CAP = 10_000;
        let iterations = 0;
        while (iterations < HARD_CAP) {
            iterations += 1;
            // 4a′: Harter USD-Deckel (§v0.2, maxCostUsd). Anders als Budget/Tiefe ist das eine Geld-Grenze,
            // KEIN Verhandlungspunkt — der Lauf stoppt hart (root wie child), ohne Elicitation-Grant. Greift
            // nur, wenn Nodes echte cost.usd melden (sonst bleibt der Iterations-Bound das Backstop).
            if (budget.isOverCostCap()) {
                return { kind: "completed", gate: "stopped" };
            }
            // 4a: Budget/Tiefe erschöpft (Inv. 21, §4 Schritt 4a). Statt hart zu sterben, eskaliert der
            // Outer Loop als Elicitation an den Menschen ("mehr Budget/Tiefe freigeben?") + Checkpoint —
            // ein Resume mit mehr Budget/Tiefe setzt den Lauf an GENAU dieser Stelle fort. Nur der
            // ROOT-Branch eskaliert; ein KIND-Branch (von einer subworkflow gefächert) liefert weiter
            // gate:"stopped" zurück, damit der Parent-Subworkflow-Mechanismus (Geschwister + Resume-Pfad,
            // §6/§11/#6) unverändert bleibt — die Eskalation ist eine Run-Ebene-Entscheidung.
            if (budget.isExhausted() || budget.isAtMaxDepth()) {
                if (isChild) {
                    return { kind: "completed", gate: "stopped" };
                }
                const reason = budget.isExhausted() ? "Budget" : "Tiefe";
                const checkpointId = newStepCheckpointId();
                const correlation = corr("__budget__", checkpointId);
                const elicitation: Elicitation = {
                    what: `mehr Budget/Tiefe freigeben? (${reason} erschöpft)`,
                    whoCanAnswer: { machine: false }, // Spitze der Kette = Mensch (Inv. 11)
                    mode: "blocking", // Budget/Tiefe-Freigabe hält den Lauf an, bis ein Mensch entscheidet
                };
                yield* this.suspendBranch(runId, branch, checkpointId, correlation, state, lastStepId, budget, artifact, packVersion, elicitation, total, isChild ? graph : undefined, pack);
                return { kind: "suspended", mode: elicitation.mode, correlation };
            }
            // 5: nächsten Step im (Branch-)Graph holen.
            const next = nextEdge(graph, lastStepId, state);
            if (next === "DONE") {
                const verdict = yield* checkGate();
                return { kind: "completed", gate: verdict?.passed === true ? "passed" : "stopped" };
            }
            const step = next;
            const node = this.registry.resolve(step.type);
            const checkpointId = newStepCheckpointId();
            const correlation = corr(step.id, checkpointId);
            {
                const ev: RunEvent = { type: "step-started", correlation, nodeType: step.type };
                this.emit(ev);
                yield ev;
            }
            // 7: ctx bauen (policy-gescopt, security by absence). Der per-Iteration BudgetTracker reist mit
            // (Inv. 21): ctx.cost bindet daran, sodass ein delegierter agent-Call das echte Restbudget +
            // die Tiefe dieses Branches erbt (nie ein frisches).
            const parentPolicy = this.resolveRoot(pack);
            const ctx = this.injector.buildCtx(node, parentPolicy, correlation, artifact, budget, pendingResume);
            pendingResume = undefined; // nur der erste (suspendierte) Step erhält die Resume-Antwort.
            // 8: Node mit Retry ausführen (reine Funktion, Inv. 5). stepRef.suspend -> input.mode.
            const nodeInput = withSuspendMode(resolveInput(step, state), step);
            const result = await tryWithRetry(node, nodeInput, ctx, this.sandbox);
            // 9: Tape append (+ Audit: was injiziert war + Datenklassen-Redaction §11/#9).
            // Feature-Stempel aus dem TATSÄCHLICH laufenden Pack (für feature-ref-Kinder = das Sub-Feature-
            // Pack, das runBranchSteps als `pack` bekommt — NICHT die runContexts-Root). So tragen die
            // Frames eines via feature-ref gefahrenen Sub-Features dessen eigene Feature-id (6b-Korrektheit).
            await this.appendTape(runId, {
                correlation,
                feature: pack.metadata.id,
                nodeType: step.type,
                input: nodeInput,
                result,
                injected: PolicyInjector.serviceKeys(ctx),
                ts: new Date().toISOString(),
            }, parentPolicy.dataClassification);
            // 10/10b/11: Status-Verzweigung (inkl. 9b Budget-Dekrement im resolved-Pfad).
            if (result.status === "resolved") {
                budget.charge(result.cost);
                budget.tickIteration();
                total = addCost(total, result.cost);
                const ev: RunEvent = {
                    type: "node-resolved",
                    correlation,
                    confidence: result.confidence,
                    cost: result.cost,
                };
                this.emit(ev);
                yield ev;
                const costEv: RunEvent = { type: "cost-delta", correlation, delta: result.cost, total };
                this.emit(costEv);
                yield costEv;
                mergeOutput(state, step, result.output);
                await applyTo(artifact, result.output);
                const upd: RunEvent = { type: "artifact-updated", correlation, artifact: artifact.ref };
                this.emit(upd);
                yield upd;
                lastStepId = step.id;
                const verdict = yield* checkGate();
                if (verdict?.passed === true) {
                    return { kind: "completed", gate: "passed" };
                }
                continue;
            }
            if (result.status === "failed") {
                const retry = node.retry ?? DEFAULT_RETRY;
                if (retry.onExhausted === "escalate") {
                    // Die Fehlermeldung durch den Redactor scrubben, BEVOR sie in die Elicitation gefaltet wird
                    // (§11/#8, Inv. 15): result.error.message kann ein aufgelöstes Secret tragen (z.B. ein
                    // DB-Fehler, der ein getemplatetes Secret echot). Diese Elicitation wird als node-suspended
                    // RunEvent (Live-Stream) emittiert, in den Checkpoint persistiert UND als RunStatus.waitingOn
                    // exponiert — alle drei sind dieselbe Surface wie das Tape, also muss der Roh-Wert hier raus.
                    const msg = this.redactor?.redactString(result.error.message) ?? result.error.message;
                    const elicitation: Elicitation = {
                        what: `Node "${step.type}" failed: ${msg} — retry/skip/abbrechen?`,
                        whoCanAnswer: { machine: false },
                        mode: parentPolicy.suspendMode,
                    };
                    yield* this.suspendBranch(runId, branch, checkpointId, correlation, state, lastStepId, budget, artifact, packVersion, elicitation, total, isChild ? graph : undefined, pack);
                    return { kind: "suspended", mode: elicitation.mode, correlation };
                }
                await this.writeDeadLetter(runId, correlation, result);
                return { kind: "completed", gate: "stopped" };
            }
            // suspended (Inv. 11/12, §6 / §4 Schritt 11): Elicitation-Propagierung HOCH.
            {
                const elicitation = result.elicitation;
                const decision = this.propagate(pack, elicitation, state);
                if (decision.kind === "auto-resolved") {
                    this.feedAnswer(state, elicitation, decision.answer);
                    const ev: RunEvent = { type: "elicitation-resolved", correlation, by: decision.by };
                    this.emit(ev);
                    yield ev;
                    lastStepId = step.id;
                    const verdict = yield* checkGate();
                    if (verdict?.passed === true)
                        return { kind: "completed", gate: "passed" };
                    continue;
                }
                if (decision.kind === "optional-default") {
                    this.feedAnswer(state, elicitation, elicitation.default);
                    const ev: RunEvent = { type: "elicitation-resolved", correlation, by: "policy" };
                    this.emit(ev);
                    yield ev;
                    lastStepId = step.id;
                    const verdict = yield* checkGate();
                    if (verdict?.passed === true)
                        return { kind: "completed", gate: "passed" };
                    continue;
                }
                // blocking / parked / timeout: Checkpoint + node-suspended + return suspended.
                // parked (Inv. 12): der Checkpoint liegt, der Branch endet HIER — aber NUR dieser Branch;
                // Geschwister-Branches (subworkflow-Kinder) laufen weiter, weil der Aufrufer den nächsten
                // Kind-Branch fährt (§6). blocking verhält sich für DIESEN Branch identisch (er hält an);
                // der Unterschied ist, dass parked-Branches als Geschwister koexistieren.
                yield* this.suspendBranch(runId, branch, checkpointId, correlation, state, lastStepId, budget, artifact, packVersion, elicitation, total, isChild ? graph : undefined, pack);
                return { kind: "suspended", mode: elicitation.mode, correlation };
            }
        }
        // Hard-Cap erreicht (pathologischer Zyklus) -> stoppen.
        return { kind: "completed", gate: "stopped" };
    }
    /**
     * Speichert den Branch-Checkpoint, emittiert node-suspended und setzt den Live-Status auf
     * "suspended" (Inv. 12, §6). Gemeinsam genutzt vom Failed-escalate- und vom Suspend-Pfad. Bei
     * einem KIND-Branch (childGraph gesetzt) wird der synthetische Kind-Graph mit-gespeichert, damit
     * resume() den Kind-Branch ohne den Feature-Graphen rekonstruiert.
     */
    private async *suspendBranch(
        runId: string,
        branch: string,
        checkpointId: string,
        correlation: CorrelationId,
        state: Record<string, unknown>,
        lastStepId: string | undefined,
        budget: BudgetTracker,
        artifact: Artifact,
        packVersion: string,
        elicitation: Elicitation,
        total: Cost,
        childGraph: GraphDefinition | undefined,
        pack: FeaturePack,
    ): AsyncGenerator<RunEvent, void, void> {
        void branch;
        const cp: Checkpoint = {
            id: checkpointId,
            correlation,
            state: this.snapshot(state, lastStepId, budget, childGraph),
            artifactRef: artifact.ref,
            // Vollständiger Artefakt-Snapshot -> ein NEUER Prozess kann den Run-Kontext für Resume
            // rekonstruieren (Pack neu geliefert + Input aus Store + Artefakt hieraus deserialisiert).
            artifactSnapshot: await serializeArtifact(artifact),
            packVersion,
            pendingElicitation: elicitation,
            createdAt: new Date().toISOString(),
        };
        await this.store.saveCheckpoint(cp);
        // Diesen Branch als offen (parked/blocking) für den Run vormerken (Slice 2B).
        let parked = this.parkedByRun.get(runId);
        if (parked === undefined) {
            parked = new Set();
            this.parkedByRun.set(runId, parked);
        }
        parked.add(corrKey(correlation));
        // Status VOR dem yield setzen (+ persistieren): ein Consumer, der beim suspended-Event abbricht
        // (z.B. die CLI mit --no-prompt, die den Generator NICHT zu Ende iteriert), würde sonst den
        // "suspended"-Status nie erhalten — und ein persistenter Store (FileRunStore) hätte ihn nicht.
        this.setSuspendedStatus(correlation, pack, elicitation, total, artifact.ref);
        const ev: RunEvent = { type: "node-suspended", correlation, elicitation, mode: elicitation.mode };
        this.emit(ev);
        yield ev;
    }
    // ───────────────────────────── Child-Branch-Executor (Slice 2B, Inv. 8/12) ─────────────────────────────
    /**
     * Baut den ChildBranchExecutor für einen Run. Eine subworkflow-Node greift ihn via
     * ctx.correlation.run ab (siehe branch.ts) und fächert über ihn EINEN Kind-Branch pro forEach-Item.
     * Jeder Kind-Branch läuft durch den geteilten Step-Loop runBranchSteps() — gegen einen synthetischen
     * linearen Graphen aus spec.steps, mit EIGENEM branchState (kein Aliasing) und auf dem geteilten
     * Run-Artefakt (Inv. 22). Ein parked Kind blockt die Geschwister NICHT: runChild() liefert den
     * suspended-Outcome zurück, die subworkflow fährt mit dem nächsten Item fort (§6).
     *
     * Budget: jedes Kind läuft auf Kind-Tiefe 1 mit dem Run-Budget als Bound (Inv. 21). Volles
     * per-record Budget-Sharing/Idempotenz/Batch ist Slice 6 — hier nur der Branch-Mechanismus.
     */
    private makeChildExecutor(
        pack: FeaturePack,
        runId: string,
        artifact: Artifact,
    ): ChildBranchExecutor {
        const self = this;
        const rc = this.runContexts.get(runId);
        const rootBudget = rc !== undefined ? rc.input.budget : 0;
        const rootDepth = rc !== undefined ? rc.input.maxDepth : 0;
        const rootMaxCostUsd = rc !== undefined ? rc.input.maxCostUsd : undefined;
        return {
            async runChild(spec: ChildBranchSpec) {
                // feature-ref (§3): ein referenziertes Sub-Feature bringt seinen eigenen Graphen + Pack mit
                // (volle Topologie + eigene Governance); sonst der lineare subworkflow-Graph unter dem Parent-Pack.
                const graph = spec.graph ?? linearGraph(spec.steps);
                const childPack = spec.pack ?? pack;
                const state = structuredClone(spec.initialState);
                // Kind-Branch erbt das Restbudget auf Tiefe 1 (Inv. 21); kein frisches Run-Budget pro Kind.
                const budget = new BudgetTracker(rootBudget, rootDepth, 1, 0, 0, rootMaxCostUsd);
                const events = [];
                // runBranchSteps emittiert selbst in den Live-Stream (this.emit); die hier gesammelten Events
                // gibt der Aufrufer (subworkflow) NICHT erneut in den Stream — sie sind bereits geflossen.
                const gen = self.runBranchSteps(childPack, runId, spec.branch, artifact, budget, state, graph, undefined, // Kind-Branch hat kein eigenes Eval-Gate
                undefined);
                let res = await gen.next();
                while (!res.done) {
                    events.push(res.value);
                    res = await gen.next();
                }
                // completed Kind: per-item-Ergebnis disjoint-key in den db-state-Holder schreiben (keyed by
                // item id). parked Kinder schreiben hier NICHT — ihr Resume schreibt denselben Record (über
                // denselben Pfad in drive()), sodass das Artefakt unabhängig von der Resume-Reihenfolge
                // identisch wird (§11/#6: disjoint-key kollidiert nie).
                if (res.value.kind === "completed") {
                    await self.writeChildRecord(artifact, spec.branch, state);
                }
                return { events, outcome: res.value, finalState: state };
            },
        };
    }
    /**
     * Schreibt das Ergebnis eines completed Kind-Branches disjoint-key in den db-state-Holder des
     * Artefakts (Inv. 22, §11/#6). Der Record-key ist die item id = letztes "/"-Segment der branch id
     * (so deterministisch wie die subworkflow sie vergibt: parentBranch + "/" + itemId). Der Wert ist
     * der finale Kind-branchState. Idempotent (disjoint-key upsert): mehrfaches Schreiben desselben
     * id kollidiert nie und überschreibt deterministisch — daher ist das Artefakt unabhängig von der
     * Reihenfolge, in der parked Kinder resumed werden. Fehlt ein db-state-Holder, ist es ein No-op.
     */
    private async writeChildRecord(
        artifact: Artifact,
        branch: string,
        finalState: Record<string, unknown>,
    ): Promise<void> {
        const itemId = branch.slice(branch.lastIndexOf("/") + 1);
        for (const holder of Object.values(artifact.holders)) {
            if (holder.kind === "db-state" && holder.concurrency === "disjoint-key") {
                const dbHolder = holder as import("./artifact").DataHolder<{ id: string; result: unknown }[]>;
                await dbHolder.write([{ id: itemId, result: finalState }]);
                // content + Holder im Gleichschritt halten (Inv. 22 / §11/#5 Round-Trip): der Holder ist die
                // Quelle der per-record Sample-Ergebnisse, die reDerive unter content.records (= holderField
                // der db-state) zurückliest. Schreiben wir hier NUR in den Holder, trüge der live content
                // KEIN `records`-Feld, reDerive aber schon -> reDerive wäre nicht identitätserhaltend. Daher
                // den aktuellen Holder-Stand zugleich in content.records spiegeln, sodass live == re-derived.
                const content = artifact.content;
                if (typeof content === "object" && content !== null && !Array.isArray(content)) {
                    (content as Record<string, unknown>)["records"] = await dbHolder.read();
                }
                return;
            }
        }
    }
    // ───────────────────────────── Elicitation-Propagierung (§6, §4 Schritt 11) ─────────────────────────────
    /**
     * Propagiert eine Elicitation den Loop-Stack HOCH (§6 / Inv. 11):
     *  1. Policy-Interceptor-Stack innen->außen: das erste policy.intercept(e, ctxState), das
     *     { resolved:true } liefert, löst inline auf -> { by:"policy" }.
     *  2. Parent-State: trägt der branchState bereits die Antwort (vor-befüllt), auto-resolve
     *     -> { by:"parent" }.
     *  3. sonst nach Modus dispatchen:
     *       optional -> Default anwenden (-> "optional-default"), continue.
     *       blocking (und v0.1 auch parked/timeout = Teil B) -> "suspend" (Checkpoint + halt).
     *
     * Reine Entscheidung (kein I/O, kein yield): der Aufrufer (drive) emittiert die Events und
     * führt den Checkpoint/Resume- bzw. continue-Pfad aus.
     */
    private propagate(
        pack: FeaturePack,
        elicitation: Elicitation,
        branchState: Record<string, unknown>,
    ):
        | { kind: "auto-resolved"; by: "policy" | "parent"; answer: unknown }
        | { kind: "optional-default" }
        | { kind: "suspend" } {
        // 1) Policy-Interceptoren (innen->außen).
        for (const policy of this.policyStack(pack)) {
            const verdict = policy.intercept?.(elicitation, branchState);
            if (verdict !== undefined && verdict.resolved) {
                return { kind: "auto-resolved", by: "policy", answer: verdict.answer };
            }
        }
        // 2) Parent-State hält bereits die Antwort? (vor-befüllter branchState)
        const pre = this.parentStateAnswer(branchState, elicitation);
        if (pre.present) {
            return { kind: "auto-resolved", by: "parent", answer: pre.answer };
        }
        // 3) nach Modus dispatchen.
        if (elicitation.mode === "optional") {
            return { kind: "optional-default" };
        }
        // blocking / parked / timeout (parked+timeout = Teil B, v0.1 wie blocking): suspend.
        return { kind: "suspend" };
    }
    /**
     * Liest eine vor-befüllte Antwort aus dem branchState (Parent-State-Auto-Resolve, §6).
     * Konvention: NUR `branchState._answers[elicitation.what]` — die Antwort muss GEZIELT für GENAU
     * diese Elicitation (per `what`) hinterlegt worden sein. Es gibt bewusst KEINEN generischen
     * `branchState.answer`-Fallback mehr: ein generischer Slot würde JEDE spätere, andere Elicitation
     * im selben Branch fälschlich auto-resolven (Cross-Elicitation-Contamination, Inv. 11/12 / §6 —
     * jede Elicitation propagiert unabhängig). So hält eine unaufgelöste Elicitation nur ihren EIGENEN
     * Branch an, und ein zweites distinktes Approval-Gate verlangt seine eigene Antwort.
     *
     * Eine bereits konsumierte Antwort wird im `_consumed`-Set vermerkt, damit dieselbe keyed Antwort
     * nicht ein zweites Mal (für eine erneut auftretende gleiche Elicitation) verwendet wird.
     */
    private parentStateAnswer(
        branchState: Record<string, unknown>,
        elicitation: Elicitation,
    ): { present: true; answer: unknown } | { present: false } {
        const answers = branchState["_answers"];
        if (typeof answers === "object" && answers !== null && !Array.isArray(answers)) {
            const map = answers as Record<string, unknown>;
            if (elicitation.what in map && !this.isConsumed(branchState, elicitation.what)) {
                return { present: true, answer: map[elicitation.what] };
            }
        }
        return { present: false };
    }
    /**
     * Speist eine (auto-)aufgelöste Antwort GEZIELT für die aufgelöste Elicitation in den branchState:
     * keyed unter `_answers[elicitation.what]` und im `_consumed`-Set markiert (damit dieselbe Antwort
     * keine andere/spätere Elicitation auto-resolved). Ein generischer `state.answer` bleibt nur als
     * Downstream-Template-Komfort ({{state.answer}}) — parentStateAnswer konsultiert ihn NICHT.
     */
    private feedAnswer(branchState: Record<string, unknown>, elicitation: Elicitation, answer: unknown): void {
        this.recordAnswer(branchState, elicitation.what, answer);
        this.markConsumed(branchState, elicitation.what);
        branchState["answer"] = answer;
    }
    /** Schreibt eine Antwort gezielt unter `_answers[what]` (legt die Map bei Bedarf an). */
    private recordAnswer(branchState: Record<string, unknown>, what: string, answer: unknown): void {
        let map = branchState["_answers"] as Record<string, unknown> | undefined;
        if (typeof map !== "object" || map === null || Array.isArray(map)) {
            map = {};
            branchState["_answers"] = map;
        }
        map[what] = answer;
    }
    /** Markiert eine Elicitation (per `what`) als verbraucht — keyed Antwort wird nicht wiederverwendet. */
    private markConsumed(branchState: Record<string, unknown>, what: string): void {
        let consumed = branchState["_consumed"] as string[] | undefined;
        if (!Array.isArray(consumed)) {
            consumed = [];
            branchState["_consumed"] = consumed;
        }
        if (!consumed.includes(what))
            consumed.push(what);
    }
    /** Ob eine Elicitation (per `what`) bereits verbraucht wurde. */
    private isConsumed(branchState: Record<string, unknown>, what: string): boolean {
        const consumed = branchState["_consumed"];
        return Array.isArray(consumed) && consumed.includes(what);
    }
    // ───────────────────────────── Sub-Routinen ─────────────────────────────
    /**
     * Führt den Eval-Gate-Node gegen { artifact } aus und liest das GateVerdict (§4 Schritt 12).
     * Gibt zusätzlich die geladenen Gate-Kosten zurück, damit der Aufrufer sie in den Run-`total`
     * falten kann — sonst divergieren budget.charged() und der gemeldete Cost-Total (Inv. 15), sobald
     * ein Gate (z.B. LLM-Judge in Slice 3) reale Kosten hat.
     */
    private async runGate(
        gateType: string,
        artifact: Artifact,
        runId: string,
        branch: string,
        budget: BudgetTracker,
        pack: FeaturePack,
    ): Promise<{ verdict: GateVerdict | undefined; cost: Cost | undefined }> {
        if (!this.registry.has(gateType)) {
            // Kein Gate registriert -> behandeln wir als "nicht bestanden" (Runner stoppt via DONE/Budget).
            return { verdict: undefined, cost: undefined };
        }
        const node = this.registry.resolve(gateType);
        const checkpointId = newStepCheckpointId();
        const correlation: CorrelationId = { run: runId, branch, step: `gate:${gateType}`, checkpoint: checkpointId };
        // Gleiche aufgelöste Policy wie die Haupt-Step-Schleife (resolveRoot), damit das Gate gegen
        // dieselbe Governance scoped wird wie jeder andere Node (sonst inkonsistent, sobald
        // resolveRoot pack.feature.policies honoriert).
        const parentPolicy = this.resolveRoot(pack);
        const ctx = this.injector.buildCtx(node, parentPolicy, correlation, artifact, budget);
        const result = await tryWithRetry(node, { artifact, value: artifact }, ctx, this.sandbox);
        let cost: Cost | undefined;
        if (result.status === "resolved") {
            budget.charge(result.cost);
            cost = result.cost;
        }
        await this.appendTape(runId, {
            correlation,
            nodeType: gateType,
            input: { artifact: artifact.ref },
            result,
            injected: PolicyInjector.serviceKeys(ctx),
            ts: new Date().toISOString(),
        }, parentPolicy.dataClassification);
        return { verdict: asVerdict(result), cost };
    }
    /** Schreibt das Gate-Verdikt in artifact.evalState (Inv. 1). */
    private applyVerdict(artifact: Artifact, gate: string, verdict: GateVerdict | undefined): void {
        if (verdict === undefined) {
            artifact.evalState = { gate, passed: false };
            return;
        }
        const evalState: NonNullable<Artifact["evalState"]> = { gate, passed: verdict.passed };
        if (verdict.score !== undefined)
            evalState.score = verdict.score;
        artifact.evalState = evalState;
    }
    /**
     * Sauberer Run-Abschluss, sobald KEINE parked Branches mehr offen sind. Auf dem FINALEN
     * parked-Child-Resume (`reRunGate`) wird das Feature-Eval-Gate gegen das geteilte Artefakt
     * RE-evaluiert — der Child-Step-Loop lief ohne Gate (gate:"stopped"), aber das Feature-Gate ist
     * die Autorität für den Run-Abschluss (Inv. 1, §4 Schritt 12). So kippt ein Gate, das erst
     * konvergiert, wenn alle parked Branches fertig sind, korrekt auf "passed". Auf dem normalen
     * Root-Pfad (`reRunGate=false`) ist `branchGate` bereits das Ergebnis des im Loop gelaufenen Gates.
     * Räumt zusätzlich etwaige run-weite "suspended"-Phantom-Status auf (Inv. 12: resolved -> done).
     */
    private async *completeRun(
        runId: string,
        branch: string,
        artifact: Artifact,
        pack: FeaturePack,
        total: Cost,
        reRunGate: boolean,
        branchGate: "passed" | "stopped",
    ): AsyncGenerator<RunEvent, void, void> {
        let gate = branchGate;
        if (reRunGate) {
            const gateType = pack.feature.artifact.evalGate;
            const budget = new BudgetTracker(0, 0, 0, 0); // Gate-Kosten in `total` falten, kein Bound nötig
            const res = await this.runGate(gateType, artifact, runId, branch, budget, pack);
            if (res.cost !== undefined) {
                total = addCost(total, res.cost);
                const corrCost: CorrelationId = {
                    run: runId,
                    branch,
                    step: `gate:${gateType}`,
                    checkpoint: newStepCheckpointId(),
                };
                const costEv: RunEvent = { type: "cost-delta", correlation: corrCost, delta: res.cost, total };
                this.emit(costEv);
                yield costEv;
            }
            this.applyVerdict(artifact, gateType, res.verdict);
            gate = res.verdict?.passed === true ? "passed" : "stopped";
        }
        yield* this.complete(runId, branch, artifact, gate, pack, total);
        // Run ist sauber fertig: etwaige zurückgebliebene "suspended"-Status dieses Runs entfernen
        // (Inv. 12 — alle Branches resolved -> done; ein Approval-Inbox-Dashboard darf keinen
        // Phantom-"suspended" mehr sehen). Der frische "done"-Eintrag bleibt.
        this.clearRunSuspended(runId);
    }
    /** Emittiert run-completed + setzt den Live-Status auf "done". */
    private async *complete(
        runId: string,
        branch: string,
        artifact: Artifact,
        gate: "passed" | "stopped",
        pack: FeaturePack,
        total: Cost,
    ): AsyncGenerator<RunEvent, void, void> {
        const correlation: CorrelationId = {
            run: runId,
            branch,
            step: "__end__",
            checkpoint: "__end__",
        };
        const ev: RunEvent = { type: "run-completed", correlation, artifact: artifact.ref, gate };
        this.emit(ev);
        // RunStatus.feature + cost tragen (wie setSuspendedStatus): liveStatus()/Approval-Inbox
        // identifizieren den Run am Feature und zeigen die akkumulierten Kosten (Inv. 15).
        this.setStatus({
            correlation,
            feature: pack.metadata.id,
            phase: "done",
            cost: total,
            artifact: artifact.ref,
        });
        yield ev;
        await Promise.resolve();
    }
    /** Snapshot des Branch-State für einen Checkpoint (rehydrierbar im resume). */
    private snapshot(
        state: Record<string, unknown>,
        lastStepId: string | undefined,
        budget: BudgetTracker,
        childGraph: GraphDefinition | undefined,
    ): SerializedBranchState {
        const snap: SerializedBranchState = {
            branchState: structuredClone(state),
            lastStepId,
            spent: budget.charged(),
            depth: budget.depth,
            iterations: budget.iterationCount(),
        };
        // Kind-Branch (von einer subworkflow gefächert): den synthetischen Kind-Graphen mit-pinnen,
        // damit resume() den Branch ohne den Feature-Graphen rekonstruiert (Slice 2B).
        if (childGraph !== undefined)
            snap.childGraph = childGraph;
        return snap;
    }
    private loadOrCreateArtifact(pack: FeaturePack, input: RunInput): Artifact {
        // Slice 1: immer frisches Artefakt aus dem Feature-Typ. (Persistente Wiederaufnahme = später.)
        void input;
        const kind = pack.feature.artifact.kind;
        const type = this.artifactTypes[kind] ?? { kind, holders: ["memory", "progress.md"] };
        return createArtifact(type, {});
    }
    /**
     * §4 Schritt 2: policyRoot = resolvePolicies(pack.feature.policies) über den Root gefaltet
     * (tighten-only, Inv. 13). Die deklarierten Policy-ids werden gegen die PolicyRegistry zu
     * Policy-Objekten aufgelöst und in Deklarationsreihenfolge via applyPolicy()/enforceTightenOnly()
     * über den Root gefaltet — jede Ebene kann nur verschärfen.
     *
     * Ein Feature darf NIE ungoverned laufen (FeatureDefinition.policies-Contract): deklariert es
     * Policies, aber es ist KEINE Registry verdrahtet, wird das explizit abgelehnt (statt die
     * Governance still zu verwerfen). Eine fehlende Policy-id wirft in resolvePolicies().
     */
    private resolveRoot(pack: FeaturePack): ResolvedPolicy {
        const root = this.rootPolicyOverride ?? rootPolicy();
        const stack = this.policyStack(pack);
        // inner->outer: jede deklarierte Policy faltet (verschärft) über den bisher resolvten Stand.
        return stack.reduce((resolved, policy) => applyPolicy(resolved, policy), root);
    }
    /**
     * Löst den Policy-Interceptor-Stack eines Features auf (Inv. 11/13, §6). Reihenfolge =
     * Deklarationsreihenfolge in pack.feature.policies (inner->outer für die Propagierung).
     * Wirft, wenn Policies deklariert sind, aber keine PolicyRegistry verdrahtet ist — ein Feature
     * darf nicht ungoverned laufen (§4 Schritt 2). Ohne deklarierte Policies = leerer Stack.
     */
    private policyStack(pack: FeaturePack): Policy[] {
        const declared = pack.feature.policies;
        if (declared === undefined || declared.length === 0)
            return [];
        if (this.policyRegistry === undefined) {
            throw new Error(`OuterLoopRunner: feature "${pack.metadata.id}" deklariert Policies [${declared.join(", ")}], ` +
                `aber es ist keine Policy-Registry verdrahtet. Ein Feature darf nicht ungoverned laufen ` +
                `(§4 Schritt 2) — registriere die Policies oder entferne sie aus dem Pack.`);
        }
        return resolvePolicies(declared, this.policyRegistry);
    }
    private async appendTape(
        runId: string,
        frame: TapeFrame,
        dataClassification?: ResolvedPolicy["dataClassification"],
    ): Promise<void> {
        // Datenklassen-Stempel (§11/#9, Inv. 16/23): die resolvte Datenklasse des Runs wird als
        // redaction.level mitgeführt. Der Redactor liest sie als Projektions-Schwelle — Felder ÜBER der
        // Klasse landen als Hash/Ref im Tape, Felder ≤ Klasse bleiben roh. Ohne Redactor bleibt der
        // Stempel als reine Audit-Annotation am Frame (kein Datenleck, da nichts projiziert werden muss,
        // solange kein Feld über der Schwelle liegt; die Projektion ist die Aufgabe des Redactors).
        // Feature-Stempel (6b): das Feature des Runs an den Frame heften (TapeFrame trägt sonst keins),
        // damit traces:<feature>-Scoping + feature-genaue Miner/Shadow-Eval greifen. Quelle = der für den
        // Run gepinnte Pack (runContexts); best-effort (fehlt der Kontext, bleibt feature undefined).
        const feature = this.runContexts.get(runId)?.pack.metadata.id;
        const withFeature =
            feature !== undefined && frame.feature === undefined ? { ...frame, feature } : frame;
        const stamped = dataClassification === undefined
            ? withFeature
            : { ...withFeature, redaction: { level: dataClassification, redactedFields: [] } };
        // Auto-Redaction (§11/#8/#9): registrierte Secret-Werte + über-der-Schwelle-Felder scrubben, BEVOR
        // der Frame persistiert.
        const safe = this.redactor !== undefined ? this.redactor.redactFrame(stamped) : stamped;
        await this.store.appendTape(runId, safe);
    }
    /**
     * Dead-Letter (§4 Schritt 10b): hält das endgültig fehlgeschlagene Result fest. v0.1 als
     * dedizierter Tape-Frame (das eigentliche Failed steht schon im regulären Frame); persistente
     * Dead-Letter-Queues docken am selben Store-Interface an.
     */
    private async writeDeadLetter(runId: string, correlation: CorrelationId, result: NodeResult): Promise<void> {
        // Über die GETEILTE appendTape()-Hilfe schreiben (NICHT this.store.appendTape direkt), damit der
        // Frame durch redactor.redactFrame() läuft (§11/#8/#9, Inv. 15). Das dead-letter result ist das
        // volle Failed-Objekt; result.error.message kann ein aufgelöstes Secret tragen (z.B. ein DB-Fehler,
        // der ein getemplatetes Secret echot) — der scoped SecretsService hat den Wert beim Redactor
        // registriert, also wird er hier auto-maskiert, bevor der Frame persistiert. Dies war der einzige
        // Tape-Append, der den Redactor umging.
        await this.appendTape(runId, {
            correlation,
            nodeType: "dead-letter",
            input: { reason: "node failed, onExhausted=fail" },
            result,
            injected: [],
            ts: new Date().toISOString(),
        });
    }
    /** Publiziert ein Event in den Live-Stream (falls der Store das unterstützt). */
    private emit(ev: RunEvent): void {
        if (isInMemoryStore(this.store)) {
            this.store.publish(ev);
        }
    }
    private setStatus(status: RunStatus): void {
        if (isInMemoryStore(this.store)) {
            this.store.setStatus(status);
        }
    }
    /** Entfernt den (suspended-)Status-Eintrag einer correlation-id (Slice 2B; siehe Store-Doc). */
    private clearStatus(id: CorrelationId): void {
        if (isInMemoryStore(this.store)) {
            this.store.clearStatus(id);
        }
    }
    /**
     * Entfernt beim sauberen Run-Abschluss alle noch auf "suspended" stehenden Status-Einträge dieses
     * Runs (Inv. 12: resolved -> done). Jeder resumte Branch löscht beim Resume bereits seinen eigenen
     * suspended-Eintrag; dies ist die defensive Schluss-Bereinigung, damit liveStatus() keinen
     * Phantom-"suspended" neben dem frischen "done" mehr zeigt.
     */
    private clearRunSuspended(runId: string): void {
        if (isInMemoryStore(this.store)) {
            this.store.clearSuspendedForRun(runId);
        }
        this.parkedByRun.delete(runId);
    }
    private setSuspendedStatus(
        correlation: CorrelationId,
        pack: FeaturePack,
        waitingOn: Elicitation,
        cost: Cost,
        artifact: import("./artifact").ArtifactRef,
    ): void {
        this.setStatus({
            correlation,
            feature: pack.metadata.id,
            phase: "suspended",
            step: correlation.step,
            waitingOn,
            cost,
            artifact,
        });
    }
}
