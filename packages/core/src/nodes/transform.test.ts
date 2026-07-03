import { describe, expect, it } from "vitest";
import { transformHandler, transformNode } from "./transform";
import type { Ctx } from "../ctx";

// transform ist eine reine Funktion; ctx wird nicht gelesen -> Dummy reicht.
const ctx = {} as Ctx;

async function out(withCfg: Record<string, unknown>): Promise<unknown> {
  const res = await transformHandler(withCfg, ctx);
  if (res.status !== "resolved") throw new Error(`expected resolved, got ${res.status}`);
  return res.output;
}

describe("transform node", () => {
  it("is registered as orchestration", () => {
    expect(transformNode.type).toBe("transform");
    expect(transformNode.klass).toBe("orchestration");
  });

  it("set -> wraps the value under `as` (default 'value')", async () => {
    expect(await out({ set: 42 })).toEqual({ value: 42 });
    expect(await out({ set: "x", as: "name" })).toEqual({ name: "x" });
  });

  it("append concatenates strings", async () => {
    expect(await out({ append: "bar", to: "foo", as: "s" })).toEqual({ s: "foobar" });
    expect(await out({ append: "abc", as: "s" })).toEqual({ s: "abc" });
  });

  it("append pushes onto arrays", async () => {
    expect(await out({ append: 3, to: [1, 2], as: "list" })).toEqual({ list: [1, 2, 3] });
  });

  it("take slices the first n of an array", async () => {
    expect(await out({ take: 2, from: [10, 20, 30, 40], as: "rows" })).toEqual({
      rows: [10, 20],
    });
  });

  it("map picks a field from each element", async () => {
    expect(
      await out({ map: { from: [{ id: "a" }, { id: "b" }], pick: "id" }, as: "ids" }),
    ).toEqual({ ids: ["a", "b"] });
  });

  it("unknown op returns the shape (minus control fields)", async () => {
    expect(await out({ mode: "dry-run", as: "ignored" })).toEqual({ mode: "dry-run" });
  });

  it("reports the configured cost (default 0)", async () => {
    const free = await transformHandler({ set: 1 }, ctx);
    if (free.status === "resolved") expect(free.cost.usd).toBe(0);
    const paid = await transformHandler({ set: 1, cost: 0.5 }, ctx);
    if (paid.status === "resolved") expect(paid.cost.usd).toBe(0.5);
  });
});
