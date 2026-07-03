// ───────────────────────────── Policy-Registry: Policies per id auflösen (Inv. 13, §4 Schritt 2) ─────────────────────────────
// Spiegel der NodeRegistry (built-in == custom): eine Policy wird per id registriert und vom Runner
// aus pack.feature.policies aufgelöst. resolvePolicies(ids, registry) faltet die deklarierten
// Policies zu einer geordneten Liste — der Runner faltet sie via applyPolicy/enforceTightenOnly
// über den Root (tighten-only, Inv. 13). Eine fehlende id wirft: ein Feature darf nie ungoverned
// laufen (FeatureDefinition.policies-Contract).

import type { Policy } from "./policy";

export class PolicyRegistry {
  private readonly policies = new Map<string, Policy>();

  /** Registriert eine Policy unter ihrer `id`. Überschreibt eine vorhandene id. */
  register(policy: Policy): void {
    this.policies.set(policy.id, policy);
  }

  /** Löst eine Policy per id auf; wirft, wenn die id nicht registriert ist (§4 Schritt 2). */
  resolve(id: string): Policy {
    const p = this.policies.get(id);
    if (p === undefined) {
      throw new Error(
        `PolicyRegistry: keine Policy "${id}" registriert. Bekannt: [${this.list().join(", ")}]`,
      );
    }
    return p;
  }

  has(id: string): boolean {
    return this.policies.has(id);
  }

  /** Alle registrierten Policy-ids. */
  list(): string[] {
    return [...this.policies.keys()];
  }
}

/**
 * Löst eine Liste von Policy-ids gegen die Registry auf (Reihenfolge = Faltungsreihenfolge:
 * inner->outer, wie sie deklariert sind). Eine fehlende id wirft (§4 Schritt 2).
 */
export function resolvePolicies(ids: string[], registry: PolicyRegistry): Policy[] {
  return ids.map((id) => registry.resolve(id));
}
