// ───────────────────────────── ID-Generierung + correlation-key (Inv. 12) ─────────────────────────────
// Node-Builtins only (node:crypto). Keine neuen Runtime-Deps.

import { randomUUID } from "node:crypto";
import type { CorrelationId } from "./elicitation";

/** Neue Run-ID (Outer Loop). */
export function newRunId(): string {
  return `run_${randomUUID()}`;
}

/** Neue Branch-ID (per-Branch State / per-record Loop). */
export function newBranchId(): string {
  return `branch_${randomUUID()}`;
}

/** Neue Step-Checkpoint-ID (= CorrelationId.checkpoint, Inv. 12). */
export function newStepCheckpointId(): string {
  return `cp_${randomUUID()}`;
}

/**
 * Stabiler String-Schlüssel über eine CorrelationId (run + branch + step + checkpoint).
 * Adressiert Checkpoints/Resume im Run Store (Inv. 12). Reihenfolge/Trenner sind fix,
 * damit der Schlüssel deterministisch ist.
 */
export function corrKey(c: CorrelationId): string {
  return `${c.run}::${c.branch}::${c.step}::${c.checkpoint}`;
}
