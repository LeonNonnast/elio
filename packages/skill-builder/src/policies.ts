// ───────────────────────────── Skill-Builder-Policies (Inv. 13, tighten-only) ─────────────────────────────
// Das build-skill-Feature deklariert `skill_write_requires_approval`. Ein Feature darf nie ungoverned
// laufen — der Runner verlangt, dass jede deklarierte Policy-id in der PolicyRegistry aufgelöst werden
// kann (§4 Schritt 2). registerSkillBuilderPolicies() registriert sie.
//
// skill_write_requires_approval: VERSCHÄRFT den Suspend-Modus auf "blocking" (mehr Oversight = tighter,
// §11/#15) — das approve_write-Gate vor dem irreversiblen Disk-Write kann so nie zu einem nicht-haltenden
// Modus gelockert werden. Die übrigen Achsen (fsPaths/allowedModels/…) reicht sie unverändert durch;
// enforceTightenOnly (Runner) stellt sicher, dass das Ergebnis nie loosere Werte als der Parent trägt.

import type { Policy, ResolvedPolicy } from "@elio/core";
import type { Runtime } from "@elio/sdk";

/** Policy-id, die das Feature-Pack deklariert. */
export const SKILL_WRITE_REQUIRES_APPROVAL = "skill_write_requires_approval";

/** Die tighten-only Policy: hebt suspendMode auf "blocking" (engstes Gate), sonst unverändert. */
export const skillWriteRequiresApprovalPolicy: Policy = {
  id: SKILL_WRITE_REQUIRES_APPROVAL,
  scope: (_req, parent): ResolvedPolicy => ({
    ...parent,
    suspendMode: "blocking",
  }),
};

/** Registriert die Skill-Builder-Policies an der Runtime-PolicyRegistry (idempotent). */
export function registerSkillBuilderPolicies(runtime: Runtime): void {
  if (!runtime.policyRegistry.has(SKILL_WRITE_REQUIRES_APPROVAL)) {
    runtime.policyRegistry.register(skillWriteRequiresApprovalPolicy);
  }
}
