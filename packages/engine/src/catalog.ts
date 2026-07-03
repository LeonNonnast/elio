// ───────────────────────────── FeatureCatalog — EIN Katalog statt drei ─────────────────────────────
// Ersetzt die drei dupliziert gepflegten Feature-Aufzählungen (cli/features.ts, mcp/registry.ts,
// studio/runtime.ts) durch eine Registry von FeatureProvidern. defaultCatalog() registriert alle
// built-in Provider; yamlProvider() baut on demand einen Provider aus einer feature.yaml.

import { createRuntime, loadFeaturePackFromFile } from "@elio/sdk";
import type { FeatureProvider } from "./provider";
import { modelOptsFrom } from "./provider";
import { draftUntilGoodProvider, helloProvider, localAgentProvider, retryThenPassProvider } from "./providers/demo";
import { migrateProvider } from "./providers/migrate";
import { skillBuilderProvider } from "./providers/skill-builder";
import { discoverProvider, eventLogProvider, sessionSummaryProvider } from "./providers/process-mining";

export class FeatureCatalog {
  private readonly providers = new Map<string, FeatureProvider>();

  constructor(seed: readonly FeatureProvider[] = []) {
    for (const p of seed) this.register(p);
  }

  /** Registriert einen Provider unter seiner id (überschreibt). */
  register(provider: FeatureProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): FeatureProvider | undefined {
    return this.providers.get(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** Alle registrierten Provider (für listFeatures). */
  all(): FeatureProvider[] {
    return [...this.providers.values()];
  }

  /** Alle bekannten Feature-ids. */
  ids(): string[] {
    return [...this.providers.keys()];
  }
}

/**
 * Der Standard-Katalog: alle built-in Feature-Provider. EINE Quelle der Wahrheit — vorher dreifach
 * (hello + demo×2 + local-agent + migrate + build-skill + pm×3). Provider werden lazy gebaut (Pack-Laden erst beim
 * Factory-Aufruf), aber der Katalog selbst materialisiert sie einmal beim Bau.
 */
export function defaultCatalog(): FeatureCatalog {
  return new FeatureCatalog([
    helloProvider(),
    draftUntilGoodProvider(),
    retryThenPassProvider(),
    localAgentProvider(),
    migrateProvider(),
    skillBuilderProvider(),
    eventLogProvider(),
    sessionSummaryProvider(),
    discoverProvider(),
  ]);
}

/**
 * Baut on demand einen FeatureProvider aus einer feature.yaml. Reine YAML-Features nutzen i.d.R. nur
 * built-in Node-Typen (transform/validate/approval/…) — Custom-Nodes registriert ihr Pack-Autor separat.
 * Modelle/Governance kommen über den FeatureSetupContext vom EngineService (der die Profile auflöst +
 * die Root-Policy baut) — NICHT mehr aus dem Client (§1.2).
 */
export function yamlProvider(path: string): FeatureProvider {
  const pack = loadFeaturePackFromFile(path);
  return {
    id: pack.metadata.id,
    pack,
    capabilities: { model: true, db: false, fs: "none", traces: false, ephemeralStore: false },
    setup: (ctx) => {
      const runtime = createRuntime({
        ...(ctx.store !== undefined ? { store: ctx.store } : {}),
        ...modelOptsFrom(ctx),
        ...(ctx.rootPolicy !== undefined ? { rootPolicy: ctx.rootPolicy } : {}),
      });
      return { runtime, pack };
    },
  };
}
