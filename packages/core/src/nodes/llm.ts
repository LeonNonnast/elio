// ───────────────────────────── Built-in: llm (Inv. 6/7, klass "intelligence") ─────────────────────────────
// EINE der zwei Klasse-2-Nodes (delegierte Intelligenz, Inv. 7): "llm" = ONE-SHOT-Completion über
// ctx.model (der LLM-Worker, Inv. 17). KEIN Multi-Turn-Loop (das ist die agent-Node), KEIN eigenes
// Provider-Wissen — die Node baut einen provider-neutralen CompletionRequest aus input/`with` und
// reicht ihn an ctx.model.complete durch. ctx.model zeigt IMMER auf den Worker, nie auf einen Adapter.
//
// Security by absence (Inv. 14): die Node FORDERT Modelle an (requests.models). Der Injector hängt
// ctx.model NUR an, wenn die (getightenete) Policy mindestens ein Modell erlaubt UND ein ModelService
// verdrahtet ist. Fehlt ctx.model, wurde diese Node NICHT für Modelle freigegeben — die Node wirft
// dann einen klaren Fehler (kein stiller No-op, kein runtime permission-check: das Fehlen IST die
// Durchsetzung). tryWithRetry im Runner fängt den throw in ein Failed.

import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer llm-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst
 * ({{state.x}} -> branchState.x). Genau eine Prompt-Quelle:
 *  - { prompt: "..." }                          -> eine einzelne user-Message
 *  - { messages: [{role,content}, ...] }        -> volle (Multi-)Message-Konversation
 * plus optional:
 *  - system:   System-Prompt
 *  - model:    Modell-ID (routet im Worker; fehlt sie, nimmt der Worker sein Default-Modell)
 *  - maxTokens: Output-Token-Cap (Adapter-Default, falls ungesetzt)
 *  - as:       Output-Feldname (Default "text"), falls der Step keine outputs-Map deklariert
 */
export interface LlmWith {
  prompt?: string;
  messages?: { role: string; content: string }[];
  system?: string;
  /** Modell-id innerhalb des Providers (z.B. "llama3", "gpt-4o", "claude-opus-4-8"). */
  model?: string;
  /**
   * Provider-Profil (z.B. "ollama", "azure-openai", "claude"). Zusammen mit `model` bildet der Node die
   * kanonische Spec `provider:model`, die der Worker auf das passende Profil routet. Im feature.yaml
   * gepinnt = reproduzierbar; das Profil selbst (Endpoint/Credentials) liefert die Umgebung, nicht das YAML.
   */
  provider?: string;
  maxTokens?: number;
  /** Output-Feldname (Default "text"), falls der Step keine outputs-Map hat. */
  as?: string;
}

/**
 * Baut die kanonische Modell-Spec aus (Profil, Modell): `provider:model`, nur `provider` (Adapter-Default)
 * oder nur `model`. Geteilt von llm + agent, damit beide Nodes identisch routen.
 */
export function canonicalModel(provider?: string, model?: string): string | undefined {
  if (typeof provider === "string" && provider.length > 0) {
    return typeof model === "string" && model.length > 0 ? `${provider}:${model}` : provider;
  }
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/**
 * Der provider-neutrale Request, den die llm-Node an ctx.model.complete durchreicht. Bewusst HIER
 * lokal definiert (nicht aus @elio/sdk importiert): @elio/core kennt keine Provider-Details und darf
 * nicht unter dem SDK durchgreifen (Inv. 2). Das SDK (normalizeRequest) akzeptiert exakt diese Form.
 */
interface CompletionRequestShape {
  model?: string;
  system?: string;
  messages: { role: string; content: string }[];
  maxTokens?: number;
}

/** Baut einen CompletionRequest aus der (template-aufgelösten) llm-Konfiguration. */
function buildRequest(cfg: LlmWith): CompletionRequestShape {
  let messages: { role: string; content: string }[];
  if (Array.isArray(cfg.messages) && cfg.messages.length > 0) {
    messages = cfg.messages.map((m) => ({
      role: typeof m.role === "string" ? m.role : "user",
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));
  } else if (typeof cfg.prompt === "string") {
    messages = [{ role: "user", content: cfg.prompt }];
  } else {
    throw new Error(
      'llm node: kein Prompt — erwartet `prompt: string` ODER `messages: [{role,content}]` in `with`.',
    );
  }

  const req: CompletionRequestShape = { messages };
  if (typeof cfg.system === "string") req.system = cfg.system;
  const model = canonicalModel(cfg.provider, cfg.model);
  if (model !== undefined) req.model = model;
  if (typeof cfg.maxTokens === "number") req.maxTokens = cfg.maxTokens;
  return req;
}

/**
 * llm-Handler: one-shot Completion über ctx.model. Liefert Resolved<{text}> mit der vom Modell
 * gemeldeten confidence + cost. Charged ctx.cost, FALLS injiziert (graceful — der Runner bucht den
 * zurückgegebenen Resolved.cost ohnehin gegen das Budget; ctx.cost ist die node-lokale Sicht, Inv. 3).
 *
 * Wirft, wenn ctx.model fehlt — security by absence (Inv. 14): diese Node wurde nicht für Modelle
 * freigegeben (Policy erlaubt keins ODER kein ModelService verdrahtet). Kein stiller No-op.
 */
export const llmHandler: Node<LlmWith, { text: string }> = async (input, ctx) => {
  const cfg = (input ?? {}) as LlmWith;
  if (ctx.model === undefined) {
    throw new Error(
      "llm node: ctx.model ist nicht injiziert — security by absence (Inv. 14): diese Node wurde " +
        "nicht für Modelle freigegeben (Policy erlaubt kein Modell ODER kein ModelService verdrahtet).",
    );
  }

  const req = buildRequest(cfg);
  const out = await ctx.model.complete(req);

  // ctx.cost (falls injiziert) ist die node-lokale, gescopte Budget-SICHT (Inv. 3): im Runner-Pfad eine
  // ISOLIERTE view() des per-run BudgetTrackers (read-through remaining/depth, isolierter charge). Der
  // Runner bleibt die EINZIGE autoritative Senke — er bucht den zurückgegebenen Resolved.cost einmal
  // gegen den Outer-Tracker (§4 Schritt 9b). Dieser node-lokale charge() dekrementiert daher NUR die
  // isolierte Sicht, nie den Run-Tracker doppelt (Inv. 21).
  if (ctx.cost !== undefined) ctx.cost.charge(out.cost);

  const key = cfg.as ?? "text";
  const result: Resolved<{ text: string }> = {
    status: "resolved",
    output: { [key]: out.text } as { text: string },
    confidence: out.confidence,
    cost: out.cost,
  };
  return result;
};

/**
 * Registrierbare Definition der built-in llm-Node (Inv. 6 — built-in == custom; Inv. 7 — Klasse 2).
 * `requests.models: ["*"]` signalisiert dem Injector "diese Node will Modelle"; der getightenete
 * Policy-Schnitt (req ∩ allowedModels) entscheidet, ob ctx.model tatsächlich injiziert wird. Ein
 * Feature/Author kann die Definition mit einer ENGEREN Modell-Liste überschreiben (tighten-only,
 * Inv. 13); "*" ist nur der weiteste Vorschlag, den die Policy beliebig verschärft.
 */
export const llmNode: NodeDefinition<LlmWith, { text: string }> = {
  type: "llm",
  klass: "intelligence",
  handler: llmHandler,
  requests: { models: ["*"] },
};
