// ───────────────────────────── registerVelaAdapter: wire the Vela engine behind ctx.agent (Inv. 17) ─────────────────────────────
// The PolicyInjector binds exactly ONE AgentEngine behind ctx.agent (gated like ctx.model). To make an
// agent node with routing.agentEngine="vela" run on the Vela engine, that engine must be the wired one.
//
// `createVelaRuntime(opts)` is the primary entry: a normal createRuntime with VelaAgentEngine pre-wired
// as opts.agentEngine. `registerVelaAdapter(runtime, opts)` adapts an EXISTING runtime by rebuilding it
// with the Vela engine while REUSING the runtime's store / registry / policy-registry / model so run
// state stays continuous (no core changes — Inv. 2: we only compose @elio/sdk's public surface).

import { createRuntime } from "@elio/sdk";
import type { Runtime, RuntimeOptions } from "@elio/sdk";
import { VelaAgentEngine } from "./vela-engine";
import type { VelaAgentEngineOptions } from "./vela-engine";

export interface RegisterVelaOptions extends RuntimeOptions {
  /** Options forwarded to the VelaAgentEngine (loader, fallback maxTurns/stopWhen, onPath hook). */
  vela?: VelaAgentEngineOptions;
}

/**
 * Build a fully-wired runtime with the Vela engine behind ctx.agent. An agent node selects it via
 * routing.agentEngine="vela" (the injector binds this single engine; the engine itself carries id
 * "vela"). The engine is transparent (Inv. 18) and falls back in-process when Vela is unavailable.
 */
export function createVelaRuntime(opts: RegisterVelaOptions = {}): Runtime {
  const engine = new VelaAgentEngine(opts.vela ?? {});
  const { vela: _vela, agentEngine: _ignored, ...rest } = opts;
  return createRuntime({ ...rest, agentEngine: engine });
}

/**
 * Adapt an existing runtime to use the Vela engine. Returns a NEW runtime that shares the source
 * runtime's store / registry / policy-registry / model (so checkpoints, tape and registered nodes
 * carry over) but routes ctx.agent through the Vela engine. Use the returned runtime for subsequent
 * run()/resume() calls.
 *
 * NOTE: the `Runtime` interface does not expose the source runtime's rootPolicy / artifactTypes /
 * fs / db / secrets wiring, so pass any of those you need preserved via `overrides`. In particular,
 * an agent node only gets ctx.agent when the resolved policy allows models — supply
 * `overrides.rootPolicy` (e.g. rootPolicy({ allowedModels: [...] })) if your base runtime had one.
 */
export function registerVelaAdapter(
  runtime: Runtime,
  opts: VelaAgentEngineOptions = {},
  overrides: Omit<RuntimeOptions, "agentEngine" | "store" | "registry" | "policyRegistry"> = {},
): Runtime {
  const engine = new VelaAgentEngine(opts);
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

/** Convenience: a standalone VelaAgentEngine (e.g. to pass directly as createRuntime({agentEngine})). */
export function createVelaAgentEngine(opts: VelaAgentEngineOptions = {}): VelaAgentEngine {
  return new VelaAgentEngine(opts);
}
