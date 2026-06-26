// ───────────────────────────── Elicitation = universelles Suspend-Signal (Inv. 11) ─────────────────────────────
// + Resume via correlation-id (Inv. 12).

import type { JsonSchema, SerializedState } from "./common";
import type { ArtifactRef } from "./artifact";

export type SuspendMode = "blocking" | "parked" | "timeout" | "optional"; // Inv. 12

export interface Answerer {
  roles?: string[];
  users?: string[];
  /** Reine Maschinen-Antwort: Policy oder Parent-State kann auto-resolven. */
  machine?: boolean;
}

export interface Elicitation {
  what: string; // was wird gebraucht / wofür Freigabe
  whoCanAnswer: Answerer; // role | user | policy | parent-state
  schema?: JsonSchema; // erwartete Form der Antwort
  mode: SuspendMode; // Inv. 12
  /** Default, falls mode = optional / timeout-default. */
  default?: unknown;
  deadline?: string; // ISO; nur für mode = timeout
  onTimeout?: "fail" | "default" | "escalate";
}

export interface CorrelationId {
  run: string;
  branch: string;
  step: string;
  checkpoint: string;
}

export interface Checkpoint {
  id: string; // = CorrelationId.checkpoint
  correlation: CorrelationId;
  /** Rehydrierbarer, komprimierter State (Artefakt-Referenz + Branch-lokaler State). */
  state: SerializedState;
  artifactRef: ArtifactRef; // was die Session-Grenze kreuzt (Inv. 4)
  /** Gepinnte Pack-Version (content-hash); Resume gegen geänderten Pack → reject/Migration (§11/#14). */
  packVersion: string;
  pendingElicitation?: Elicitation;
  createdAt: string;
}
