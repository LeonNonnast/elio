import { describe, expect, it } from "vitest";
import { OllamaModel } from "./ollama";

function jsonFetch(payload: unknown, capture?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.(String(url), init);
    return { ok: true, status: 200, statusText: "OK", json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ndjsonFetch(ndjson: string): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ndjson));
        controller.close();
      },
    });
    return { ok: true, status: 200, statusText: "OK", body } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("OllamaModel — complete()", () => {
  it("POSTs /api/chat, returns text, and reports usd:0 with token counts", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const model = new OllamaModel({
      fetchImpl: jsonFetch(
        { message: { role: "assistant", content: "hi there" }, prompt_eval_count: 5, eval_count: 2, done: true },
        (u, i) => {
          seenUrl = u;
          seenBody = JSON.parse(String(i?.body)) as Record<string, unknown>;
        },
      ),
    });
    const res = await model.complete({
      model: "llama3",
      system: "be terse",
      messages: [{ role: "user", content: "hey" }],
    });
    expect(seenUrl).toBe("http://localhost:11434/api/chat");
    expect(seenBody["stream"]).toBe(false);
    // system becomes the first system-message in the chat array.
    expect(seenBody["messages"]).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hey" },
    ]);
    expect(res.text).toBe("hi there");
    expect(res.cost.usd).toBe(0); // local model -> always 0
    expect(res.cost.tokensIn).toBe(5);
    expect(res.cost.tokensOut).toBe(2);
    expect(res.cost.model).toBe("llama3");
  });
});

describe("OllamaModel — stream()", () => {
  it("parses NDJSON chunks into deltas and a final done{cost usd:0}", async () => {
    const ndjson =
      '{"message":{"content":"Hel"},"done":false}\n' +
      '{"message":{"content":"lo"},"done":false}\n' +
      '{"message":{"content":""},"done":true,"prompt_eval_count":3,"eval_count":2}\n';
    const model = new OllamaModel({ fetchImpl: ndjsonFetch(ndjson) });
    const deltas: string[] = [];
    let done: { cost: { usd?: number; tokensOut?: number } } | undefined;
    for await (const chunk of model.stream({ messages: [{ role: "user", content: "hi" }] })) {
      if ("delta" in chunk) deltas.push(chunk.delta);
      else done = chunk.done;
    }
    expect(deltas.join("")).toBe("Hello");
    expect(done?.cost.usd).toBe(0);
    expect(done?.cost.tokensOut).toBe(2);
  });
});
