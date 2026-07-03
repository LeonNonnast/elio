import type { JsonSchema, SerializedState } from "./common";
import type { ArtifactRef } from "./artifact";
export type SuspendMode = "blocking" | "parked" | "timeout" | "optional";
export interface Answerer {
    roles?: string[];
    users?: string[];
    /** Reine Maschinen-Antwort: Policy oder Parent-State kann auto-resolven. */
    machine?: boolean;
}
export interface Elicitation {
    what: string;
    whoCanAnswer: Answerer;
    schema?: JsonSchema;
    mode: SuspendMode;
    /** Default, falls mode = optional / timeout-default. */
    default?: unknown;
    deadline?: string;
    onTimeout?: "fail" | "default" | "escalate";
}
export interface CorrelationId {
    run: string;
    branch: string;
    step: string;
    checkpoint: string;
}
export interface Checkpoint {
    id: string;
    correlation: CorrelationId;
    /** Rehydrierbarer, komprimierter State (Artefakt-Referenz + Branch-lokaler State). */
    state: SerializedState;
    artifactRef: ArtifactRef;
    /**
     * Vollständiger, serialisierter Artefakt-Snapshot (SerializedArtifact) — erlaubt es einem NEUEN Prozess,
     * das Artefakt für einen cross-process Resume zu deserialisieren (der Run-Kontext wird sonst nur
     * in-memory gehalten). Bewusst `unknown` getypt, um keinen Import-Zyklus elicitation -> artifact-impl
     * zu erzeugen; der Runner serialisiert/deserialisiert mit dem konkreten Typ.
     */
    artifactSnapshot?: unknown;
    /** Gepinnte Pack-Version (content-hash); Resume gegen geänderten Pack → reject/Migration (§11/#14). */
    packVersion: string;
    pendingElicitation?: Elicitation;
    createdAt: string;
}
