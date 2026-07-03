import { describe, expect, it } from "vitest";
import { llmHandler, llmNode } from "./llm";
import type { Ctx, CostService, ModelService } from "../ctx";

/** Minimal-ctx mit (optional) ModelService + CostService. */
function ctxWith(over: Partial<Ctx> = {}): Ctx {
  return over as unknown as Ctx;
}

const echoModel: ModelService = {
  complete: (req) => {
    const r = req as { messages?: { content?: string }[]; system?: string };
    const last = r.messages?.[r.messages.length - 1]?.content ?? "";
    return Promise.resolve({
      text: `echo: ${last}`,
      cost: { usd: 0.5, tokensIn: 3, tokensOut: 2, model: "mock" },
      confidence: 0.7,
    });
  },
};

describe("llm node (Slice 3, Inv. 7/17)", () => {
  it("is registered as an intelligence node that requests models", () => {
    expect(llmNode.type).toBe("llm");
    expect(llmNode.klass).toBe("intelligence");
    expect(llmNode.requests).toEqual({ models: ["*"] });
  });

  it("builds a CompletionRequest from {prompt} and returns Resolved<{text}> with model cost/confidence", async () => {
    const res = await llmHandler({ prompt: "ping" }, ctxWith({ model: echoModel }));
    expect(res.status).toBe("resolved");
    if (res.status !== "resolved") throw new Error("not resolved");
    expect(res.output).toEqual({ text: "echo: ping" });
    expect(res.confidence).toBe(0.7);
    expect(res.cost).toEqual({ usd: 0.5, tokensIn: 3, tokensOut: 2, model: "mock" });
  });

  it("passes system + messages + model + maxTokens through to ctx.model.complete", async () => {
    let captured: unknown;
    const capModel: ModelService = {
      complete: (req) => {
        captured = req;
        return Promise.resolve({ text: "ok", cost: { usd: 0 }, confidence: 1 });
      },
    };
    await llmHandler(
      {
        system: "sys",
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
        model: "claude-opus-4-8",
        maxTokens: 64,
      },
      ctxWith({ model: capModel }),
    );
    expect(captured).toEqual({
      system: "sys",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ],
      model: "claude-opus-4-8",
      maxTokens: 64,
    });
  });

  it("honors `as` for the output field name", async () => {
    const res = await llmHandler({ prompt: "x", as: "draft" }, ctxWith({ model: echoModel }));
    if (res.status !== "resolved") throw new Error("not resolved");
    expect(res.output).toEqual({ draft: "echo: x" });
  });

  it("charges ctx.cost when injected (node-local budget view, Inv. 3)", async () => {
    let charged: unknown;
    const cost: CostService = {
      charge: (c) => {
        charged = c;
      },
      remaining: () => 100,
    };
    await llmHandler({ prompt: "ping" }, ctxWith({ model: echoModel, cost }));
    expect(charged).toEqual({ usd: 0.5, tokensIn: 3, tokensOut: 2, model: "mock" });
  });

  it("FAILS CLEARLY without ctx.model — security by absence (Inv. 14)", async () => {
    await expect(llmHandler({ prompt: "ping" }, ctxWith({}))).rejects.toThrow(
      /ctx\.model.*not injected|nicht injiziert|security by absence/i,
    );
  });

  it("throws a clear error when no prompt/messages are given", async () => {
    await expect(llmHandler({}, ctxWith({ model: echoModel }))).rejects.toThrow(/prompt|messages/i);
  });
});
