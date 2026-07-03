// ───────────────────────────── registerClaudeAdapter: wire the OPAQUE Claude engine behind ctx.agent (Inv. 17) ─────────────────────────────
// The PolicyInjector binds exactly ONE AgentEngine behind ctx.agent (gated like ctx.model). To make an agent
// node with routing.agentEngine="claude-code" run on the Claude engine, that engine must be the wired one.
//
// `createClaudeRuntime(opts)` is the primary entry: a normal createRuntime with ClaudeAgentEngine pre-wired as
// opts.agentEngine. `registerClaudeAdapter(runtime, opts)` adapts an EXISTING runtime by rebuilding it with the
// Claude engine while REUSING the runtime's store / registry / policy-registry / model so run state stays
// continuous (no core changes — Inv. 2: we only compose @elio/sdk's public surface).
//
// TRANSPORT SELECTION (the decided auth context): opts.transport picks which black-box transport runs the turn
//   - "agent-sdk"  (DEFAULT) — @anthropic-ai/claude-agent-sdk, billed via API key.
//   - "claude-cli"           — spawns `claude -p`, reuses the Claude-Code subscription.
//   - an injected ClaudeTransport instance — e.g. a FakeTransport in tests.
// Neither real transport is exercised by tests; only an injected Fake is (honesty discipline — see transports).

import { createRuntime } from "@elio/sdk";
import type { Runtime, RuntimeOptions } from "@elio/sdk";
import { ClaudeAgentEngine } from "./claude-engine";
import type { ClaudeAgentEngineOptions, OutputGate } from "./claude-engine";
import type { ClaudeTransport } from "./claude-contract";
import { AgentSdkTransport, ClaudeCliTransport } from "./claude-transports";
import type { AgentSdkTransportOptions, ClaudeCliTransportOptions } from "./claude-transports";

/** Which transport drives the opaque turn. Default "agent-sdk"; "claude-cli"; or an injected instance (Fake in tests). */
export type ClaudeTransportSelector =
  | "agent-sdk"
  | "claude-cli"
  | ClaudeTransport;

export interface ClaudeAdapterOptions {
  /** Transport selector (default "agent-sdk"). Pass a FakeTransport instance in tests. */
  transport?: ClaudeTransportSelector;
  /** Forwarded to AgentSdkTransport when transport === "agent-sdk". */
  agentSdk?: AgentSdkTransportOptions;
  /** Forwarded to ClaudeCliTransport when transport === "claude-cli". */
  claudeCli?: ClaudeCliTransportOptions;
  /** HULL output-gate hook (runs on the transport result before it becomes the node result). */
  outputGate?: OutputGate;
  /** Observe which path a turn took — for tests + audit. */
  onPath?: ClaudeAgentEngineOptions["onPath"];
}

export interface RegisterClaudeOptions extends RuntimeOptions {
  /** Options forwarded to the ClaudeAgentEngine (transport selection, output-gate, onPath). */
  claude?: ClaudeAdapterOptions;
}

/** Resolve the transport selector into a concrete ClaudeTransport instance. */
function resolveTransport(opts: ClaudeAdapterOptions): ClaudeTransport {
  const sel = opts.transport ?? "agent-sdk";
  if (typeof sel !== "string") return sel; // an injected instance (e.g. FakeTransport)
  if (sel === "claude-cli") return new ClaudeCliTransport(opts.claudeCli ?? {});
  // default: the preferred Agent SDK transport (billed via API key).
  return new AgentSdkTransport(opts.agentSdk ?? {});
}

/** Build the engine from adapter options (transport + hull hooks). */
function buildEngine(opts: ClaudeAdapterOptions): ClaudeAgentEngine {
  const engineOpts: ClaudeAgentEngineOptions = { transport: resolveTransport(opts) };
  if (opts.outputGate !== undefined) engineOpts.outputGate = opts.outputGate;
  if (opts.onPath !== undefined) engineOpts.onPath = opts.onPath;
  return new ClaudeAgentEngine(engineOpts);
}

/**
 * Build a fully-wired runtime with the OPAQUE Claude engine behind ctx.agent. An agent node selects it via
 * routing.agentEngine="claude-code" (the injector binds this single engine; the engine carries id "claude-code"
 * and governance "opaque"). The engine inherits + decrements budget/depth across the boundary (Inv. 21).
 */
export function createClaudeRuntime(opts: RegisterClaudeOptions = {}): Runtime {
  const engine = buildEngine(opts.claude ?? {});
  const { claude: _claude, agentEngine: _ignored, ...rest } = opts;
  return createRuntime({ ...rest, agentEngine: engine });
}

/**
 * Adapt an existing runtime to use the Claude engine. Returns a NEW runtime that shares the source runtime's
 * store / registry / policy-registry / model (so checkpoints, tape and registered nodes carry over) but routes
 * ctx.agent through the Claude engine. Use the returned runtime for subsequent run()/resume() calls.
 *
 * NOTE: the `Runtime` interface does not expose the source runtime's rootPolicy / artifactTypes / fs / db /
 * secrets wiring, so pass any of those you need preserved via `overrides`. In particular, an agent node only
 * gets ctx.agent when the resolved policy allows models — supply `overrides.rootPolicy` (e.g.
 * rootPolicy({ allowedModels: [...] })) if your base runtime had one. To inject creds as env (HULL), supply
 * `overrides.secretsProvider` so ctx.secrets is available to the engine's cred resolution.
 */
export function registerClaudeAdapter(
  runtime: Runtime,
  opts: ClaudeAdapterOptions = {},
  overrides: Omit<RuntimeOptions, "agentEngine" | "store" | "registry" | "policyRegistry"> = {},
): Runtime {
  const engine = buildEngine(opts);
  return createRuntime({
    ...overrides,
    store: runtime.store,
    registry: runtime.registry,
    policyRegistry: runtime.policyRegistry,
    model: overrides.model ?? runtime.model,
    agentEngine: engine,
    // Built-ins already live on the shared registry; do not re-register.
    registerBuiltins: false,
  });
}

/** Convenience: a standalone ClaudeAgentEngine (e.g. to pass directly as createRuntime({agentEngine})). */
export function createClaudeAgentEngine(opts: ClaudeAdapterOptions = {}): ClaudeAgentEngine {
  return buildEngine(opts);
}
