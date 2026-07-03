// ───────────────────────────── Retro-Toolkit: wiederverwertbare Tools + Services als Funktionen ─────────────────────────────
// Das Substrat der Learning/Optimization-Engine (docs/elio-learning-engine.md). Miner komponieren diese
// Bausteine, statt Tape-Lesen/Hashen/Gruppieren/Kandidaten je neu zu implementieren — built-in == custom
// (Inv. 6) gilt auch hier: ein gelernter Miner ist nur eine weitere Funktion über demselben Toolkit.

export * from "./canon";
export * from "./callsite";
export * from "./stats";
export * from "./candidate";
export * from "./process";
export * from "./miners";
export * from "./capture";
export * from "./summaries";
export * from "./orchestrator";
export * from "./process-route";
export * from "./pm-discover";
export * from "./pm-event-log";
export * from "./pm-session-summary";
export * from "./promotion";
export * from "./promote";
export * from "./synthesize";
export * from "./demote";
