// ───────────────────────────── Demo-Test: hello (der Aha-Case, offline & deterministisch) ─────────────────────────────
// Beweist den Kern-Mehrwert (Inv. 1): der Outer Loop treibt einen Gruß hoch, behebt die Qualitätsmängel
// EINEN NACH DEM ANDEREN und beendet sich am Eval-Gate — nicht, wenn Steps "durch" sind. Rein, offline,
// kein Modell/Netz.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "@elio/core";
import { collectEvents } from "../runtime";
import { createDemoRuntime } from "./retry-then-pass";
import { greetingFailures, helloPack, polishGreeting } from "./hello";

describe("demo.hello — pure polish/gate logic", () => {
  it("polishGreeting fixes exactly one issue per call, converging to 'Hello world!'", () => {
    const a = polishGreeting(""); // 1) raw draft
    const b = polishGreeting(a); // 2) capitalize
    const c = polishGreeting(b); // 3) closing punctuation
    expect(a).toBe("hello world");
    expect(b).toBe("Hello world");
    expect(c).toBe("Hello world!");
    expect(polishGreeting(c)).toBe("Hello world!"); // already good -> stable (idempotent)
  });

  it("greetingFailures lists ALL open issues, then reports none once ready", () => {
    expect(greetingFailures("")).toEqual(["Gruß ist leer"]);
    // lowercase + no punctuation -> both issues surface at once (the loop then fixes them one per pass).
    expect(greetingFailures("hello world")).toEqual([
      "Gruß ist nicht großgeschrieben",
      "Gruß hat kein Satzzeichen am Ende (! . ?)",
    ]);
    expect(greetingFailures("Hello world")).toEqual(["Gruß hat kein Satzzeichen am Ende (! . ?)"]);
    expect(greetingFailures("Hello world!")).toEqual([]);
  });
});

describe("demo.hello — end-to-end through the runtime (Outer Loop converges to the gate)", () => {
  it("loops until the greeting passes review, then completes with gate=passed", async () => {
    const rt = createDemoRuntime();
    const events: RunEvent[] = await collectEvents(
      rt.run(helloPack, { payload: {}, budget: 100, maxDepth: 10 }),
    );

    // Exactly three polish iterations: raw -> capitalize -> punctuation.
    const polishSteps = events.filter((e) => e.type === "step-started" && e.nodeType === "polish-greeting");
    expect(polishSteps.length).toBe(3);

    // Terminates at the gate (not by running out of a step list), successfully.
    const end = events[events.length - 1];
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("passed");

    // The finished artifact holds the polished greeting.
    const runId = events.find((e) => e.type === "run-started")?.correlation.run ?? "";
    const artifact = rt.store.getTape(runId).filter((f) => f.nodeType === "polish-greeting").at(-1);
    expect(artifact?.result.status).toBe("resolved");
    if (artifact?.result.status === "resolved") {
      expect((artifact.result.output as { greeting?: string }).greeting).toBe("Hello world!");
    }
  });
});
