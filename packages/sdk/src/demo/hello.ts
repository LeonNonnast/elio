// ───────────────────────────── Demo: hello (der "Aha"-Case) ─────────────────────────────
// Der einfachste mögliche Beweis, WAS ELIO bringt (Inv. 1): du gibst ein Ziel (ein Gruß) und eine
// Qualitäts-Prüfung (das Eval-Gate) — die Outer-Loop-Engine treibt einen Entwurf hoch, behebt die
// Mängel EINEN NACH DEM ANDEREN und stoppt von selbst, sobald alle Checks bestehen. Kein "Steps
// abgearbeitet", sondern "Ergebnis gut genug".
//
// Deterministisch + offline (kein Modell, kein Netz), damit der allererste `elio run demo.hello` bei
// JEDEM sofort läuft. Der `polish`-Step ist bewusst eine gewöhnliche Node — tausch ihn gegen einen
// `llm`/`agent`-Node (echtes Modell) oder häng ein `approval` an: dieselbe Schleife, dieselbe Governance.
//
// Was man im RunEvent-Stream SIEHT: der Gruß verbessert sich pro Iteration ("hello world" ->
// "Hello world" -> "Hello world!"), das Gate meldet zuerst offene Mängel und dann gate=passed.

import type { FeaturePack, GateVerdict, NodeDefinition, Resolved } from "@elio/core";
import type { Runtime } from "../runtime";

/**
 * Ein Verbesserungs-Schritt Richtung "fertiger Gruß": behebt pro Aufruf GENAU einen Mangel, damit die
 * Konvergenz im Loop sichtbar wird. Leer -> Rohentwurf; klein geschrieben -> großschreiben; ohne
 * Satzzeichen -> "!" anhängen. Rein, deterministisch (Inv. 5).
 */
export function polishGreeting(current: string): string {
  const t = current.trim();
  if (t.length === 0) return "hello world"; // 1) Rohentwurf
  if (t[0] !== t[0]!.toUpperCase()) return t[0]!.toUpperCase() + t.slice(1); // 2) großschreiben
  if (!/[!.?]$/.test(t)) return `${t}!`; // 3) Satzzeichen
  return t; // schon gut
}

/** Die Qualitäts-Checkliste (menschenlesbar), die das Gate prüft. */
export function greetingFailures(greeting: string): string[] {
  const t = greeting.trim();
  const failures: string[] = [];
  if (t.length === 0) {
    failures.push("Gruß ist leer");
    return failures;
  }
  if (t[0] !== t[0]!.toUpperCase()) failures.push("Gruß ist nicht großgeschrieben");
  if (!/[!.?]$/.test(t)) failures.push("Gruß hat kein Satzzeichen am Ende (! . ?)");
  return failures;
}

/** Node "polish-greeting": liest den aktuellen Gruß (aus `with.current`, template-aufgelöst) und verbessert ihn. */
export const polishGreetingNode: NodeDefinition<{ current?: string }, { greeting: string }> = {
  type: "polish-greeting",
  klass: "orchestration",
  handler: (input) => {
    const current = typeof input?.current === "string" ? input.current : "";
    const res: Resolved<{ greeting: string }> = {
      status: "resolved",
      output: { greeting: polishGreeting(current) },
      confidence: 1,
      // nominelles Budget-Dekrement pro Outer-Iteration (Inv. 21) — macht die Schleife im Cost-Stream sichtbar.
      cost: { usd: 0.2 },
    };
    return Promise.resolve(res);
  },
};

/**
 * Eval-Gate "greeting-ready": besteht, sobald der Gruß nicht-leer, großgeschrieben und mit Satzzeichen
 * endet. Liefert die offenen Mängel als menschenlesbare `failures` — genau das macht den Loop-Fortschritt
 * im Stream ablesbar.
 */
export const greetingReadyGate: NodeDefinition<{ artifact?: { content?: unknown } }, GateVerdict> = {
  type: "greeting-ready",
  klass: "orchestration",
  handler: (input) => {
    const content = input?.artifact?.content as Record<string, unknown> | undefined;
    const greeting = typeof content?.["greeting"] === "string" ? (content["greeting"] as string) : "";
    const failures = greetingFailures(greeting);
    const passed = failures.length === 0;
    const verdict: GateVerdict = {
      passed,
      score: passed ? 1 : Math.max(0, 1 - failures.length / 3),
      failures,
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

/**
 * FeaturePack `demo.hello`: ein einziger `polish`-Step mit Self-Edge treibt den Outer Loop; das
 * greeting-ready-Gate beendet ihn, sobald der Gruß fertig ist ("Hello world!"). autonomy "static".
 */
export const helloPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "demo.hello", version: "0.1.0", owner: "demo" },
  contentHash: "demo.hello@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "note", evalGate: "greeting-ready" },
    io: { input: {}, output: {} },
    graph: {
      state: { greeting: "" },
      steps: [
        {
          id: "polish",
          type: "polish-greeting",
          // reicht den aktuellen Stand rein; die Node gibt den nächsten (besseren) zurück.
          with: { current: "{{state.greeting}}" },
          // Ergebnis zurück in den Branch-State -> nächste Iteration liest den neuen Gruß.
          outputs: { greeting: "state.greeting" },
        },
      ],
      // Self-Edge: nach jedem polish erneut polish (Outer Loop), bis das Gate exit-et.
      edges: [{ from: "polish", to: "polish" }],
    },
  },
};

/** Registriert polish-greeting + greeting-ready an einer Runtime und gibt den Pack zurück. */
export function setupHello(runtime: Runtime): FeaturePack {
  if (!runtime.registry.has("polish-greeting")) {
    runtime.registry.register(polishGreetingNode as unknown as NodeDefinition);
  }
  if (!runtime.registry.has("greeting-ready")) {
    runtime.registry.register(greetingReadyGate as unknown as NodeDefinition);
  }
  return helloPack;
}
