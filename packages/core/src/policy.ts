// ───────────────────────────── Policy: tighten-only (Inv. 13) + Injector (Inv. 14) ─────────────────────────────

import type { CorrelationId, Elicitation, SuspendMode } from "./elicitation";
import type { Artifact } from "./artifact";
import type { Ctx } from "./ctx";
import type { NodeDefinition } from "./node";

export interface CapabilityRequest {
  models?: string[];
  cloud?: boolean;
  fs?: { read?: string[]; write?: string[] };
  db?: string[];
  http?: boolean;
  tools?: string[];
}

export interface ResolvedPolicy {
  allowedModels: string[];
  allowCloud: boolean;
  dataClassification: "public" | "internal" | "confidential" | "private" | "regulated";
  maxCostUsd?: number;
  suspendMode: SuspendMode; // engste erlaubte Suspend-Art
  fsPaths?: { read: string[]; write: string[] };
  dbScopes?: string[];
  toolPermissions: string[];
}

export interface Policy {
  id: string;
  /**
   * Interceptor auf dem Injection-Pfad (runter) und dem Elicitation-Pfad (hoch).
   * Vertrag: darf NUR verschärfen. Eine Policy kann eine angeforderte Capability
   * entziehen/einschränken, niemals eine nicht-angeforderte hinzufügen.
   */
  scope(req: CapabilityRequest, parent: ResolvedPolicy): ResolvedPolicy;
  /** Kann eine hochpropagierende Elicitation auto-resolven (Inv. 11). */
  intercept?(
    e: Elicitation,
    ctxState: unknown,
  ): { resolved: true; answer: unknown } | { resolved: false };
}

export interface Injector {
  /**
   * Baut das gescopte ctx für genau diese Node:
   *  resolved = tighten(parentPolicy, node.requests)   // Inv. 13
   *  ctx      = nur die Services, die `resolved` erlaubt  // Inv. 14: security by absence
   */
  buildCtx(
    node: NodeDefinition,
    parent: ResolvedPolicy,
    correlation: CorrelationId,
    artifact: Artifact,
  ): Ctx;
}
