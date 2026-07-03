// ───────────────────────────── Claude transport contract (the pluggable seam) ─────────────────────────────
// The ClaudeAgentEngine is OPAQUE (Inv. 18): it does NOT route per-call through ctx.model. Instead it maps
// one ELIO session turn onto a single ClaudeTransport.run(req) call and maps the result back. The transport
// is PLUGGABLE on purpose (auth context, decided): the Agent SDK is the preferred transport but BILLS VIA
// API KEY; `claude -p` reuses the user's Claude-Code SUBSCRIPTION. We therefore do NOT hard-wire either —
// registerClaudeAdapter selects the transport (default: agent-sdk).
//
// HONESTY DISCIPLINE (impl-decisions): the ONLY transport the tests exercise is FakeTransport (deterministic,
// offline — no key, no network, no real claude/SDK). AgentSdkTransport and ClaudeCliTransport COMPILE and are
// type-correct but are GUARDED (only used when a key/SDK/CLI is present) and are NOT exercised by tests. Do
// NOT read a green test run as evidence that a real Claude call works — it never makes one.

import type { Cost, Elicitation } from "@elio/core";

/**
 * The request the engine hands the transport for ONE ELIO session turn. This is the HULL the opaque
 * black-box agent is governed by (Inv. 18): the resolved task prompt, the working directory, a memory
 * slice, the inherited+decremented budget/depth (Inv. 21), the resolved model id hint, and the resolved
 * credential env (creds/scopes from ctx.secrets). There is NO per-call model hook — opaque means the
 * agent picks its own model internally; ELIO governs the HULL, not each call.
 */
export interface ClaudeTransportRequest {
  /** The resolved task prompt the agent works on (from contract.input). */
  prompt: string;
  /** Optional system prompt (HULL: task framing). */
  system?: string;
  /** Working directory the black-box agent runs in (HULL: cwd). */
  cwd?: string;
  /** A memory slice passed across the boundary (opaque to ELIO; the agent may use it). */
  memorySlice?: unknown;
  /** Model id hint (HULL only — the opaque agent may override internally; NOT per-call governance). */
  model?: string;
  /**
   * Inherited REMAINING budget for this turn (Inv. 21 — NEVER fresh). The transport may surface it to the
   * agent (e.g. as a task budget) and MUST treat exceeding it as the hull's ceiling.
   */
  budget: number;
  /** Inherited depth of THIS turn (already decremented across the boundary by the engine, Inv. 21). */
  depth: number;
  /** The depth ceiling (Inv. 21). */
  maxDepth: number;
  /**
   * Resolved credential env (HULL: injected creds/scopes). Names map to resolved secret VALUES — the engine
   * resolves these via ctx.secrets BEFORE handing them to the transport, so the transport never touches the
   * SecretsService directly. Empty when the node was not cleared for any secret (security by absence).
   */
  env?: Record<string, string>;
}

/**
 * What a transport returns for one turn. Exactly one of `text`/`output` (a resolved result) OR `elicitation`
 * (the black-box agent asked a question that must propagate UP, Inv. 11). `cost` is the HULL budget charge
 * (opaque: a single per-turn figure, NOT per-model-call accounting).
 */
export interface ClaudeTransportResult {
  /** Primary textual reply (resolved). */
  text?: string;
  /** Structured output if the transport produced one (resolved); surfaced opaquely. */
  output?: unknown;
  /** Set when the agent raised an elicitation — propagates UP as an ELIO Suspended (Inv. 11). */
  elicitation?: Elicitation;
  /** HULL budget charge for this turn (Inv. 18/21). */
  cost?: Cost;
}

/**
 * The pluggable transport seam. One method: run one ELIO turn -> one Claude turn. THREE implementations
 * exist (FakeTransport, AgentSdkTransport, ClaudeCliTransport); registerClaudeAdapter selects which.
 */
export interface ClaudeTransport {
  /** Stable id of this transport ("fake" | "agent-sdk" | "claude-cli") — for audit/onPath. */
  readonly kind: string;
  run(req: ClaudeTransportRequest): Promise<ClaudeTransportResult>;
}
