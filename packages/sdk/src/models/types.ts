// ───────────────────────────── ModelService — konkrete CompletionRequest-Form (Slice 3, Inv. 17) ─────────────────────────────
// @elio/core deklariert ModelService.complete(req: unknown) / stream?(req: unknown) bewusst untypisiert
// (der Kern kennt keine Provider-Details). Hier pinnt das SDK die konkrete Request-Form, die ALLE Adapter
// (mock/ollama/claude) + der LlmWorker teilen. ctx.model zeigt auf den Worker, nie direkt auf einen Adapter.

import type { Cost } from "@elio/core";

/** Eine Chat-Message im Provider-neutralen Format. */
export interface CompletionMessage {
  role: string; // "user" | "assistant" (system geht über CompletionRequest.system)
  content: string;
}

/**
 * Provider-neutraler Completion-Request. Jeder Adapter mappt das auf sein Wire-Format:
 *  - mock:   deterministische Transformation, kein Netz.
 *  - ollama: POST /api/chat (messages + optional system als erste system-message).
 *  - claude: POST /v1/messages (messages + top-level `system`).
 */
export interface CompletionRequest {
  /** Modell-ID; routet im Worker zum Provider. Fehlt sie, nimmt der Worker sein Default-Modell. */
  model?: string;
  /** Optionaler System-Prompt. */
  system?: string;
  /** Die Konversation (mindestens eine user-Message). */
  messages: CompletionMessage[];
  /** Max. Output-Tokens (Adapter-Default, falls ungesetzt). */
  maxTokens?: number;
}

/** Ergebnis von complete(). */
export interface CompletionResult {
  text: string;
  cost: Cost;
  confidence: number; // 0..1
}

/** Ein Streaming-Chunk: ein Delta-Token ODER der finale done-Marker mit Cost/Confidence. */
export type CompletionChunk = { delta: string } | { done: { cost: Cost; confidence: number } };

/**
 * Re-Export des Kern-Contracts. Adapter implementieren `ModelService` (complete + optional stream);
 * die hier definierte CompletionRequest-Form ist das, was zur Laufzeit als `req` durchgereicht wird.
 */
export type { ModelService } from "@elio/core";
export type { Cost } from "@elio/core";

// ───────────────────────────── Kosten (Cost.usd) — Richtwerte statt präziser Tabelle ─────────────────────────────
/**
 * BEWUSST LEER: ELIO führt keine präzise Pricing-Tabelle pro Modell mehr. Kosten sind grobe RICHTWERTE
 * pro Provider-PROFIL (`profile.cost.usdPerMTok`) und werden zentral vom LlmWorker aus den Token-Counts
 * gestempelt (siehe worker.ts stampCost). Adapter melden daher von sich aus usd:0; das Geld kommt aus dem
 * Profil. Diese Konstante + usdFromTokens bleiben als rückwärtskompatibler Helfer (liefert 0 für alle).
 */
export const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {};

/** Backward-compat-Helfer: liefert mit der (jetzt leeren) Tabelle 0 — Kosten kommen aus Profil-Richtwerten. */
export function usdFromTokens(model: string, tokensIn: number, tokensOut: number): number {
  const price = PRICE_PER_MTOK[model];
  if (price === undefined) return 0;
  return (tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out;
}

/**
 * Normalisiert einen rohen `req: unknown` (so wie der Kern ihn an ModelService durchreicht) zu einer
 * CompletionRequest. Akzeptiert: bereits-CompletionRequest, oder ein {prompt: string}-Kurzform,
 * oder einen reinen String. Wirft bei unbrauchbarem Input — Adapter sollen früh & klar fehlschlagen.
 */
export function normalizeRequest(req: unknown): CompletionRequest {
  if (typeof req === "string") {
    return { messages: [{ role: "user", content: req }] };
  }
  if (typeof req === "object" && req !== null) {
    const r = req as Record<string, unknown>;
    if (Array.isArray(r["messages"])) {
      // Schon eine CompletionRequest-artige Form: defensiv die Felder übernehmen.
      const messages = (r["messages"] as unknown[]).map((m) => {
        const mm = (m ?? {}) as Record<string, unknown>;
        return {
          role: typeof mm["role"] === "string" ? (mm["role"] as string) : "user",
          content: typeof mm["content"] === "string" ? (mm["content"] as string) : String(mm["content"] ?? ""),
        };
      });
      const out: CompletionRequest = { messages };
      if (typeof r["model"] === "string") out.model = r["model"] as string;
      if (typeof r["system"] === "string") out.system = r["system"] as string;
      if (typeof r["maxTokens"] === "number") out.maxTokens = r["maxTokens"] as number;
      return out;
    }
    if (typeof r["prompt"] === "string") {
      const out: CompletionRequest = { messages: [{ role: "user", content: r["prompt"] as string }] };
      if (typeof r["model"] === "string") out.model = r["model"] as string;
      if (typeof r["system"] === "string") out.system = r["system"] as string;
      if (typeof r["maxTokens"] === "number") out.maxTokens = r["maxTokens"] as number;
      return out;
    }
  }
  throw new Error("ModelService: invalid request — expected CompletionRequest, {prompt} or string");
}

/** Letzte user-Message (für mock/echo). Fällt auf die letzte Message zurück, falls keine user-Rolle. */
export function lastUserContent(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m !== undefined && m.role === "user") return m.content;
  }
  const last = req.messages[req.messages.length - 1];
  return last?.content ?? "";
}
