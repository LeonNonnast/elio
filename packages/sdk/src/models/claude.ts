// ───────────────────────────── ClaudeModel: Anthropic Messages API (RAW fetch, Slice 3, Inv. 17, §6) ─────────────────────────────
// POST https://api.anthropic.com/v1/messages über rohes fetch (KEIN SDK, keine neue Runtime-Dep).
// Default-Modell claude-opus-4-8. Opus-4.8-Constraints: KEINE temperature/top_p/top_k, KEIN
// thinking.budget_tokens (alle 400) -> für einen reinen Completion-Adapter thinking ganz weglassen.
// Cost.usd aus usage-Tokens + Preistabelle (claude-opus-4-8 = $5 in / $25 out per 1M).
// Injizierbarer fetchImpl + apiKey, damit Tests ohne Netz laufen.

import type { Cost } from "@elio/core";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  ModelService,
} from "./types";
import { normalizeRequest, usdFromTokens } from "./types";

type FetchImpl = typeof fetch;

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";

export interface ClaudeModelOptions {
  /** API-Key; Default process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Default-Modell, falls req.model fehlt (Default claude-opus-4-8). */
  defaultModel?: string;
  /** Default max_tokens, falls req.maxTokens fehlt (Default 1024). */
  maxTokens?: number;
  /** Injizierbares fetch (Default global fetch) — Tests reichen ein Double rein. */
  fetchImpl?: FetchImpl;
  /** Feste Confidence (Anthropic liefert keine; Default 0.9). */
  confidence?: number;
  /** Endpoint-Override (Tests/Proxy); Default die echte Messages-API-URL. */
  endpoint?: string;
}

/** Anthropic-Request-Body. Bewusst OHNE temperature/top_p/top_k/thinking (Opus-4.8-Constraints). */
interface AnthropicBody {
  model: string;
  max_tokens: number;
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  stream?: boolean;
}

/** Mappt CompletionRequest auf den Anthropic-Body. Nur user/assistant; alles andere -> user. */
function toAnthropicBody(req: CompletionRequest, model: string, maxTokens: number): AnthropicBody {
  const messages = req.messages.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));
  const body: AnthropicBody = { model, max_tokens: maxTokens, messages };
  if (req.system !== undefined && req.system.length > 0) body.system = req.system;
  return body;
}

export class ClaudeModel implements ModelService {
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: FetchImpl;
  private readonly confidence: number;
  private readonly endpoint: string;

  constructor(opts: ClaudeModelOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "";
    this.defaultModel = opts.defaultModel ?? DEFAULT_CLAUDE_MODEL;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.confidence = opts.confidence ?? 0.9;
    this.endpoint = opts.endpoint ?? ENDPOINT;
  }

  /** Ob ein API-Key vorhanden ist (vom Preflight genutzt, um ein claude-Profil als einsatzbereit zu prüfen). */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Die drei Pflicht-Header (content-type + x-api-key + anthropic-version). */
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  async complete(reqRaw: unknown): Promise<CompletionResult> {
    const req = normalizeRequest(reqRaw);
    const model = req.model ?? this.defaultModel;
    const maxTokens = req.maxTokens ?? this.maxTokens;
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(toAnthropicBody(req, model, maxTokens)),
    });
    if (!res.ok) {
      throw new Error(`ClaudeModel: HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      content?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      model?: unknown;
    };

    const text = extractText(json.content);
    const tokensIn = typeof json.usage?.input_tokens === "number" ? json.usage.input_tokens : 0;
    const tokensOut = typeof json.usage?.output_tokens === "number" ? json.usage.output_tokens : 0;
    const respModel = typeof json.model === "string" ? json.model : model;

    const cost: Cost = {
      usd: usdFromTokens(respModel, tokensIn, tokensOut),
      tokensIn,
      tokensOut,
      model: respModel,
    };
    return { text, cost, confidence: this.confidence };
  }

  async *stream(reqRaw: unknown): AsyncIterable<CompletionChunk> {
    const req = normalizeRequest(reqRaw);
    const model = req.model ?? this.defaultModel;
    const maxTokens = req.maxTokens ?? this.maxTokens;
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ ...toAnthropicBody(req, model, maxTokens), stream: true }),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`ClaudeModel: HTTP ${res.status} ${res.statusText} (no stream body)`);
    }

    // SSE: "data: {json}"-Zeilen. content_block_delta(delta.type==="text_delta") -> delta.text;
    // message_delta trägt usage.output_tokens + stop_reason; message_stop beendet es.
    // input_tokens kommt im message_start.message.usage.
    let tokensIn = 0;
    let tokensOut = 0;
    let respModel = model;

    for await (const data of readSse(res.body)) {
      let ev: {
        type?: unknown;
        delta?: { type?: unknown; text?: unknown };
        message?: { usage?: { input_tokens?: unknown }; model?: unknown };
        usage?: { output_tokens?: unknown };
      };
      try {
        ev = JSON.parse(data) as typeof ev;
      } catch {
        continue;
      }
      const type = ev.type;
      if (type === "message_start") {
        if (typeof ev.message?.usage?.input_tokens === "number") {
          tokensIn = ev.message.usage.input_tokens;
        }
        if (typeof ev.message?.model === "string") respModel = ev.message.model;
      } else if (type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          const text = ev.delta.text;
          if (text.length > 0) yield { delta: text };
        }
      } else if (type === "message_delta") {
        if (typeof ev.usage?.output_tokens === "number") tokensOut = ev.usage.output_tokens;
      } else if (type === "message_stop") {
        break;
      }
    }

    const cost: Cost = {
      usd: usdFromTokens(respModel, tokensIn, tokensOut),
      tokensIn,
      tokensOut,
      model: respModel,
    };
    yield { done: { cost, confidence: this.confidence } };
  }
}

/** Extrahiert Text aus den content-Blöcken (type==="text" -> .text), konkateniert in Reihenfolge. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>)["type"] === "text" &&
      typeof (block as Record<string, unknown>)["text"] === "string"
    ) {
      out += (block as Record<string, unknown>)["text"] as string;
    }
  }
  return out;
}

/**
 * Liest einen SSE-Body und yieldet die JSON-Nutzlast jeder `data:`-Zeile (ohne das "data: "-Präfix).
 * Events werden durch Leerzeilen getrennt; `event:`-Zeilen werden ignoriert (der `type` steht im JSON).
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const rawLine = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          if (data.length > 0 && data !== "[DONE]") yield data;
        }
      }
    }
    const tail = buf.replace(/\r$/, "");
    if (tail.startsWith("data:")) {
      const data = tail.slice(5).trimStart();
      if (data.length > 0 && data !== "[DONE]") yield data;
    }
  } finally {
    reader.releaseLock();
  }
}
