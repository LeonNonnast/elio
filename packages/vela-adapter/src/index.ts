// @elio/vela-adapter — bindet Vela als transparente agent-Node-Engine (Inner Loop, Inv. 17/18).
//
// INTEGRATION LEVEL: PARTIAL (impl-decisions §7). VelaAgentEngine (id "vela", governance "transparent")
// drives one ELIO session turn through the REAL vela-sdk engine when it is installed — SessionContract
// -> single-delegate-step WorkflowDefinition -> DefaultWorkflowEngine.startOrResume/.advance, with the
// model call routed through ctx.model via a registered Vela delegate (Inv. 18 transparency). The working
// real-Vela v0.1 surface is ONE RESOLVED turn. The identity-based resume <-> correlation-id mapping
// (Inv. 12) and the block->Suspended mapping (Inv. 11) are WIRED but NOT reachable on the real single-
// step shape (v0.2 — see the RESUME/BLOCK CAVEAT in vela-bridge.ts; validated here via a double). When
// vela-sdk is NOT importable (it is intentionally NOT a hard dependency — Inv. 2), or a turn throws, the
// engine falls back to the in-process InProcessAgentEngine (Slice 3) — a valid, honest v0.1 outcome.
// Either way an agent node with routing.agentEngine="vela" can route to it. v0.2 deferrals: vela-engine.ts.

export { VelaAgentEngine } from "./vela-engine";
export type { VelaAgentEngineOptions } from "./vela-engine";

export { createVelaRuntime, registerVelaAdapter, createVelaAgentEngine } from "./register";
export type { RegisterVelaOptions } from "./register";

export { defaultVelaModuleLoader, adaptVelaModule } from "./loader";

export {
  runVelaTurn,
  blockedElicitation,
  ELIO_MODEL_DELEGATE,
  CORRELATION_PARAM,
  PROMPT_PARAM,
} from "./vela-bridge";
export type { BridgeAgentInput, BridgeTurnResult } from "./vela-bridge";

export type {
  VelaModule,
  VelaModuleLoader,
  VelaRunState,
  VelaAdvanceResult,
  VelaDelegateContext,
  VelaDelegateHandler,
  VelaWorkflowEngine,
  VelaWorkflowStore,
  VelaWorkflowDefinition,
} from "./vela-contract";
