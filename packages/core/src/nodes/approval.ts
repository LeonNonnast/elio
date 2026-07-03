// ───────────────────────────── Built-in: approval (Inv. 6/7/11/12, klass "orchestration") ─────────────────────────────
// Approval = ein Spezialfall der universellen Elicitation (Inv. 11): "Freigabe nötig" ist dasselbe
// Primitiv wie fehlender Input oder Eskalation. Die Node raised via ctx.elicit.raise(...) ein
// Suspended-Result; der Runner propagiert es hoch (Policy-Interceptor -> Parent-State -> Mensch, §6).
//
// Der Suspend-Mode kommt aus stepRef.suspend (vom Runner als input.mode durchgereicht, Default
// "blocking" — das engste/sicherste für ein Approval-Gate). tighten-only (Inv. 13): eine Policy
// kann ein vorgeschlagenes "blocking" niemals zu "optional" lockern; das setzt der ElicitService
// bzw. der Injector via resolved.suspendMode durch.

import type { Node, NodeDefinition } from "../node";
import type { SuspendMode } from "../elicitation";
import type { JsonSchema } from "../common";
import type { Answerer } from "../elicitation";

/**
 * Konfiguration einer approval-Node. Alle Felder optional — ein nacktes approval-Gate
 * raised mit sinnvollen Defaults ("approval required", whoCanAnswer operator, blocking).
 *  - reason:        was freigegeben werden soll (-> elicitation.what)
 *  - whoCanAnswer:  Rollen/User/Maschine, die antworten dürfen (-> elicitation.whoCanAnswer)
 *  - schema:        erwartete Form der Antwort (-> elicitation.schema)
 *  - mode:          vom Runner aus stepRef.suspend gespeist (Default "blocking")
 */
export interface ApprovalWith {
  reason?: string;
  whoCanAnswer?: Answerer;
  schema?: JsonSchema;
  /** Vom Runner aus stepRef.suspend durchgereicht (Default "blocking"). */
  mode?: SuspendMode;
}

/**
 * approval-Handler: raised eine Elicitation -> Suspended (Inv. 11). Nutzt ausschließlich
 * ctx.elicit (immer injiziert, §injector). Wirft, wenn ctx.elicit fehlt — ein Approval-Gate
 * OHNE Suspend-Pfad wäre ein stiller Governance-Bypass.
 */
export const approvalHandler: Node<ApprovalWith, never> = (input, ctx) => {
  const cfg = (input ?? {}) as ApprovalWith;
  if (ctx.elicit === undefined) {
    throw new Error(
      "approval node: ctx.elicit ist nicht injiziert — ein Approval-Gate ohne Suspend-Pfad ist ein Governance-Bypass.",
    );
  }
  return Promise.resolve(
    ctx.elicit.raise({
      what: cfg.reason ?? "approval required",
      whoCanAnswer: cfg.whoCanAnswer ?? { users: ["operator"] },
      // mode aus stepRef.suspend (vom Runner gespeist); Default "blocking" (engstes Gate).
      mode: cfg.mode ?? "blocking",
      ...(cfg.schema !== undefined ? { schema: cfg.schema } : {}),
    }),
  );
};

/** Registrierbare Definition der built-in approval-Node (Inv. 6 — built-in == custom). */
export const approvalNode: NodeDefinition<ApprovalWith, never> = {
  type: "approval",
  klass: "orchestration",
  handler: approvalHandler,
};
