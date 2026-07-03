// ───────────────────────────── VelaBridge: the real Vela integration seam (Inv. 17/18/21) ─────────────────────────────
// Drives ONE ELIO inner-loop turn through the REAL Vela workflow engine:
//
//   1. Build a single-delegate-step WorkflowDefinition. Its identity param carries the ELIO correlation
//      key (corrKey) so the run is tagged for a future store.findByIdentity lookup — see the RESUME
//      CAVEAT below for why that lookup does NOT yet round-trip on the real v0.1 path.
//   2. startOrResume(def, { params }) — creates the run (and, IF a prior ACTIVE/PAUSED run with the
//      same identity exists in the SAME store, re-finds it; v0.1 never reaches that branch — caveat below).
//   3. advance(run, def) — runs the delegate step. The delegate handler is the INVERSION seam: it
//      calls ELIOs ctx.model.complete(...) (Inv. 18 transparency — every model call flows through the
//      policy-scoped ctx.model, full per-call audit/cost). Vela never calls a model itself. THIS is the
//      genuinely real-API-faithful core: executeDelegateStep -> JSON.stringify -> parseStepOutput
//      captures `text` -> updateStep merges stateData.text, which we read back below.
//   4. Read the captured reply out of run.stateData and return it as an ELIO NodeResult.
//
// WHY single-delegate-step: findByIdentity only re-finds ACTIVE/PAUSED runs (a finished run is not a
// resume target), and a one-delegate-step-per-turn shape is the robust, non-brittle slice of Vela that
// maps cleanly onto an ELIO session turn (impl-decisions §7: best-effort, do NOT force depth/budget
// semantics Vela lacks). Multi-step Vela workflows are v0.2.
//
// RESUME / BLOCK CAVEAT (honest v0.1 scope — impl-decisions §7):
//   The real DefaultWorkflowEngine returns `blocked:true` ONLY inside `if (nextStepId)` after a failed
//   validateDependsOn (workflow-engine.ts advance()). A single delegate step has next:null and no
//   following step, so resolveNext() returns null, the engine takes the "No next step — complete" branch
//   EVERY time, and the run ends COMPLETED. Consequently, against the REAL engine for this v0.1 shape:
//     • advance() can NEVER return blocked:true       -> the block->Suspended mapping below is v0.2-only;
//     • the run is never left ACTIVE/PAUSED            -> findByIdentity never has a resume target;
//   so cross-turn identity-based resume (the Inv. 12 aspiration in skeleton §2) does NOT function on the
//   real path yet. The block/pause + identity-resume behaviour is exercised in tests ONLY via the
//   deterministic double's synthetic `blockOn` directive (a behavioural spec for the v0.2 multi-step
//   shape), not as real-Vela v0.1 conformance. The genuinely working real-Vela v0.1 outcome is a single
//   RESOLVED turn (step 3 above). Making resume real needs a 2+ step workflow whose depends_on can go
//   unsatisfied AND a store that outlives a turn — both v0.2.
//
// The delegate registry is a MODULE-GLOBAL in vela-sdk (registerDelegate throws on duplicate). The
// bridge registers ONE stable handler name idempotently (guarded by resolveDelegate) and threads the
// per-call ctx.model through a per-run AsyncLocalStorage so concurrent/repeat sessions never collide on
// the shared global handler.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Cost, Ctx, Elicitation, SessionContract } from "@elio/core";
import { corrKey } from "@elio/core";
import type {
  VelaAdvanceResult,
  VelaDelegateContext,
  VelaModule,
  VelaWorkflowDefinition,
} from "./vela-contract";

/** Stable delegate name the bridge registers in Velas global registry. */
export const ELIO_MODEL_DELEGATE = "elio-model";

/**
 * Identity param carrying the ELIO correlation key. Wired for the Inv. 12 resume mapping (skeleton §2),
 * but see the RESUME CAVEAT in the file header: with the v0.1 single-delegate-step shape the run always
 * COMPLETEs, so findByIdentity never has an ACTIVE/PAUSED run to re-find — cross-turn resume is v0.2.
 */
export const CORRELATION_PARAM = "elioCorrelation";
/** Param carrying the resolved prompt for the turn. */
export const PROMPT_PARAM = "elioPrompt";

/** What the per-run AsyncLocalStorage carries into the global delegate handler. */
interface DelegateCallContext {
  ctx: Ctx;
  input: BridgeAgentInput;
  /** Accumulates the model cost charged during this turn. */
  costSink: { cost: Cost };
  /** Captures the model's confidence (last completion). */
  confidenceSink: { confidence: number };
}

/** The (template-resolved) agent config the agent node passes as contract.input. */
export interface BridgeAgentInput {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  model?: string;
  maxTokens?: number;
}

/** Provider-neutral completion request (same shape ctx.model.complete accepts). */
interface CompletionRequestShape {
  model?: string;
  system?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
}

const delegateStore = new AsyncLocalStorage<DelegateCallContext>();

function addCost(a: Cost, b: Cost): Cost {
  const out: Cost = {};
  const usd = (a.usd ?? 0) + (b.usd ?? 0);
  if (a.usd !== undefined || b.usd !== undefined) out.usd = usd;
  const ti = (a.tokensIn ?? 0) + (b.tokensIn ?? 0);
  if (ti !== 0) out.tokensIn = ti;
  const to = (a.tokensOut ?? 0) + (b.tokensOut ?? 0);
  if (to !== 0) out.tokensOut = to;
  if (b.model !== undefined) out.model = b.model;
  else if (a.model !== undefined) out.model = a.model;
  return out;
}

function buildMessages(input: BridgeAgentInput): { role: string; content: string }[] {
  if (Array.isArray(input.messages) && input.messages.length > 0) {
    return input.messages.map((m) => ({
      role: typeof m.role === "string" ? m.role : "user",
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));
  }
  if (typeof input.prompt === "string") {
    return [{ role: "user", content: input.prompt }];
  }
  throw new Error(
    "VelaBridge: kein Prompt — erwartet `prompt` ODER `messages` im SessionContract.input.",
  );
}

/**
 * The global delegate handler. Runs ONCE per registration; reads the active turn's ctx.model from the
 * AsyncLocalStorage and routes the model call through it (Inv. 18). Returns `{ text }` which Velas
 * capture pipeline writes into run.stateData.text.
 */
async function elioModelDelegate(
  _step: { id: string; delegate: string; task: unknown },
  _velaCtx: VelaDelegateContext,
): Promise<{ text: string }> {
  const call = delegateStore.getStore();
  if (call === undefined) {
    throw new Error(
      "VelaBridge: delegate invoked outside a bridged turn (no AsyncLocalStorage context).",
    );
  }
  if (call.ctx.model === undefined) {
    // transparent engine without ctx.model = not cleared for models (security by absence, Inv. 14).
    throw new Error(
      "VelaBridge: ctx.model ist nicht injiziert — die transparente Vela-Engine kann ohne " +
        "Modell-Pfad nicht denken (Inv. 14/18).",
    );
  }
  const req: CompletionRequestShape = { messages: buildMessages(call.input) };
  if (typeof call.input.system === "string") req.system = call.input.system;
  if (typeof call.input.model === "string") req.model = call.input.model;
  if (typeof call.input.maxTokens === "number") req.maxTokens = call.input.maxTokens;

  const out = await call.ctx.model.complete(req);
  call.costSink.cost = addCost(call.costSink.cost, out.cost);
  call.confidenceSink.confidence = out.confidence;
  // Transparent cost: also charge the shared ctx.cost tracker so the OUTER budget stays correct.
  if (call.ctx.cost !== undefined) call.ctx.cost.charge(out.cost);
  return { text: out.text };
}

/** Idempotently register the model delegate in Velas global registry (registerDelegate throws on dup). */
function ensureDelegateRegistered(vela: VelaModule): void {
  if (vela.resolveDelegate(ELIO_MODEL_DELEGATE) === undefined) {
    vela.registerDelegate(ELIO_MODEL_DELEGATE, elioModelDelegate);
  }
}

/** Build the single-delegate-step workflow definition for one ELIO session turn. */
function buildWorkflowDefinition(): VelaWorkflowDefinition {
  return {
    id: "elio.inner-session",
    version: "1.0.0",
    name: "ELIO inner session (bridged to Vela)",
    description: "",
    params: [
      {
        name: CORRELATION_PARAM,
        required: false,
        // identity:true tags the run for a findByIdentity resume lookup; v0.1 single-step runs always
        // COMPLETE so that lookup never re-finds them (see RESUME CAVEAT in the header) — wired for v0.2.
        identity: true,
        application: false,
        resolve: false,
      },
      { name: PROMPT_PARAM, required: false, identity: false, application: false, resolve: false },
    ],
    context: null,
    lifecycle: null,
    tools: [],
    resources: [],
    steps: [
      {
        type: "delegate",
        id: "call-model",
        delegate: ELIO_MODEL_DELEGATE,
        task: `{{params.${PROMPT_PARAM}}}`,
        capture: [
          {
            key: "text",
            type: "string",
            required: false,
            source: "output",
            options: [],
            suggest: false,
            elicit: "if_missing",
          },
        ],
        depends_on: [],
        next: null,
        tools: [],
        instructions: null,
      },
    ],
  };
}

/**
 * Outcome of one bridged turn. Deliberately carries ONLY what the agent node actually consumes
 * (text + cost + confidence). It does NOT surface a velaRunId / resumed flag: the agent node re-builds a
 * fresh SessionContract every turn and the runner's checkpoint persists branchState/artifact/elicitation
 * — never a Vela run id — so a surfaced run id would be inert (and `resumed` would be structurally false
 * for the single-step shape; see the RESUME CAVEAT in the header). Re-introduce these only together with
 * a store that outlives a turn + checkpoint threading (v0.2).
 */
export interface BridgeTurnResult {
  text: string;
  cost: Cost;
  confidence: number;
  /**
   * Set ONLY when Vela paused/blocked the run -> the engine maps it to an ELIO Suspended (Inv. 11).
   * NOTE: unreachable on the real v0.1 engine for the single-delegate-step shape (RESUME CAVEAT in the
   * header) — produced only by the deterministic double's synthetic `blockOn`; a v0.2 multi-step spec.
   */
  blocked?: { by: string[] };
}

/**
 * Runs one ELIO session turn through the real Vela engine. Pure w.r.t. ELIO state — it only reads
 * ctx.model / ctx.cost and the contract; the caller maps the result onto a SessionResult.
 */
export async function runVelaTurn(
  vela: VelaModule,
  contract: SessionContract,
  ctx: Ctx,
): Promise<BridgeTurnResult> {
  ensureDelegateRegistered(vela);

  const input = (contract.input ?? {}) as BridgeAgentInput;
  // Resolve the prompt text the delegate will route through ctx.model.
  const promptText =
    typeof input.prompt === "string"
      ? input.prompt
      : Array.isArray(input.messages) && input.messages.length > 0
        ? String(input.messages[input.messages.length - 1]?.content ?? "")
        : "";

  // NOTE: a fresh store per turn. For the v0.1 single-delegate-step shape the run COMPLETEs in one
  // advance(), so a longer-lived store would buy nothing on the real path (findByIdentity only re-finds
  // ACTIVE/PAUSED runs; see RESUME CAVEAT in the header). A persistent, correlation-keyed store is the
  // v0.2 prerequisite for cross-turn resume.
  const store = new vela.InMemoryStore();
  const engine = new vela.DefaultWorkflowEngine(store);
  const def = buildWorkflowDefinition();

  const correlation = corrKey(ctx.correlation);
  // The identity param is supplied so a v0.2 persistent store COULD re-find this run; v0.1 always creates.
  const [run] = await engine.startOrResume(def, {
    params: { [CORRELATION_PARAM]: correlation, [PROMPT_PARAM]: promptText },
  });

  const costSink = { cost: {} as Cost };
  const confidenceSink = { confidence: 0 };

  const advanced: VelaAdvanceResult = await delegateStore.run(
    { ctx, input, costSink, confidenceSink },
    () => engine.advance(run, def),
  );

  const text =
    typeof advanced.run.stateData["text"] === "string"
      ? (advanced.run.stateData["text"] as string)
      : "";

  const result: BridgeTurnResult = {
    text,
    cost: costSink.cost,
    confidence: confidenceSink.confidence,
  };
  // Real v0.1 single-step engine never sets blocked (RESUME CAVEAT) — this branch fires only under the
  // test double's synthetic blockOn, the v0.2 multi-step behavioural spec.
  if (advanced.blocked === true) {
    result.blocked = { by: advanced.blockedBy ?? [] };
  }
  return result;
}

/** Build the Elicitation an ELIO agent node raises when Vela blocks/pauses the run (Inv. 11). */
export function blockedElicitation(by: string[]): Elicitation {
  return {
    what:
      "Vela inner loop blockiert: unerfüllte Abhängigkeiten" +
      (by.length > 0 ? ` (${by.join(", ")})` : "") +
      " — eingreifen / freigeben? (Inv. 11)",
    whoCanAnswer: { users: ["operator"] },
    mode: "blocking",
  };
}
