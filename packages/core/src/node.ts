// ───────────────────────────── Node = reine Funktion (Inv. 5) + Rückgabe-Contract (Inv. 10, §11/#7) ─────────────────────────────

import type { Cost } from "./common";
import type { Elicitation } from "./elicitation";
import type { Ctx } from "./ctx";
import type { CapabilityRequest } from "./policy";
import type { StepRef } from "./feature";

export type Node<I = unknown, O = unknown> = (input: I, ctx: Ctx) => Promise<NodeResult<O>>;

/** Eine registrierte Node-Definition. built-in == custom (Inv. 6). */
export interface NodeDefinition<I = unknown, O = unknown> {
  type: string; // "router" | "validate" | "llm" | "agent" | "@org/foo#bar" ...
  klass: "orchestration" | "intelligence"; // Inv. 7
  handler: Node<I, O>;
  /** Welche ctx-Capabilities diese Node *anfordert*. Die Policy verschärft (Inv. 13/14). */
  requests?: CapabilityRequest;
  /** Per-Node Retry-Policy für den Failed-Pfad (§11/#7). Feature kann überschreiben. */
  retry?: RetryPolicy;
}

export type NodeResult<O = unknown> = Resolved<O> | Suspended | Failed;

export interface Resolved<O = unknown> {
  status: "resolved";
  output: O;
  confidence: number; // 0..1
  cost: Cost;
}

export interface Suspended {
  status: "suspended";
  elicitation: Elicitation;
}

/** Fehlerpfad (§11/#7). Runner entscheidet via RetryPolicy: retry | Eskalation (Elicitation) | Dead-Letter. */
export interface Failed {
  status: "failed";
  error: { message: string; code?: string };
  retryable: boolean;
  attempts: number;
}

/** Per-Node/Feature deklarierte Retry-Policy (§11/#7). */
export interface RetryPolicy {
  maxAttempts: number;
  backoff?: "none" | "fixed" | "exponential";
  baseDelayMs?: number;
  /** nach Erschöpfung: als Elicitation eskalieren (Inv. 11) ODER hart fehlschlagen. */
  onExhausted: "escalate" | "fail";
}

// ───────────────────────────── Eval-Gate als Node-Verdikt (Inv. 1/6, §11/#4) ─────────────────────────────
/** Dünnes Verdikt, das der Runner liest. Erzeugt von validate-/judge-/hybrid-Node — kein Sonder-Primitiv. */
export interface GateVerdict {
  passed: boolean;
  score?: number;
  failures: string[];
}

// ───────────────────────────── Planner-Output-Contract (Inv. 9, §11/#10) ─────────────────────────────
/** Validiert gegen Step-Whitelist + maxDepth; rationale ist Pflicht im Tape. */
export interface PlanDecision {
  nextStep: StepRef | "DONE";
  rationale: string; // Pflichtfeld im Tape
}
