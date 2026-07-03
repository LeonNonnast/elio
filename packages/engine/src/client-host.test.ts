// ───────────────────────────── EngineHost ↔ EngineClient Round-Trip (Phase 4) ─────────────────────────────
// Startet einen EngineHost über einem LocalEngine auf einem ephemeren Port und treibt ihn über einen
// EngineClient (echtes HTTP/SSE, global fetch). Beweist: dieselbe EngineService-Oberfläche funktioniert
// remote — start/resume streamen, liveStatus/tape/getArtifact/subscribe lesen über die Wire.

import type { AddressInfo } from "node:net";
import { collectEvents } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { afterEach, describe, expect, it } from "vitest";
import { LocalEngine } from "./engine";
import { createEngineHost } from "./host";
import type { EngineHost } from "./host";
import { EngineClient } from "./client";

const RUN_INPUT = { payload: {}, budget: 1000, maxDepth: 200 };

let host: EngineHost | undefined;
afterEach(async () => {
  if (host !== undefined) {
    await host.closeHost();
    host = undefined;
  }
});

async function startHost(): Promise<{ client: EngineClient; engine: LocalEngine }> {
  const engine = new LocalEngine();
  host = createEngineHost({ engine });
  const port = await new Promise<number>((resolve) => {
    host!.listen(0, () => resolve((host!.address() as AddressInfo).port));
  });
  return { client: new EngineClient({ baseUrl: `http://127.0.0.1:${port}` }), engine };
}

describe("EngineHost ↔ EngineClient (remote EngineService)", () => {
  it("listFeatures() comes across the wire with projected graph + capabilities", async () => {
    const { client } = await startHost();
    const features = await client.listFeatures();
    const ids = features.map((f) => f.id);
    expect(ids).toContain("demo.draft-until-good");
    expect(ids).toContain("migrate.csv-to-db");
    const migrate = features.find((f) => f.id === "migrate.csv-to-db")!;
    expect(migrate.capabilities.db).toBe(true);
    expect(migrate.graph?.steps.some((s) => s.id === "commit")).toBe(true);
  });

  it("startRun() streams RunEvents over SSE to run-completed{passed}", async () => {
    const { client } = await startHost();
    const events = await collectEvents(client.startRun("demo.draft-until-good", RUN_INPUT));
    const end = events.at(-1);
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("passed");
  });

  it("a run started via the client is visible in liveStatus()/tape over the wire", async () => {
    const { client } = await startHost();
    const events = await collectEvents(client.startRun("demo.draft-until-good", RUN_INPUT));
    const runId = events[0]?.correlation.run as string;

    const status = await client.liveStatus();
    expect(status.some((s) => s.correlation.run === runId)).toBe(true);

    const frames = [];
    for await (const f of client.tape(runId)) frames.push(f);
    expect(frames.length).toBeGreaterThan(0);
  });

  it("suspend→resume works remotely: migrate suspends, resumeRun drives it to passed + artifact", async () => {
    const { client } = await startHost();
    const ev1 = await collectEvents(client.startRun("migrate.csv-to-db", RUN_INPUT));
    const suspended = ev1.find((e) => e.type === "node-suspended") as
      | Extract<RunEvent, { type: "node-suspended" }>
      | undefined;
    expect(suspended).toBeDefined();
    const correlation = suspended!.correlation as CorrelationId;

    const ev2 = await collectEvents(client.resumeRun(correlation, { approved: true }));
    const end = ev2.at(-1);
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("passed");

    // getArtifact crosses the wire (the run's final artifact lives in the host's engine).
    const artifact = await client.getArtifact(correlation.run);
    expect(artifact).toBeDefined();
  });

  it("startRun() with an unknown feature surfaces the host error over the stream", async () => {
    const { client } = await startHost();
    await expect(collectEvents(client.startRun("does.not.exist", RUN_INPUT))).rejects.toThrow(
      /Unbekanntes Feature/,
    );
  });

  it("subscribe() delivers live events to a remote subscriber while a run is driven", async () => {
    const { client, engine } = await startHost();
    // Subscribe via the client (SSE), then drive a run on the host's engine. migrate suspends at the
    // commit approval -> events are published AND the run stays alive, so the remote subscriber reliably
    // observes at least the run-started frame over the wire.
    const sub = client.subscribe()[Symbol.asyncIterator]();
    // next() FIRST -> startet die HTTP-Anfrage -> Host registriert die Subscription. Erst DANN den Run
    // treiben, sonst publiziert er, bevor der Remote-Subscriber existiert (Live-Stream = keine Historie).
    const firstP = sub.next();
    await new Promise((r) => setTimeout(r, 200));
    const driven = collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));

    const first = await firstP;
    expect(first.done).toBe(false);
    expect((first.value as RunEvent).type).toBeDefined();
    void sub.return?.(undefined);
    await driven;
  }, 15_000);
});
