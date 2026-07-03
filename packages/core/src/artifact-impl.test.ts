import { describe, expect, it } from "vitest";
import {
  applyTo,
  createArtifact,
  deserializeArtifact,
  DbStateHolder,
  MemoryHolder,
  ProgressMdHolder,
  reDerive,
  serializeArtifact,
} from "@elio/core";
import type { ArtifactType } from "@elio/core";

const migrationType: ArtifactType = {
  kind: "migration-script",
  holders: ["db-state", "progress.md", "memory"],
};

describe("artifact data-holders", () => {
  it("MemoryHolder is append-only and versions on each entry", async () => {
    const h = new MemoryHolder<number>([1]);
    await h.write([2, 3]);
    await h.append(4);
    expect(await h.read()).toEqual([1, 2, 3, 4]);
    expect(await h.version()).toBe(4);
  });

  it("ProgressMdHolder is single-writer (full replace)", async () => {
    const h = new ProgressMdHolder("a");
    await h.write("b");
    expect(await h.read()).toBe("b");
    expect(await h.version()).toBe(1);
  });

  it("DbStateHolder is disjoint-key keyed by record id (upsert, no collision)", async () => {
    const h = new DbStateHolder<{ id: string; v: number }>([{ id: "r1", v: 1 }]);
    await h.write([{ id: "r2", v: 2 }, { id: "r1", v: 9 }]);
    expect(await h.read()).toEqual([
      { id: "r1", v: 9 },
      { id: "r2", v: 2 },
    ]);
    expect(h.has("r1")).toBe(true);
    expect(h.has("nope")).toBe(false);
  });
});

describe("createArtifact / applyTo", () => {
  it("createArtifact builds the holders declared by the type", () => {
    const a = createArtifact(migrationType, { records: [], progress: "" });
    expect(Object.keys(a.holders).sort()).toEqual(["db-state", "memory", "progress.md"]);
    expect(a.ref.kind).toBe("migration-script");
    expect(a.ref.version).toBe(0);
  });

  it("applyTo grows content and bumps ref.version", async () => {
    const a = createArtifact(migrationType, { records: [], progress: "", memory: [] });
    await applyTo(a, { records: [{ id: "r1", v: 1 }], progress: "step1 done" });
    expect(a.ref.version).toBe(1);
    expect((a.content as { progress: string }).progress).toBe("step1 done");
    await applyTo(a, { records: [{ id: "r2", v: 2 }], memory: ["fixed bug X"] });
    expect(a.ref.version).toBe(2);
  });
});

describe("re-derive round-trip (CRITICAL: serialize -> reDerive -> identical)", () => {
  it("reDerive reads state back from holders identically", async () => {
    const a = createArtifact(migrationType, { records: [], progress: "", memory: [] });
    await applyTo(a, { records: [{ id: "r1", v: 1 }], progress: "p1", memory: ["m1"] });
    await applyTo(a, { records: [{ id: "r2", v: 2 }], memory: ["m2"] });

    const reDerived = await reDerive(a);
    expect(reDerived.content).toEqual({
      records: [
        { id: "r1", v: 1 },
        { id: "r2", v: 2 },
      ],
      progress: "p1",
      memory: ["m1", "m2"],
    });
  });

  it("serialize -> deserialize -> reDerive is identical to the live re-derive", async () => {
    const a = createArtifact(migrationType, { records: [], progress: "", memory: [] });
    await applyTo(a, { records: [{ id: "r1", v: 1 }], progress: "p1", memory: ["m1"] });
    await applyTo(a, { records: [{ id: "r2", v: 2 }], memory: ["m2"] });

    const liveDerived = await reDerive(a);

    // Pack-Invariante: durch eine JSON-Runde schicken, dann rehydrieren + re-deriven.
    const snap = await serializeArtifact(a);
    const json = JSON.parse(JSON.stringify(snap)) as typeof snap;
    const rehydrated = deserializeArtifact(json);
    const roundTripDerived = await reDerive(rehydrated);

    expect(roundTripDerived.content).toEqual(liveDerived.content);
    expect(roundTripDerived.ref).toEqual(a.ref);
    expect(roundTripDerived.type).toEqual(a.type);
  });
});
