// ───────────────────────────── @elio/migrate — echter Provider statt mock (Vertical-Retrofit) ─────────────────────────────
// Beweist: setupMigrate({ models }) verdrahtet eine ECHTE Provider-Map (hier ein OllamaModel mit injiziertem
// fetchImpl — kein echtes Netz) unter ihrem echten Profil-Key. Der Mapping-Agent läuft damit NICHT auf der
// mock-id, sondern auf "ollama:llama3"; der Worker reicht dem Adapter NUR den reinen Modellnamen ("llama3",
// nie "ollama:llama3"). Der Lauf erreicht das blocking Commit-Approval und committet auf Approve (gate=passed).

import { describe, it, expect } from "vitest";
import { collectEvents, OllamaModel } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { setupMigrate } from "./setup";

const SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
`;

function suspendStep(events: RunEvent[]): CorrelationId | undefined {
  const s = events.find((e) => e.type === "node-suspended");
  return s && s.type === "node-suspended" ? s.correlation : undefined;
}

describe("migrate.csv-to-db — runs on a REAL (non-mock) provider profile", () => {
  it("routes the mapping agent through OllamaModel and reaches gate=passed", async () => {
    // Fängt den an den Adapter gereichten Modellnamen + die request-bodies ab. Liefert eine valide
    // Mapping-JSON + DONE, sodass der Agent auf DIESER Ausgabe konvergiert (nicht dem DEFAULT_MAPPING).
    const seenModels: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { model?: string };
      if (typeof body.model === "string") seenModels.push(body.model);
      const content = 'Mapping: { "fields": { "name": "full_name", "email": "email_addr" } } DONE';
      return new Response(JSON.stringify({ message: { content } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const ollama = new OllamaModel({ fetchImpl });

    // ECHTE Provider-Map unter dem Profil-Key "ollama"; Default-Spec kanonisch "ollama:llama3";
    // Policy-Freigabe per Wildcard "ollama:*".
    const { runtime, pack, target } = setupMigrate({
      source: { content: SAMPLE_CSV },
      models: { ollama },
      defaultModel: "ollama:llama3",
      allowedModels: ["ollama:*"],
    });

    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));

    // Der Mapping-Agent lief (intelligence node) auf dem echten Provider.
    expect(ev1.some((e) => e.type === "step-started" && e.nodeType === "agent")).toBe(true);
    // Der Adapter sah den REINEN Modellnamen "llama3" — NIE die kanonische Spec "ollama:llama3".
    expect(seenModels.length).toBeGreaterThan(0);
    expect(seenModels.every((m) => m === "llama3")).toBe(true);
    expect(seenModels).not.toContain("ollama:llama3");
    expect(seenModels).not.toContain("mock");

    // Lauf suspendiert am blocking Commit-Approval — noch NICHTS committet.
    const corr = suspendStep(ev1);
    expect(corr?.step).toBe("commit");
    expect(target.rows()).toHaveLength(0);

    // Approve -> commit -> gate "sample_passes" passed; beide Records gemappt im Ziel.
    const ev2 = await collectEvents(runtime.resume(corr as CorrelationId, { approved: true }));
    const completed = ev2.find((e) => e.type === "run-completed");
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("passed");
    expect(target.rows().map((r) => String(r["id"])).sort()).toEqual(["u1", "u2"]);
    const byId = new Map(target.rows().map((r) => [String(r["id"]), r]));
    expect(byId.get("u1")).toMatchObject({ id: "u1", name: "Ann Acker", email: "ann@example.com" });
  });
});
