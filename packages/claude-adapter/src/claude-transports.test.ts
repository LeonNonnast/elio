// ───────────────────────────── Real-transport coverage: OFFLINE mapping + GUARDED live ─────────────────────────────
//
// Honesty discipline (see claude-transports.ts): the two REAL transports were previously NOT exercised at all —
// only FakeTransport was. This file closes that gap WITHOUT a key/network:
//   - AgentSdkTransport is driven through an INJECTED loadQuery stub (a fake `query()` generator). No SDK, no
//     key — but the transport's own HULL mapping (cwd/env/model/systemPrompt/maxBudgetUsd) and result parsing
//     (text/cost/structured/is_error/no-result) run for real.
//   - ClaudeCliTransport is driven against a FAKE bin (a tiny node shebang script) that prints the documented
//     `--output-format json` payload. Real spawn + close + parseCliJson run; `claude` itself is never touched.
// Plus two GENUINELY guarded live tests (skipped unless an env flag is set) that hit the real SDK/CLI.

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSdkTransport, ClaudeCliTransport } from "./claude-transports";
import type { AgentSdkQueryFn } from "./claude-transports";
import type { ClaudeTransportRequest } from "./claude-contract";

const baseReq: ClaudeTransportRequest = { prompt: "say hi", budget: 2.5, depth: 0, maxDepth: 3 };

// ───────────────────────── AgentSdkTransport — offline via injected loadQuery ─────────────────────────

describe("AgentSdkTransport — HULL mapping + result parsing (offline, injected loadQuery)", () => {
  /** A fake `query()` that records the options it was called with and yields a terminal result message. */
  function fakeQuery(capture: { options?: unknown; prompt?: string }, result: Record<string, unknown>): AgentSdkQueryFn {
    return ((params: { prompt: string; options?: unknown }) => {
      capture.prompt = params.prompt;
      capture.options = params.options;
      return (async function* () {
        yield { type: "assistant" } as { type: string };
        yield { type: "result", is_error: false, ...result } as { type: string };
      })();
    }) as AgentSdkQueryFn;
  }

  it("maps cwd/system/model/budget onto SDK options, spreads process.env, and returns text+cost", async () => {
    const cap: { options?: unknown; prompt?: string } = {};
    const t = new AgentSdkTransport({
      loadQuery: () => Promise.resolve(fakeQuery(cap, {
        result: "hello from fake sdk",
        total_cost_usd: 0.02,
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
      defaultModel: "claude-default",
    });

    const res = await t.run({ ...baseReq, cwd: "/work", env: { INJECTED: "cred" }, system: "you are terse" });

    expect(res.text).toBe("hello from fake sdk");
    expect(res.cost?.usd).toBe(0.02);
    expect(res.cost?.tokensIn).toBe(10);
    expect(res.cost?.tokensOut).toBe(5);

    const opts = cap.options as {
      cwd?: string; systemPrompt?: string; model?: string; maxBudgetUsd?: number;
      env?: Record<string, string | undefined>;
    };
    expect(cap.prompt).toBe("say hi");
    expect(opts.cwd).toBe("/work");
    expect(opts.systemPrompt).toBe("you are terse");
    expect(opts.model).toBe("claude-default"); // fell back to defaultModel (req.model unset)
    expect(opts.maxBudgetUsd).toBe(2.5); // inherited Inv. 21 budget -> SDK's real USD ceiling
    // env REPLACES (not merges) inside the SDK, so the transport must spread process.env + inject on top.
    expect(opts.env?.INJECTED).toBe("cred");
    expect(opts.env?.["PATH"]).toBe(process.env["PATH"]);
  });

  it("prefers an explicit req.model over the default", async () => {
    const cap: { options?: unknown } = {};
    const t = new AgentSdkTransport({
      loadQuery: () => Promise.resolve(fakeQuery(cap, { result: "ok" })),
      defaultModel: "claude-default",
    });
    await t.run({ ...baseReq, model: "claude-explicit" });
    expect((cap.options as { model?: string }).model).toBe("claude-explicit");
  });

  it("surfaces structured_output when present", async () => {
    const cap: { options?: unknown } = {};
    const t = new AgentSdkTransport({
      loadQuery: () => Promise.resolve(fakeQuery(cap, { result: "", structured_output: { a: 1 } })),
    });
    const res = await t.run(baseReq);
    expect(res.output).toEqual({ a: 1 });
  });

  it("throws on an is_error result message", async () => {
    const cap: { options?: unknown } = {};
    const t = new AgentSdkTransport({
      loadQuery: () => Promise.resolve(fakeQuery(cap, { is_error: true, subtype: "error_max_budget_usd" })),
    });
    await expect(t.run(baseReq)).rejects.toThrow(/agent run failed/i);
  });

  it("throws when the stream ends without a result message", async () => {
    const noResult: AgentSdkQueryFn = (() =>
      (async function* () {
        yield { type: "assistant" } as { type: string };
      })()) as AgentSdkQueryFn;
    const t = new AgentSdkTransport({ loadQuery: () => Promise.resolve(noResult) });
    await expect(t.run(baseReq)).rejects.toThrow(/without a result message/i);
  });

  it("throws a clear 'not available' error when the loader fails (missing SDK/creds)", async () => {
    const t = new AgentSdkTransport({ loadQuery: () => Promise.reject(new Error("Cannot find module")) });
    await expect(t.run(baseReq)).rejects.toThrow(/not available/i);
  });
});

// ───────────────────────── ClaudeCliTransport — offline via fake bin ─────────────────────────

describe("ClaudeCliTransport — real spawn + parse against a fake bin (offline)", () => {
  async function fakeBin(script: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "elio-claude-cli-"));
    const bin = join(dir, "fake-claude.mjs");
    await writeFile(bin, `#!/usr/bin/env node\n${script}\n`, "utf8");
    await chmod(bin, 0o755);
    return bin;
  }

  it("parses a --output-format json result object into text + cost", async () => {
    const bin = await fakeBin(
      `process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "cli hello", total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 } }))`,
    );
    const t = new ClaudeCliTransport({ bin, defaultModel: "claude-cli-model" });
    const res = await t.run(baseReq);
    expect(res.text).toBe("cli hello");
    expect(res.cost?.usd).toBe(0.01);
    expect(res.cost?.model).toBe("claude-cli-model");
  });

  it("rejects when the bin reports is_error=true", async () => {
    const bin = await fakeBin(`process.stdout.write(JSON.stringify({ type: "result", is_error: true }))`);
    const t = new ClaudeCliTransport({ bin });
    await expect(t.run(baseReq)).rejects.toThrow(/is_error=true/i);
  });

  it("rejects on a non-zero exit code", async () => {
    const bin = await fakeBin(`process.stderr.write("boom"); process.exit(3);`);
    const t = new ClaudeCliTransport({ bin });
    await expect(t.run(baseReq)).rejects.toThrow(/exited 3/i);
  });
});

// ───────────────────────── GUARDED live tests (skipped unless env flag set) ─────────────────────────
//
// These make a REAL call. They are OFF by default and only run when the operator opts in with an env flag +
// working credentials. CI never sets these, so the suite stays offline/deterministic.

const RUN_REAL_SDK = process.env["ELIO_RUN_REAL_CLAUDE"] === "1";
const RUN_REAL_CLI = process.env["ELIO_RUN_REAL_CLAUDE_CLI"] === "1";

describe("GUARDED live transports (opt-in)", () => {
  it.runIf(RUN_REAL_SDK)("AgentSdkTransport reaches the real Agent SDK and returns text", async () => {
    const t = new AgentSdkTransport({ maxTurns: 1 });
    const res = await t.run({ ...baseReq, prompt: "Reply with exactly: pong" });
    expect(typeof res.text).toBe("string");
    expect((res.text ?? "").length).toBeGreaterThan(0);
  }, 120_000);

  it.runIf(RUN_REAL_CLI)("ClaudeCliTransport spawns the real `claude -p` and returns text", async () => {
    const t = new ClaudeCliTransport({ timeoutMs: 120_000 });
    const res = await t.run({ ...baseReq, prompt: "Reply with exactly: pong" });
    expect(typeof res.text).toBe("string");
    expect((res.text ?? "").length).toBeGreaterThan(0);
  }, 120_000);
});
