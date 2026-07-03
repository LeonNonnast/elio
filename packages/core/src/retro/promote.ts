// ───────────────────────────── retro.promote-candidate — die menschlich gegatete Mutation (Doc §4) ─────────────────────────────
// Das Feature, das den Loop schließt: ein Operator startet es mit einem Kandidaten als Payload; eine
// approval-Node hält an (blocking) bis ein Mensch zustimmt; erst dann schreibt promote-apply die neue
// Feature-Version. DENY → der Edge-Guard greift nicht → kein apply → run stopped (safe-by-default).
//
// Der Kandidat reist im RunInput.payload und ist via {{state.input}} lesbar (Runner legt payload dort ab).
// Voraussetzungen am Lauf: eine Root-Policy, die "featurestore:write" + "traces:read" gewährt, ein
// verdrahteter featureStore (mit dem Ziel-Pack) und Tape-Zugriff (für Shadow-Eval).

import type { FeaturePack } from "../feature";

export const promoteCandidatePack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "retro.promote-candidate", version: "0.1.0", owner: "retro" },
  contentHash: "retro.promote-candidate@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "promotion-result", evalGate: "promote-complete" },
    io: { input: {}, output: {} },
    graph: {
      steps: [
        {
          id: "approve",
          type: "approval",
          suspend: "blocking",
          with: { reason: "Promote candidate? (schreibt Graph-Rewrite + neue Feature-Version)" },
        },
        {
          id: "apply",
          type: "promote-apply",
          with: { candidate: "{{state.input}}" },
        },
      ],
      // Deny-safe (Roadmap §3): apply läuft NUR, wenn die Approval-Antwort approved==true ist.
      edges: [{ from: "approve", to: "apply", when: "state.answer.approved == true" }],
    },
  },
};
