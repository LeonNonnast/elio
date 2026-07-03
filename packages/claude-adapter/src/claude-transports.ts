// ───────────────────────────── Real transports: AgentSdkTransport + ClaudeCliTransport (GUARDED) ─────────────────────────────
//
// HONESTY DISCIPLINE (the load-bearing note of this file): NEITHER transport here is exercised by the test
// suite. The tests run entirely through FakeTransport — no API key, no network, no real claude/SDK. These two
// transports COMPILE and are type-correct, but they only DO anything when a key/SDK/CLI is actually present at
// runtime; otherwise they throw a clear "not available" error. Treat them as the real-integration seam, NOT as
// validated behaviour. (Same posture as vela-adapter's real path being best-effort + fallback.)
//
// WHY TWO (the decided auth context): the Agent SDK is the PREFERRED transport but BILLS VIA API KEY; `claude -p`
// reuses the user's Claude-Code SUBSCRIPTION. We do not hard-wire either — the transport is pluggable, and
// registerClaudeAdapter selects it (default: agent-sdk). Both are OPAQUE (Inv. 18): one ELIO turn -> one
// black-box agent run; ELIO governs the HULL (cwd, env/creds, prompt, budget, depth), not each model call.

import { spawn } from "node:child_process";
import type { Cost } from "@elio/core";
import type { ClaudeTransport, ClaudeTransportRequest, ClaudeTransportResult } from "./claude-contract";

// ───────────────────────── AgentSdkTransport (DEFAULT, billed via API key) ─────────────────────────
//
// Drives @anthropic-ai/claude-agent-sdk's `query()` for one ELIO turn. INSPECTED against the real installed
// .d.ts (sdk.d.ts @ 0.3.195): `query({ prompt, options })` returns an async generator of SDKMessage; the final
// `type: "result"` message (SDKResultSuccess) carries `result` (text), `total_cost_usd`, `usage`
// ({input_tokens, output_tokens, ...}), and optional `structured_output`. The HULL maps onto Options:
// cwd -> options.cwd, model hint -> options.model, system -> options.systemPrompt, the inherited Inv. 21
// budget -> options.maxBudgetUsd (the SDK's real USD ceiling; exceeding it yields an error_max_budget_usd
// result), plus a secondary turn-cap -> options.maxTurns.
//
// env: the SDK REPLACES the subprocess env with options.env (it does NOT merge process.env — see sdk.d.ts).
// So we hand it `{ ...process.env, ...req.env }` — otherwise injecting any HULL cred would wipe PATH/HOME and,
// fatally, ANTHROPIC_API_KEY, breaking the very auth this transport relies on. Mirrors ClaudeCliTransport.
//
// The SDK is imported LAZILY via a variable specifier so this package TYPECHECKS + the bundler does not force
// a hard static resolution; the dep is declared in package.json but the transport is only ever constructed when
// a consumer actually selects "agent-sdk" with a key present. Credential resolution is like Claude Code (API
// key in env, or an ant-login profile the SDK picks up) — we do not manage it; we only pass req.env through.

/** Options forwarded to the Agent SDK transport. */
export interface AgentSdkTransportOptions {
  /**
   * Loader for the SDK's `query` function. Default dynamic-imports "@anthropic-ai/claude-agent-sdk". Injectable
   * for completeness; the tests do NOT use this transport at all (they use FakeTransport).
   */
  loadQuery?: () => Promise<AgentSdkQueryFn>;
  /** Default model when neither the input nor the routing hint set one. */
  defaultModel?: string;
  /**
   * Secondary turn-cap so an opaque run cannot spin unboundedly (HULL: bounded turns). Default: a small fixed
   * cap. NOTE: this is NOT how the inherited Inv. 21 budget is enforced — the SDK exposes a real USD lever
   * (`Options.maxBudgetUsd`) which run() wires from req.budget; maxTurns is only an additional safety ceiling.
   */
  maxTurns?: number;
}

/** Minimal structural shape of the SDK's `query` we depend on (verified against sdk.d.ts @ 0.3.195). */
export type AgentSdkQueryFn = (params: {
  prompt: string;
  options?: {
    cwd?: string;
    // env mirrors the SDK's `Options.env` (sdk.d.ts @ 0.3.195): `{ [envVar: string]: string | undefined }`,
    // and — critically — the SDK REPLACES the subprocess env with this value (it does NOT merge process.env).
    env?: { [envVar: string]: string | undefined };
    model?: string;
    systemPrompt?: string;
    maxTurns?: number;
    // Maximum budget in USD; the query stops + returns an `error_max_budget_usd` result if exceeded
    // (sdk.d.ts @ 0.3.195 `Options.maxBudgetUsd`). This is the real lever for the inherited Inv. 21 budget.
    maxBudgetUsd?: number;
  };
}) => AsyncIterable<AgentSdkMessage>;

/** The only SDK message fields the transport reads — the terminal `result` message (SDKResultSuccess/Error). */
interface AgentSdkMessage {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const AGENT_SDK_SPECIFIER = "@anthropic-ai/claude-agent-sdk";

/** Default loader: dynamic-import the real SDK and pull out `query`. Held in a variable so it stays lazy. */
async function defaultLoadQuery(): Promise<AgentSdkQueryFn> {
  const specifier = AGENT_SDK_SPECIFIER;
  const mod: unknown = await import(/* @vite-ignore */ specifier);
  const q = (mod as { query?: unknown }).query;
  if (typeof q !== "function") {
    throw new Error(`AgentSdkTransport: '${AGENT_SDK_SPECIFIER}' exposes no query() — SDK surface drifted.`);
  }
  return q as AgentSdkQueryFn;
}

export class AgentSdkTransport implements ClaudeTransport {
  readonly kind = "agent-sdk";

  private readonly loadQuery: () => Promise<AgentSdkQueryFn>;
  private readonly defaultModel: string | undefined;
  private readonly maxTurns: number;

  constructor(opts: AgentSdkTransportOptions = {}) {
    this.loadQuery = opts.loadQuery ?? defaultLoadQuery;
    this.defaultModel = opts.defaultModel;
    this.maxTurns = opts.maxTurns ?? 8;
  }

  async run(req: ClaudeTransportRequest): Promise<ClaudeTransportResult> {
    // GUARD: the SDK only works with a key/profile present. If the import fails (not installed / no creds path),
    // surface a clear error — the engine's caller decides what to do. NOT exercised by tests (FakeTransport is).
    let query: AgentSdkQueryFn;
    try {
      query = await this.loadQuery();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `AgentSdkTransport: '${AGENT_SDK_SPECIFIER}' not available (${reason}). ` +
          `Install it + provide ANTHROPIC_API_KEY (or an ant-login profile), or use the claude-cli/fake transport.`,
        { cause: err },
      );
    }

    const options: Parameters<AgentSdkQueryFn>[0]["options"] = { maxTurns: this.maxTurns };
    if (req.cwd !== undefined) options.cwd = req.cwd;
    // The SDK REPLACES (does not merge) the subprocess env with options.env. Always spread process.env so the
    // agent inherits PATH/HOME/ANTHROPIC_API_KEY; HULL-injected creds (req.env) override on top. Mirrors
    // ClaudeCliTransport — keeping the two real transports consistent. (sdk.d.ts: env value type allows undefined.)
    options.env = { ...process.env, ...(req.env ?? {}) };
    if (req.system !== undefined) options.systemPrompt = req.system;
    const model = req.model ?? this.defaultModel;
    if (model !== undefined) options.model = model;
    // HULL budget (Inv. 21): wire the inherited REMAINING USD budget onto the SDK's real ceiling. Exceeding it
    // stops the query with an error_max_budget_usd result — the hull's ceiling, exactly as claude-contract.ts requires.
    if (Number.isFinite(req.budget)) options.maxBudgetUsd = req.budget;

    // Drive the opaque run to its terminal `result` message; capture text + the single HULL cost figure.
    let text = "";
    let structured: unknown;
    let cost: Cost = {};
    let sawResult = false;
    for await (const msg of query({ prompt: req.prompt, options })) {
      if (msg.type === "result") {
        sawResult = true;
        if (msg.is_error === true) {
          throw new Error(`AgentSdkTransport: agent run failed (subtype=${msg.subtype ?? "error"}).`);
        }
        if (typeof msg.result === "string") text = msg.result;
        if (msg.structured_output !== undefined) structured = msg.structured_output;
        cost = mapCost(msg, model);
      }
    }
    if (!sawResult) {
      throw new Error("AgentSdkTransport: agent stream ended without a result message.");
    }

    const out: ClaudeTransportResult = { text, cost };
    if (structured !== undefined) out.output = structured;
    return out;
  }
}

/** Map an SDK result message onto an ELIO Cost (HULL figure: usd + tokens). */
function mapCost(msg: AgentSdkMessage, model: string | undefined): Cost {
  const cost: Cost = {};
  if (typeof msg.total_cost_usd === "number") cost.usd = msg.total_cost_usd;
  if (typeof msg.usage?.input_tokens === "number") cost.tokensIn = msg.usage.input_tokens;
  if (typeof msg.usage?.output_tokens === "number") cost.tokensOut = msg.usage.output_tokens;
  if (model !== undefined) cost.model = model;
  return cost;
}

// ───────────────────────── ClaudeCliTransport (subscription-billed, GUARDED) ─────────────────────────
//
// Spawns `claude -p "<prompt>" --output-format json` as a subprocess for one ELIO turn, reusing the user's
// Claude-Code SUBSCRIPTION auth (no API key). cwd is the HULL working dir; req.env is merged into the child
// env (HULL: injected creds/scopes). Flags per `claude -p --help`: -p/--print, --output-format, --model,
// --append-system-prompt. Per that help, --output-format has THREE shapes: text (default), `json` (a SINGLE
// result object carrying { result, is_error, total_cost_usd, usage }), and `stream-json` (a realtime stream
// of events). We request `json`, so the terminal `type: "result"` object is the whole payload; parseCliJson
// still tolerates an ARRAY too (the stream-json shape) defensively. This is NOT verified against captured live
// output — treat the shape as documented-but-unexercised (the offline suite never spawns claude).
//
// GUARDED: only usable when the `claude` CLI is on PATH. NOT exercised by tests (FakeTransport is). The spawn
// is real and would reach Anthropic via the subscription — never invoked in the offline suite.

export interface ClaudeCliTransportOptions {
  /** Path to the claude binary (default "claude" — resolved on PATH). */
  bin?: string;
  /** Default model id (passed via --model) when none is set on the request. */
  defaultModel?: string;
  /** Max time to wait for the subprocess (ms). Default 120000. */
  timeoutMs?: number;
}

/** Shape of the terminal `result` object/event in `claude -p --output-format json` (per `claude -p --help`; not live-verified). */
interface ClaudeCliResultEvent {
  type: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ClaudeCliTransport implements ClaudeTransport {
  readonly kind = "claude-cli";

  private readonly bin: string;
  private readonly defaultModel: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliTransportOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.defaultModel = opts.defaultModel;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  run(req: ClaudeTransportRequest): Promise<ClaudeTransportResult> {
    const args = ["-p", req.prompt, "--output-format", "json"];
    const model = req.model ?? this.defaultModel;
    if (model !== undefined) args.push("--model", model);
    if (req.system !== undefined) args.push("--append-system-prompt", req.system);

    // HULL: cwd + injected creds/scopes (merged onto the inherited process env, so subscription auth survives).
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(req.env ?? {}) };
    const spawnOpts: { cwd?: string; env: NodeJS.ProcessEnv } = { env: childEnv };
    if (req.cwd !== undefined) spawnOpts.cwd = req.cwd;

    return new Promise<ClaudeTransportResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.bin, args, spawnOpts);
      } catch (err) {
        // GUARD: claude not on PATH -> clear error. Never hit by tests.
        const reason = err instanceof Error ? err.message : String(err);
        reject(new Error(`ClaudeCliTransport: failed to spawn '${this.bin}' (${reason}).`));
        return;
      }

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`ClaudeCliTransport: '${this.bin} -p' timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`ClaudeCliTransport: '${this.bin}' error: ${err.message}`));
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new Error(
              `ClaudeCliTransport: '${this.bin} -p' exited ${code ?? "null"}: ${stderr.slice(0, 500)}`,
            ),
          );
          return;
        }
        try {
          resolve(parseCliJson(stdout, model));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }
}

/**
 * Parse `claude -p --output-format json` stdout -> ClaudeTransportResult. The `json` format yields a SINGLE
 * result object; we normalize to a 1-element array and also tolerate a real array (the stream-json shape) so
 * either form parses to the terminal `type: "result"` entry.
 */
function parseCliJson(stdout: string, model: string | undefined): ClaudeTransportResult {
  const parsed: unknown = JSON.parse(stdout);
  const events: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  let resultEvent: ClaudeCliResultEvent | undefined;
  for (const ev of events) {
    if (ev !== null && typeof ev === "object" && (ev as { type?: unknown }).type === "result") {
      resultEvent = ev as ClaudeCliResultEvent;
    }
  }
  if (resultEvent === undefined) {
    throw new Error("ClaudeCliTransport: no result event in claude -p output.");
  }
  if (resultEvent.is_error === true) {
    throw new Error("ClaudeCliTransport: claude -p reported is_error=true.");
  }
  const cost: Cost = {};
  if (typeof resultEvent.total_cost_usd === "number") cost.usd = resultEvent.total_cost_usd;
  if (typeof resultEvent.usage?.input_tokens === "number") cost.tokensIn = resultEvent.usage.input_tokens;
  if (typeof resultEvent.usage?.output_tokens === "number") cost.tokensOut = resultEvent.usage.output_tokens;
  if (model !== undefined) cost.model = model;
  return { text: typeof resultEvent.result === "string" ? resultEvent.result : "", cost };
}
