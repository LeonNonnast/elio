// ───────────────────────────── Vela contract (structural mirror) ─────────────────────────────
// Minimal STRUCTURAL types that mirror the real `vela-sdk` surface inspected at
// /home/leon/workspaces/vela/packages/vela-sdk-ts (engine/types.ts, engine/workflow-engine.ts,
// delegate/types.ts, delegate/registry.ts, storage/store.ts, schemas/workflow.ts).
//
// We mirror — rather than import — Vela's types so @elio/vela-adapter TYPECHECKS without a hard
// dependency on the OSS package (Inv. 2: Vela stays a standalone project; impl-decisions §7: the
// adapter is BEST-EFFORT). The real module is loaded lazily at RUNTIME via an injectable loader
// (see vela-bridge.ts); when it resolves, the real DefaultWorkflowEngine drives ONE resolved session
// turn (the working v0.1 surface). When it does not (Vela not installed / contract drift / a turn
// throws), the engine falls back to the in-process loop. (Cross-turn resume + block->Suspended are
// v0.2 — see the RESUME/BLOCK CAVEAT in vela-bridge.ts.)
//
// These declarations are deliberately the *narrow slice* the bridge uses — not Vela's full API.
// Source-of-truth, verified against vela-sdk source (engine/workflow-engine.ts):
//   - startOrResume(def, {params}) -> [run, created]; identity params (param.identity) WOULD re-find an
//     ACTIVE/PAUSED run via store.findByIdentity (the Inv. 12 resume aspiration). v0.1 single-step runs
//     always COMPLETE, so that branch is never reached on the real path — see the RESUME/BLOCK CAVEAT in
//     vela-bridge.ts. The mapping is wired but cross-turn resume is v0.2.
//   - advance(run, def) runs a `delegate` step's registered handler in-place; handler return is
//     captured into run.stateData via the step's `capture` map (JSON.stringify -> parseStepOutput).
//   - registerDelegate(name, handler) is a MODULE-GLOBAL registry (throws on duplicate); the bridge
//     registers ONE stable handler and reads the per-call ctx.model from the run params/state.

/** Mirrors vela-sdk WorkflowRunStatus (string enum). */
export type VelaRunStatus = "active" | "paused" | "completed" | "cancelled";

/** Mirrors vela-sdk WorkflowRunState (the framework-agnostic run record). */
export interface VelaRunState {
  id: string;
  workflowId: string;
  workflowVersion: string;
  currentStep?: string | null;
  status: VelaRunStatus;
  params: Record<string, unknown>;
  stateData: Record<string, unknown>;
  parentRunId?: string | null;
  parentStepId?: string | null;
}

/** Mirrors vela-sdk AdvanceResult (the engine's per-step verdict). */
export interface VelaAdvanceResult {
  run: VelaRunState;
  prompt?: string | null;
  completed: boolean;
  subWorkflowRef?: string | null;
  delegate?: string | null;
  delegateInstructions?: string | null;
  blocked?: boolean;
  blockedBy?: string[];
}

/** Mirrors vela-sdk DelegateContext (handed to a delegate handler). */
export interface VelaDelegateContext {
  resolveVars: (v: unknown) => unknown;
  setCapture: (key: string, value: unknown) => void;
  signal?: AbortSignal;
  log: (msg: string, meta?: unknown) => void;
}

/** Mirrors vela-sdk DelegateHandler. */
export type VelaDelegateHandler = (
  step: { id: string; delegate: string; task: unknown },
  ctx: VelaDelegateContext,
) => Promise<unknown>;

/** Mirrors vela-sdk StartOptions (the subset the bridge passes). */
export interface VelaStartOptions {
  params?: Record<string, unknown>;
  parentRunId?: string | null;
  parentStepId?: string | null;
}

/**
 * Options the bridge passes to advance() (subset of vela-sdk's AdvanceOptions). On a RESUME turn the
 * bridge supplies `resumeAnswer` — the human's answer to the elicitation that paused the run — so the
 * engine can unblock the paused step (real Vela accepts `options.stepOutput`/`notes`; we mirror the
 * narrow slice the bridge needs). Absent on a first turn.
 */
export interface VelaAdvanceOptions {
  resumeAnswer?: unknown;
}

/** Mirrors vela-sdk IWorkflowEngine (the two methods the bridge drives). */
export interface VelaWorkflowEngine {
  startOrResume(
    workflowDef: VelaWorkflowDefinition,
    options?: VelaStartOptions,
  ): Promise<[VelaRunState, boolean]>;
  advance(
    run: VelaRunState,
    workflowDef: VelaWorkflowDefinition,
    options?: VelaAdvanceOptions,
  ): Promise<VelaAdvanceResult>;
}

/** Mirrors vela-sdk WorkflowStore (only findByIdentity is referenced directly). */
export interface VelaWorkflowStore {
  findByIdentity(
    workflowId: string,
    identityParams: Record<string, string>,
  ): Promise<VelaRunState | null>;
}

/** Mirrors a vela-sdk workflow definition (the single-delegate-step shape the bridge builds). */
export interface VelaWorkflowDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  params: {
    name: string;
    required: boolean;
    identity: boolean;
    application: boolean;
    resolve: boolean;
    default?: unknown;
  }[];
  context: null;
  lifecycle: null;
  tools: never[];
  resources: never[];
  steps: VelaDelegateStep[];
}

/** A single Vela `delegate` step (the only step type the bridge emits). */
export interface VelaDelegateStep {
  type: "delegate";
  id: string;
  delegate: string;
  task: unknown;
  capture: {
    key: string;
    type: string;
    required: boolean;
    source: string;
    options: never[];
    suggest: boolean;
    elicit: string;
  }[];
  depends_on: never[];
  next: null;
  tools: never[];
  instructions: null;
  title?: string;
}

/**
 * The runtime slice of `vela-sdk` the bridge needs. A VelaModule loader returns exactly this. The
 * real module (DefaultWorkflowEngine, InMemoryStore, registerDelegate, resolveDelegate) satisfies it
 * structurally; tests inject a deterministic double of the same shape.
 */
export interface VelaModule {
  DefaultWorkflowEngine: new (store: VelaWorkflowStore) => VelaWorkflowEngine;
  InMemoryStore: new () => VelaWorkflowStore;
  registerDelegate: (name: string, handler: VelaDelegateHandler) => void;
  resolveDelegate: (name: string) => VelaDelegateHandler | undefined;
}

/**
 * Loader seam (impl-decisions §7 best-effort). Returns the Vela runtime module, or null/undefined /
 * throws if Vela is not available. Default impl dynamic-imports the published "vela-sdk" package;
 * tests inject a double. Keeping this injectable means the adapter NEVER hard-depends on Vela.
 */
export type VelaModuleLoader = () => Promise<VelaModule | null | undefined>;
