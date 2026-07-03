// ───────────────────────────── Migrate-FeatureProvider ─────────────────────────────
// Wrappt die setupMigrate()-Fassade (KEIN Hand-Wiring wie Studio es tat). Das deterministische Sample-CSV
// lebt jetzt EINMAL hier — vorher byte-identisch dreifach in cli/features.ts, mcp/registry.ts,
// studio/runtime.ts. Überschreibbar via ctx.params.sourceCsv.

import { loadMigrateFeature, setupMigrate } from "@elio/migrate";
import type { FeatureProvider } from "../provider";
import { modelOptsFrom, storeOptFrom } from "../provider";

/** Kleines, deterministisches CSV-Sample für die Migrate-Demo (offline, MockModel). */
export const MIGRATE_SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
u3,Cara Cole,cara@example.com
`;

const MIGRATE_CAPS = { model: true, db: true, fs: "read", traces: false, ephemeralStore: false } as const;

/** migrate.csv-to-db — Datenmigrations-Vertikale: CSV → DB mit Commit-Approval-Gate. */
export function migrateProvider(): FeatureProvider {
  const pack = loadMigrateFeature();
  return {
    id: pack.metadata.id,
    pack,
    capabilities: { ...MIGRATE_CAPS },
    setup: (ctx) => {
      const sourceCsv =
        typeof ctx.params?.["sourceCsv"] === "string"
          ? (ctx.params["sourceCsv"] as string)
          : MIGRATE_SAMPLE_CSV;
      const setup = setupMigrate({
        source: { content: sourceCsv },
        ...storeOptFrom(ctx, MIGRATE_CAPS),
        ...modelOptsFrom(ctx),
        ...(ctx.rootPolicy !== undefined ? { rootPolicy: ctx.rootPolicy } : {}),
      });
      return {
        runtime: setup.runtime,
        pack: setup.pack,
        handles: { source: setup.source, target: setup.target, failCommitIds: setup.failCommitIds },
      };
    },
  };
}
