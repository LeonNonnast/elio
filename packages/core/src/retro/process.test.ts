import { describe, expect, it } from "vitest";
import { classifySession, directlyFollows, jaccard } from "@elio/core";
import type { ProcessSignature } from "@elio/core";

describe("retro/process — directlyFollows", () => {
  it("encodes consecutive pairs as \"a→b\"", () => {
    expect([...directlyFollows(["a", "b", "c"])].sort()).toEqual(["a→b", "b→c"]);
  });

  it("collapses repeated edges into a set", () => {
    expect([...directlyFollows(["a", "b", "a", "b"])].sort()).toEqual(["a→b", "b→a"]);
  });

  it("has no transitions for sequences of length 0 or 1", () => {
    expect(directlyFollows([]).size).toBe(0);
    expect(directlyFollows(["only"]).size).toBe(0);
  });
});

describe("retro/process — jaccard", () => {
  it("is 1 for identical sets", () => {
    expect(jaccard(new Set(["a→b", "b→c"]), new Set(["a→b", "b→c"]))).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a→b"]), new Set(["x→y"]))).toBe(0);
  });

  it("is |∩|/|∪| for partial overlap", () => {
    // ∩ = {a→b} (1), ∪ = {a→b, b→c, b→d} (3) → 1/3
    expect(jaccard(new Set(["a→b", "b→c"]), new Set(["a→b", "b→d"]))).toBeCloseTo(1 / 3);
  });

  it("treats empty/empty as identical (similarity 1)", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it("is 0 when only one side is empty", () => {
    expect(jaccard(new Set(["a→b"]), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set(["a→b"]))).toBe(0);
  });
});

describe("retro/process — classifySession", () => {
  const catalog: ProcessSignature[] = [
    { id: "proc.refactor", variant: ["Read", "Edit", "Bash"], follows: ["Read→Edit", "Edit→Bash"] },
    { id: "proc.explore", variant: ["Read", "Grep"], follows: ["Read→Grep"] },
  ];

  it("returns unknown for an empty catalog (bootstrapping)", () => {
    const sig = { variant: ["Read", "Edit"], follows: directlyFollows(["Read", "Edit"]) };
    expect(classifySession(sig, [])).toEqual({ classification: "unknown", similarity: 0 });
  });

  it("classifies an exact-footprint session as known", () => {
    const sig = { variant: ["Read", "Edit", "Bash"], follows: directlyFollows(["Read", "Edit", "Bash"]) };
    const r = classifySession(sig, catalog);
    expect(r.classification).toBe("known");
    expect(r.matched).toBe("proc.refactor");
    expect(r.similarity).toBe(1);
  });

  it("classifies a dissimilar session as unknown (below theta)", () => {
    const sig = { variant: ["Write", "Glob"], follows: directlyFollows(["Write", "Glob"]) };
    const r = classifySession(sig, catalog);
    expect(r.classification).toBe("unknown");
    expect(r.matched).toBeUndefined();
  });

  it("classifies known at exactly theta (>= boundary)", () => {
    // Session footprint {Read→Edit, Edit→Bash, Bash→Test} vs catalog {Read→Edit, Edit→Bash}:
    // ∩=2, ∪=3 → 2/3 ≈ 0.667. With theta=2/3 it is inclusive → known.
    const sig = {
      variant: ["Read", "Edit", "Bash", "Test"],
      follows: directlyFollows(["Read", "Edit", "Bash", "Test"]),
    };
    expect(classifySession(sig, catalog, 2 / 3).classification).toBe("known");
    // The same session is unknown just above its similarity.
    expect(classifySession(sig, catalog, 2 / 3 + 0.01).classification).toBe("unknown");
  });

  it("picks the best match across catalog entries", () => {
    const sig = { variant: ["Read", "Grep"], follows: directlyFollows(["Read", "Grep"]) };
    const r = classifySession(sig, catalog);
    expect(r.matched).toBe("proc.explore");
    expect(r.similarity).toBe(1);
  });
});
