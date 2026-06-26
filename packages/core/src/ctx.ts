// ───────────────────────────── ctx: injizierte, policy-gescopte Services (Inv. 5/14/17) ─────────────────────────────
// Jeder Service ist optional: Was nicht injiziert wurde, KANN die Node nicht (security by absence).
// Es gibt KEINEN runtime permission-check.

import type { Cost } from "./common";
import type { CorrelationId, Elicitation, SuspendMode } from "./elicitation";
import type { Artifact } from "./artifact";
import type { ResolvedPolicy } from "./policy";
import type { Suspended } from "./node";
import type { SessionContract, SessionResult } from "./session";

// ctx.model = roher Completion-Pfad; dahinter der LLM-Worker (concurrency-gated, pro Provider). Inv. 17.
export interface ModelService {
  complete(req: unknown): Promise<{ text: string; cost: Cost; confidence: number }>;
  /** Streaming speist RunEvents → Studio-Live-Status (Inv. 15). */
  stream?(req: unknown): AsyncIterable<{ delta: string } | { done: { cost: Cost; confidence: number } }>;
}

// ctx.agent = Inner-Loop-Pfad. Pluggable Engine: Vela, Claude Code, Copilot CLI, Foundry Agents (Inv. 17/18).
export interface AgentService {
  session(contract: SessionContract): Promise<SessionResult>;
}

export interface MemoryService {
  slice(): Promise<unknown>;
  write(x: unknown): Promise<void>;
}
export interface LoggerService {
  log(x: unknown): void;
}
export interface AuditService {
  record(x: unknown): void;
}
export interface CostService {
  charge(c: Cost): void;
  remaining(): number;
}
export interface FsService {
  read(p: string): Promise<string>;
  write(p: string, c: string): Promise<void>;
}
export interface DbService {
  query(q: string, p?: unknown[]): Promise<unknown[]>;
}
export interface HttpService {
  fetch(url: string, init?: unknown): Promise<unknown>;
}

// ───────────────────────────── Secrets: policy-gescopte Handles (§11/#8) ─────────────────────────────
/** Referenziert ein Secret per Name — NIE inline. Auflösung erst im (gesandboxten) Injector. */
export interface SecretRef {
  name: string;
}
export interface SecretsService {
  resolve(ref: SecretRef): Promise<string>;
  has(name: string): boolean;
}

export interface ElicitService {
  /** Erzeugt ein Suspended-Result; der Runner propagiert es hoch. */
  raise(e: Omit<Elicitation, "mode"> & { mode?: SuspendMode }): Suspended;
}

export interface Ctx {
  readonly correlation: CorrelationId;
  readonly artifact: Artifact; // immer present: das Ziel

  // delegierte Intelligenz (Inv. 7, Klasse 2) — gescopt auf erlaubte Modelle (Inv. 13)
  readonly model?: ModelService;
  readonly agent?: AgentService; // Vela optional als Inner Loop (Inv. 8)

  // cross-cutting, NIE als Step (Inv. 5)
  readonly logger?: LoggerService;
  readonly memory?: MemoryService; // gescopt auf erlaubten memory-slice (Inv. 3)
  readonly audit?: AuditService;
  readonly cost?: CostService; // gescopt auf Budget (Inv. 3)

  // Suspend/Resume nach oben (Inv. 11)
  readonly elicit?: ElicitService;

  // side-effecting capabilities — nur wenn Policy sie injiziert (Inv. 14)
  readonly fs?: FsService; // gescopt auf erlaubte Pfade
  readonly db?: DbService; // gescopt auf erlaubte Connections/Tabellen
  readonly http?: HttpService;
  readonly secrets?: SecretsService; // policy-gescopte Secret-Handles; NIE inline, auto-redacted

  // read-only Sicht der für diese Node geltenden Policy (Inv. 13)
  readonly policy: ResolvedPolicy;
}
