// ───────────────────────────── InProcessAgentEngine: transparenter Inner Loop (Slice 3, Inv. 17/18/21) ─────────────────────────────
// ctx.agent = der Inner-Loop-Pfad (Inv. 17). Diese Engine ist die v0.1-Default-AgentEngine: ein
// IN-PROCESS Multi-Turn-Loop, dessen Modellaufrufe ALLE durch ctx.model fließen — daher
// governance: "transparent" (Inv. 18: volle per-Call-Governance/Audit/Cost, weil jeder Call durch den
// gescopten ctx.model-Worker geht; KEINE opake Black Box). Vela (Slice 5) und opake Coding-CLIs docken
// am SELBEN AgentEngine-Contract an; diese hier ist die transparente, dep-freie Referenz-Engine.
//
// Inv. 21 (Budget/Tiefe): run(contract, ctx) erbt das RESTbudget aus contract.budget UND die Tiefe aus
// contract.depth — NIE ein frisches. BEIDE Hälften der Invariante werden geprüft: VOR dem Loop wird
// contract.depth gegen contract.maxDepth geprüft (Ceiling erreicht -> Elicitation an den Menschen, kein
// stilles Weiterlaufen). Im Loop dekrementiert ein lokales Rest-Budget pro Turn und stoppt, sobald es
// erschöpft ist; das verbrauchte Budget reist als SessionResult.result.cost hoch, wo der aufrufende
// agent-Node + der Outer Runner es gegen den geteilten Tracker buchen.

import type {
  AgentEngine,
  AgentService,
  Cost,
  Ctx,
  Elicitation,
  Resolved,
  SessionContract,
  SessionResult,
  Suspended,
} from "@elio/core";
import { canonicalModel } from "@elio/core";

/** Provider-neutraler Request — dieselbe Form wie CompletionRequest (normalizeRequest akzeptiert sie). */
interface CompletionRequestShape {
  model?: string;
  system?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
}

/** Die (template-aufgelöste) agent-Konfiguration, die der agent-Node als contract.input durchreicht. */
interface AgentInput {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  model?: string;
  provider?: string;
  maxTokens?: number;
  maxTurns?: number;
  stopWhen?: string;
}

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

function initialMessages(input: AgentInput): { role: string; content: string }[] {
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
    'InProcessAgentEngine: kein Prompt — erwartet `prompt` ODER `messages` im SessionContract.input.',
  );
}

export interface InProcessAgentEngineOptions {
  /** Default maxTurns, falls der Input keins setzt (Default 3). */
  maxTurns?: number;
  /** Default Stop-Marker, falls der Input keins setzt (Default "DONE"). */
  stopWhen?: string;
}

export class InProcessAgentEngine implements AgentEngine {
  readonly id = "in-process";
  /** transparent: jeder Modellaufruf fließt durch ctx.model -> volle Inv. 14/18. */
  readonly governance = "transparent" as const;

  private readonly defaultMaxTurns: number;
  private readonly defaultStopWhen: string;

  constructor(opts: InProcessAgentEngineOptions = {}) {
    this.defaultMaxTurns = opts.maxTurns ?? 3;
    this.defaultStopWhen = opts.stopWhen ?? "DONE";
  }

  /**
   * Bounded Inner Loop via ctx.model (Inv. 18). Erbt contract.budget (RESTbudget, nie frisch — Inv. 21)
   * als lokalen Bound: jeder Turn zieht seine usd-Kosten ab; ist das lokale Budget erschöpft, stoppt
   * der Loop und liefert den bisherigen Stand. Konvergenz-/Rollen-Stop: enthält eine Antwort den
   * Stop-Marker, ist der Loop fertig.
   *
   * Tiefen-Ceiling (Inv. 21, BEIDE Hälften): VOR dem Loop wird die geerbte contract.depth gegen
   * contract.maxDepth geprüft. depth >= maxDepth -> KEIN Loop, sondern eine Elicitation an den Menschen
   * ("Tiefen-Limit erreicht — mehr freigeben?", Inv. 11/21) — kein hartes Sterben, kein ungebremstes
   * Nesting. So trägt die Session-Grenze ein echtes, konsumiertes Tiefen-Limit (nicht nur eine
   * Konstante, die niemand liest).
   */
  async run(contract: SessionContract, ctx: Ctx): Promise<SessionResult> {
    if (ctx.model === undefined) {
      // transparente Engine OHNE ctx.model = nicht für Modelle freigegeben (security by absence).
      throw new Error(
        "InProcessAgentEngine: ctx.model ist nicht injiziert — die transparente Engine kann ohne " +
          "Modell-Pfad nicht denken (Inv. 14/18).",
      );
    }

    // Inv. 21 (Tiefe): das geerbte Ceiling prüfen, BEVOR der Inner Loop überhaupt startet. Erreicht die
    // geerbte Tiefe das maxDepth, propagiert die Engine eine Elicitation HOCH (kein stilles Weiterlaufen,
    // kein Hard-Crash) — der aufrufende agent-Node reicht das Suspended an den Outer Runner.
    if (contract.depth >= contract.maxDepth) {
      const elicitation: Elicitation = {
        what:
          `agent inner loop: Tiefen-Limit erreicht (depth=${contract.depth} >= maxDepth=${contract.maxDepth}) ` +
          `— mehr Tiefe freigeben? (Inv. 21)`,
        whoCanAnswer: { users: ["operator"] },
        mode: "blocking",
      };
      return { elicitation };
    }

    const input = (contract.input ?? {}) as AgentInput;
    const maxTurns = Math.max(1, input.maxTurns ?? this.defaultMaxTurns);
    const stopWhen = input.stopWhen ?? this.defaultStopWhen;
    const stopMarker = stopWhen.toLowerCase();
    const messages = initialMessages(input);

    // Lokales Rest-Budget = das geerbte contract.budget (Inv. 21). Wird pro Turn dekrementiert; der
    // geteilte ctx.cost-Tracker (falls injiziert) wird zusätzlich belastet, damit der OUTER-Budget-
    // Stand korrekt mitläuft (transparent: dieselbe Senke wie ein direkter ctx.model-Call).
    let remaining = contract.budget;
    let totalCost: Cost = {};
    let lastText = "";
    let lastConfidence = 0;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      // Inv. 21: erschöpftes (geerbtes) Budget stoppt den Loop — kein frisches Budget pro Turn.
      if (turn > 0 && remaining <= 0) break;

      const req: CompletionRequestShape = { messages: [...messages] };
      if (typeof input.system === "string") req.system = input.system;
      // Kanonische provider:model-Spec (aus input.provider+model) ODER das vom agent-Node gesetzte
      // contract.routing[0] (das bereits kanonisch ist). So routet die transparente Engine identisch.
      const model = canonicalModel(input.provider, input.model) ?? contract.routing?.models?.[0];
      if (typeof model === "string") req.model = model;
      if (typeof input.maxTokens === "number") req.maxTokens = input.maxTokens;

      const out = await ctx.model.complete(req);
      lastText = out.text;
      lastConfidence = out.confidence;
      totalCost = addCost(totalCost, out.cost);
      remaining -= out.cost.usd ?? 0;
      if (ctx.cost !== undefined) ctx.cost.charge(out.cost);

      messages.push({ role: "assistant", content: out.text });

      if (out.text.toLowerCase().includes(stopMarker)) break;

      if (turn < maxTurns - 1) {
        messages.push({
          role: "user",
          content: `Refine the previous answer. If it is already complete and correct, reply with "${stopWhen}".`,
        });
      }
    }

    const resolved: Resolved<{ text: string }> = {
      status: "resolved",
      output: { text: lastText },
      confidence: lastConfidence,
      cost: totalCost,
    };
    return { result: resolved };
  }
}

/**
 * AgentService-Wrapper, der eine AgentEngine an ein konkretes Ctx bindet (Inv. 17). `session(contract)`
 * ruft `engine.run(contract, ctx)`. Der PolicyInjector bindet die Engine intern selbst (security by
 * absence — ctx.agent wird wie ctx.model gegated); dieser Wrapper ist die SDK-seitige, direkt nutzbare
 * Variante (z.B. um eine Engine programmatisch gegen ein gebautes Ctx zu fahren / in Tests).
 */
export class InProcessAgentService implements AgentService {
  constructor(
    private readonly engine: AgentEngine,
    private readonly ctx: Ctx,
  ) {}

  session(contract: SessionContract): Promise<SessionResult> {
    return this.engine.run(contract, this.ctx);
  }
}

/** Factory: bindet eine AgentEngine an ein Ctx und liefert den AgentService (Inv. 17). */
export function boundAgentService(engine: AgentEngine, ctx: Ctx): AgentService {
  return new InProcessAgentService(engine, ctx);
}

// Re-Export der genutzten Kern-Typen für Konsumenten dieses Moduls (Suspended wird im Engine-Pfad
// nicht erzeugt, aber der Contract erlaubt es — re-exportiert für vollständige Typ-Sicht).
export type { AgentEngine, AgentService, SessionContract, SessionResult, Suspended };
