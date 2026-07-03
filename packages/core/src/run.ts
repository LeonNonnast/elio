import type { Cost } from "./common";
import type { Checkpoint, CorrelationId, Elicitation, SuspendMode } from "./elicitation";
import type { NodeResult } from "./node";
import type { ArtifactRef } from "./artifact";
import type { FeaturePack } from "./feature";
import type { ResolvedPolicy } from "./policy";
export interface RunInput {
    artifact?: ArtifactRef;
    payload: unknown;
    budget: number;
    maxDepth: number;
}
export interface RunRecord {
    id: string;
}
export interface RunStatus {
    correlation: CorrelationId;
    feature: string;
    phase: "running" | "suspended" | "done";
    step?: string;
    waitingOn?: Elicitation;
    cost: Cost;
    artifact?: ArtifactRef;
}
/** Pro Schritt emittiert. Persistiert = Loop Tape; live abonniert = Live-Status — derselbe Stream (Inv. 15). */
export type RunEvent = {
    type: "run-started";
    correlation: CorrelationId;
    feature: string;
} | {
    type: "step-started";
    correlation: CorrelationId;
    nodeType: string;
} | {
    type: "node-resolved";
    correlation: CorrelationId;
    confidence?: number;
    cost?: Cost;
} | {
    type: "node-suspended";
    correlation: CorrelationId;
    elicitation: Elicitation;
    mode: SuspendMode;
} | {
    type: "elicitation-resolved";
    correlation: CorrelationId;
    by: "policy" | "parent" | "human";
} | {
    type: "artifact-updated";
    correlation: CorrelationId;
    artifact: ArtifactRef;
} | {
    type: "cost-delta";
    correlation: CorrelationId;
    delta: Cost;
    total: Cost;
} | {
    type: "run-completed";
    correlation: CorrelationId;
    artifact: ArtifactRef;
    gate: "passed" | "stopped";
};
export interface TapeFrame {
    correlation: CorrelationId;
    /** Feature-id des Runs (vom Runner gestempelt) — speist traces:<feature>-Scoping + feature-genaue Miner/Shadow-Eval. */
    feature?: string;
    nodeType: string;
    input: unknown;
    result: NodeResult;
    injected: string[];
    /** Redaction-Projektion: über der Schwelle stehen hier Hashes/Refs statt Roh-Nutzdaten (§11/#9). */
    redaction?: {
        level: ResolvedPolicy["dataClassification"];
        redactedFields: string[];
    };
    ts: string;
}
export interface RunStore {
    createRun(input: RunInput): Promise<RunRecord>;
    saveCheckpoint(cp: Checkpoint): Promise<void>;
    loadCheckpoint(id: CorrelationId): Promise<Checkpoint | null>;
    /** Antwort adressiert die correlation-id -> rehydrate -> resume. */
    resolveElicitation(id: CorrelationId, answer: unknown): Promise<void>;
    appendTape(run: string, frame: TapeFrame): Promise<void>;
    tape(run: string): AsyncIterable<TapeFrame>;
    /** Alle bekannten Run-IDs (read-only Enumeration) — speist TracesService.collect & Studio-Run-Liste. */
    runIds(): Promise<string[]>;
    /** Live-Stream laufender Runs — speist Studio-Live-Status & Live-Updates (gleiche Events wie das Tape). */
    subscribe(filter?: {
        run?: string;
        active?: boolean;
    }): AsyncIterable<RunEvent>;
    /** Momentaufnahme: welche Runs/Branches laufen, worauf warten sie. */
    liveStatus(): Promise<RunStatus[]>;
}
export interface Runner {
    /** Outer Loop über mehrere Sessions; konvergiert gegen das Eval-Gate des Artefakts (Inv. 1). */
    run(pack: FeaturePack, input: RunInput): AsyncIterable<RunEvent>;
    /** Resume via correlation-id + Antwort (Inv. 12). */
    resume(id: CorrelationId, answer: unknown): AsyncIterable<RunEvent>;
}
