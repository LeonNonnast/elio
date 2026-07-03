import { describe, expect, it } from "vitest";
import { validateHandler, validateNode } from "./validate";
import type { GateVerdict } from "../node";
import type { Ctx } from "../ctx";

const ctx = {} as Ctx;

async function verdict(withCfg: Record<string, unknown>): Promise<GateVerdict> {
  const res = await validateHandler(withCfg, ctx);
  if (res.status !== "resolved") throw new Error(`expected resolved, got ${res.status}`);
  return res.output;
}

describe("validate node", () => {
  it("is registered as orchestration and always resolves (pass OR fail is a verdict, not Failed)", async () => {
    expect(validateNode.type).toBe("validate");
    expect(validateNode.klass).toBe("orchestration");
    const res = await validateHandler({ value: "", minLength: 5 }, ctx);
    expect(res.status).toBe("resolved");
  });

  it("minLength on strings", async () => {
    expect((await verdict({ value: "abcde", minLength: 5 })).passed).toBe(true);
    const fail = await verdict({ value: "abc", minLength: 5 });
    expect(fail.passed).toBe(false);
    expect(fail.failures.length).toBeGreaterThan(0);
  });

  it("predicate path", async () => {
    expect((await verdict({ value: 10, predicate: (v: unknown) => (v as number) > 5 })).passed).toBe(
      true,
    );
    expect((await verdict({ value: 2, predicate: (v: unknown) => (v as number) > 5 })).passed).toBe(
      false,
    );
  });

  it("predicate that throws fails gracefully", async () => {
    const v = await verdict({
      value: null,
      predicate: () => {
        throw new Error("nope");
      },
    });
    expect(v.passed).toBe(false);
    expect(v.failures.join(" ")).toMatch(/threw/);
  });

  it("mini json-schema: required + types + nested", async () => {
    const schema = {
      type: "object",
      required: ["name", "age"],
      properties: { name: { type: "string" }, age: { type: "number", minimum: 0 } },
    };
    expect((await verdict({ value: { name: "x", age: 3 }, schema })).passed).toBe(true);
    const missing = await verdict({ value: { name: "x" }, schema });
    expect(missing.passed).toBe(false);
    expect(missing.failures.join(" ")).toMatch(/required property "age"/);
    const wrongType = await verdict({ value: { name: 1, age: 3 }, schema });
    expect(wrongType.passed).toBe(false);
    expect(wrongType.failures.join(" ")).toMatch(/expected type string/);
    const belowMin = await verdict({ value: { name: "x", age: -1 }, schema });
    expect(belowMin.passed).toBe(false);
    expect(belowMin.failures.join(" ")).toMatch(/below minimum/);
  });

  it("score defaults to 1/0 and honors an override", async () => {
    expect((await verdict({ value: "ok", minLength: 1 })).score).toBe(1);
    expect((await verdict({ value: "", minLength: 1 })).score).toBe(0);
    expect((await verdict({ value: "x", minLength: 5, score: 0.42 })).score).toBe(0.42);
  });
});
