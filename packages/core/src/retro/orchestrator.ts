// ───────────────────────────── retro.orchestrator — der lauffähige Retro-Loop (Doc §3/§9.5) ─────────────────────────────
// Ein FeaturePack, das die Miner-Suite über `ctx.traces` fährt und die Kandidaten ins durable Artefakt
// (kind "promotion-candidate-set") aggregiert. EIN-SCHUSS + read-only: kein Konvergenz-Loop, kein
// featureStore:write. Lauffähig über den OuterLoopRunner — der Einstiegspunkt der Learning-Engine.
//
// v0.1-Form: ein `retro-miner`-Step fährt die GANZE Suite (determinism + flaky-retry) in EINER Node. Die
// echte Registry-getriebene Fan-out-Form (ein subworkflow PRO Retro-Feature, Doc §3) braucht den
// feature-ref-subworkflow (v0.2) — bis dahin orchestriert die Node die Miner-Suite. Der Graph bleibt
// dadurch erweiterbar: ein weiterer Miner = ein Listeneintrag in `with.miners` (bzw. später ein Step).
//
// Damit `ctx.traces` injiziert wird (security by absence, Inv. 14), MUSS die Root-Policy des Laufs
// "traces:read" gewähren (Runner-`rootPolicy`-Override bzw. eine Policy im PolicyRegistry). Ohne Grant
// failt der mine-Step klar — der Orchestrator liest sonst nichts.

import type { FeaturePack } from "../feature";

export const retroOrchestratorPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "retro.orchestrator", version: "0.1.0", owner: "retro" },
  contentHash: "retro.orchestrator@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "promotion-candidate-set", evalGate: "retro-complete" },
    io: { input: {}, output: {} },
    graph: {
      // Kein state/outputs-Mapping: der Eval-Gate (retro-complete) liest die Kandidaten aus dem Artefakt-
      // `content`, in das der Runner den rohen Node-Output via applyTo flach faltet (Review-Befund C). Ein
      // state-Mapping wird erst relevant, wenn v0.2 mehrere Miner-Steps über `prior` akkumulieren.
      steps: [
        {
          id: "mine",
          type: "retro-miner",
          // kein `with.miners` → die volle registrierte Miner-Suite (Default ALL_MINERS); neue Miner
          // wirken automatisch mit, ohne den Pack zu ändern.
        },
      ],
      edges: [],
    },
  },
};
