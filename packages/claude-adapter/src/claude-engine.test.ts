// Unit tests for the OPAQUE ClaudeAgentEngine. ALL offline via FakeTransport — NO key, NO network, NO real
// claude/SDK. These pin the engine's contract handling (id/governance, the SessionContract -> transport
// mapping, inherited+decremented budget/depth per Inv. 21, elicitation propagation per Inv. 11, the HULL
// cred resolution + cost charge). They do NOT prove a real Claude turn works — that path (AgentSdk/ClaudeCli)
// is guarded and unexercised by design.

import { describe, expect, it } from "vitest";
import type { Cost, Ctx, SecretsService, SessionContract } from "@elio/core";
import { ClaudeAgentEngine } from "./claude-engine";
import { FakeTransport } from "./claude-double";

const CORR = { run: "r1", branch: "b1", step: "s1", checkpoint: "c1" };

function ctxWith(over: Partial<Ctx>): Ctx {
  return { correlation: CORR, ...over } as unknown as Ctx;
}

describe("ClaudeAgentEngine — identity + opaque governance (Inv. 17/18)", () => {
  it('identifies as engine id "claude-code" with OPAQUE governance', () => {
    const eng = new ClaudeAgentEngine({ transport: new FakeTransport() });
    expect(eng.id).toBe("claude-code");
    expect(eng.governance).toBe("opaque");
  });

  it("OPAQUE: does NOT route through ctx.model — resolves a turn purely via the transport", async () => {
    const transport = new FakeTransport({ reply: "drafted note", cost: { usd: 2 } });
    let modelCalled = false;
    const eng = new ClaudeAgentEngine({ transport });
    const contract: SessionContract = {
      input: { prompt: "draft the note" },
      budget: 100,
      depth: 1,
      maxDepth: 5,
    };
    // ctx.model is present but must NEVER be touched by the opaque engine.
    const sr = await eng.run(
      contract,
      ctxWith({
        model: {
          complete: () => {
            modelCalled = true;
            return Promise.resolve({ text: "x", cost: {}, confidence: 0.5 });
          },
        },
      }),
    );

    expect(modelCalled).toBe(false); // opaque: no per-call model governance
    expect(transport.calls).toBe(1); // the black box ran exactly once
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "drafted note" });
    expect(sr.result.cost.usd).toBe(2);
  });

  it("maps the SessionContract onto the transport request (prompt, cwd, memorySlice, model hint)", async () => {
    const transport = new FakeTransport({ reply: "ok" });
    const eng = new ClaudeAgentEngine({ transport });
    const contract: SessionContract = {
      input: { prompt: "do it", cwd: "/work/repo", system: "be terse", model: "claude-x" },
      memorySlice: { notes: ["a", "b"] },
      budget: 42,
      depth: 2,
      maxDepth: 7,
    };
    await eng.run(contract, ctxWith({}));

    const req = transport.lastRequest!;
    expect(req.prompt).toBe("do it");
    expect(req.cwd).toBe("/work/repo");
    expect(req.system).toBe("be terse");
    expect(req.model).toBe("claude-x"); // HULL model hint, NOT per-call governance
    expect(req.memorySlice).toEqual({ notes: ["a", "b"] });
  });

  it("uses routing.agentEngine model hint when the input sets none (HULL hint only)", async () => {
    const transport = new FakeTransport();
    const eng = new ClaudeAgentEngine({ transport });
    const contract: SessionContract = {
      input: { prompt: "go" },
      routing: { models: ["sonnet-via-routing"] },
      budget: 10,
      depth: 1,
      maxDepth: 5,
    };
    await eng.run(contract, ctxWith({}));
    expect(transport.lastRequest!.model).toBe("sonnet-via-routing");
  });
});

describe("ClaudeAgentEngine — inherited budget + depth (Inv. 21, NEVER fresh)", () => {
  it("INHERITS the depth ceiling: depth >= maxDepth escalates BEFORE the transport runs", async () => {
    const transport = new FakeTransport({ reply: "should-not-run" });
    let path: string | undefined;
    const eng = new ClaudeAgentEngine({ transport, onPath: (p) => (path = p) });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 3, maxDepth: 3 },
      ctxWith({}),
    );
    expect("elicitation" in sr).toBe(true);
    if (!("elicitation" in sr)) throw new Error("expected elicitation");
    expect(sr.elicitation.what).toMatch(/tiefe|depth|limit/i);
    expect(sr.elicitation.mode).toBe("blocking");
    expect(transport.calls).toBe(0); // ceiling hit before any black-box work
    expect(path).toBe("ceiling");
  });

  it("INHERITS the remaining budget + depth across the boundary (NOT a fresh budget)", async () => {
    // The agent node hands down ctx.cost.remaining() as contract.budget and parentDepth+1 as contract.depth.
    // The engine MUST pass those through verbatim to the transport — never a fresh constant.
    const transport = new FakeTransport({ reply: "ok", cost: { usd: 4 } });
    const eng = new ClaudeAgentEngine({ transport });
    const contract: SessionContract = {
      input: { prompt: "go" },
      budget: 17, // a non-default REMAINING figure — proves it isn't a fresh constant
      depth: 4, // already decremented (childDepth) by the node
      maxDepth: 9,
    };
    await eng.run(contract, ctxWith({}));

    const req = transport.lastRequest!;
    expect(req.budget).toBe(17); // inherited remaining, NOT fresh
    expect(req.depth).toBe(4); // inherited (already decremented) depth
    expect(req.maxDepth).toBe(9);
  });

  it("charges the HULL cost to the shared ctx.cost tracker (Inv. 18/21 — opaque, single per-turn figure)", async () => {
    const transport = new FakeTransport({ reply: "ok", cost: { usd: 5, tokensIn: 10, tokensOut: 3 } });
    let remaining = 20;
    const charges: number[] = [];
    const eng = new ClaudeAgentEngine({ transport });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 20, depth: 1, maxDepth: 5 },
      ctxWith({
        cost: {
          charge: (c: Cost) => {
            remaining -= c.usd ?? 0;
            charges.push(c.usd ?? 0);
          },
          remaining: () => remaining,
        },
      }),
    );
    expect(charges).toEqual([5]); // ONE per-turn HULL charge (not per model call)
    expect(remaining).toBe(15);
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.cost.usd).toBe(5); // and the turn cost rides up in the result
  });
});

describe("ClaudeAgentEngine — elicitation propagation (Inv. 11)", () => {
  it("propagates a transport-raised elicitation UP as an ELIO elicitation/Suspended", async () => {
    const transport = new FakeTransport({
      elicitation: {
        what: "The agent needs the deploy target — which environment?",
        whoCanAnswer: { users: ["operator"] },
        mode: "blocking",
      },
    });
    let path: string | undefined;
    const eng = new ClaudeAgentEngine({ transport, onPath: (p) => (path = p) });
    const sr = await eng.run(
      { input: { prompt: "deploy it" }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({}),
    );
    expect("elicitation" in sr).toBe(true);
    if (!("elicitation" in sr)) throw new Error("expected elicitation");
    expect(sr.elicitation.what).toMatch(/deploy target|environment/i);
    expect(sr.elicitation.mode).toBe("blocking");
    expect(path).toBe("elicitation");
  });

  it("does NOT charge the budget when the turn elicits (no resolved result)", async () => {
    const transport = new FakeTransport({
      elicitation: { what: "need input", whoCanAnswer: { users: ["operator"] }, mode: "blocking" },
      cost: { usd: 99 },
    });
    let charged = 0;
    const eng = new ClaudeAgentEngine({ transport });
    await eng.run(
      { input: { prompt: "go" }, budget: 100, depth: 1, maxDepth: 5 },
      ctxWith({ cost: { charge: (c: Cost) => (charged += c.usd ?? 0), remaining: () => 100 } }),
    );
    expect(charged).toBe(0); // elicitation path returns before the HULL cost charge
  });
});

describe("ClaudeAgentEngine — HULL creds via ctx.secrets (Inv. 14)", () => {
  it("resolves only policy-allowed secrets into the transport env; skips denied names", async () => {
    const transport = new FakeTransport();
    const secrets: SecretsService = {
      has: (name: string) => name === "GH_TOKEN", // only this one is in the allowed scope
      resolve: (ref) =>
        ref.name === "GH_TOKEN"
          ? Promise.resolve("ghp-secret-value")
          : Promise.reject(new Error("denied")),
    };
    const eng = new ClaudeAgentEngine({ transport });
    await eng.run(
      {
        input: { prompt: "go", secretEnv: { GITHUB_TOKEN: "GH_TOKEN", AWS_KEY: "AWS_SECRET" } },
        budget: 10,
        depth: 1,
        maxDepth: 5,
      },
      ctxWith({ secrets }),
    );
    // GH_TOKEN resolves -> injected as env var GITHUB_TOKEN; AWS_SECRET is denied -> absent (security by absence).
    expect(transport.lastRequest!.env).toEqual({ GITHUB_TOKEN: "ghp-secret-value" });
  });

  it("omits env entirely when there is no ctx.secrets or no secretEnv", async () => {
    const transport = new FakeTransport();
    const eng = new ClaudeAgentEngine({ transport });
    await eng.run({ input: { prompt: "go" }, budget: 10, depth: 1, maxDepth: 5 }, ctxWith({}));
    expect(transport.lastRequest!.env).toBeUndefined();
  });
});

describe("ClaudeAgentEngine — output-gate hook (HULL governance)", () => {
  it("runs the output-gate on the transport result before it becomes the node output", async () => {
    const transport = new FakeTransport({ reply: "raw", cost: { usd: 1 } });
    const eng = new ClaudeAgentEngine({
      transport,
      outputGate: (res) => ({ ...res, text: `gated:${res.text}` }),
    });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 10, depth: 1, maxDepth: 5 },
      ctxWith({}),
    );
    if (!("result" in sr) || sr.result.status !== "resolved") throw new Error("not resolved");
    expect(sr.result.output).toEqual({ text: "gated:raw" });
  });

  it("an output-gate may CONVERT a resolved result into an elicitation (propagates UP, Inv. 11)", async () => {
    const transport = new FakeTransport({ reply: "low-quality draft" });
    const eng = new ClaudeAgentEngine({
      transport,
      outputGate: (res) =>
        String(res.text).includes("low-quality")
          ? { elicitation: { what: "gate rejected output — intervene?", whoCanAnswer: { users: ["operator"] }, mode: "blocking" } }
          : res,
    });
    const sr = await eng.run(
      { input: { prompt: "go" }, budget: 10, depth: 1, maxDepth: 5 },
      ctxWith({}),
    );
    expect("elicitation" in sr).toBe(true);
  });
});
