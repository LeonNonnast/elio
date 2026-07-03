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
 * Subset of vela-sdk's AdvanceOptions. The bridge does NOT resume via these — real Vela unblocks a
 * depends_on gate by having the field PRESENT in stateData, not by an advance option (there is no
 * per-key inject option). The bridge instead writes the answer + hops currentStep via store.updateStep,
 * then advances with no options. Kept for structural fidelity to the real advance(run, def, options?).
 */
export interface VelaAdvanceOptions {
  stepOutput?: string | null;
  notes?: string | null;
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

/** Mirrors the slice of vela-sdk WorkflowStore the bridge drives (findByIdentity + getById + updateStep). */
export interface VelaWorkflowStore {
  findByIdentity(
    workflowId: string,
    identityParams: Record<string, string>,
  ): Promise<VelaRunState | null>;
  /** Fetch a run by id (used on resume to reload after a state injection). */
  getById(runId: string): Promise<VelaRunState | null>;
  /**
   * Shallow-merge `stateData` and/or move `currentStep` (stepId) / set `status`. On resume the bridge uses
   * this to (a) write the human answer into the dependency field and (b) HOP currentStep onto the gated
   * delegate step so the next advance runs it (instead of re-running the already-run step). `stepId=null`
   * keeps the current step. Mirrors vela-sdk WorkflowStore.updateStep(runId, stepId, { stateData, status }).
   */
  updateStep(
    runId: string,
    stepId: string | null,
    opts: { stateData?: Record<string, unknown>; status?: VelaRunStatus },
  ): Promise<void>;
}

/** Mirrors a vela-sdk workflow definition (the freeform-gate -> delegate HITL shape the bridge builds). */
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
  steps: VelaStep[];
}

/** A capture entry on a step (delegate output -> run.stateData[key], per the capture pipeline). */
export interface VelaCapture {
  key: string;
  type: string;
  required: boolean;
  source: string;
  options: never[];
  suggest: boolean;
  elicit: string;
}

/**
 * A Vela step (the narrow slice the bridge emits): a `delegate` step (routes the model call) or a
 * `freeform` gate step. `depends_on` on the NEXT step is the engine's real pause primitive — an
 * unsatisfied field parks the run (blocked:true) until the human answer is written into stateData.
 */
export interface VelaStep {
  type: string;
  id: string;
  /** Present on a `delegate` step; absent on a `freeform` gate step. */
  delegate?: string;
  task?: unknown;
  capture: VelaCapture[];
  /** `{ step, fields }` — fields that must be present in run.stateData before advancing INTO this step. */
  depends_on: { step: string; fields: string[] }[];
  next: string | null;
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
