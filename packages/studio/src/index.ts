// ───────────────────────────── @elio/studio — Public Entry (Inv. 2: dünner @elio/engine-Client) ─────────────────────────────
// Exportiert die Server-Fabrik + die Dashboard-Helfer + die Seed-Treiber + main(), damit Tests die
// Studio-Surface PROGRAMMATISCH treiben können (node:http-Requests gegen einen ephemeren Port, kein
// Browser). Die Surface enthält KEINE Engine-Logik — sie ist ein read-mostly Client des EngineService
// und schreibt ausschließlich über den Elicitation-Resume-Pfad zurück (Inv. 2/§2).

export const ELIO_STUDIO_VERSION = "0.0.0";

export { createStudioServer } from "./server";
export type { CreateStudioServerOptions, StudioServer } from "./server";

export { dashboardHtml, DASHBOARD_MARKER } from "./dashboard";

export {
  seedStudioRuns,
  seedDemoRuns,
  seedMigrateApproval,
  seedSkillApproval,
  STUDIO_SKILL_BRIEF,
} from "./runtime";

export { main, DEFAULT_STUDIO_PORT } from "./bin";
export type { StudioMainOptions } from "./bin";
