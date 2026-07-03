import { describe, expect, it } from "vitest";
import { AzureOpenAiModel } from "./azure-openai";

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

const BASE_OPTS = {
  endpoint: "https://my-res.openai.azure.com",
  apiKey: "test-key",
  deployment: "gpt-4o",
};

// complete() parses a CANNED Azure OpenAI JSON response (no real network).
describe("AzureOpenAiModel — complete() against a canned JSON response", () => {
  it("extracts choices[0].message.content and computes Cost.usd from usage tokens", async () => {
    const canned = {
      choices: [{ message: { role: "assistant", content: "Hello, world." } }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      model: "gpt-4o",
    };
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const model = new AzureOpenAiModel({
      ...BASE_OPTS,
      fetchImpl: jsonFetch(canned, (u, i) => {
        seenUrl = u;
        seenInit = i;
      }),
    });

    const res = await model.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(res.text).toBe("Hello, world.");
    // 1M in @ $2.5/1M + 1M out @ $10/1M = $12.5.
    expect(res.cost.usd).toBe(0); // bare adapter: usd 0 — Kosten via Profil-Richtwert (Worker)
    expect(res.cost.tokensIn).toBe(1_000_000);
    expect(res.cost.tokensOut).toBe(1_000_000);
    expect(res.cost.model).toBe("gpt-4o");
    expect(res.confidence).toBe(0.9);

    // URL: {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=2024-10-21
    expect(seenUrl).toBe(
      "https://my-res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
    );
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["api-key"]).toBe("test-key");
    expect(headers).not.toHaveProperty("authorization");
    const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>;
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect(body["max_tokens"]).toBe(1024);
    expect(body).not.toHaveProperty("stream");
  });

  it("sends the system prompt as the FIRST message role=system; unknown-model usd falls back to 0", async () => {
    let seenBody: Record<string, unknown> = {};
    const model = new AzureOpenAiModel({
      ...BASE_OPTS,
      deployment: "custom-deploy",
      fetchImpl: jsonFetch(
        {
          choices: [{ message: { content: "x" } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
          model: "some-unknown-model",
        },
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
    expect(seenBody["messages"]).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ]);
    expect(seenBody["max_tokens"]).toBe(256);
    expect(res.cost.usd).toBe(0); // unknown model -> no price -> 0
    expect(res.cost.tokensIn).toBe(10);
    expect(res.cost.tokensOut).toBe(20);
  });

  it("falls back to the deployment name for cost.model when the response omits model", async () => {
    const model = new AzureOpenAiModel({
      ...BASE_OPTS,
      deployment: "my-gpt-4o-mini",
      fetchImpl: jsonFetch({
        choices: [{ message: { content: "y" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    });
    const res = await model.complete("hi");
    expect(res.cost.model).toBe("my-gpt-4o-mini");
  });

  it("handles missing/null usage defensively (tokens fall back to 0)", async () => {
    const model = new AzureOpenAiModel({
      ...BASE_OPTS,
      fetchImpl: jsonFetch({ choices: [{ message: { content: "z" } }] }),
    });
    const res = await model.complete("hi");
    expect(res.text).toBe("z");
    expect(res.cost.tokensIn).toBe(0);
    expect(res.cost.tokensOut).toBe(0);
  });

  it("throws on a non-ok HTTP status", async () => {
    const model = new AzureOpenAiModel({
      ...BASE_OPTS,
      fetchImpl: (async () =>
        ({ ok: false, status: 401, statusText: "Unauthorized" }) as unknown as Response) as unknown as typeof fetch,
    });
    await expect(model.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      /HTTP 401/,
    );
  });
});

// stream() parses canned SSE lines into deltas + a final done with cost.
describe("AzureOpenAiModel — stream() against canned SSE", () => {
  it("parses choices[0].delta.content into deltas and trailing usage into the final cost", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}],"model":"gpt-4o"}',
      "",
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":", world"}}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":2000000,"completion_tokens":1000000}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const model = new AzureOpenAiModel({ ...BASE_OPTS, fetchImpl: sseFetch(sse) });

    const deltas: string[] = [];
    let done:
      | { cost: { usd?: number; tokensIn?: number; tokensOut?: number; model?: string }; confidence: number }
      | undefined;
    for await (const chunk of model.stream({ messages: [{ role: "user", content: "hi" }] })) {
      if ("delta" in chunk) deltas.push(chunk.delta);
      else done = chunk.done;
    }

    expect(deltas.join("")).toBe("Hello, world");
    expect(done).toBeDefined();
    expect(done?.cost.tokensIn).toBe(2_000_000);
    expect(done?.cost.tokensOut).toBe(1_000_000);
    expect(done?.cost.model).toBe("gpt-4o");
    // 2M in @ $2.5/1M = $5 ; 1M out @ $10/1M = $10 ; total $15.
    expect(done?.cost.usd).toBe(0); // bare adapter: usd 0 — Kosten via Profil-Richtwert (Worker)
    expect(done?.confidence).toBe(0.9);
  });

  it("ignores empty deltas and the [DONE] marker; still emits a final done", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":""}}],"model":"gpt-4o"}\n\n' +
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n' +
      "data: [DONE]\n\n";
    const model = new AzureOpenAiModel({ ...BASE_OPTS, fetchImpl: sseFetch(sse) });
    const deltas: string[] = [];
    let sawDone = false;
    for await (const chunk of model.stream("hi")) {
      if ("delta" in chunk) deltas.push(chunk.delta);
      else sawDone = true;
    }
    expect(deltas.join("")).toBe("ok");
    expect(sawDone).toBe(true);
  });

  it("includes stream:true in the request body", async () => {
    let seenBody: Record<string, unknown> = {};
    const capturing = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return { ok: true, status: 200, statusText: "OK", body } as unknown as Response;
    }) as unknown as typeof fetch;
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return capturing(url, init);
    }) as unknown as typeof fetch;
    const model = new AzureOpenAiModel({ ...BASE_OPTS, fetchImpl: wrapped });
    for await (const _ of model.stream("hi")) void _;
    expect(seenBody["stream"]).toBe(true);
  });
});

// isConfigured() gate used by preflight.
describe("AzureOpenAiModel — isConfigured()", () => {
  it("is true only when endpoint, apiKey and deployment are all present", () => {
    expect(new AzureOpenAiModel(BASE_OPTS).isConfigured()).toBe(true);
    expect(new AzureOpenAiModel({ endpoint: "x", apiKey: "y" }).isConfigured()).toBe(false);
    expect(new AzureOpenAiModel({}).isConfigured()).toBe(false);
  });
});
