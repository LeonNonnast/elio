import { describe, expect, it } from "vitest";
import { LlmWorker } from "./worker";
import { MockModel } from "./mock";
import type { Cost } from "@elio/core";
import type {
  CompletionChunk,
  CompletionRequest,
  CompletionResult,
  ModelService,
} from "./types";
import { normalizeRequest } from "./types";

/** Eine Fake-ModelService, die max-in-flight aufzeichnet und per Promise gated bleibt, bis release(). */
class CountingFake implements ModelService {
  inFlight = 0;
  maxInFlight = 0;
  total = 0;
  private gate: Promise<void>;
  private releaseFn: () => void = () => {};

  constructor(private readonly model = "fake") {
    this.gate = new Promise<void>((r) => {
      this.releaseFn = r;
    });
  }

  /** Gibt alle wartenden Calls frei (sodass sie resolven können). */
  release(): void {
    this.releaseFn();
  }

  async complete(reqRaw: unknown): Promise<CompletionResult> {
    const req: CompletionRequest = normalizeRequest(reqRaw);
    this.inFlight += 1;
    this.total += 1;
    if (this.inFlight > this.maxInFlight) this.maxInFlight = this.inFlight;
    await this.gate; // bis zum expliziten release() blockieren -> alle eingelassenen Calls halten ihren Slot
    this.inFlight -= 1;
    const cost: Cost = { usd: 0, tokensIn: 1, tokensOut: 1, model: req.model ?? this.model };
    return { text: "ok", cost, confidence: 1 };
  }
}

// (b) Worker concurrency gate.
describe("LlmWorker — per-provider concurrency gate", () => {
  it("never runs more than `limit` calls concurrently per provider; all resolve", async () => {
    const fake = new CountingFake();
    const worker = new LlmWorker({
      providers: { fake },
      defaultModel: "fake",
      concurrency: 3,
    });

    // 10 gleichzeitige Calls feuern; das Limit ist 3.
    const calls = Array.from({ length: 10 }, () =>
      worker.complete({ model: "fake", messages: [{ role: "user", content: "x" }] }),
    );

    // Dem Event-Loop Zeit geben, die zulässigen Calls einzulassen.
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.inFlight).toBe(3); // genau das Limit ist gleichzeitig "in flight"
    expect(fake.maxInFlight).toBeLessThanOrEqual(3);

    // Gate freigeben -> die Queue läuft ab, immer höchstens 3 gleichzeitig.
    fake.release();
    const results = await Promise.all(calls);

    expect(results).toHaveLength(10);
    expect(fake.total).toBe(10);
    expect(fake.maxInFlight).toBe(3); // nie über das Limit
    expect(fake.inFlight).toBe(0); // alle abgeschlossen
  });

  it("gates each provider independently (separate semaphores)", async () => {
    const a = new CountingFake("a");
    const b = new CountingFake("b");
    const worker = new LlmWorker({
      providers: { a, b },
      defaultModel: "a",
      concurrency: 2,
    });

    const calls = [
      ...Array.from({ length: 5 }, () => worker.complete({ model: "a", messages: [{ role: "user", content: "1" }] })),
      ...Array.from({ length: 5 }, () => worker.complete({ model: "b", messages: [{ role: "user", content: "2" }] })),
    ];
    await new Promise((r) => setTimeout(r, 10));
    // Jeder Provider lässt unabhängig bis zu seinem eigenen Limit ein.
    expect(a.inFlight).toBe(2);
    expect(b.inFlight).toBe(2);

    a.release();
    b.release();
    await Promise.all(calls);
    expect(a.maxInFlight).toBe(2);
    expect(b.maxInFlight).toBe(2);
  });

  it("routes by exact model id and by longest prefix match", async () => {
    const claude = new CountingFake("claude");
    const mock = new MockModel();
    const worker = new LlmWorker({ providers: { claude, mock }, defaultModel: "mock", concurrency: 4 });

    // Präfix-Match: "claude-opus-4-8" -> "claude".
    const p = worker.complete({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(claude.inFlight).toBe(1);
    claude.release();
    await p;
    expect(claude.total).toBe(1);

    // Default-Modell, wenn req.model fehlt -> "mock".
    const r = await worker.complete({ messages: [{ role: "user", content: "yo" }] });
    expect(r.text).toBe("echo: yo");
  });

  it("throws for an unregistered model", async () => {
    const worker = new LlmWorker({ providers: { mock: new MockModel() }, defaultModel: "mock" });
    await expect(
      worker.complete({ model: "gpt-4", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/no provider registered/);
  });
});

// (c) Cost is computed/charged correctly through the worker.
describe("LlmWorker — cost passthrough", () => {
  it("returns the adapter's computed cost (charged unchanged by the worker)", async () => {
    const worker = new LlmWorker({
      providers: { mock: new MockModel({ charsPerToken: 4 }) },
      defaultModel: "mock",
    });
    const res = await worker.complete({ messages: [{ role: "user", content: "abcd" }] });
    // input "abcd" = 4 chars -> 1 token; output "echo: abcd" = 10 chars -> ceil(10/4) = 3 tokens.
    expect(res.cost.usd).toBe(0);
    expect(res.cost.tokensIn).toBe(1);
    expect(res.cost.tokensOut).toBe(3);
    expect(res.cost.model).toBe("mock");
  });

  it("stream() holds a slot for the lifetime of the iterator and yields a final done{cost}", async () => {
    const worker = new LlmWorker({ providers: { mock: new MockModel() }, defaultModel: "mock", concurrency: 1 });
    const chunks: CompletionChunk[] = [];
    for await (const c of worker.stream({ messages: [{ role: "user", content: "a b" }] })) {
      chunks.push(c);
    }
    const done = chunks.find((c): c is { done: { cost: Cost; confidence: number } } => "done" in c);
    expect(done).toBeDefined();
    expect(done?.done.cost.usd).toBe(0);
    // Nach erschöpftem Stream ist der Slot wieder frei -> ein weiterer Stream läuft sofort durch.
    const more: CompletionChunk[] = [];
    for await (const c of worker.stream({ messages: [{ role: "user", content: "c" }] })) more.push(c);
    expect(more.some((c) => "done" in c)).toBe(true);
  });
});
