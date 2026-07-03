// ───────────────────────────── Demo: draft-until-good (Outer-Loop-Konvergenz) ─────────────────────────────
// Zeigt den Kern-Beweis von ELIO (Inv. 1): der Loop endet nicht, wenn "Steps fertig" sind, sondern
// wenn das ARTEFAKT "gut genug" ist (Eval-Gate). Ein einzelner transform-Step "append" hängt pro
// Outer-Iteration einen fixen Chunk an den Artefakt-Inhalt; eine Self-Edge lässt ihn wiederholen.
// Das Gate "min-length" besteht, sobald content.progress >= 30 Zeichen lang ist.
//
// Demonstriert: Outer-Loop-Konvergenz + Budget-Dekrement + Gate-Exit.

import type {
  ArtifactType,
  FeaturePack,
  GateVerdict,
  NodeDefinition,
  Resolved,
} from "@elio/core";
import type { Runtime } from "../runtime";

/** Fixer Chunk, der pro Iteration angehängt wird (10 Zeichen inkl. Leerzeichen). */
export const DRAFT_CHUNK = "lorem ipsm";
/** Gate-Schwelle: ab dieser Länge ist das Artefakt "gut genug". */
export const MIN_LENGTH = 30;

/** Artefakt-Typ: text-doc mit progress.md (Stand-Scratchpad) + memory (episodic). */
export const TEXT_DOC_TYPE: ArtifactType = {
  kind: "text-doc",
  holders: ["progress.md", "memory"],
};

/**
 * Eval-Gate-Node "min-length": liest das Artefakt (über input.artifact, vom Runner als
 * { artifact, value: artifact } übergeben) und bestimmt die Länge des progress-Inhalts.
 * Liefert Resolved<GateVerdict> — als Gate gelesen vom Runner (§4 Schritt 12, kein Sonder-Primitiv).
 */
export const minLengthGate: NodeDefinition<{ artifact?: { content?: unknown } }, GateVerdict> = {
  type: "min-length",
  klass: "orchestration",
  handler: (input) => {
    const content = input?.artifact?.content as Record<string, unknown> | undefined;
    const text = typeof content?.["progress"] === "string" ? (content["progress"] as string) : "";
    const len = text.length;
    const passed = len >= MIN_LENGTH;
    const verdict: GateVerdict = {
      passed,
      score: Math.min(1, len / MIN_LENGTH),
      failures: passed ? [] : [`content length ${len} < required ${MIN_LENGTH}`],
    };
    const res: Resolved<GateVerdict> = {
      status: "resolved",
      output: verdict,
      confidence: 1,
      cost: { usd: 0 },
    };
    return Promise.resolve(res);
  },
};

/** Der programmatische FeaturePack. autonomy "static"; Self-Edge auf "append" treibt den Outer Loop. */
export const draftUntilGoodPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "demo.draft-until-good", version: "0.1.0", owner: "demo" },
  contentHash: "demo.draft-until-good@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "text-doc", evalGate: "min-length" },
    io: { input: {}, output: {} },
    graph: {
      state: { progress: "" },
      steps: [
        {
          id: "append",
          type: "transform",
          // Hängt DRAFT_CHUNK an den aktuellen progress-String (template-aufgelöst) an.
          // `cost` attribuiert pro Iteration ein nominelles Budget-Dekrement (Inv. 21).
          with: { append: DRAFT_CHUNK, to: "{{state.progress}}", as: "progress", cost: 0.5 },
          // Schreibt das Ergebnis zurück in den Branch-State -> nächste Iteration liest den neuen Stand.
          outputs: { progress: "state.progress" },
        },
      ],
      // Self-Edge: nach jedem append erneut append (Outer Loop), bis das Gate exit-et.
      edges: [{ from: "append", to: "append" }],
    },
  },
};

/**
 * Registriert das min-length-Gate + den text-doc-Artefakt-Typ an einer Runtime und gibt den Pack zurück.
 * (transform ist bereits als Built-in registriert.)
 */
export function setupDraftUntilGood(runtime: Runtime): FeaturePack {
  if (!runtime.registry.has("min-length")) {
    runtime.registry.register(minLengthGate as unknown as NodeDefinition);
  }
  return draftUntilGoodPack;
}
