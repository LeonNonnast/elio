// ───────────────────────────── Deterministic Vela double (TEST ONLY, no network, no real server) ─────────────────────────────
// An in-memory mirror of the SLICE of `vela-sdk` the bridge drives, matched against the real source
// (engine/workflow-engine.ts, storage/memory-store.ts). It lets the tests exercise the REAL bridge code
// path (runVelaTurn, the registerDelegate model-routing seam, the RESOLVED capture pipeline) WITHOUT
// installing vela-sdk or standing up an MCP server.
//
// Faithfulness to the real contract (the v0.1 RESOLVED happy path is exact):
//   - module-global delegate registry; registerDelegate throws on duplicate (matches vela-sdk).
//   - startOrResume builds identity params from params flagged `identity`, then findByIdentity re-finds
//     an ACTIVE/PAUSED run (matches vela-sdk: a COMPLETED run is not a resume target).
//   - advance runs a `delegate` step's handler, resolves `{{params.x}}` templates, captures the
//     handler's `{text}` into run.stateData.text, and COMPLETES the (single-step) run.
//
// PAUSE / RESUME model (faithful to Vela's semantics, exercises the real bridge suspend/resume path):
// the `blockOn` directive makes the FIRST advance() return { blocked, blockedBy } and leave the run
// PAUSED (mirrors an unsatisfied depends_on). A later advance() that carries `options.resumeAnswer` (the
// bridge supplies it on the resume turn) does NOT re-block — it runs the delegate and COMPLETEs, mirroring
// real Vela's advance(run, def, {stepOutput}) unblocking a paused step. Combined with findByIdentity
// (re-finds ACTIVE/PAUSED runs) this lets the tests drive the genuine identity↔correlation resume roundtrip.
// The real single-delegate-step shape does not pause on the real engine (its depends_on is empty); a real
// multi-step/pause-surface workflow is the remaining real-path work (see vela-bridge.ts HONESTY note).

import type {
  VelaAdvanceOptions,
  VelaAdvanceResult,
  VelaDelegateContext,
  VelaDelegateHandler,
  VelaModule,
  VelaRunState,
  VelaStartOptions,
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
      if (run.status !== "active" && run.status !== "paused") continue;
      const allMatch = Object.entries(identityParams).every(([k, v]) => run.params[k] === v);
      if (allMatch) return run;
    }
    return null;
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

export interface FakeEngineOptions {
  /** If set, advance returns blocked with these missing fields (mirrors unsatisfied depends_on). */
  blockOn?: string[];
}

export class FakeWorkflowEngine implements VelaWorkflowEngine {
  constructor(
    private readonly store: FakeInMemoryStore,
    private readonly registry: FakeDelegateRegistry,
    private readonly opts: FakeEngineOptions = {},
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
    options?: VelaAdvanceOptions,
  ): Promise<VelaAdvanceResult> {
    const step = def.steps.find((s) => s.id === run.currentStep);
    if (!step) {
      run.status = "completed";
      run.currentStep = null;
      return { run, completed: true };
    }
    // Blocked path: mirror an unsatisfied depends_on (run pauses, no delegate runs). A RESUME advance
    // (options.resumeAnswer present) carries the human's answer that satisfies the dependency, so it does
    // NOT re-block — it falls through and runs the delegate to COMPLETE the paused step (identity↔correlation
    // resume, Inv. 11/12). This mirrors real Vela's advance(run, def, {stepOutput}) unblocking a paused step.
    if (
      this.opts.blockOn !== undefined &&
      this.opts.blockOn.length > 0 &&
      options?.resumeAnswer === undefined
    ) {
      run.status = "paused";
      return { run, completed: false, blocked: true, blockedBy: this.opts.blockOn };
    }
    const handler = this.registry.resolve(step.delegate);
    if (!handler) throw new Error(`No handler registered for delegate '${step.delegate}'`);
    const ctx: VelaDelegateContext = {
      resolveVars: (v) =>
        typeof v === "string" ? resolveTemplate(v, run.params) : v,
      setCapture: (key, value) => {
        run.stateData[key] = value;
      },
      log: () => {},
    };
    const result = await handler({ id: step.id, delegate: step.delegate, task: step.task }, ctx);
    // Capture {text} into stateData (mirrors vela-sdk's output capture pipeline).
    if (result && typeof result === "object" && "text" in (result as Record<string, unknown>)) {
      run.stateData["text"] = (result as { text: unknown }).text;
    }
    run.status = "completed";
    run.currentStep = null;
    return { run, completed: true };
  }
}

/** Build a VelaModule double. A shared registry mirrors vela-sdk's module-global delegate registry. */
export function makeVelaDouble(opts: FakeEngineOptions = {}): {
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
        this.inner = new FakeWorkflowEngine(store as FakeInMemoryStore, registry, opts);
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
