// ───────────────────────────── Feature Pack / Definition ─────────────────────────────

import type { JsonSchema } from "./common";
import type { SuspendMode } from "./elicitation";

export interface FeaturePack {
  apiVersion: "elio/v1";
  kind: "Feature";
  metadata: { id: string; version: string; owner?: string; lifecycle?: string };
  /** content-hash über Pack + content-addressed Prompts → reproduzierbare Evals + Resume-Pinning (§11/#14). */
  contentHash?: string;
  feature: FeatureDefinition;
}

export interface FeatureDefinition {
  /** Wo das Feature auf dem Autonomie-Dial liegt (Inv. 9). */
  autonomy: "static" | "guided" | "dynamic";
  /** Statischer Graph (autonomy=static/guided) ODER Planner-Node (autonomy=dynamic). */
  graph?: GraphDefinition;
  planner?: { node: string }; // ein agent-Node, der "nächster Step" zurückgibt (Inv. 9)
  artifact: { kind: string; evalGate: string }; // Exit-Condition = Artefakt gut genug (Inv. 1)
  policies?: string[];
  io: { input: JsonSchema; output: JsonSchema };
}

export interface GraphDefinition {
  state?: Record<string, unknown>;
  steps: StepRef[]; // jede StepRef referenziert eine registrierte NodeDefinition (Inv. 6)
  edges: { from: string; to: string; when?: string }[];
}

export interface StepRef {
  id: string;
  type: string; // built-in == custom (Inv. 6)
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  suspend?: SuspendMode;
  when?: string;
}
