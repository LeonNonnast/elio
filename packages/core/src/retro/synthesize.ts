// ───────────────────────────── retro.synthesize-script — der generative Tier-2-Schritt (Doc §4/§9.x) ─────────────────────────────
// Nimmt einen Tier-0 node-replacement-Kandidaten (deterministische Aufrufstelle) als Payload und lässt die
// synthesize-script-Node aus den ECHTEN Tape-Beispielen eine reine Funktion GENERIEREN, isoliert validieren
// (ctx.scripts) und held-out shadow-evaluieren. Bei bestandenem Gate liegt ein VALIDIERTER Tier-2-Kandidat
// im Artefakt (`content.candidate`) — den der Operator dann ins separate, approval-gegatete
// promote-candidate-Feature gibt (Doc §4: Analyse erzeugt Vorschlag, Mutation ist entkoppelt + gegated).
//
// Voraussetzungen am Lauf (security by absence, Inv. 14): eine Root-Policy, die Modelle (Codegen) +
// "traces:read" (Beispiele) + "scripts:execute" (Validierung) gewährt, ein verdrahtetes ModelService,
// ein ScriptRunner und Tape-Zugriff. Schreibt KEIN Pack (kein featurestore:write).

import type { FeaturePack } from "../feature";

export const synthesizeScriptPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "retro.synthesize-script", version: "0.1.0", owner: "retro" },
  contentHash: "retro.synthesize-script@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "tier2-synthesis", evalGate: "synthesize-complete" },
    io: { input: {}, output: {} },
    graph: {
      // Kein outputs-Mapping: der Eval-Gate (synthesize-complete) liest `synthesized`/`candidate` aus dem
      // Artefakt-`content`, in das der Runner den Node-Output via applyTo flach faltet (wie retro.orchestrator).
      steps: [{ id: "synth", type: "synthesize-script", with: { candidate: "{{state.input}}" } }],
      edges: [],
    },
  },
};
