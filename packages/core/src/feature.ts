import type { JsonSchema } from "./common";
import type { SuspendMode } from "./elicitation";
export interface FeaturePack {
    apiVersion: "elio/v1";
    kind: "Feature";
    metadata: {
        id: string;
        version: string;
        owner?: string;
        lifecycle?: string;
        /**
         * Dateipfad, aus dem das Pack geladen wurde (nur bei `loadFeaturePack({ path })` gesetzt).
         * Built-in/Inline-Packs (Code-Exporte, reine YAML-Strings) tragen ihn NICHT — die Anzeige
         * fällt dann auf „built-in" zurück. Read-only Anzeige-/Diagnose-Info, fließt NICHT in den
         * contentHash (siehe loader: erst nach computeContentHash gesetzt).
         */
        sourcePath?: string;
    };
    /** content-hash über Pack + content-addressed Prompts → reproduzierbare Evals + Resume-Pinning (§11/#14). */
    contentHash?: string;
    feature: FeatureDefinition;
}
export interface FeatureDefinition {
    /** Wo das Feature auf dem Autonomie-Dial liegt (Inv. 9). */
    autonomy: "static" | "guided" | "dynamic";
    /** Statischer Graph (autonomy=static/guided) ODER Planner-Node (autonomy=dynamic). */
    graph?: GraphDefinition;
    planner?: {
        node: string;
    };
    artifact: {
        kind: string;
        evalGate: string;
    };
    policies?: string[];
    io: {
        input: JsonSchema;
        output: JsonSchema;
    };
}
export interface GraphDefinition {
    state?: Record<string, unknown>;
    steps: StepRef[];
    edges: {
        from: string;
        to: string;
        when?: string;
    }[];
}
export interface StepRef {
    id: string;
    type: string;
    with?: Record<string, unknown>;
    outputs?: Record<string, string>;
    suspend?: SuspendMode;
    when?: string;
}
