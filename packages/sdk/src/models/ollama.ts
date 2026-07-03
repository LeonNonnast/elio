// ───────────────────────────── OllamaModel: lokaler HTTP-Adapter (Slice 3, Inv. 17, §6) ─────────────────────────────
// POST http://localhost:11434/api/chat (stream + non-stream). Lokale Modelle -> Cost.usd = 0.
// Injizierbarer fetchImpl, damit Tests ohne echtes Netz laufen.

import type { Cost } from "@elio/core";
import type {
  CompletionChunk,
  CompletionMessage,
  CompletionRequest,
  CompletionResult,
  ModelService,
} from "./types";
import { normalizeRequest } from "./types";

type FetchImpl = typeof fetch;

export interface OllamaModelOptions {
  /** Basis-URL (Default http://localhost:11434). */
  baseUrl?: string;
  /** Default-Modell, falls req.model fehlt (Default "llama3"). */
  defaultModel?: string;
  /** Injizierbares fetch (Default global fetch). */
  fetchImpl?: FetchImpl;
  /** Feste Confidence (Ollama liefert keine; Default 0.8). */
  confidence?: number;
}

/** Mappt CompletionRequest auf Ollamas /api/chat messages (system als erste system-message). */
function toOllamaMessages(req: CompletionRequest): CompletionMessage[] {
  const msgs: CompletionMessage[] = [];
  if (req.system !== undefined && req.system.length > 0) {
    msgs.push({ role: "system", content: req.system });
  }
  for (const m of req.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

export class OllamaModel implements ModelService {
  /** Basis-URL (öffentlich, damit der Preflight die Erreichbarkeit gegen /api/tags prüfen kann). */
  readonly baseUrl: string;
  private readonly defaultModel: string;
  readonly fetchImpl: FetchImpl;
  private readonly confidence: number;

  constructor(opts: OllamaModelOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "http://localhost:11434";
    this.defaultModel = opts.defaultModel ?? "llama3";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.confidence = opts.confidence ?? 0.8;
  }

  private body(req: CompletionRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model ?? this.defaultModel,
      messages: toOllamaMessages(req),
      stream,
    });
  }

  private cost(req: CompletionRequest, tokensIn: number, tokensOut: number): Cost {
    // Lokale Modelle: usd:0 (Inv. 17 / §6). Token-Counts durchreichen, falls Ollama sie meldet.
    return { usd: 0, tokensIn, tokensOut, model: req.model ?? this.defaultModel };
  }

  async complete(reqRaw: unknown): Promise<CompletionResult> {
    const req = normalizeRequest(reqRaw);
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: this.body(req, false),
    });
    if (!res.ok) {
      throw new Error(`OllamaModel: HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      message?: { content?: unknown };
      prompt_eval_count?: unknown;
      eval_count?: unknown;
    };
    const text = typeof json.message?.content === "string" ? json.message.content : "";
    const tokensIn = typeof json.prompt_eval_count === "number" ? json.prompt_eval_count : 0;
    const tokensOut = typeof json.eval_count === "number" ? json.eval_count : 0;
    return { text, cost: this.cost(req, tokensIn, tokensOut), confidence: this.confidence };
  }

  async *stream(reqRaw: unknown): AsyncIterable<CompletionChunk> {
    const req = normalizeRequest(reqRaw);
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: this.body(req, true),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`OllamaModel: HTTP ${res.status} ${res.statusText} (no stream body)`);
    }

    // Ollama streamt newline-delimited JSON (NDJSON): eine JSON-Zeile pro Chunk,
    // letzte Zeile hat done:true + prompt_eval_count/eval_count.
    let tokensIn = 0;
    let tokensOut = 0;
    for await (const line of readNdjson(res.body)) {
      let obj: {
        message?: { content?: unknown };
        done?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      try {
        obj = JSON.parse(line) as typeof obj;
      } catch {
        continue; // unvollständige/leere Zeile überspringen
      }
      const delta = typeof obj.message?.content === "string" ? obj.message.content : "";
      if (delta.length > 0) yield { delta };
      if (typeof obj.prompt_eval_count === "number") tokensIn = obj.prompt_eval_count;
      if (typeof obj.eval_count === "number") tokensOut = obj.eval_count;
      if (obj.done === true) break;
    }
    yield { done: { cost: this.cost(req, tokensIn, tokensOut), confidence: this.confidence } };
  }
}

/** Liest einen ReadableStream<Uint8Array> als newline-getrennte Zeilen. */
async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) yield line;
      }
    }
    const tail = buf.trim();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}
