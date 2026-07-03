// ───────────────────────────── FeatureStore: schreibender Feature-Katalog (Inv. 13/14) ─────────────────────────────
// ctx.featureStore ist die EINZIGE mutierende Capability der Learning-Engine: promote-candidate schreibt
// hierüber eine neue Pack-Version (v_{n+1}, Graph-Rewrite mit Memo+Fallback). Gegated wie traces/secrets
// (security by absence, Inv. 14): die Capability reitet auf den toolPermissions ("featurestore:write"),
// der Injector injiziert ctx.featureStore nur bei mindestens einem erlaubten Scope UND verdrahtetem Store.

import type { FeaturePack } from "./feature";
import type { FeatureStoreService } from "./ctx";

const FEATURESTORE_TOOL_PREFIX = "featurestore:";

/**
 * Leitet die erlaubten featurestore-Scopes aus den resolvten toolPermissions ab (analog
 * `allowedTraceScopes`/`allowedSecretNames`). Ein Node fordert `tools: ["featurestore:write"]`; die Policy
 * entscheidet per Mengen-Schnitt (tighten-only), welche Scopes überleben.
 */
export function allowedFeatureStoreScopes(toolPermissions: readonly string[]): string[] {
  const scopes: string[] = [];
  for (const t of toolPermissions) {
    if (t.startsWith(FEATURESTORE_TOOL_PREFIX)) {
      const scope = t.slice(FEATURESTORE_TOOL_PREFIX.length);
      if (scope.length > 0) scopes.push(scope);
    }
  }
  return scopes;
}

/**
 * In-Memory Feature-Katalog: pro Pack-id eine versionierte Liste (Einfügereihenfolge). `get` liefert die
 * neueste Version; `put` ist Upsert auf `metadata.version`. Persistente Kataloge docken am selben
 * Interface an (analog InMemoryRunStore). Mit `seed` lassen sich Ausgangs-Packs vorab einlegen.
 */
export class InMemoryFeatureStore implements FeatureStoreService {
  private readonly byId = new Map<string, FeaturePack[]>();

  constructor(seed: readonly FeaturePack[] = []) {
    for (const pack of seed) this.upsert(pack);
  }

  private upsert(pack: FeaturePack): void {
    const list = this.byId.get(pack.metadata.id);
    if (list === undefined) {
      this.byId.set(pack.metadata.id, [pack]);
      return;
    }
    const i = list.findIndex((p) => p.metadata.version === pack.metadata.version);
    if (i >= 0) list[i] = pack;
    else list.push(pack);
  }

  get(id: string): Promise<FeaturePack | null> {
    const list = this.byId.get(id);
    if (list === undefined || list.length === 0) return Promise.resolve(null);
    return Promise.resolve(list[list.length - 1] as FeaturePack);
  }

  put(pack: FeaturePack): Promise<void> {
    this.upsert(pack);
    return Promise.resolve();
  }

  versions(id: string): Promise<string[]> {
    return Promise.resolve((this.byId.get(id) ?? []).map((p) => p.metadata.version));
  }
}
