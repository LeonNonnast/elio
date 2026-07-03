import { describe, expect, it } from "vitest";
import { InMemoryCandidateStore, makeCandidate } from "@elio/core";
import type { CandidateSpec } from "@elio/core";

const base: CandidateSpec = {
  source: "m",
  kind: "alert",
  support: 1,
  evidence: { runs: ["r1"] },
  proposal: { x: 1 },
  summary: "s",
};

describe("retro/candidate — makeCandidate", () => {
  it("derives a content-hash id (idempotent for the same finding)", () => {
    expect(makeCandidate(base).id).toBe(makeCandidate(base).id);
  });

  it("changes the id when the proposal changes", () => {
    expect(makeCandidate(base).id).not.toBe(makeCandidate({ ...base, proposal: { x: 2 } }).id);
  });

  it("omits optional fields when not provided, includes them when given", () => {
    const c = makeCandidate(base);
    expect(c.callSite).toBeUndefined();
    expect(c.estImpact).toBeUndefined();
    const withImpact = makeCandidate({
      ...base,
      callSite: { feature: "f", step: "a", nodeType: "llm" },
      estImpact: { usd: 0.5 },
    });
    expect(withImpact.callSite?.step).toBe("a");
    expect(withImpact.estImpact?.usd).toBe(0.5);
  });
});

describe("retro/candidate — InMemoryCandidateStore", () => {
  it("upserts on id (re-adding the same finding does not duplicate)", async () => {
    const store = new InMemoryCandidateStore();
    await store.add(makeCandidate(base));
    await store.add(makeCandidate(base));
    expect(await store.list()).toHaveLength(1);
  });

  it("get returns null for unknown id", async () => {
    const store = new InMemoryCandidateStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("list filters by source and kind", async () => {
    const store = new InMemoryCandidateStore();
    await store.add(makeCandidate({ ...base, source: "a", kind: "alert", proposal: 1 }));
    await store.add(makeCandidate({ ...base, source: "b", kind: "node-config", proposal: 2 }));
    expect(await store.list({ source: "a" })).toHaveLength(1);
    expect(await store.list({ kind: "node-config" })).toHaveLength(1);
    expect((await store.list({ source: "a" }))[0]?.kind).toBe("alert");
  });
});
