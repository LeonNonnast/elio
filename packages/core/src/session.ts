// ───────────────────────────── Session Contract = Boundary-Objekt (Inv. 3, §11/#12) ─────────────────────────────

import type { NodeResult } from "./node";
import type { Elicitation } from "./elicitation";
import type { Ctx } from "./ctx";

/** Typisiert die Session-Grenze. */
export interface SessionContract {
  // runter
  input: unknown;
  routing?: { models?: string[]; agentEngine?: string };
  memorySlice?: unknown;
  budget: number; // PFLICHT, propagiert + dekrementiert (Inv. 21)
  depth: number; // aktuelle Tiefe; gegen maxDepth geprüft (Inv. 21)
}

/** hoch: Ergebnis ODER Elicitation. */
export type SessionResult = { result: NodeResult } | { elicitation: Elicitation };

export interface AgentEngine {
  readonly id: string; // "vela" | "claude-code" | "copilot-cli" | …
  readonly governance: "transparent" | "opaque"; // transparent: Calls durch ctx.model (Inv. 14)
  // opaque: nur Hüllen-Governance (cwd/creds/prompt/sandbox/budget/gate)
  run(contract: SessionContract, ctx: Ctx): Promise<SessionResult>; // erbt Restbudget, nie frisch (Inv. 21)
}
