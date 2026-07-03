import { describe, expect, it } from "vitest";
import { MockModel } from "./mock";
import type { CompletionChunk, CompletionRequest } from "./types";

// (a) MockModel deterministic output + cost.
describe("MockModel — deterministic complete()", () => {
  it("echoes the last user message and is byte-for-byte deterministic across calls", async () => {
    const m = new MockModel();
    const req: CompletionRequest = {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "world" },
      ],
    };
    const a = await m.complete(req);
    const b = await m.complete(req);
    expect(a.text).toBe("echo: world"); // last *user* message, not the last message
    expect(a).toEqual(b); // fully deterministic
  });

  it("derives token counts from string length and reports usd:0 + model", async () => {
    const m = new MockModel({ charsPerToken: 4 });
    // input = system("") + "abcd"(4) + "wxyz"(4) = 8 chars -> ceil(8/4) = 2 tokens in
    // output = "echo: wxyz" = 10 chars -> ceil(10/4) = 3 tokens out
    const res = await m.complete({
      messages: [
        { role: "user", content: "abcd" },
        { role: "user", content: "wxyz" },
      ],
    });
    expect(res.cost.usd).toBe(0);
    expect(res.cost.tokensIn).toBe(2);
    expect(res.cost.tokensOut).toBe(3);
    expect(res.cost.model).toBe("mock");
    expect(res.confidence).toBe(1);
  });

  it("accepts the {prompt} shorthand and a bare string", async () => {
    const m = new MockModel();
    expect((await m.complete({ prompt: "foo" })).text).toBe("echo: foo");
    expect((await m.complete("bar")).text).toBe("echo: bar");
  });

  it("honors a custom transform + confidence", async () => {
    const m = new MockModel({
      transform: (last) => last.toUpperCase(),
      confidence: 0.5,
      model: "mock-x",
    });
    const res = await m.complete({ messages: [{ role: "user", content: "hey" }] });
    expect(res.text).toBe("HEY");
    expect(res.confidence).toBe(0.5);
    expect(res.cost.model).toBe("mock-x");
  });
});

describe("MockModel — stream()", () => {
  it("streams deltas that reassemble to the text and ends with a done{cost}", async () => {
    const m = new MockModel();
    const chunks: CompletionChunk[] = [];
    for await (const c of m.stream({ messages: [{ role: "user", content: "a b c" }] })) {
      chunks.push(c);
    }
    const deltas = chunks.filter((c): c is { delta: string } => "delta" in c).map((c) => c.delta);
    const done = chunks.find((c): c is { done: { cost: { usd?: number }; confidence: number } } => "done" in c);
    expect(deltas.join("")).toBe("echo: a b c");
    expect(done).toBeDefined();
    expect(done?.done.cost.usd).toBe(0);
    expect(done?.done.confidence).toBe(1);
  });
});
