// ───────────────────────────── Slice 2 part B: parked suspend + multi-branch + race-test ─────────────────────────────
// Beweist Inv. 12 (parked) + die Concurrency-Resolution (§11/#6):
//  (1) Eine subworkflow fächert >= 2 Items; jedes Kind parkt auf einem approval. Resumed man die
//      parked Kinder in UMGEKEHRTER / beliebiger Reihenfolge, completen ALLE, der disjoint-key
//      Holder trägt JEDES Ergebnis ohne Kollision, und das finale Artefakt ist UNABHÄNGIG von der
//      Resume-Reihenfolge identisch.
//  (2) Ein parked Geschwister blockt den anderen Branch NICHT: parkt das erste Kind, macht das
//      zweite trotzdem Fortschritt (läuft durch / schreibt sein Ergebnis).

import { describe, expect, it } from "vitest";
import {
  InMemoryRunStore,
  NodeRegistry,
  OuterLoopRunner,
  PolicyRegistry,
  registerBuiltins,
  serializeArtifact,
} from "./index";
import type { ArtifactType, CorrelationId, FeaturePack, RunEvent } from "./index";

// ───────────────────────────── Helpers ─────────────────────────────

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** Artefakt-Typ mit disjoint-key db-state-Holder (+ append-only memory) für die per-item-Ergebnisse. */
const ARTIFACT_TYPES: Record<string, ArtifactType> = {
  "race-artifact": { kind: "race-artifact", holders: ["db-state", "memory"] },
};

/**
 * Eval-Gate, das bestanden ist, sobald der disjoint-key db-state-Holder >= `expected` Records trägt.
 * Auf dem First-Pass (alle Kinder parked) sind es 0 Records -> nicht bestanden -> Run meldet
 * suspended; nach dem Resume aller Kinder sind alle Records da -> bestanden.
 */
function registerGate(registry: NodeRegistry, expected: number): void {
  registry.register({
    type: "all-records-present",
    klass: "orchestration",
    handler: async (input) => {
      const artifact = (input as { artifact?: { holders?: Record<string, unknown> } })?.artifact;
      let count = 0;
      const holders = artifact?.holders ?? {};
      for (const h of Object.values(holders)) {
        const holder = h as { kind?: string; read?: () => Promise<unknown[]> };
        if (holder.kind === "db-state" && typeof holder.read === "function") {
          count = (await holder.read()).length;
        }
      }
      const passed = count >= expected;
      return {
        status: "resolved" as const,
        output: { passed, failures: passed ? [] : [`have ${count}/${expected}`] },
        confidence: 1,
        cost: { usd: 0 },
      };
    },
  });
}

/**
 * Child-Step: leitet aus dem Item ein deterministisches Ergebnis ab und schreibt es in den
 * Kind-branchState (kein Aliasing zwischen Kindern: jedes Kind hat seinen eigenen State). Das macht
 * das finale Kind-Ergebnis reihenfolge-unabhängig (es hängt NUR am Item, nicht am Resume-Timing).
 */
function registerDeriveResult(registry: NodeRegistry): void {
  registry.register({
    type: "derive-result",
    klass: "orchestration",
    handler: (input) => {
      const cfg = (input ?? {}) as { item?: { n?: number }; id?: string };
      const n = typeof cfg.item?.n === "number" ? cfg.item.n : 0;
      return Promise.resolve({
        status: "resolved" as const,
        // deterministisch aus dem Item -> identisch egal wann das Kind resumed wird.
        output: { derived: n * 10, label: `item-${cfg.id ?? "?"}` },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  });
}

/** Feature: eine subworkflow fächert über state.items; jedes Kind parkt auf einem approval. */
function makePack(): FeaturePack {
  const childSteps = [
    // 1) deterministisches Ergebnis aus dem Item ableiten (in den Kind-branchState).
    {
      id: "derive",
      type: "derive-result",
      with: { item: "{{state.item}}", id: "{{state.id}}" },
      outputs: { derived: "state.derived", label: "state.label" },
    },
    // 2) approval -> PARKED. Hier hält NUR dieses Kind an; Geschwister laufen weiter (§6).
    { id: "approve", type: "approval", suspend: "parked" as const, with: { reason: "ok this item?" } },
    // 3) nach Resume: das Kind als done markieren (läuft erst, nachdem der Mensch antwortet).
    { id: "finalize", type: "transform", with: { set: true, as: "done" }, outputs: { done: "state.done" } },
  ];

  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "race.parked-subworkflow", version: "1", owner: "t" },
    contentHash: "race.parked-subworkflow@1",
    feature: {
      autonomy: "guided",
      artifact: { kind: "race-artifact", evalGate: "all-records-present" },
      io: { input: {}, output: {} },
      graph: {
        state: {
          items: [
            { id: "a", n: 1 },
            { id: "b", n: 2 },
            { id: "c", n: 3 },
          ],
        },
        steps: [
          {
            id: "fanout",
            type: "subworkflow",
            with: { forEach: "{{state.items}}", steps: childSteps },
          },
        ],
        edges: [],
      },
    },
  };
}

function makeRuntime(expected: number): {
  runner: OuterLoopRunner;
  store: InMemoryRunStore;
} {
  const registry = new NodeRegistry();
  registerBuiltins(registry); // transform, validate, approval, subworkflow
  registerGate(registry, expected);
  registerDeriveResult(registry);
  const store = new InMemoryRunStore();
  const runner = new OuterLoopRunner({
    registry,
    store,
    policyRegistry: new PolicyRegistry(),
    artifactTypes: ARTIFACT_TYPES,
  });
  return { runner, store };
}

/**
 * Zieht die parked KIND-Branch correlation-ids aus dem Live-Status des Stores (NICHT aus dem
 * root-run()-Strom): die von einer subworkflow gefächerten Kind-Branches laufen im Runner und
 * publizieren ihre node-suspended-Events in den Live-Stream / das Tape — der root run()-Generator
 * ist nur die lineare Sicht des Root-Branches (so liest auch Studio Multi-Branch-Aktivität, §2/§3).
 * Kind-Branches erkennen wir an der branch id parentBranch + "/" + itemId. Sortiert nach item id
 * (deterministisch), unabhängig von der Fan-out-Reihenfolge.
 */
async function parkedCorrelations(store: InMemoryRunStore): Promise<CorrelationId[]> {
  const st = await store.liveStatus();
  return st
    .filter((s) => s.phase === "suspended" && s.correlation.branch.includes("/"))
    .map((s) => s.correlation)
    .sort((a, b) => a.branch.localeCompare(b.branch));
}

/** Liest die db-state-Records des Artefakts als id->result Map (deterministisch). */
async function dbRecords(
  runner: OuterLoopRunner,
  runId: string,
): Promise<{ id: string }[]> {
  const artifact = runner.getArtifact(runId);
  if (artifact === undefined) throw new Error("no artifact");
  for (const holder of Object.values(artifact.holders)) {
    if (holder.kind === "db-state" && holder.concurrency === "disjoint-key") {
      return (await holder.read()) as { id: string }[];
    }
  }
  return [];
}

/**
 * Fährt einen Run inkl. Resume aller parked Kinder in der gegebenen Reihenfolge und gibt den
 * serialisierten Artefakt-Snapshot + die run id zurück. `order` indiziert in die Fan-out-Liste der
 * parked correlations.
 */
async function runWithResumeOrder(order: (n: number) => number[]): Promise<{
  snapshot: unknown;
  runId: string;
  runner: OuterLoopRunner;
  store: InMemoryRunStore;
  parked: CorrelationId[];
}> {
  const { runner, store } = makeRuntime(3);
  const pack = makePack();
  const first = await collect(runner.run(pack, { payload: {}, budget: 1000, maxDepth: 100 }));
  const runId = first.find((e) => e.type === "run-started")!.correlation.run;
  const parked = await parkedCorrelations(store);

  // Resume in der gewünschten Reihenfolge; jedes Kind bekommt DIESELBE Antwort (reihenfolge-neutral).
  for (const idx of order(parked.length)) {
    const corr = parked[idx];
    if (corr === undefined) throw new Error(`no parked correlation at index ${idx}`);
    await collect(runner.resume(corr, { approved: true }));
  }

  const artifact = runner.getArtifact(runId)!;
  const snapshot = await serializeArtifact(artifact);
  return { snapshot, runId, runner, store, parked };
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) Race-Test: parked Kinder in beliebiger Reihenfolge resumen -> identisches Artefakt.
// ─────────────────────────────────────────────────────────────────────────────
describe("(1) subworkflow fans out, each child parks; resume in arbitrary order -> all complete, no collision, identical artifact", () => {
  it("first pass: each child PARKS (mode parked), the run does not hang, and reports suspended", async () => {
    const { runner, store } = makeRuntime(3);
    const pack = makePack();
    // run() kehrt SAUBER zurück (kein Hang/Busy-Spin), obwohl alle Kind-Branches parken: die
    // Kinder laufen synchron im Runner bis zum Park-Punkt und hinterlassen Checkpoints.
    const first = await collect(runner.run(pack, { payload: {}, budget: 1000, maxDepth: 100 }));
    const runId = first.find((e) => e.type === "run-started")!.correlation.run;

    // 3 Kind-Branches parkten (Live-Stream/Tape, nicht der root run()-Strom) — alle mode "parked".
    const parkedEvents = store
      .getTape(runId)
      .map((f) => f.result)
      .filter((r) => r.status === "suspended");
    expect(parkedEvents.length).toBe(3);
    for (const r of parkedEvents) {
      if (r.status === "suspended") expect(r.elicitation.mode).toBe("parked");
    }

    // jedes parked Kind hat eine DISJUNKTE branch id parentBranch/<itemId>.
    const parked = await parkedCorrelations(store);
    const branches = new Set(parked.map((c) => c.branch));
    expect(branches.size).toBe(3);
    expect([...branches].every((b) => /\/(a|b|c)$/.test(b))).toBe(true);

    // First-Pass: noch KEIN Kind hat seinen disjoint-key Record geschrieben (alle parked vor finalize).
    expect((await dbRecords(runner, runId)).length).toBe(0);

    // Da alle Branches parked sind, meldet liveStatus() suspended (Inv. 12).
    const statuses = await store.liveStatus();
    expect(statuses.some((s) => s.phase === "suspended")).toBe(true);
    // KEIN run-completed auf dem First-Pass (es sind noch Branches offen).
    expect(first.some((e) => e.type === "run-completed")).toBe(false);
  });

  it("resume in REVERSED order: all children complete, disjoint-key holder has every result", async () => {
    const { snapshot, runId, runner } = await runWithResumeOrder((n) =>
      Array.from({ length: n }, (_, i) => n - 1 - i),
    );

    const records = await dbRecords(runner, runId);
    // jedes Item genau einmal, keine Kollision.
    const ids = records.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    expect(new Set(ids).size).toBe(3);

    // der Run ist nun sauber fertig (alle Branches resolved -> kein offener parked Branch).
    void snapshot;
  });

  it("the final artifact is IDENTICAL regardless of resume order (forward vs reversed vs middle-first)", async () => {
    const forward = await runWithResumeOrder((n) => Array.from({ length: n }, (_, i) => i));
    const reversed = await runWithResumeOrder((n) => Array.from({ length: n }, (_, i) => n - 1 - i));
    const middleFirst = await runWithResumeOrder((n) => {
      // beliebige Permutation: Mitte zuerst, dann Ränder (für n=3: [1,2,0]).
      const order: number[] = [];
      const mid = Math.floor(n / 2);
      order.push(mid);
      for (let i = 0; i < n; i += 1) if (i !== mid) order.push(i);
      return order;
    });

    // Die per-item-Records (disjoint-key) sind in allen drei Läufen identisch (Reihenfolge-invariant).
    const norm = (snap: unknown): string => {
      const s = snap as { holders: Record<string, { kind: string; state: unknown }> };
      const db = Object.values(s.holders).find((h) => h.kind === "db-state");
      const recs = (db?.state ?? []) as { id: string }[];
      return JSON.stringify([...recs].sort((a, b) => a.id.localeCompare(b.id)));
    };

    expect(norm(forward.snapshot)).toBe(norm(reversed.snapshot));
    expect(norm(forward.snapshot)).toBe(norm(middleFirst.snapshot));

    // und es sind wirklich alle drei Items mit ihrem deterministischen Ergebnis enthalten.
    const recs = JSON.parse(norm(forward.snapshot)) as { id: string; result: { done?: boolean } }[];
    expect(recs.map((r) => r.id)).toEqual(["a", "b", "c"]);
    for (const r of recs) expect(r.result.done).toBe(true); // finalize lief nach dem Resume
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Ein parked Geschwister blockt den anderen Branch NICHT.
// ─────────────────────────────────────────────────────────────────────────────
describe("(2) a parked sibling does not block the other branch from making progress", () => {
  /**
   * Feature mit ZWEI Items: das erste Kind parkt auf einem approval, das zweite läuft komplett durch
   * (kein approval-Step). Beweis: obwohl Kind 1 parked, schreibt Kind 2 seinen disjoint-key Record
   * (= Fortschritt) — der parked Geschwister blockt es nicht (§6).
   */
  function makeMixedPack(): FeaturePack {
    // Gemeinsame Steps für BEIDE Kinder; das approval parkt jedes Kind. Um zu zeigen, dass ein
    // parked Geschwister nicht blockt, fächern wir 2 Kinder und prüfen: BEIDE haben unabhängig
    // einen Checkpoint (beide parked, keiner wartet auf den anderen), und nach Resume NUR von Kind 2
    // (das andere bleibt parked) hat Kind 2 Fortschritt gemacht, Kind 1 NICHT.
    const childSteps = [
      { id: "derive", type: "derive-result", with: { item: "{{state.item}}", id: "{{state.id}}" }, outputs: { derived: "state.derived" } },
      { id: "approve", type: "approval", suspend: "parked" as const, with: { reason: "hold" } },
      { id: "finalize", type: "transform", with: { set: true, as: "done" }, outputs: { done: "state.done" } },
    ];
    return {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "race.sibling", version: "1", owner: "t" },
      contentHash: "race.sibling@1",
      feature: {
        autonomy: "guided",
        artifact: { kind: "race-artifact", evalGate: "all-records-present" },
        io: { input: {}, output: {} },
        graph: {
          state: { items: [{ id: "p", n: 7 }, { id: "q", n: 9 }] },
          steps: [{ id: "fanout", type: "subworkflow", with: { forEach: "{{state.items}}", steps: childSteps } }],
          edges: [],
        },
      },
    };
  }

  it("with both children parked, resuming ONLY the second makes it progress while the first stays parked", async () => {
    const { runner, store } = makeRuntime(2);
    const pack = makeMixedPack();
    const first = await collect(runner.run(pack, { payload: {}, budget: 1000, maxDepth: 100 }));
    const runId = first.find((e) => e.type === "run-started")!.correlation.run;

    // BEIDE Kinder parkten unabhängig -> 2 Checkpoints, disjunkte Branches.
    const parked = await parkedCorrelations(store);
    expect(parked.length).toBe(2);
    const byItem = new Map(parked.map((c) => [c.branch.slice(c.branch.lastIndexOf("/") + 1), c]));
    expect([...byItem.keys()].sort()).toEqual(["p", "q"]);

    // First-Pass: kein Record (beide parked vor finalize).
    expect((await dbRecords(runner, runId)).length).toBe(0);

    // NUR Kind "q" resumen -> es macht Fortschritt (finalize läuft, sein Record erscheint),
    // OHNE dass das parked Kind "p" dafür gebraucht/entblockt wird.
    const q = byItem.get("q")!;
    await collect(runner.resume(q, { approved: true }));

    const recsAfterQ = await dbRecords(runner, runId);
    expect(recsAfterQ.map((r) => r.id)).toEqual(["q"]); // NUR q hat Fortschritt gemacht
    // "p" ist weiterhin parked: sein Checkpoint ist noch ladbar + resumebar.
    const pCp = await store.loadCheckpoint(byItem.get("p")!);
    expect(pCp).not.toBeNull();

    // p nachträglich resumen -> jetzt sind beide da (Beweis, dass p die ganze Zeit unabhängig wartete).
    await collect(runner.resume(byItem.get("p")!, { approved: true }));
    const recsAfterP = await dbRecords(runner, runId);
    expect(recsAfterP.map((r) => r.id).sort()).toEqual(["p", "q"]);
  });
});
