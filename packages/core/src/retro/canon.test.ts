import { describe, expect, it } from "vitest";
import { canonicalize, canonicalJson, hashValue } from "@elio/core";

describe("retro/canon — canonicalize", () => {
  it("sorts object keys (order observable via Object.keys)", () => {
    expect(Object.keys(canonicalize({ b: 1, a: 2, c: 3 }) as object)).toEqual(["a", "b", "c"]);
  });

  it("preserves array order (order IS meaning for arrays)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("drops undefined object fields, maps top-level undefined to null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson(undefined)).toBe("null");
  });
});

describe("retro/canon — canonicalJson stability", () => {
  it("is identical across (nested) key reordering", () => {
    const a = { x: { p: 1, q: 2 }, y: [{ m: 1, n: 2 }] };
    const b = { y: [{ n: 2, m: 1 }], x: { q: 2, p: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe("retro/canon — hashValue", () => {
  it("is stable across key reorder and sensitive to content", () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });

  it("honours the length parameter and distinguishes look-alike types", () => {
    expect(hashValue("x")).toHaveLength(16);
    expect(hashValue("x", 8)).toHaveLength(8);
    expect(hashValue(1)).not.toBe(hashValue("1"));
    expect(hashValue(null)).not.toBe(hashValue("null"));
  });
});
