import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryCaptureStore,
  RunStoreTracesService,
  TableTapeSource,
  eventId,
  mineDfg,
  mineVariants,
  rowToFrame,
} from "@elio/core";
import type { CaptureEvent, StoredCaptureEvent } from "@elio/core";

function ev(over: Partial<CaptureEvent> = {}): CaptureEvent {
  return {
    session: over.session ?? "sess_1",
    seq: over.seq ?? 0,
    ts: over.ts ?? "2026-01-01T00:00:00.000Z",
    source: over.source ?? "claude-code",
    activity: over.activity ?? "Read",
    ...(over.inputHash !== undefined ? { inputHash: over.inputHash } : {}),
    ...(over.outputHash !== undefined ? { outputHash: over.outputHash } : {}),
    ...(over.cost !== undefined ? { cost: over.cost } : {}),
    ...(over.raw !== undefined ? { raw: over.raw } : {}),
    ...(over.id !== undefined ? { id: over.id } : {}),
  };
}

describe("capture — rowToFrame mapping (Doc §4)", () => {
  it("maps an events row onto a TapeFrame with the documented sentinels", () => {
    const row: StoredCaptureEvent = {
      id: "abc123",
      session: "sess_42",
      seq: 3,
      ts: "2026-03-04T05:06:07.000Z",
      source: "ollama",
      activity: "Bash",
      inputHash: "in#",
      outputHash: "out#",
      cost: { usd: 0.01, tokensIn: 10, tokensOut: 5, model: "m" },
      raw: { full: "redacted" },
    };
    const frame = rowToFrame(row);
    expect(frame.correlation).toEqual({
      run: "sess_42", // session → run (carries the runs axis)
      branch: "main", // sentinel — no branch concept
      step: "3", // seq → step
      checkpoint: "abc123", // content-hash id as stable token
    });
    expect(frame.nodeType).toBe("Bash"); // activity == nodeType
    expect(frame.feature).toBeUndefined(); // no feature column → undefined (readAll-safe)
    expect(frame.input).toEqual({ hash: "in#" });
    expect(frame.result).toEqual({
      status: "resolved",
      output: { hash: "out#" },
      confidence: 1, // no confidence in events → default 1
      cost: { usd: 0.01, tokensIn: 10, tokensOut: 5, model: "m" },
    });
    expect(frame.injected).toEqual([]); // sentinel — no injected service keys
    expect(frame.redaction).toBeUndefined(); // no dataClassification source → omitted
    expect(frame.ts).toBe("2026-03-04T05:06:07.000Z");
  });

  it("defaults absent hashes/cost cleanly (no undefined leaking into the frame)", () => {
    const frame = rowToFrame({ ...ev(), id: "x" });
    expect(frame.input).toEqual({ hash: null });
    expect((frame.result as { output: unknown }).output).toEqual({ hash: null });
    expect((frame.result as { cost: unknown }).cost).toEqual({});
  });
});

describe("capture — idempotent append (content-hash id)", () => {
  it("appends the same event twice → exactly one row", async () => {
    const store = new InMemoryCaptureStore();
    const a = await store.append(ev({ session: "s", seq: 1, activity: "Read" }));
    const b = await store.append(ev({ session: "s", seq: 1, activity: "Read" }));
    expect(a.id).toBe(b.id); // same content → same content-hash id
    expect(await store.events("s")).toHaveLength(1); // upsert on id → no duplicate
  });

  it("derives the same id whether or not an explicit id is supplied", async () => {
    const derived = eventId(ev({ session: "s", seq: 2, activity: "Edit" }));
    const store = new InMemoryCaptureStore();
    const stored = await store.append(ev({ session: "s", seq: 2, activity: "Edit" }));
    expect(stored.id).toBe(derived);
  });

  it("distinct content → distinct rows", async () => {
    const store = new InMemoryCaptureStore();
    await store.append(ev({ session: "s", seq: 1, activity: "Read" }));
    await store.append(ev({ session: "s", seq: 2, activity: "Edit" }));
    expect(await store.events("s")).toHaveLength(2);
  });

  it("treats raw as provenance-only — does not affect the content-hash id", async () => {
    const store = new InMemoryCaptureStore();
    const a = await store.append(ev({ session: "s", seq: 1, raw: { a: 1 } }));
    const b = await store.append(ev({ session: "s", seq: 1, raw: { b: 2 } }));
    expect(a.id).toBe(b.id);
    expect(await store.events("s")).toHaveLength(1);
  });
});

describe("capture — durable JSONL mirror", () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.length = 0;
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "elio-capture-"));
    dirs.push(d);
    return d;
  }

  function lineCount(dir: string): number {
    return readFileSync(join(dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0).length;
  }

  it("re-hydrates events from the JSONL mirror in a fresh store (cross-process durability)", async () => {
    const dir = tmp();
    const first = new InMemoryCaptureStore({ dir });
    await first.append(ev({ session: "s", seq: 1, activity: "Read" }));
    await first.append(ev({ session: "s", seq: 2, activity: "Edit" }));
    expect(lineCount(dir)).toBe(2); // two distinct events → two JSONL lines
    // Re-delivery in the same process: no extra row AND no extra JSONL line (pins the `!known` guard;
    // otherwise the durability file would grow on every re-delivery — Doc §4 idempotency).
    await first.append(ev({ session: "s", seq: 1, activity: "Read" }));
    expect(lineCount(dir)).toBe(2); // re-delivery appended NO line

    const second = new InMemoryCaptureStore({ dir });
    const rows = await second.events("s");
    expect(rows.map((r) => r.activity)).toEqual(["Read", "Edit"]); // exactly the two distinct rows
  });

  it("re-delivery survives a re-hydrate without growing the mirror (cross-process idempotency)", async () => {
    const dir = tmp();
    const first = new InMemoryCaptureStore({ dir });
    await first.append(ev({ session: "s", seq: 1, activity: "Read" }));
    expect(lineCount(dir)).toBe(1);

    // Fresh process re-hydrates, then RE-delivers the same logical event. Because hydrate re-derives the id
    // from content (not the persisted id), the re-delivery is recognized as known → no duplicate line/row.
    const second = new InMemoryCaptureStore({ dir });
    await second.append(ev({ session: "s", seq: 1, activity: "Read" }));
    expect(lineCount(dir)).toBe(1); // still one line after cross-process re-delivery
    expect(await second.events("s")).toHaveLength(1);
  });

  it("re-derives the id on hydrate (stale/hand-edited persisted id does not defeat dedup)", async () => {
    const dir = tmp();
    // Simulate a JSONL line written by an older eventId version (or hand-edited): correct content, STALE id.
    const content = ev({ session: "s", seq: 1, activity: "Read" });
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ ...content, id: "STALE_OLD_VERSION_ID" })}\n`, "utf8");

    const store = new InMemoryCaptureStore({ dir });
    expect(await store.events("s")).toHaveLength(1); // hydrated the one row
    // Re-deliver the same logical event: the fresh content-hash id must match the RE-DERIVED hydrated id,
    // not the stale persisted one → recognized as known → no duplicate row, no extra JSONL line.
    await store.append(content);
    expect(await store.events("s")).toHaveLength(1);
    expect(lineCount(dir)).toBe(1);
  });

  it("skips structurally unusable hydrated lines (missing/garbage fields → no undefined-keyed bucket)", async () => {
    const dir = tmp();
    const good = ev({ session: "s", seq: 1, activity: "Read" });
    // A line with no `id` and a missing `session` must be skipped, not set under an `undefined` key.
    const lines = [
      JSON.stringify({ seq: 0, ts: "2026-01-01T00:00:00.000Z" }), // no session → skip
      JSON.stringify({ ...good, id: undefined }), // id-less but valid content → re-derived + kept
    ].join("\n");
    writeFileSync(join(dir, "events.jsonl"), `${lines}\n`, "utf8");

    const store = new InMemoryCaptureStore({ dir });
    expect((await store.sessions()).sort()).toEqual(["s"]); // only the valid line survived
    expect(await store.events("s")).toHaveLength(1);
  });

  it("enforces the seq-uniqueness write precondition: a distinct event in a taken (session, seq) slot throws", async () => {
    const store = new InMemoryCaptureStore();
    await store.append(ev({ session: "s", seq: 1, activity: "Read" }));
    // Same (session, seq), genuinely DIFFERENT content → would silently overwrite under an id-keyed upsert.
    await expect(store.append(ev({ session: "s", seq: 1, activity: "Bash" }))).rejects.toThrow(/unique per session/);
    expect(await store.events("s")).toHaveLength(1); // the first event is preserved, not clobbered
  });
});

describe("capture — TableTapeSource ordering + runIds", () => {
  it("orders a run's frames by (seq, ts) regardless of insertion order", async () => {
    const store = new InMemoryCaptureStore();
    await store.append(ev({ session: "s", seq: 2, activity: "Edit", ts: "2026-01-03T00:00:00.000Z" }));
    await store.append(ev({ session: "s", seq: 0, activity: "Read", ts: "2026-01-01T00:00:00.000Z" }));
    await store.append(ev({ session: "s", seq: 1, activity: "Bash", ts: "2026-01-02T00:00:00.000Z" }));
    const src = new TableTapeSource(store);
    const seen: string[] = [];
    for await (const f of src.tape("s")) seen.push(f.nodeType);
    expect(seen).toEqual(["Read", "Bash", "Edit"]);
  });

  it("runIds() enumerates distinct sessions", async () => {
    const store = new InMemoryCaptureStore();
    await store.append(ev({ session: "a", seq: 0 }));
    await store.append(ev({ session: "b", seq: 0 }));
    await store.append(ev({ session: "a", seq: 1 }));
    const ids = (await new TableTapeSource(store).runIds()).sort();
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("capture — read path via RunStoreTracesService.collect (TraceQuery filtering)", () => {
  async function populated(): Promise<InMemoryCaptureStore> {
    const store = new InMemoryCaptureStore();
    await store.append(ev({ session: "s", seq: 0, activity: "Read", ts: "2026-01-01T00:00:00.000Z" }));
    await store.append(ev({ session: "s", seq: 1, activity: "Edit", ts: "2026-02-01T00:00:00.000Z" }));
    return store;
  }

  it("collects all mapped frames across enumerated sessions by default", async () => {
    const svc = new RunStoreTracesService(new TableTapeSource(await populated()));
    expect(await svc.collect()).toHaveLength(2);
  });

  it("filters by nodeType (= activity)", async () => {
    const svc = new RunStoreTracesService(new TableTapeSource(await populated()));
    expect(await svc.collect({ nodeType: "Read" })).toHaveLength(1);
  });

  it("filters by ts window (since/until inclusive, lexicographic ISO)", async () => {
    const svc = new RunStoreTracesService(new TableTapeSource(await populated()));
    const since = await svc.collect({ since: "2026-01-15T00:00:00.000Z" });
    expect(since.map((f) => f.nodeType)).toEqual(["Edit"]);
    const until = await svc.collect({ until: "2026-01-01T00:00:00.000Z" });
    expect(until.map((f) => f.nodeType)).toEqual(["Read"]); // boundary inclusive
  });

  it("filters by explicit run (session) set; unknown run yields nothing", async () => {
    const svc = new RunStoreTracesService(new TableTapeSource(await populated()));
    expect(await svc.collect({ runs: ["s"] })).toHaveLength(2);
    expect(await svc.collect({ runs: ["nope"] })).toHaveLength(0);
  });
});

describe("capture — END TO END: Slice-1 miners over a seeded CaptureStore", () => {
  // Seed a few sessions of dev activity, read via ctx.traces-style collect(), then mine.
  async function seeded(): Promise<RunStoreTracesService> {
    const store = new InMemoryCaptureStore();
    let t = 0;
    const stamp = (): string => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`;
    const append = async (session: string, activities: string[]): Promise<void> => {
      let seq = 0;
      for (const activity of activities) {
        await store.append(ev({ session, seq: seq++, activity, ts: stamp(), cost: { usd: 0.001 } }));
      }
    };
    // Two sessions share the SAME variant; one is different → mineVariants should see support 2 for it.
    await append("s1", ["Read", "Edit", "Bash"]);
    await append("s2", ["Read", "Edit", "Bash"]);
    await append("s3", ["Read", "Grep", "Edit"]);
    return new RunStoreTracesService(new TableTapeSource(store));
  }

  it("mineVariants over collect() finds the repeated variant with support 2", async () => {
    const svc = await seeded();
    const frames = await svc.collect();
    expect(frames).toHaveLength(9); // 3 sessions × 3 activities
    const candidates = mineVariants(frames);
    // Two distinct variants → two candidates; the repeated one has support 2.
    expect(candidates).toHaveLength(2);
    const supports = candidates.map((c) => c.support).sort((a, b) => a - b);
    expect(supports).toEqual([1, 2]);
  });

  it("mineDfg over collect() yields a single process-variant candidate with directly-follows edges", async () => {
    const svc = await seeded();
    const frames = await svc.collect();
    const candidates = mineDfg(frames);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe("process-variant");
    // The DFG proposal carries edges over the per-(run,branch) activity sequences (Read→Edit etc.).
    const proposal = candidates[0]?.proposal as { kind: string; edges?: unknown[] };
    expect(proposal.kind).toBe("dfg");
    expect(Array.isArray(proposal.edges)).toBe(true);
    expect((proposal.edges as unknown[]).length).toBeGreaterThan(0);
  });

  it("a since-window narrows the mined input (read path honors TraceQuery)", async () => {
    const svc = await seeded();
    // Drop the very first frame of s1 (ts ...:00) → s1's variant changes / shrinks.
    const all = await svc.collect();
    const since = all[1]?.ts;
    expect(since).toBeDefined();
    const windowed = await svc.collect(since !== undefined ? { since } : {});
    expect(windowed.length).toBeLessThan(all.length);
    // Still mineable without throwing — candidates remain sensible (≥1).
    expect(mineVariants(windowed).length).toBeGreaterThanOrEqual(1);
  });
});
