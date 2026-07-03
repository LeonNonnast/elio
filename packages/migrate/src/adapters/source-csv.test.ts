// ───────────────────────────── source-csv adapter — hand-rolled CSV parse ─────────────────────────────

import { describe, it, expect } from "vitest";
import { parseCsv, SourceCsvAdapter } from "./source-csv";

describe("parseCsv — hand-rolled, dependency-free", () => {
  it("parses a simple CSV with header into id-keyed records", () => {
    const recs = parseCsv("id,full_name\n1,Ann\n2,Bob\n");
    expect(recs).toEqual([
      { id: "1", full_name: "Ann" },
      { id: "2", full_name: "Bob" },
    ]);
  });

  it("handles quoted fields with embedded commas and doubled quotes", () => {
    const recs = parseCsv('id,note\n1,"a, b"\n2,"he said ""hi"""\n');
    expect(recs[0]).toEqual({ id: "1", note: "a, b" });
    expect(recs[1]).toEqual({ id: "2", note: 'he said "hi"' });
  });

  it("derives id from the first column when no id column is present", () => {
    const recs = parseCsv("code,name\nX,Ann\nY,Bob\n");
    expect(recs.map((r) => r.id)).toEqual(["X", "Y"]);
  });

  it("falls back to the row index when the id cell is empty", () => {
    const recs = parseCsv("id,name\n,Ann\n,Bob\n");
    expect(recs.map((r) => r.id)).toEqual(["0", "1"]);
  });

  it("skips blank lines", () => {
    const recs = parseCsv("id,name\n1,Ann\n\n2,Bob\n\n");
    expect(recs).toHaveLength(2);
  });
});

describe("SourceCsvAdapter", () => {
  it("reads rows from an inline content fixture", async () => {
    const adapter = new SourceCsvAdapter({ content: "id,name\nu1,Ann\n" });
    expect(await adapter.rows()).toEqual([{ id: "u1", name: "Ann" }]);
  });

  it("reads rows from a path via an injected FsReader", async () => {
    const adapter = new SourceCsvAdapter({ path: "/data/in.csv" });
    const fs = { read: (_p: string): Promise<string> => Promise.resolve("id,name\nu9,Zed\n") };
    expect(await adapter.rows(fs)).toEqual([{ id: "u9", name: "Zed" }]);
  });

  it("throws when a path is set but no FsReader is provided (security by absence)", async () => {
    const adapter = new SourceCsvAdapter({ path: "/data/in.csv" });
    await expect(adapter.rows()).rejects.toThrow(/security by absence|FsReader/);
  });
});
