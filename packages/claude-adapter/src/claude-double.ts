// ───────────────────────────── FakeTransport: deterministic, offline (TEST ONLY) ─────────────────────────────
// The ONLY transport the tests use. It is fully deterministic and OFFLINE — no API key, no network, no real
// claude CLI, no @anthropic-ai/claude-agent-sdk. It lets the tests exercise the REAL ClaudeAgentEngine code
// path (the SessionContract -> ClaudeTransportRequest mapping, the inherited budget/depth threading, the
// elicitation propagation, the HULL cost charge) WITHOUT any external dependency.
//
// HONESTY DISCIPLINE (mirrors vela-double.ts): this is a TEST DOUBLE, not a real Claude call — it never
// reaches Anthropic. The real transports (AgentSdkTransport, ClaudeCliTransport) are what would make a real
// call; they are guarded and NOT exercised by tests. A green test run proves the ENGINE's contract handling,
// not that a real Claude turn works.
//
// It supports the two behaviours the tests pin:
//   1. returning a RESOLVED result (text + a deterministic per-turn HULL cost);
//   2. raising an ELICITATION (to test Inv. 11 propagation up through the engine + runner).
// It also records the LAST request it received so tests can assert the inherited budget/depth (Inv. 21) and
// the resolved cred env crossed the boundary correctly.

import type { Cost, Elicitation } from "@elio/core";
import type { ClaudeTransport, ClaudeTransportRequest, ClaudeTransportResult } from "./claude-contract";

export interface FakeTransportOptions {
  /**
   * The text the agent "produces" for a resolved turn. May be a constant string or a function of the request
   * (e.g. to echo the prompt). Ignored when `elicitOn` matches.
   */
  reply?: string | ((req: ClaudeTransportRequest) => string);
  /** Deterministic HULL cost charged per turn (Inv. 18/21). Default { usd: 1 }. */
  cost?: Cost;
  /**
   * If set, the transport RAISES this elicitation instead of resolving — to test Inv. 11. Either an
   * Elicitation, or a predicate that returns one (or undefined to resolve normally) based on the request.
   */
  elicitation?: Elicitation | ((req: ClaudeTransportRequest) => Elicitation | undefined);
}

export class FakeTransport implements ClaudeTransport {
  readonly kind = "fake";

  /** The last request the engine handed this transport (for assertions). */
  lastRequest: ClaudeTransportRequest | undefined;
  /** How many times run() was called. */
  calls = 0;

  private readonly opts: FakeTransportOptions;

  constructor(opts: FakeTransportOptions = {}) {
    this.opts = opts;
  }

  run(req: ClaudeTransportRequest): Promise<ClaudeTransportResult> {
    this.calls += 1;
    this.lastRequest = req;

    // Elicitation path (Inv. 11): the black-box agent asked a question -> propagate UP.
    const elicitation =
      typeof this.opts.elicitation === "function" ? this.opts.elicitation(req) : this.opts.elicitation;
    if (elicitation !== undefined) {
      return Promise.resolve({ elicitation });
    }

    // Resolved path: a deterministic reply + per-turn HULL cost.
    const reply = typeof this.opts.reply === "function" ? this.opts.reply(req) : (this.opts.reply ?? "ok");
    const cost: Cost = this.opts.cost ?? { usd: 1 };
    return Promise.resolve({ text: reply, cost });
  }
}
