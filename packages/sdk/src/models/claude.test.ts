import { describe, expect, it } from "vitest";
import { ClaudeModel } from "./claude";

/** Baut eine fetch-Double, die einen kanonischen JSON-Body als Response liefert (kein Netz). */
function jsonFetch(payload: unknown, capture?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.(String(url), init);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Baut eine fetch-Double, deren `body` die gegebenen SSE-Zeilen streamt (kein Netz). */
function sseFetch(sse: string): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    });
    return { ok: true, status: 200, statusText: "OK", body } as unknown as Response;
  }) as unknown as typeof fetch;
}

// (d) ClaudeModel.complete parses a CANNED Anthropic JSON response (no real network).
describe("ClaudeModel — complete() against a canned JSON response", () => {
  it("extracts text from content blocks and computes Cost.usd from usage tokens", async () => {
    const canned = {
      content: [
        { type: "text", text: "Hello, " },
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: "world." },
      ],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      stop_reason: "end_turn",
      model: "claude-opus-4-8",
    };
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const model = new ClaudeModel({
      apiKey: "test-key",
      fetchImpl: jsonFetch(canned, (u, i) => {
        seenUrl = u;
        seenInit = i;
      }),
    });

    const res = await model.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(res.text).toBe("Hello, world."); // only type==="text" blocks, concatenated
    // 1M in @ $5/1M + 1M out @ $25/1M = $30.
    expect(res.cost.usd).toBe(0); // bare adapter: usd 0 — Kosten kommen aus Profil-Richtwerten (Worker)
    expect(res.cost.tokensIn).toBe(1_000_000);
    expect(res.cost.tokensOut).toBe(1_000_000);
    expect(res.cost.model).toBe("claude-opus-4-8");

    // Verify the request shape: endpoint, the 3 required headers, default model, no sampling/thinking params.
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("claude-opus-4-8");
    expect(body["max_tokens"]).toBe(1024);
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("stream");
  });

  it("sends the system prompt as a top-level field and unknown-model usd falls back to 0", async () => {
    let seenBody: Record<string, unknown> = {};
    const model = new ClaudeModel({
      apiKey: "k",
      defaultModel: "ollama-local", // not in the price table -> usd 0
      fetchImpl: jsonFetch(
        { content: [{ type: "text", text: "x" }], usage: { input_tokens: 10, output_tokens: 20 }, model: "ollama-local" },
        (_u, i) => {
          seenBody = JSON.parse(String(i?.body)) as Record<string, unknown>;
        },
      ),
    });
    const res = await model.complete({
      system: "You are terse.",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
    });
    expect(seenBody["system"]).toBe("You are terse.");
    expect(seenBody["max_tokens"]).toBe(256);
    expect(res.cost.usd).toBe(0); // unknown model -> no price -> 0
    expect(res.cost.tokensIn).toBe(10);
  });

  it("throws on a non-ok HTTP status", async () => {
    const model = new ClaudeModel({
      apiKey: "k",
      fetchImpl: (async () => ({ ok: false, status: 400, statusText: "Bad Request" }) as unknown as Response) as unknown as typeof fetch,
    });
    await expect(model.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/HTTP 400/);
  });
});

// (e) ClaudeModel.stream parses canned SSE lines into deltas + a final done with cost.
describe("ClaudeModel — stream() against canned SSE", () => {
  it("parses content_block_delta text into deltas and message_delta usage into the final cost", async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":2000000}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1000000}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join("\n");

    const model = new ClaudeModel({ apiKey: "k", fetchImpl: sseFetch(sse) });

    const deltas: string[] = [];
    let done: { cost: { usd?: number; tokensIn?: number; tokensOut?: number; model?: string }; confidence: number } | undefined;
    for await (const chunk of model.stream({ messages: [{ role: "user", content: "hi" }] })) {
      if ("delta" in chunk) deltas.push(chunk.delta);
      else done = chunk.done;
    }

    expect(deltas.join("")).toBe("Hello, world");
    expect(done).toBeDefined();
    expect(done?.cost.tokensIn).toBe(2_000_000);
    expect(done?.cost.tokensOut).toBe(1_000_000);
    expect(done?.cost.model).toBe("claude-opus-4-8");
    // 2M in @ $5/1M = $10 ; 1M out @ $25/1M = $25 ; total $35.
    expect(done?.cost.usd).toBe(0); // bare adapter: usd 0 — Kosten via Profil-Richtwert (Worker)
  });

  it("ignores non-text deltas and [DONE] markers; still emits a final done", async () => {
    const sse =
      'data: {"type":"message_start","message":{"model":"claude-opus-4-8","usage":{"input_tokens":0}}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n' +
      'data: {"type":"message_stop"}\n\n' +
      'data: [DONE]\n\n';
    const model = new ClaudeModel({ apiKey: "k", fetchImpl: sseFetch(sse) });
    const deltas: string[] = [];
    let sawDone = false;
    for await (const chunk of model.stream("hi")) {
      if ("delta" in chunk) deltas.push(chunk.delta);
      else sawDone = true;
    }
    expect(deltas.join("")).toBe("ok"); // thinking_delta ignored
    expect(sawDone).toBe(true);
  });
});
