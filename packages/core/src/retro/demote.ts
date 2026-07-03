// ───────────────────────────── retro.demote-candidate — die Umkehrung (Punkt 5) ─────────────────────────────
// Spiegelbild zu promote: ein Operator startet es mit { feature, step } als Payload; eine approval-Node
// hält an (blocking) bis ein Mensch zustimmt; erst dann entfernt demote-apply das Memo (applyDemotion) und
// schreibt die neue Version. DENY → kein apply → run stopped (safe-by-default). Genutzt, wenn der
// drift-monitor eine veraltete Memo-Domäne flaggt.

import type { FeaturePack } from "../feature";

export const demoteCandidatePack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "retro.demote-candidate", version: "0.1.0", owner: "retro" },
  contentHash: "retro.demote-candidate@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "demotion-result", evalGate: "demote-complete" },
    io: { input: {}, output: {} },
    graph: {
      steps: [
        {
          id: "approve",
          type: "approval",
          suspend: "blocking",
          with: { reason: "Demote? (entfernt das Memo, fällt auf das LLM zurück)" },
        },
        {
          id: "apply",
          type: "demote-apply",
          with: { feature: "{{state.input.feature}}", step: "{{state.input.step}}" },
        },
      ],
      edges: [{ from: "approve", to: "apply", when: "state.answer.approved == true" }],
    },
  },
};
