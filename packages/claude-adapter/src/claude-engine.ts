// ───────────────────────────── ClaudeAgentEngine (id "claude-code", governance "opaque", Inv. 17/18/21) ─────────────────────────────
//
// The OPAQUE counterpart to the transparent VelaAgentEngine / InProcessAgentEngine. An agent node with
// routing.agentEngine="claude-code" delegates one inner-loop turn (Inv. 17) to a black-box Claude Code agent
// via a pluggable ClaudeTransport. Because the agent is a black box, governance DEGRADES TO THE HULL (Inv.
// 18 — opaque vs transparent):
//
//   transparent (Vela/in-process): every model call flows through ctx.model -> full per-call governance.
//   OPAQUE (this engine):          NO per-call model hook. ELIO governs only the HULL around the box:
//      - cwd                  (where the agent runs)               -> ClaudeTransportRequest.cwd
//      - injected creds/scopes(resolved via ctx.secrets, see below)-> ClaudeTransportRequest.env
//      - task prompt          (the resolved instruction)           -> ClaudeTransportRequest.prompt/system
//      - sandbox              (the transport's own confinement)    -> transport-specific (cwd + env)
//      - budget               (inherited remaining, Inv. 21)       -> ClaudeTransportRequest.budget
//      - depth                (inherited + decremented, Inv. 21)   -> ClaudeTransportRequest.depth/maxDepth
//      - output-gate          (a hook run on the agent's result)   -> opts.outputGate
//   It does NOT route per-call through ctx.model (that is the whole point of "opaque").
//
// Inv. 21 (budget+depth inherited + decremented, NEVER fresh): identical discipline to VelaAgentEngine —
//   - depth ceiling checked HERE before any transport call (contract.depth >= contract.maxDepth -> Elicitation
//     UP; no silent nesting, no hard crash).
//   - the contract.budget (the REMAINING budget threaded down by the agent node via ctx.cost.remaining())
//     is passed to the transport as the turn's ceiling — NEVER a fresh constant. The HULL cost the transport
//     reports rides back up in SessionResult.result.cost and is charged to the shared ctx.cost tracker so the
//     OUTER budget stays correct (just like a transparent engine, but a single per-turn figure).
//
// Inv. 11 (elicitation propagates up): a transport that raises an Elicitation (the black-box agent asked a
// question) is mapped to { elicitation } -> the agent node returns a Suspended -> the Outer Runner can
// checkpoint/resume. This is REACHABLE and tested (via FakeTransport), unlike Vela's block path.
//
// CREDS (Inv. 14): the engine resolves the node's allowed secrets via ctx.secrets BEFORE the transport runs,
// so the transport never touches the SecretsService. Only policy-allowed names resolve (security by absence);
// the resolved VALUES are auto-redacted from the Loop Tape by the SDK's TapeRedactor.

import type {
  AgentEngine,
  Cost,
  Ctx,
  Elicitation,
  Resolved,
  SecretRef,
  SessionContract,
  SessionResult,
} from "@elio/core";
import type { ClaudeTransport, ClaudeTransportRequest, ClaudeTransportResult } from "./claude-contract";

/** The (template-resolved) agent config the agent node passes as contract.input. */
export interface ClaudeAgentInput {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  model?: string;
  /** Working directory the black-box agent runs in (HULL: cwd). */
  cwd?: string;
  /**
   * Secret NAMES this turn needs injected as env (HULL: injected creds/scopes). The engine resolves each via
   * ctx.secrets (only policy-allowed ones survive) and hands the transport the resolved VALUES. The map key
   * is the ENV VAR NAME the agent expects; the value is the SECRET NAME to resolve.
   */
  secretEnv?: Record<string, string>;
}

/** Hook to gate / transform the black-box agent's output before it becomes the node result (HULL: output-gate). */
export type OutputGate = (
  result: ClaudeTransportResult,
  contract: SessionContract,
) => ClaudeTransportResult | Promise<ClaudeTransportResult>;

export interface ClaudeAgentEngineOptions {
  /** The pluggable transport (Inv. 18). REQUIRED — registerClaudeAdapter supplies the default (agent-sdk). */
  transport: ClaudeTransport;
  /** Output-gate hook (HULL governance): runs on the transport result before it is mapped to the node result. */
  outputGate?: OutputGate;
  /** Observe which path a turn took ("resolved" | "elicitation" | "ceiling") — for tests + audit. Optional. */
  onPath?: (path: "resolved" | "elicitation" | "ceiling", meta?: string) => void;
}

export class ClaudeAgentEngine implements AgentEngine {
  /** Engine id — an agent node with routing.agentEngine="claude-code" selects THIS engine. */
  readonly id = "claude-code";
  /**
   * OPAQUE (Inv. 18): a black-box coding agent. Governance degrades to the HULL (cwd, injected creds/scopes,
   * task prompt, sandbox, budget, output-gate). NO per-call model governance — never routes through ctx.model.
   */
  readonly governance = "opaque" as const;

  private readonly transport: ClaudeTransport;
  private readonly outputGate: OutputGate | undefined;
  private readonly onPath: ClaudeAgentEngineOptions["onPath"];

  constructor(opts: ClaudeAgentEngineOptions) {
    this.transport = opts.transport;
    this.outputGate = opts.outputGate;
    this.onPath = opts.onPath;
  }

  /**
   * Inner-loop run (Inv. 17). Inherits REMAINING budget + depth from the contract (never fresh, Inv. 21):
   * the depth ceiling is checked HERE before any transport call (the black-box agent has no ELIO depth
   * semantics). depth>=maxDepth -> Elicitation UP (no silent nesting, no hard crash).
   */
  async run(contract: SessionContract, ctx: Ctx): Promise<SessionResult> {
    // ── Inv. 21 (depth ceiling) — enforced by ELIO, not the black box. Same guard as the transparent
    //    engines so behaviour is uniform regardless of which engine runs. ──
    if (contract.depth >= contract.maxDepth) {
      this.onPath?.("ceiling");
      const elicitation: Elicitation = {
        what:
          `claude inner loop: Tiefen-Limit erreicht (depth=${contract.depth} >= maxDepth=${contract.maxDepth}) ` +
          `— mehr Tiefe freigeben? (Inv. 21)`,
        whoCanAnswer: { users: ["operator"] },
        mode: "blocking",
      };
      return { elicitation };
    }

    const input = (contract.input ?? {}) as ClaudeAgentInput;
    const prompt = resolvePrompt(input);

    // ── HULL: injected creds/scopes (Inv. 14). Resolve only policy-allowed secrets via ctx.secrets; the
    //    transport never touches the SecretsService. Resolved values are auto-redacted from the Tape. ──
    const env = await resolveSecretEnv(input.secretEnv, ctx);

    // ── Build the HULL request. budget + depth are INHERITED from the contract (Inv. 21, NEVER fresh):
    //    contract.budget = the remaining budget the agent node read off ctx.cost.remaining(); contract.depth
    //    is already childDepth (parentDepth+1) — decremented across the boundary by the node. ──
    const req: ClaudeTransportRequest = {
      prompt,
      budget: contract.budget,
      depth: contract.depth,
      maxDepth: contract.maxDepth,
    };
    if (typeof input.system === "string") req.system = input.system;
    if (typeof input.cwd === "string") req.cwd = input.cwd;
    if (contract.memorySlice !== undefined) req.memorySlice = contract.memorySlice;
    // Model is a HULL hint only (opaque): prefer the input, else the routing hint. NOT per-call governance.
    const modelHint = input.model ?? contract.routing?.models?.[0];
    if (typeof modelHint === "string") req.model = modelHint;
    if (env !== undefined) req.env = env;

    // ── Run the opaque black box (one ELIO turn -> one transport turn). ──
    let result = await this.transport.run(req);

    // ── HULL: output-gate (runs before the result becomes the node output). ──
    if (this.outputGate !== undefined) {
      result = await this.outputGate(result, contract);
    }

    // ── Inv. 11: a raised elicitation propagates UP as an ELIO Suspended the runner can checkpoint/resume. ──
    if (result.elicitation !== undefined) {
      this.onPath?.("elicitation");
      return { elicitation: result.elicitation };
    }

    // ── HULL budget charge (Inv. 18/21): a single per-turn figure (opaque — not per-call). Charge the shared
    //    ctx.cost tracker so the OUTER budget stays correct, exactly like a transparent engine's model call. ──
    const cost: Cost = result.cost ?? {};
    if (ctx.cost !== undefined && (cost.usd !== undefined || cost.tokensIn !== undefined || cost.tokensOut !== undefined)) {
      ctx.cost.charge(cost);
    }

    this.onPath?.("resolved");
    const resolved: Resolved<{ text: string }> = {
      status: "resolved",
      output: { text: result.text ?? coerceText(result.output) },
      // Opaque agent gives no calibrated confidence; report 1 (it returned a result) — the gate judges quality.
      confidence: 1,
      cost,
    };
    return { result: resolved };
  }
}

/** Resolve the prompt text from the (template-resolved) agent config. */
function resolvePrompt(input: ClaudeAgentInput): string {
  if (typeof input.prompt === "string") return input.prompt;
  if (Array.isArray(input.messages) && input.messages.length > 0) {
    const last = input.messages[input.messages.length - 1];
    return String(last?.content ?? "");
  }
  throw new Error(
    "ClaudeAgentEngine: kein Prompt — erwartet `prompt` ODER `messages` im SessionContract.input.",
  );
}

/**
 * Resolve the node's secret env via ctx.secrets (Inv. 14). The input maps ENV_VAR_NAME -> secretName; only
 * policy-allowed secret names resolve (security by absence). A denied/missing secret is SKIPPED (not fatal) —
 * the hull simply runs without it, the same posture as ctx.fs/ctx.db being absent. Returns undefined if there
 * is nothing to inject or no ctx.secrets at all.
 */
async function resolveSecretEnv(
  secretEnv: Record<string, string> | undefined,
  ctx: Ctx,
): Promise<Record<string, string> | undefined> {
  if (secretEnv === undefined || Object.keys(secretEnv).length === 0) return undefined;
  if (ctx.secrets === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [envName, secretName] of Object.entries(secretEnv)) {
    if (!ctx.secrets.has(secretName)) continue; // security by absence: not in the allowed scope -> skip
    const ref: SecretRef = { name: secretName };
    try {
      out[envName] = await ctx.secrets.resolve(ref);
    } catch {
      // denied/not-found -> skip (the hull runs without it); never leak which name failed.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Coerce a transport's structured `output` to a string for the {text} node shape. */
function coerceText(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
