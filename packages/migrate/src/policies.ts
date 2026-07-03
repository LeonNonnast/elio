// ───────────────────────────── Migrate-Policies (Inv. 13, tighten-only) ─────────────────────────────
// Das migrate.csv-to-db-Feature deklariert `commit_requires_approval`. Ein Feature darf nie ungoverned
// laufen — der Runner verlangt, dass jede deklarierte Policy-id in der PolicyRegistry aufgelöst werden
// kann (§4 Schritt 2). registerMigratePolicies() registriert sie.
//
// commit_requires_approval: VERSCHÄRFT den Suspend-Modus auf "blocking" (mehr Oversight = tighter,
// §11/#15) — ein Commit-Gate kann so nie zu einem nicht-haltenden Modus gelockert werden. Sie reicht
// die übrigen Achsen (allowedModels/dbScopes/…) unverändert durch; enforceTightenOnly (Runner) stellt
// sicher, dass das Ergebnis nie loosere Werte als der Parent trägt (tighten-only, Inv. 13).

import type { Policy, ResolvedPolicy } from "@elio/core";
import type { Runtime } from "@elio/sdk";

/** Policy-id, die das Feature-Pack deklariert. */
export const COMMIT_REQUIRES_APPROVAL = "commit_requires_approval";

/** Die tighten-only Policy: hebt suspendMode auf "blocking" (engstes Gate), sonst unverändert. */
export const commitRequiresApprovalPolicy: Policy = {
  id: COMMIT_REQUIRES_APPROVAL,
  scope: (_req, parent): ResolvedPolicy => ({
    ...parent,
    suspendMode: "blocking",
  }),
};

/** Registriert die Migrate-Policies an der Runtime-PolicyRegistry (idempotent). */
export function registerMigratePolicies(runtime: Runtime): void {
  if (!runtime.policyRegistry.has(COMMIT_REQUIRES_APPROVAL)) {
    runtime.policyRegistry.register(commitRequiresApprovalPolicy);
  }
}
