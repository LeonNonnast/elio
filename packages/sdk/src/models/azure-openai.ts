// ───────────────────────────── AzureOpenAiModel: Azure OpenAI Chat Completions (RAW fetch, Slice 3, Inv. 17, §6) ─────────────────────────────
// POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version={apiVersion} über rohes
// fetch (KEIN SDK, keine neue Runtime-Dep). Header `api-key` (NICHT authorization) + content-type.
// Wire-Format ist OpenAI-kompatibel: der System-Prompt ist die ERSTE message mit role:"system"
// (kein top-level system-Feld wie bei Claude); das Deployment routet über die URL, nicht über `model`.
// Cost.usd aus usage-Tokens (prompt_tokens/completion_tokens) + Preistabelle (gpt-4o = $2.5 in / $10 out).
// Injizierbarer fetchImpl + apiKey/endpoint/deployment, damit Tests ohne Netz laufen.

import type { Cost } from "@elio/core";
import type {
  CompletionChunk,
  CompletionMessage,
  CompletionRequest,
  CompletionResult,
  ModelService,
} from "./types";
import { normalizeRequest, usdFromTokens } from "./types";

type FetchImpl = typeof fetch;

const DEFAULT_API_VERSION = "2024-10-21";

export interface AzureOpenAiModelOptions {
  /** Azure-Resource-Endpoint, z.B. https://my-res.openai.azure.com (oder env AZURE_OPENAI_ENDPOINT). */
  endpoint?: string;
  /** API-Key (oder env AZURE_OPENAI_API_KEY). */
  apiKey?: string;
  /** Deployment-Name (= das in Azure deployte Modell; oder env AZURE_OPENAI_DEPLOYMENT). */
  deployment?: string;
  /** API-Version (Default "2024-10-21"). */
  apiVersion?: string;
  /** Default max_tokens, falls req.maxTokens fehlt (Default 1024). */
  maxTokens?: number;
  /** Injizierbares fetch (Default global fetch) — Tests reichen ein Double rein. */
  fetchImpl?: FetchImpl;
  /** Feste Confidence (Azure liefert keine; Default 0.9). */
  confidence?: number;
}

/** Azure/OpenAI-Chat-Body. System geht als ERSTE message role:"system" (kein top-level Feld). */
interface AzureBody {
  messages: { role: string; content: string }[];
  max_tokens: number;
  model?: string;
  stream?: boolean;
}

/** Mappt CompletionRequest auf die OpenAI-messages (system als erste system-message). */
function toAzureMessages(req: CompletionRequest): CompletionMessage[] {
  const msgs: CompletionMessage[] = [];
  if (req.system !== undefined && req.system.length > 0) {
    msgs.push({ role: "system", content: req.system });
  }
  for (const m of req.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

/**
 * Voll verdrahteter Adapter für Azure OpenAI. complete() + SSE-stream(), OpenAI-kompatibles Wire-Format.
 * endpoint/deployment sind öffentlich (Preflight prüft isConfigured()); der reine Modellname landet in
 * cost.model (der Worker stempelt ggf. die kanonische `azure-openai:<model>`-Spec drüber).
 */
export class AzureOpenAiModel implements ModelService {
  readonly endpoint: string | undefined;
  readonly deployment: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly apiVersion: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: FetchImpl;
  private readonly confidence: number;

  constructor(opts: AzureOpenAiModelOptions = {}) {
    this.endpoint = opts.endpoint;
    this.deployment = opts.deployment;
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.maxTokens = opts.maxTokens ?? 1024;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.confidence = opts.confidence ?? 0.9;
  }

  /** Ob das Profil konfiguriert ist (Endpoint + Key + Deployment vorhanden) — vom Preflight genutzt. */
  isConfigured(): boolean {
    return (
      typeof this.endpoint === "string" &&
      this.endpoint.length > 0 &&
      typeof this.apiKey === "string" &&
      this.apiKey.length > 0 &&
      typeof this.deployment === "string" &&
      this.deployment.length > 0
    );
  }

  /** Baut die Chat-Completions-URL: {endpoint}/openai/deployments/{deployment}/...?api-version=... */
  private url(): string {
    const base = (this.endpoint ?? "").replace(/\/+$/, "");
    const dep = encodeURIComponent(this.deployment ?? "");
    return `${base}/openai/deployments/${dep}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
  }

  /** Die zwei Pflicht-Header (content-type + api-key — NICHT authorization). */
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "api-key": this.apiKey ?? "",
    };
  }

  /** Das Modell für cost.model: reiner Modellname (req.model) bzw. Fallback Deployment-Name. */
  private costModel(req: CompletionRequest): string {
    return req.model ?? this.deployment ?? "";
  }

  private body(req: CompletionRequest, maxTokens: number, stream: boolean): string {
    const body: AzureBody = { messages: toAzureMessages(req), max_tokens: maxTokens };
    // model ist in Azure redundant (Routing über die URL/Deployment), wird aber für Audit mitgegeben.
    if (req.model !== undefined) body.model = req.model;
    if (stream) body.stream = true;
    return JSON.stringify(body);
  }

  async complete(reqRaw: unknown): Promise<CompletionResult> {
    const req = normalizeRequest(reqRaw);
    const maxTokens = req.maxTokens ?? this.maxTokens;
    const res = await this.fetchImpl(this.url(), {
      method: "POST",
      headers: this.headers(),
      body: this.body(req, maxTokens, false),
    });
    if (!res.ok) {
      throw new Error(`AzureOpenAiModel: HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      model?: unknown;
    };

    const first = Array.isArray(json.choices) ? json.choices[0] : undefined;
    const text = typeof first?.message?.content === "string" ? first.message.content : "";
    const tokensIn = typeof json.usage?.prompt_tokens === "number" ? json.usage.prompt_tokens : 0;
    const tokensOut =
      typeof json.usage?.completion_tokens === "number" ? json.usage.completion_tokens : 0;
    const respModel = typeof json.model === "string" ? json.model : this.costModel(req);

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
    const maxTokens = req.maxTokens ?? this.maxTokens;
    const res = await this.fetchImpl(this.url(), {
      method: "POST",
      headers: this.headers(),
      body: this.body(req, maxTokens, true),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`AzureOpenAiModel: HTTP ${res.status} ${res.statusText} (no stream body)`);
    }

    // SSE: "data: {json}"-Zeilen; choices[0].delta.content trägt die Tokens, "data: [DONE]" beendet es.
    // usage kommt (falls aktiviert) in einer späten Zeile mit leeren choices; fehlt sie, bleiben 0.
    let tokensIn = 0;
    let tokensOut = 0;
    let respModel = this.costModel(req);

    for await (const data of readSse(res.body)) {
      let ev: {
        choices?: { delta?: { content?: unknown } }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        model?: unknown;
      };
      try {
        ev = JSON.parse(data) as typeof ev;
      } catch {
        continue;
      }
      if (typeof ev.model === "string") respModel = ev.model;
      const delta = Array.isArray(ev.choices) ? ev.choices[0]?.delta?.content : undefined;
      if (typeof delta === "string" && delta.length > 0) yield { delta };
      if (typeof ev.usage?.prompt_tokens === "number") tokensIn = ev.usage.prompt_tokens;
      if (typeof ev.usage?.completion_tokens === "number") tokensOut = ev.usage.completion_tokens;
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

/**
 * Liest einen SSE-Body und yieldet die JSON-Nutzlast jeder `data:`-Zeile (ohne das "data: "-Präfix).
 * Events werden durch Leerzeilen getrennt; der Terminator "data: [DONE]" wird verschluckt.
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
