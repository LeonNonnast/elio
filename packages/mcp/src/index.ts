// ───────────────────────────── @elio/mcp — Public Entry (Inv. 2: dünner @elio/sdk-Client) ─────────────────────────────
// Exportiert die Server-Fabrik + die Feature-Discovery + main(), damit Tests die MCP-Surface
// PROGRAMMATISCH treiben können (In-Memory-Transport, kein Subprozess). Die Surface enthält KEINE
// Engine-Logik — sie ist außen ein MCP-Server, intern ein Client der @elio/sdk-Runtime (Inv. 19 B).

export const ELIO_MCP_VERSION = "0.0.0";

export {
  createMcpServer,
  featureToTool,
  normalizeInputSchema,
  runFeature,
  DEFAULT_MCP_BUDGET,
  DEFAULT_MCP_MAX_DEPTH,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from "./server";
export type { CreateMcpServerOptions } from "./server";

export { discoverFeatures, indexFeatures, briefFromArgs, SKILL_SAMPLE_BRIEF } from "./registry";
export type { FeatureInfo } from "./registry";

export { main } from "./bin";
