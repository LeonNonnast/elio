// ───────────────────────────── Built-in: agent (Inv. 6/7/8/17, klass "intelligence") ─────────────────────────────
// Die ZWEITE Klasse-2-Node (delegierte Intelligenz, Inv. 7): "agent" = ein MULTI-TURN Inner Loop
// (im Gegensatz zum one-shot "llm"). v0.1 ist der Loop IN-PROCESS (Vela als pluggable Engine kommt
// in Slice 5, §7):
//   - ctx.agent vorhanden  -> an die verdrahtete AgentEngine delegieren (Inv. 17/18). Die Engine
//                             erbt das Restbudget/-Tiefe via SessionContract (nie frisch, Inv. 21).
//   - sonst                -> kleiner in-process Loop über ctx.model: ein erster "propose"-Turn,
//                             dann bis maxTurns "self-refine"-Turns, mit einer einfachen
//                             Konvergenz-/Rollen-Stop-Bedingung. ctx.model fehlt -> klarer Fehler
//                             (security by absence, Inv. 14 — die Node wurde nicht für Modelle freigegeben).
//
// Rückgabe: Resolved<{output}> (akkumulierte Kosten aller Turns) ODER Suspended (die Node KANN via
// ctx.elicit eskalieren — z.B. wenn maxTurns ohne Konvergenz erschöpft ist und das Feature Oversight
// will). Budget/Tiefe werden geehrt: der innere Loop bricht ab, sobald ctx.cost (falls injiziert) kein
// Restbudget mehr meldet — er erbt damit dasselbe Budget wie der Outer Loop (Inv. 21), nie ein frisches.

import type { Cost } from "../common";
import type { Node, NodeDefinition, Resolved, Suspended } from "../node";
import type { SessionContract, SessionResult } from "../session";
import { canonicalModel } from "./llm";

/**
 * Konfiguration einer agent-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst.
 *  - prompt / messages: Start der Konversation (wie bei llm).
 *  - system:    System-Prompt.
 *  - model:     Modell-ID (routet im Worker; sonst Worker-Default).
 *  - maxTokens: Output-Token-Cap pro Turn.
 *  - maxTurns:  Obergrenze an Turns des in-process Loops (Default 3). Inkl. dem propose-Turn.
 *  - stopWhen:  optionaler Stop-Marker; enthält die Antwort eines Turns ihn (case-insensitive),
 *               gilt der Loop als konvergiert. Default: "DONE".
 *  - onMaxTurns: was tun, wenn maxTurns OHNE Konvergenz erschöpft ist:
 *               "resolve" (Default) -> die letzte Antwort als Output liefern;
 *               "escalate"          -> via ctx.elicit eskalieren (Suspended), sofern ctx.elicit da ist.
 *  - as:        Output-Feldname (Default "output"), falls der Step keine outputs-Map deklariert.
 */
export interface AgentWith {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  /** Modell-id innerhalb des Providers. */
  model?: string;
  /** Provider-Profil; mit `model` bildet der Node die kanonische Spec `provider:model` (siehe llm-Node). */
  provider?: string;
  maxTokens?: number;
  maxTurns?: number;
  stopWhen?: string;
  onMaxTurns?: "resolve" | "escalate";
  as?: string;
}

/** Provider-neutraler Request — lokal definiert (Inv. 2: @elio/core greift nicht unter das SDK). */
interface CompletionRequestShape {
  model?: string;
  system?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
}

/** Summiert zwei Cost-Werte (usd + tokens), nur gesetzte Felder. */
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

/** Baut die initialen Messages aus der (template-aufgelösten) Konfiguration. */
function initialMessages(cfg: AgentWith): { role: string; content: string }[] {
  if (Array.isArray(cfg.messages) && cfg.messages.length > 0) {
    return cfg.messages.map((m) => ({
      role: typeof m.role === "string" ? m.role : "user",
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));
  }
  if (typeof cfg.prompt === "string") {
    return [{ role: "user", content: cfg.prompt }];
  }
  throw new Error(
    'agent node: kein Prompt — erwartet `prompt: string` ODER `messages: [{role,content}]` in `with`.',
  );
}

/** Extrahiert ein NodeResult aus einem SessionResult der delegierten Engine. */
function fromSessionResult(sr: SessionResult): Resolved<{ output: unknown }> | Suspended {
  if ("elicitation" in sr) {
    return { status: "suspended", elicitation: sr.elicitation };
  }
  const res = sr.result;
  if (res.status === "suspended") return res;
  if (res.status === "resolved") {
    // Engine-Output unter {output} normalisieren (so liest mergeOutput/outputs ihn einheitlich).
    return {
      status: "resolved",
      output: { output: res.output },
      confidence: res.confidence,
      cost: res.cost,
    };
  }
  // Failed aus einer Engine -> als Fehler hochwerfen (tryWithRetry fängt es in Failed).
  throw new Error(`agent node: delegierte Engine lieferte failed: ${res.error.message}`);
}

export const agentHandler: Node<AgentWith, { output: unknown }> = async (input, ctx) => {
  const cfg = (input ?? {}) as AgentWith;
  const asKey = cfg.as ?? "output";

  // ── Pfad A: an die verdrahtete AgentEngine delegieren (Inv. 17/18). ──
  // Restbudget UND Tiefe reisen im SessionContract (nie frisch, Inv. 21). ctx.cost ist die node-lokale
  // Budget-/Tiefen-Sicht (im integrierten Runtime an den per-run BudgetTracker gebunden): remaining()
  // = echtes Restbudget; depth()/maxDepth() = die echte Rekursionstiefe + das Ceiling. Der Inner Loop
  // läuft EINE Stufe tiefer als der aufrufende Outer-Step (childDepth = depth+1); die Engine prüft das
  // gegen maxDepth und dekrementiert das Budget selbst.
  if (ctx.agent !== undefined) {
    const parentDepth = ctx.cost?.depth?.() ?? 0;
    const maxDepth = ctx.cost?.maxDepth?.() ?? Number.POSITIVE_INFINITY;
    const canonical = canonicalModel(cfg.provider, cfg.model);
    const contract: SessionContract = {
      input: cfg,
      budget: ctx.cost !== undefined ? ctx.cost.remaining() : Number.POSITIVE_INFINITY,
      depth: parentDepth + 1,
      maxDepth,
      ...(canonical !== undefined ? { routing: { models: [canonical] } } : {}),
      // Resume (Inv. 11/12): setzt der Runner ctx.resume (nur am wieder-ausgeführten suspendierten Step),
      // reicht die Node die Antwort in den Contract — eine Engine mit persistenter Session (Vela) setzt
      // damit ihren pausierten Inner Loop fort, statt frisch zu starten.
      ...(ctx.resume !== undefined ? { resume: { answer: ctx.resume.answer } } : {}),
    };
    const sr = await ctx.agent.session(contract);
    const mapped = fromSessionResult(sr);
    if (mapped.status === "resolved") {
      // {output} -> {<asKey>} umbenennen, damit `as`/outputs greift.
      const value = (mapped.output as { output: unknown }).output;
      return {
        status: "resolved",
        output: { [asKey]: value } as { output: unknown },
        confidence: mapped.confidence,
        cost: mapped.cost,
      };
    }
    return mapped;
  }

  // ── Pfad B: in-process Loop über ctx.model (Vela kommt Slice 5). ──
  if (ctx.model === undefined) {
    throw new Error(
      "agent node: weder ctx.agent noch ctx.model injiziert — security by absence (Inv. 14): " +
        "diese Node wurde nicht für delegierte Intelligenz freigegeben.",
    );
  }

  const maxTurns = Math.max(1, cfg.maxTurns ?? 3);
  const stopMarker = (cfg.stopWhen ?? "DONE").toLowerCase();
  const messages = initialMessages(cfg);

  let totalCost: Cost = {};
  let lastText = "";
  let lastConfidence = 0;
  let converged = false;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    // Budget-Bewusstsein (Inv. 21): erbt das Outer-Restbudget über ctx.cost. Vor jedem Turn prüfen —
    // ein erschöpftes Budget stoppt den Loop (kein frisches Budget pro Turn).
    if (ctx.cost !== undefined && turn > 0 && ctx.cost.remaining() <= 0) break;

    const req: CompletionRequestShape = { messages: [...messages] };
    if (typeof cfg.system === "string") req.system = cfg.system;
    const canonicalB = canonicalModel(cfg.provider, cfg.model);
    if (canonicalB !== undefined) req.model = canonicalB;
    if (typeof cfg.maxTokens === "number") req.maxTokens = cfg.maxTokens;

    const out = await ctx.model.complete(req);
    lastText = out.text;
    lastConfidence = out.confidence;
    totalCost = addCost(totalCost, out.cost);
    if (ctx.cost !== undefined) ctx.cost.charge(out.cost);

    // Antwort des Modells als assistant-Turn anhängen.
    messages.push({ role: "assistant", content: out.text });

    // Konvergenz-/Rollen-Stop: Marker in der Antwort -> fertig.
    if (out.text.toLowerCase().includes(stopMarker)) {
      converged = true;
      break;
    }

    // Self-refine-Turn: das Modell zur Verfeinerung auffordern (außer es war der letzte erlaubte Turn).
    if (turn < maxTurns - 1) {
      messages.push({
        role: "user",
        content: `Refine the previous answer. If it is already complete and correct, reply with "${cfg.stopWhen ?? "DONE"}".`,
      });
    }
  }

  // maxTurns ohne Konvergenz erschöpft -> optional eskalieren (Inv. 11), sonst die letzte Antwort liefern.
  if (!converged && cfg.onMaxTurns === "escalate" && ctx.elicit !== undefined) {
    return ctx.elicit.raise({
      what: `agent did not converge within ${maxTurns} turns — intervene? (last: ${lastText.slice(0, 200)})`,
      whoCanAnswer: { users: ["operator"] },
    });
  }

  const result: Resolved<{ output: unknown }> = {
    status: "resolved",
    output: { [asKey]: lastText } as { output: unknown },
    confidence: lastConfidence,
    cost: totalCost,
  };
  return result;
};

/**
 * Registrierbare Definition der built-in agent-Node (Inv. 6 — built-in == custom; Inv. 7 — Klasse 2).
 * Wie llm fordert sie Modelle an ("*" = "die erlaubten", Policy verschärft); dasselbe Gate steuert
 * ctx.model UND ctx.agent (siehe Injector). Eine engere Modell-Liste = tighten-only (Inv. 13).
 */
export const agentNode: NodeDefinition<AgentWith, { output: unknown }> = {
  type: "agent",
  klass: "intelligence",
  handler: agentHandler,
  requests: { models: ["*"] },
};
