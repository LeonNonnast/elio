// @elio/migrate — Dogfood-Vertikale: Datenmigration (CSV -> DB), §7.
// Injizierte Source/Target-Adapter als Services (KEINE Steps), Migrate-Nodes (built-in == custom),
// das kanonische migrate.csv-to-db-Feature-Pack + eine Setup-Fassade.

// ───────────────────────────── Adapter (injizierte Services, §7) ─────────────────────────────
export { SourceCsvAdapter, parseCsv } from "./adapters/source-csv";
export type { CsvRecord, SourceCsvOptions, CsvFsReader } from "./adapters/source-csv";
export { TargetDbAdapter } from "./adapters/target-db";
export type { TargetDbOptions } from "./adapters/target-db";

// ───────────────────────────── Migrate-Nodes + Mapping/Validierung ─────────────────────────────
export {
  registerMigrate,
  parseMappingProposal,
  applyMapping,
  validateTargetRecord,
  DEFAULT_MAPPING,
  TARGET_REQUIRED_FIELDS,
} from "./nodes";
export type { Mapping, RegisterMigrateOptions } from "./nodes";

// ───────────────────────────── Policies ─────────────────────────────
export {
  registerMigratePolicies,
  commitRequiresApprovalPolicy,
  COMMIT_REQUIRES_APPROVAL,
} from "./policies";

// ───────────────────────────── Setup-Fassade + Feature-Pack ─────────────────────────────
export {
  setupMigrate,
  loadMigrateFeature,
  migrateFeaturePath,
  migrateRootPolicy,
  MIGRATION_SCRIPT_TYPE,
  MIGRATE_MODEL,
} from "./setup";
export type { SetupMigrateOptions, MigrateSetup } from "./setup";
