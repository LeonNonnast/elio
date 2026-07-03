import { InMemoryRunStore } from "@elio/core";
import { collectEvents } from "@elio/sdk";
import { describe, expect, it } from "vitest";
import { defaultCatalog } from "./catalog";

describe("FeatureCatalog (Phase 1 — EIN Katalog statt drei)", () => {
  it("kennt alle built-in Feature-ids", () => {
    const ids = defaultCatalog().ids();
    expect(ids).toEqual(
      expect.arrayContaining([
        "demo.draft-until-good",
        "demo.retry-then-pass",
        "demo.local-agent",
        "migrate.csv-to-db",
        "build-skill",
        "pm.event-log",
        "pm.session-summary",
        "pm.discover",
      ]),
    );
  });

  it("jeder Provider hat ein statisch bekanntes Pack mit passender id + Capabilities", () => {
    for (const p of defaultCatalog().all()) {
      expect(p.pack.metadata.id).toBe(p.id);
      expect(typeof p.capabilities.model).toBe("boolean");
      expect(["read", "write", "none"]).toContain(p.capabilities.fs);
    }
  });

  it("ein Provider baut über setup() eine lauffähige Runtime auf dem GETEILTEN Store", async () => {
    // Der geteilte Store ist der Kern des Engine-Modells: alle Features schreiben in EINEN Store,
    // sodass liveStatus/tape/subscribe später alle Runs sehen (Cross-Feature-Sicht).
    const store = new InMemoryRunStore();
    const provider = defaultCatalog().get("demo.draft-until-good");
    expect(provider).toBeDefined();
    const { runtime, pack } = provider!.setup({ store });

    const events = await collectEvents(runtime.run(pack, { payload: {}, budget: 100, maxDepth: 5 }));
    const end = events.at(-1);
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("passed");

    // Der geteilte Store hat den Run gesehen (nicht der provider-interne Default-Store).
    const status = await store.liveStatus();
    expect(status.length).toBeGreaterThan(0);
  });

  it("der migrate-Provider wrappt die Fassade (liefert pack + handles statt Hand-Wiring)", () => {
    const store = new InMemoryRunStore();
    const result = defaultCatalog().get("migrate.csv-to-db")!.setup({ store });
    expect(result.pack.metadata.id).toBe("migrate.csv-to-db");
    expect(result.handles?.["source"]).toBeDefined();
    expect(result.handles?.["target"]).toBeDefined();
  });
});
