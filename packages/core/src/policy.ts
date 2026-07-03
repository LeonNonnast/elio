import type { CorrelationId, Elicitation, SuspendMode } from "./elicitation";
import type { Artifact } from "./artifact";
import type { Ctx } from "./ctx";
import type { NodeDefinition } from "./node";
import type { BudgetTracker } from "./cost";
export interface CapabilityRequest {
    models?: string[];
    cloud?: boolean;
    fs?: {
        read?: string[];
        write?: string[];
    };
    db?: string[];
    /**
     * http-Request-Achse (§v0.2): erlaubte Hosts, analog zu `db`-Scopes. Ein Eintrag ist ein Host
     * (z.B. "api.example.com") oder "*" für "jeder Host". Leer/fehlend = kein Netzzugang. tighten()
     * schneidet gegen den Parent (nur verschärfen, Inv. 13); der Injector setzt `ctx.http` NUR, wenn
     * nach dem Verschärfen Hosts übrig bleiben (security by absence, Inv. 14).
     */
    http?: string[];
    tools?: string[];
}
export interface ResolvedPolicy {
    allowedModels: string[];
    allowCloud: boolean;
    dataClassification: "public" | "internal" | "confidential" | "private" | "regulated";
    /**
     * Per-Policy/per-Node Cost-Cap. v0.1: RESOLVED (tighten = min über den Stack), aber NICHT enforced —
     * die harte Budget-Durchsetzung läuft run-weit über den BudgetTracker (Inv. 21). Ein node-lokaler
     * Cost-Cap (eine Node/Agent-Loop, die ihr per-Node-Budget überschreitet, suspendiert/failt) ist
     * späteren Slices vorbehalten. Bis dahin ist dies ein aufgelöstes, aber inaktives Governance-Feld —
     * NICHT als aktive Kontrolle verstehen.
     */
    maxCostUsd?: number;
    suspendMode: SuspendMode;
    fsPaths?: {
        read: string[];
        write: string[];
    };
    dbScopes?: string[];
    /**
     * Erlaubte HTTP-Hosts nach dem Verschärfen (§v0.2), analog zu `dbScopes`. "*" = jeder Host.
     * Fehlt/leer -> der Injector setzt kein `ctx.http` (security by absence, Inv. 14).
     */
    httpHosts?: string[];
    toolPermissions: string[];
}
export interface Policy {
    id: string;
    /**
     * Interceptor auf dem Injection-Pfad (runter) und dem Elicitation-Pfad (hoch).
     * Vertrag: darf NUR verschärfen. Eine Policy kann eine angeforderte Capability
     * entziehen/einschränken, niemals eine nicht-angeforderte hinzufügen.
     */
    scope(req: CapabilityRequest, parent: ResolvedPolicy): ResolvedPolicy;
    /** Kann eine hochpropagierende Elicitation auto-resolven (Inv. 11). */
    intercept?(e: Elicitation, ctxState: unknown): {
        resolved: true;
        answer: unknown;
    } | {
        resolved: false;
    };
}
export interface Injector {
    /**
     * Baut das gescopte ctx für genau diese Node:
     *  resolved = tighten(parentPolicy, node.requests)   // Inv. 13
     *  ctx      = nur die Services, die `resolved` erlaubt  // Inv. 14: security by absence
     *
     * `budget` (Inv. 21): der per-Iteration BudgetTracker des laufenden (Sub-)Branches. Wird er
     * übergeben, bindet der Injector `ctx.cost` an GENAU diesen Tracker — so erbt ein delegierter Call
     * (agent-Node -> AgentEngine) über ctx.cost das echte Restbudget + die Tiefe (nie ein frisches).
     * Fehlt er, fällt der Injector auf seinen optional konfigurierten Default-Tracker zurück.
     */
    buildCtx(node: NodeDefinition, parent: ResolvedPolicy, correlation: CorrelationId, artifact: Artifact, budget?: BudgetTracker, resume?: {
        answer: unknown;
    }): Ctx;
}
