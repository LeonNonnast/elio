// ───────────────────────────── FeatureRegistry: Sub-Features per id auflösen (§3, feature-ref) ─────────────────────────────
// Ein einfacher Katalog von FeaturePacks, den der OuterLoopRunner als FeatureResolver durchreicht, damit
// die feature-ref-Node Sub-Features per id als Kind-Branches fahren kann (registry-driven fan-out). Built-in
// == custom (Inv. 6): ein registriertes Sub-Feature ist ein gewöhnliches Pack.

import type { FeaturePack } from "./feature";
import type { FeatureResolver } from "./branch";

export class FeatureRegistry implements FeatureResolver {
  private readonly packs = new Map<string, FeaturePack>();

  constructor(seed: readonly FeaturePack[] = []) {
    for (const p of seed) this.register(p);
  }

  /** Registriert ein Pack unter seiner metadata.id (überschreibt). */
  register(pack: FeaturePack): void {
    this.packs.set(pack.metadata.id, pack);
  }

  resolve(id: string): FeaturePack | undefined {
    return this.packs.get(id);
  }

  has(id: string): boolean {
    return this.packs.has(id);
  }

  /** Alle registrierten Feature-ids (z.B. für eine Fan-out-Auswahl). */
  list(): string[] {
    return [...this.packs.keys()];
  }
}
