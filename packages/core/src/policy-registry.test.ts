import { describe, expect, it } from "vitest";
import { PolicyRegistry, resolvePolicies } from "./policy-registry";
import type { Policy, ResolvedPolicy } from "./policy";

function passthrough(id: string): Policy {
  return { id, scope: (_req, p): ResolvedPolicy => p };
}

describe("PolicyRegistry (Inv. 13, §4 step 2)", () => {
  it("register/resolve/has/list", () => {
    const reg = new PolicyRegistry();
    expect(reg.has("a")).toBe(false);
    const a = passthrough("a");
    reg.register(a);
    expect(reg.has("a")).toBe(true);
    expect(reg.resolve("a")).toBe(a);
    expect(reg.list()).toEqual(["a"]);
  });

  it("resolve throws for an unregistered id", () => {
    const reg = new PolicyRegistry();
    expect(() => reg.resolve("missing")).toThrow(/keine Policy "missing"/);
  });

  it("register overwrites a same-id policy", () => {
    const reg = new PolicyRegistry();
    const first = passthrough("x");
    const second = passthrough("x");
    reg.register(first);
    reg.register(second);
    expect(reg.resolve("x")).toBe(second);
    expect(reg.list()).toEqual(["x"]); // not duplicated
  });

  it("resolvePolicies maps ids to policies in declaration order", () => {
    const reg = new PolicyRegistry();
    reg.register(passthrough("a"));
    reg.register(passthrough("b"));
    const out = resolvePolicies(["b", "a"], reg);
    expect(out.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("resolvePolicies throws on the first missing id", () => {
    const reg = new PolicyRegistry();
    reg.register(passthrough("a"));
    expect(() => resolvePolicies(["a", "nope"], reg)).toThrow(/keine Policy "nope"/);
  });
});
