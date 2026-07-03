// pm.event-log end-to-end (Doc §3.1/§3.4, Slice 3b): treibt den Logger-Pack über setupEventLog und belegt:
//   (1) ein Run schreibt GENAU EINE events-Zeile aus dem payload (gate passed, Quittung im Artefakt);
//   (2) idempotent: derselbe payload erneut → weiterhin genau eine Zeile (Re-Delivery dedupliziert);
//   (3) KEIN durables Tape: der Logger-Run-Store ist ephemer (leer nach dem Run, Doc §3.4);
//   (4) fail-closed: ohne capture:write-Grant wirft append → gate stopped, keine Zeile.

import { describe, expect, it } from "vitest";
import {
  InMemoryCaptureStore,
  pmEventLogPack,
  rootPolicy,
  registerEventLog,
} from "@elio/core";
import type { RunEvent } from "@elio/core";
import { collectEvents, createRuntime } from "./runtime";
import { setupEventLog } from "./setup-pm-capture";

const HOOK_EVENT = {
  session_id: "sess-1",
  seq: 0,
  tool_name: "Read",
  tool_input: { file: "/tmp/x" },
  tool_output: "ok",
  received_at: "2026-01-01T00:00:00.000Z",
};

async function drive(rt: ReturnType<typeof createRuntime>, payload: unknown): Promise<RunEvent[]> {
  return collectEvents(rt.run(pmEventLogPack, { payload, budget: 100, maxDepth: 10 }));
}

function gateOf(events: RunEvent[]): "passed" | "stopped" | undefined {
  const last = events[events.length - 1];
  return last?.type === "run-completed" ? last.gate : undefined;
}

describe("pm.event-log — the logger appends exactly one events row", () => {
  it("appends one events row from the payload and passes the event-logged gate", async () => {
    const captureStore = new InMemoryCaptureStore();
    const { runtime } = setupEventLog({ captureStore });

    const events = await drive(runtime, HOOK_EVENT);

    expect(gateOf(events)).toBe("passed");
    const rows = await captureStore.events("sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activity).toBe("Read");
    // Boundary-Redaction (Inv. 23): nur Hashes überleben, nie der rohe Input/Output.
    expect(rows[0]?.inputHash).toBeTypeOf("string");
    expect(rows[0]?.outputHash).toBeTypeOf("string");
    expect((rows[0] as unknown as { tool_input?: unknown }).tool_input).toBeUndefined();
  });

  it("is idempotent on re-run: the same payload yields still exactly one row", async () => {
    const captureStore = new InMemoryCaptureStore();
    const { runtime } = setupEventLog({ captureStore });

    await drive(runtime, HOOK_EVENT);
    await drive(runtime, HOOK_EVENT); // Re-Delivery desselben Events.

    const rows = await captureStore.events("sess-1");
    expect(rows).toHaveLength(1); // idempotenter Insert über den Inhalts-Hash (capture.ts).
  });

  it("leaves no durable run tape: the run store is ephemeral, the durable output is the events row (Doc §3.4)", async () => {
    const captureStore = new InMemoryCaptureStore();
    const { runtime } = setupEventLog({ captureStore });

    await drive(runtime, HOOK_EVENT);

    // Der durable Output ist allein die events-Zeile (CaptureStore), NICHT ein persistiertes Run-Tape.
    expect((await captureStore.sessions()).sort()).toEqual(["sess-1"]);

    // Der Run-Store ist ephemer (prozess-lokaler InMemoryRunStore, KEIN FileRunStore): ein FRISCHES Setup
    // (neuer ephemerer Store) sieht KEINEN Logger-Run eines früheren Setups — strukturell kein Self-Mining,
    // der Discoverer liest die events-Tabelle, nie das Logger-Run-Tape (Doc §3.4).
    const fresh = setupEventLog({ captureStore: new InMemoryCaptureStore() });
    expect(await fresh.runtime.store.runIds()).toEqual([]);
  });

  it("two seq-less events in the same session do not collide on slot (session,0) — both persist", async () => {
    // Production hook payloads may omit `seq` (Slice-4 glue counts it, but the degenerate path lacks it).
    // Defaulting seq→0 would make the second distinct event claim the already-taken (session,0) slot, throw
    // in CaptureStore.append, stop the gate, and silently DROP the event. The logger must instead assign a
    // monotonic per-session seq for seq-less events so BOTH distinct events persist.
    const captureStore = new InMemoryCaptureStore();
    const { runtime } = setupEventLog({ captureStore });

    const first = await drive(runtime, { session_id: "noseq", tool_name: "Read" });
    expect(gateOf(first)).toBe("passed");
    const second = await drive(runtime, { session_id: "noseq", tool_name: "Bash" });
    expect(gateOf(second)).toBe("passed"); // NOT stopped — no slot collision

    const rows = await captureStore.events("noseq");
    expect(rows.map((r) => r.activity)).toEqual(["Read", "Bash"]); // both events survived
    expect(rows.map((r) => r.seq)).toEqual([0, 1]); // monotonic seq assigned by the store
  });

  it("fails closed (gate stopped, no row) when capture:write is not granted", async () => {
    const captureStore = new InMemoryCaptureStore();
    // Eigene Runtime mit DEFAULT rootPolicy() (KEIN capture:write) → die append-Node wirft (fail-closed).
    const runtime = createRuntime({ rootPolicy: rootPolicy() });
    registerEventLog(runtime.registry, { captureStore });

    const events = await drive(runtime, HOOK_EVENT);

    expect(gateOf(events)).toBe("stopped"); // security by absence (Inv. 14)
    expect(await captureStore.events("sess-1")).toHaveLength(0);
  });
});
