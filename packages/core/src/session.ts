import type { NodeResult } from "./node";
import type { Elicitation } from "./elicitation";
import type { Ctx } from "./ctx";
/** Typisiert die Session-Grenze. */
export interface SessionContract {
    input: unknown;
    routing?: {
        models?: string[];
        agentEngine?: string;
    };
    memorySlice?: unknown;
    budget: number;
    depth: number;
    maxDepth: number;
}
/** hoch: Ergebnis ODER Elicitation. */
export type SessionResult = {
    result: NodeResult;
} | {
    elicitation: Elicitation;
};
export interface AgentEngine {
    readonly id: string;
    readonly governance: "transparent" | "opaque";
    run(contract: SessionContract, ctx: Ctx): Promise<SessionResult>;
}
