// ───────────────────────────── @elio/migrate — Re-derive Round-Trip (Inv. 22, §11/#5) ─────────────────────────────
// (b) Serialisiert das migration-script-Artefakt eines echten Laufs und re-deriviert es -> identisch.
//     Pack-Invariante: serialize -> (JSON) -> deserialize -> re-derive == live re-derive (Inv. 22).

import { describe, it, expect } from "vitest";
import { collectEvents, deserializeArtifact, reDerive, serializeArtifact } from "@elio/sdk";
import type { Artifact, CorrelationId, RunEvent } from "@elio/core";
import { setupMigrate } from "./setup";

const SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
`;

async function runToCompletion(): Promise<Artifact> {
  const { runtime, pack } = setupMigrate({ source: { content: SAMPLE_CSV } });
  const ev1: RunEvent[] = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
  const runId = ev1.find((e) => e.type === "run-started")!.correlation.run;
  const corr = ev1.find((e) => e.type === "node-suspended");
  if (!corr || corr.type !== "node-suspended") throw new Error("expected commit approval suspend");
  await collectEvents(runtime.resume(corr.correlation as CorrelationId, { approved: true }));
  const artifact = runtime.runner.getArtifact(runId);
  if (artifact === undefined) throw new Error("no artifact for run");
  return artifact;
}

describe("migrate.csv-to-db — re-derive round-trip (b, Inv. 22)", () => {
  it("serialize -> JSON -> deserialize -> re-derive is identical to the live re-derive", async () => {
    const artifact = await runToCompletion();

    expect(artifact.ref.kind).toBe("migration-script");
    // The migration-script artifact composes a disjoint-key db-state holder (per-record sample results).
    expect(Object.values(artifact.holders).some((h) => h.kind === "db-state")).toBe(true);

    // Snapshot the ORIGINAL live content BEFORE any re-derive (the invariant target). Deep-cloned so a
    // later in-place mutation of the live artifact cannot retroactively change what we assert against.
    const originalContent = structuredClone(artifact.content);

    // (1) re-derive is IDENTITY-preserving over the LIVE artifact: serialize -> re-derive == the input.
    // This is the real §11/#5 invariant — re-derive must return the SAME artifact you put in, not just
    // agree with another re-derive. It catches a holder/content divergence (e.g. a spurious `records`
    // key that re-derive injects but the live content never had).
    const liveDerived = await reDerive(artifact);
    expect(liveDerived.content).toEqual(originalContent);

    // (2) Full JSON serialize -> deserialize -> re-derive round trip ALSO equals the original content
    // (a persisted-then-rehydrated run yields the identical artifact.content as the in-process run).
    const snap = await serializeArtifact(artifact);
    const json = JSON.parse(JSON.stringify(snap)) as typeof snap;
    const rehydrated = deserializeArtifact(json);
    const roundTripDerived = await reDerive(rehydrated);

    expect(roundTripDerived.content).toEqual(originalContent);
    expect(roundTripDerived.ref).toEqual(artifact.ref);
    expect(roundTripDerived.type).toEqual(artifact.type);

    // (3) serialize(rehydrated) deep-equals serialize(original): the full snapshot (incl. holder state)
    // survives the round trip byte-for-byte.
    expect(await serializeArtifact(rehydrated)).toEqual(snap);

    // The per-record sample results survive the round trip (each record present exactly once).
    const records = (roundTripDerived.content as { records?: { id: string }[] }).records ?? [];
    expect(records.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });
});
