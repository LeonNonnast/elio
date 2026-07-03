// ───────────────────────────── router + condition built-ins (Inv. 6/7, Slice 4) ─────────────────────────────

import { describe, expect, it } from "vitest";
import {
  conditionHandler,
  createArtifact,
  PolicyInjector,
  rootPolicy,
  routerHandler,
} from "@elio/core";
import type { Artifact, ArtifactType, CorrelationId, Ctx, Resolved } from "@elio/core";

const type: ArtifactType = { kind: "demo", holders: ["memory"] };
const artifact: Artifact = createArtifact(type, {});
const corr: CorrelationId = { run: "r", branch: "b", step: "s", checkpoint: "c" };

function ctxFor(): Ctx {
  return new PolicyInjector({}).buildCtx(
    { type: "t", klass: "orchestration", handler: () => Promise.reject(new Error("unused")) },
    rootPolicy(),
    corr,
    artifact,
  );
}

function out(r: Awaited<ReturnType<typeof routerHandler>>): Record<string, unknown> {
  expect(r.status).toBe("resolved");
  return (r as Resolved).output as Record<string, unknown>;
}

describe("router node — deterministic branch selection", () => {
  it("picks a route from cases by value", async () => {
    const r = await routerHandler({ value: "b", cases: { a: 1, b: 2 } }, ctxFor());
    expect(out(r)["route"]).toBe("b");
  });

  it("falls back to default when value is not in cases", async () => {
    const r = await routerHandler({ value: "x", cases: { a: 1 }, default: "fallback" }, ctxFor());
    expect(out(r)["route"]).toBe("fallback");
  });

  it("picks the first truthy when-route from routes[]", async () => {
    const r = await routerHandler(
      { routes: [{ to: "skip", when: false }, { to: "go", when: true }] },
      ctxFor(),
    );
    expect(out(r)["route"]).toBe("go");
  });

  it("direct passthrough: route = String(value)", async () => {
    const r = await routerHandler({ value: 42 }, ctxFor());
    expect(out(r)["route"]).toBe("42");
  });

  it("custom output key via `as`", async () => {
    const r = await routerHandler({ value: "a", cases: { a: 1 }, as: "branch" }, ctxFor());
    expect(out(r)["branch"]).toBe("a");
  });

  it("throws when nothing matches and no default", async () => {
    await expect(routerHandler({ cases: { a: 1 } }, ctxFor())).rejects.toThrow(/router/i);
  });
});

describe("condition node — boolean predicate over state", () => {
  it("truthy value -> passed true", async () => {
    const r = await conditionHandler({ value: "non-empty" }, ctxFor());
    expect(out(r)["passed"]).toBe(true);
  });

  it("empty array -> passed false", async () => {
    const r = await conditionHandler({ value: [] }, ctxFor());
    expect(out(r)["passed"]).toBe(false);
  });

  it("equals comparison", async () => {
    expect(out(await conditionHandler({ value: 5, equals: 5 }, ctxFor()))["passed"]).toBe(true);
    expect(out(await conditionHandler({ value: 5, equals: 6 }, ctxFor()))["passed"]).toBe(false);
  });

  it("numeric comparisons gt/gte/lt/lte", async () => {
    expect(out(await conditionHandler({ value: 10, gt: 5 }, ctxFor()))["passed"]).toBe(true);
    expect(out(await conditionHandler({ value: 10, lte: 10 }, ctxFor()))["passed"]).toBe(true);
    expect(out(await conditionHandler({ value: 3, gte: 5 }, ctxFor()))["passed"]).toBe(false);
  });

  it("predicate path", async () => {
    const r = await conditionHandler(
      { value: { n: 7 }, predicate: (v) => (v as { n: number }).n > 3 },
      ctxFor(),
    );
    expect(out(r)["passed"]).toBe(true);
  });
});
