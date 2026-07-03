// ───────────────────────────── elio (CLI) — Public Entry (Inv. 2: dünner @elio/engine-Client) ─────────────────────────────
// Exportiert die Command-Handler + IO-Seam + main(), damit Tests die Befehle PROGRAMMATISCH treiben
// können (ohne Prozess/TTY). Die CLI enthält KEINE Engine-Logik — sie treibt nur einen EngineService.

export const ELIO_CLI_VERSION = "0.0.0";

export { main, parseArgs, DEFAULT_ENGINE_PORT } from "./bin";
export type { ParsedArgs, MainOptions } from "./bin";

export {
  runCommand,
  resumeCommand,
  runsCommand,
  serveCommand,
  encodeCorrelation,
  decodeCorrelation,
  parseAnswer,
  parsePayload,
  EXIT_OK,
  EXIT_FAIL,
  EXIT_USAGE,
} from "./commands";
export type { CommandResult, RunCommandOptions } from "./commands";

export { StdioCliIO, InMemoryCliIO } from "./io";
export type { CliIO } from "./io";

export {
  formatEvent,
  formatRunStatus,
  formatElicitationPrompt,
  formatCost,
  corrTag,
} from "./format";

export { USAGE } from "./help";
