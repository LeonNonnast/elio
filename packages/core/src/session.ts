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
    /**
     * Resume-Antwort (Inv. 11/12, §v0.2): gesetzt, wenn dieser Turn einen zuvor suspendierten Inner Loop
     * FORTSETZT (der Agent hatte via Elicitation eine Frage hochpropagiert). Eine Engine mit persistenter
     * Session (z.B. Vela via identity↔correlation) re-findet ihren pausierten Run und advanced ihn mit
     * dieser Antwort; fehlt sie, ist es ein Erst-Turn. Opake Engines dürfen sie als Task-Input behandeln.
     */
    resume?: { answer: unknown };
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
