// ───────────────────────────── Deterministic Vela double (TEST ONLY, no network, no real server) ─────────────────────────────
// An in-memory mirror of the SLICE of `vela-sdk` the bridge drives, matched against the real source
// (engine/workflow-engine.ts, storage/memory-store.ts) AND cross-checked by running the exact bridge
// workflow shape against the real built dist (see the guarded real test). It lets the tests exercise the
// REAL bridge code path (runVelaTurn, the registerDelegate model-routing seam, the RESOLVED capture
// pipeline, and the genuine suspend/resume protocol) WITHOUT installing vela-sdk or standing up a server.
//
// Faithfulness to the real engine (verified against the dist):
//   - module-global delegate registry; registerDelegate throws on duplicate.
//   - startOrResume builds identity params from params flagged `identity`, then findByIdentity re-finds a
//     run whose status is ACTIVE or PAUSED (a COMPLETED run is not a resume target).
//   - advance runs a `delegate` step's handler in-place, captures its output into run.stateData, then
//     evaluates the NEXT step's `depends_on`: any field missing from stateData -> blocked:true (status
//     stays ACTIVE, currentStep unchanged) — the real engine's ONLY generic "wait for a human" primitive.
//   - resume = write the missing field into stateData + hop currentStep onto the gated step (store.updateStep),
//     then advance runs that step. Mirrors workflow-engine.ts advance()/validateDependsOn + memory-store.ts.

import type {
  VelaAdvanceOptions,
  VelaAdvanceResult,
  VelaDelegateContext,
  VelaDelegateHandler,
  VelaModule,
  VelaRunState,
  VelaRunStatus,
  VelaStartOptions,
  VelaStep,
  VelaWorkflowDefinition,
  VelaWorkflowEngine,
  VelaWorkflowStore,
} from "./vela-contract";

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `vela-run-${nextId}`;
}

/** Per-instance delegate registry — a stand-in for vela-sdk's module-global registry. */
export class FakeDelegateRegistry {
  private readonly handlers = new Map<string, VelaDelegateHandler>();
  register(name: string, handler: VelaDelegateHandler): void {
    if (this.handlers.has(name)) throw new Error(`delegate '${name}' already registered`);
    this.handlers.set(name, handler);
  }
  resolve(name: string): VelaDelegateHandler | undefined {
    return this.handlers.get(name);
  }
  clear(): void {
    this.handlers.clear();
  }
}

export class FakeInMemoryStore implements VelaWorkflowStore {
  readonly runs = new Map<string, VelaRunState>();

  async findByIdentity(
    workflowId: string,
    identityParams: Record<string, string>,
  ): Promise<VelaRunState | null> {
    for (const run of this.runs.values()) {
      if (run.workflowId !== workflowId) continue;
      // Real store: only ACTIVE/PAUSED runs are resume targets (a depends_on block leaves status ACTIVE).
      if (run.status !== "active" && run.status !== "paused") continue;
      const allMatch = Object.entries(identityParams).every(([k, v]) => run.params[k] === v);
      if (allMatch) return run;
    }
    return null;
  }

  async getById(runId: string): Promise<VelaRunState | null> {
    return this.runs.get(runId) ?? null;
  }

  async updateStep(
    runId: string,
    stepId: string | null,
    opts: { stateData?: Record<string, unknown>; status?: VelaRunStatus },
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    if (stepId !== null) run.currentStep = stepId; // hop currentStep (null keeps it)
    if (opts.stateData !== undefined) Object.assign(run.stateData, opts.stateData); // shallow-merge
    if (opts.status !== undefined) run.status = opts.status;
  }
}

function resolveTemplate(text: string, params: Record<string, unknown>): string {
  return text.replace(/\{\{(.+?)\}\}/g, (_m, rawKey: string) => {
    const key = rawKey.trim();
    const parts = key.split(".");
    let value: unknown = { params };
    for (const part of parts) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        return `{{${key}}}`;
      }
    }
    return value === undefined ? `{{${key}}}` : String(value);
  });
}

/** Missing depends_on fields for advancing INTO `step` given the current stateData (mirrors validateDependsOn). */
function missingDeps(step: VelaStep, stateData: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const dep of step.depends_on) {
    for (const f of dep.fields) {
      if (!(f in stateData)) missing.push(f);
    }
  }
  return missing;
}

export class FakeWorkflowEngine implements VelaWorkflowEngine {
  constructor(
    private readonly store: FakeInMemoryStore,
    private readonly registry: FakeDelegateRegistry,
  ) {}

  async startOrResume(
    def: VelaWorkflowDefinition,
    options?: VelaStartOptions,
  ): Promise<[VelaRunState, boolean]> {
    const params = options?.params ?? {};
    const identityParams: Record<string, string> = {};
    for (const p of def.params) {
      if (p.identity && p.name in params) identityParams[p.name] = String(params[p.name]);
    }
    if (Object.keys(identityParams).length > 0) {
      const existing = await this.store.findByIdentity(def.id, identityParams);
      if (existing) return [existing, false];
    }
    const run: VelaRunState = {
      id: newId(),
      workflowId: def.id,
      workflowVersion: def.version,
      currentStep: def.steps.length > 0 ? (def.steps[0]?.id ?? null) : null,
      status: "active",
      params: { ...params },
      stateData: {},
    };
    this.store.runs.set(run.id, run);
    return [run, true];
  }

  async advance(
    run: VelaRunState,
    def: VelaWorkflowDefinition,
    _options?: VelaAdvanceOptions,
  ): Promise<VelaAdvanceResult> {
    if (run.status !== "active" && run.status !== "paused") return { run, completed: true };
    const step = def.steps.find((s) => s.id === run.currentStep);
    if (!step) {
      run.status = "completed";
      run.currentStep = null;
      return { run, completed: true };
    }
    // Run a `delegate` step's handler in-place (a `freeform` gate step runs nothing).
    if (step.type === "delegate" && typeof step.delegate === "string") {
      const handler = this.registry.resolve(step.delegate);
      if (!handler) throw new Error(`No handler registered for delegate '${step.delegate}'`);
      const ctx: VelaDelegateContext = {
        resolveVars: (v) => (typeof v === "string" ? resolveTemplate(v, run.params) : v),
        setCapture: (key, value) => {
          run.stateData[key] = value;
        },
        log: () => {},
      };
      const result = await handler({ id: step.id, delegate: step.delegate, task: step.task }, ctx);
      // Capture pipeline: copy each output-capture key from the handler's returned object into stateData.
      if (result !== null && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        for (const cap of step.capture) {
          if (cap.source === "output" && cap.key in obj) run.stateData[cap.key] = obj[cap.key];
        }
      }
    }
    // Determine the next step; no next -> complete.
    const nextId = step.next;
    if (nextId === null || nextId === undefined) {
      run.status = "completed";
      run.currentStep = null;
      return { run, completed: true };
    }
    const nextStep = def.steps.find((s) => s.id === nextId);
    if (nextStep === undefined) {
      run.status = "completed";
      run.currentStep = null;
      return { run, completed: true };
    }
    // depends_on gate on the NEXT step: any field missing from stateData -> block (stay ACTIVE, do not move).
    const missing = missingDeps(nextStep, run.stateData);
    if (missing.length > 0) {
      return { run, completed: false, blocked: true, blockedBy: missing };
    }
    run.currentStep = nextId;
    return { run, completed: false };
  }
}

/** Build a VelaModule double. A shared registry mirrors vela-sdk's module-global delegate registry. */
export function makeVelaDouble(): {
  module: VelaModule;
  registry: FakeDelegateRegistry;
  stores: FakeInMemoryStore[];
} {
  const registry = new FakeDelegateRegistry();
  const stores: FakeInMemoryStore[] = [];
  const module: VelaModule = {
    DefaultWorkflowEngine: class implements VelaWorkflowEngine {
      private readonly inner: FakeWorkflowEngine;
      constructor(store: VelaWorkflowStore) {
        this.inner = new FakeWorkflowEngine(store as FakeInMemoryStore, registry);
      }
      startOrResume(def: VelaWorkflowDefinition, options?: VelaStartOptions) {
        return this.inner.startOrResume(def, options);
      }
      advance(run: VelaRunState, def: VelaWorkflowDefinition, options?: VelaAdvanceOptions) {
        return this.inner.advance(run, def, options);
      }
    },
    InMemoryStore: class extends FakeInMemoryStore {
      constructor() {
        super();
        stores.push(this);
      }
    },
    registerDelegate: (name, handler) => registry.register(name, handler),
    resolveDelegate: (name) => registry.resolve(name),
  };
  return { module, registry, stores };
}
