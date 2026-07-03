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
// SUSPEND / RESUME (identity↔correlation, Inv. 11/12 — §v0.2, IMPLEMENTED):
//   A turn that PAUSES (Vela's advance returns blocked / leaves the run PAUSED) is surfaced as `blocked`,
//   which the engine maps to an ELIO Suspended (Inv. 11). The paused run is kept in a store that OUTLIVES
//   the turn (the engine owns one persistent store, not one-per-turn). On the RESUME turn the agent node
//   re-delegates with contract.resume set (the human's answer); startOrResume re-finds the SAME run by its
//   RESUME-STABLE identity key (identityKey() = run::branch::step, checkpoint dropped so it matches across
//   the suspend/resume boundary), and advance() is driven with `{ resumeAnswer }` to unblock the step,
//   route the model call through ctx.model, and RESOLVE. This closes the two v0.1 gaps (no cross-turn
//   store, unstable identity key). The core seam that carries the answer across the boundary is real
//   (SessionContract.resume <- ctx.resume, set by the runner only at the re-driven step).
//
// HONESTY (impl-decisions §7): the suspend/resume + identity-resume roundtrip is verified against the
// deterministic double (a faithful mirror of Vela's findByIdentity + pause). The REAL DefaultWorkflowEngine
// returns blocked:true only for a NEXT step with an unsatisfied depends_on; the single-delegate-step shape
// does not pause on the real engine, so on real Vela this still degrades to a single RESOLVED turn (a real
// multi-step/pause-surface workflow is the remaining real-path work). Same best-effort posture as before —
// now with the resume machinery genuinely built + tested, not merely aspirational.
//
// The delegate registry is a MODULE-GLOBAL in vela-sdk (registerDelegate throws on duplicate). The
// bridge registers ONE stable handler name idempotently (guarded by resolveDelegate) and threads the
// per-call ctx.model through a per-run AsyncLocalStorage so concurrent/repeat sessions never collide on
// the shared global handler.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Cost, CorrelationId, Ctx, Elicitation, SessionContract } from "@elio/core";
import type {
  VelaAdvanceResult,
  VelaDelegateContext,
  VelaModule,
  VelaWorkflowDefinition,
  VelaWorkflowStore,
} from "./vela-contract";

/** Stable delegate name the bridge registers in Velas global registry. */
export const ELIO_MODEL_DELEGATE = "elio-model";

/**
 * Identity param carrying a RESUME-STABLE ELIO correlation key (identity↔correlation, Inv. 12). This is
 * the key Vela's store.findByIdentity uses to re-find a PAUSED run on the next (resume) turn. It must be
 * stable across a suspend/resume cycle, so it deliberately DROPS the volatile checkpoint segment of the
 * correlation (a fresh checkpoint id is minted on every suspend) — see identityKey().
 */
export const CORRELATION_PARAM = "elioCorrelation";
/** Param carrying the resolved prompt for the turn. */
export const PROMPT_PARAM = "elioPrompt";

/**
 * Resume-stable identity key = run::branch::step (NO checkpoint). corrKey() would append the checkpoint,
 * which changes on every suspend, so it could never match across a suspend/resume. Dropping it makes the
 * SAME agent step re-find its own paused Vela run on resume (identity↔correlation, Inv. 12).
 */
export function identityKey(corr: CorrelationId): string {
  return `${corr.run}::${corr.branch}::${corr.step}`;
}

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
        // identity:true tags the run so startOrResume can re-find it via findByIdentity on the resume turn
        // (identity↔correlation, Inv. 12). The value is the resume-stable identityKey (see header).
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
   * Set when Vela paused/blocked the run -> the engine maps it to an ELIO Suspended (Inv. 11) and keeps
   * the run PAUSED in the persistent store as the resume target. Produced by the double's `blockOn` (and
   * by any real multi-step/pause-surface workflow); the single-delegate-step shape does not pause on the
   * real engine (see header HONESTY note).
   */
  blocked?: { by: string[] };
}

/**
 * Runs one ELIO session turn through the Vela engine. Pure w.r.t. ELIO state — it only reads
 * ctx.model / ctx.cost and the contract; the caller maps the result onto a SessionResult.
 *
 * `store` is supplied by the engine and PERSISTS across turns (identity↔correlation, Inv. 12): on a
 * resume turn, startOrResume re-finds the same run's PAUSED entry by its resume-stable identity key and
 * advance() is driven with the human's answer (contract.resume) to unblock it. On a first turn the run
 * is created fresh; if the run pauses/blocks, the bridge surfaces `blocked` -> the engine maps it to an
 * ELIO Suspended (Inv. 11) and the run stays in `store` as the resume target for the next turn.
 */
export async function runVelaTurn(
  vela: VelaModule,
  contract: SessionContract,
  ctx: Ctx,
  store: VelaWorkflowStore,
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

  const engine = new vela.DefaultWorkflowEngine(store);
  const def = buildWorkflowDefinition();

  const identity = identityKey(ctx.correlation);
  // startOrResume re-finds a PAUSED run with this identity (resume), else creates a fresh one (first turn).
  const [run] = await engine.startOrResume(def, {
    params: { [CORRELATION_PARAM]: identity, [PROMPT_PARAM]: promptText },
  });

  const costSink = { cost: {} as Cost };
  const confidenceSink = { confidence: 0 };

  // On a resume turn, feed the human answer into advance() so the paused step unblocks (Inv. 11/12).
  const advanceOpts =
    contract.resume !== undefined ? { resumeAnswer: contract.resume.answer } : undefined;

  const advanced: VelaAdvanceResult = await delegateStore.run(
    { ctx, input, costSink, confidenceSink },
    () => engine.advance(run, def, advanceOpts),
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
  // Vela paused/blocked the run (unsatisfied depends_on / a pause surface) -> surface it so the engine
  // maps it to an ELIO Suspended; the run stays PAUSED in `store` as the resume target for the next turn.
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
