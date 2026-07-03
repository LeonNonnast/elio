// @elio/claude-adapter — bindet Claude Code als OPAKE agent-Node-Engine (Inner Loop, Inv. 17/18).
//
// INTEGRATION LEVEL: PARTIAL (honesty discipline). ClaudeAgentEngine (id "claude-code", governance "opaque")
// drives one ELIO session turn through a PLUGGABLE ClaudeTransport. Governance degrades to the HULL (Inv. 18):
// cwd, injected creds/scopes (resolved via ctx.secrets), task prompt, sandbox, budget+depth (inherited +
// decremented across the boundary, NEVER fresh — Inv. 21), and an output-gate hook. It does NOT route per-call
// through ctx.model (that is the whole point of "opaque"). An elicitation raised by the black-box agent
// propagates UP as an ELIO Suspended the runner can checkpoint/resume (Inv. 11).
//
// THREE transports, ONE tested:
//   - FakeTransport  — deterministic, offline (no key/network/SDK/CLI). The ONLY transport the tests exercise.
//   - AgentSdkTransport (DEFAULT) — @anthropic-ai/claude-agent-sdk, billed via API key. COMPILES + type-correct,
//                                   but GUARDED (only runs with a key/SDK) and NOT exercised by tests.
//   - ClaudeCliTransport — spawns `claude -p`, reuses the Claude-Code subscription. Same guarded/untested status.
// The pluggable transport is deliberate (decided auth context): the Agent SDK is preferred but bills via API
// key; `claude -p` reuses the subscription — so neither is hard-wired. registerClaudeAdapter selects it.

export { ClaudeAgentEngine } from "./claude-engine";
export type { ClaudeAgentEngineOptions, ClaudeAgentInput, OutputGate } from "./claude-engine";

export {
  createClaudeRuntime,
  registerClaudeAdapter,
  createClaudeAgentEngine,
} from "./register";
export type {
  RegisterClaudeOptions,
  ClaudeAdapterOptions,
  ClaudeTransportSelector,
} from "./register";

export { FakeTransport } from "./claude-double";
export type { FakeTransportOptions } from "./claude-double";

export { AgentSdkTransport, ClaudeCliTransport } from "./claude-transports";
export type {
  AgentSdkTransportOptions,
  AgentSdkQueryFn,
  ClaudeCliTransportOptions,
} from "./claude-transports";

export type {
  ClaudeTransport,
  ClaudeTransportRequest,
  ClaudeTransportResult,
} from "./claude-contract";
