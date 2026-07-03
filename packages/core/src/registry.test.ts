import { describe, expect, it } from "vitest";
import { NodeRegistry } from "@elio/core";
import type { NodeDefinition } from "@elio/core";

const transform: NodeDefinition = {
  type: "transform",
  klass: "orchestration",
  handler: (input) =>
    Promise.resolve({ status: "resolved", output: input, confidence: 1, cost: {} }),
};

describe("NodeRegistry", () => {
  it("registers and resolves a node definition", () => {
    const reg = new NodeRegistry();
    expect(reg.has("transform")).toBe(false);
    reg.register(transform);
    expect(reg.has("transform")).toBe(true);
    expect(reg.resolve("transform")).toBe(transform);
    expect(reg.list()).toEqual(["transform"]);
  });

  it("throws on resolving an unregistered type (§4 step 6)", () => {
    const reg = new NodeRegistry();
    expect(() => reg.resolve("nope")).toThrow(/no.*registriert|kein Node-Typ/i);
  });

  it("re-registering a type overwrites it (built-in == custom, Inv. 6)", () => {
    const reg = new NodeRegistry();
    reg.register(transform);
    const custom: NodeDefinition = { ...transform, klass: "intelligence" };
    reg.register(custom);
    expect(reg.resolve("transform").klass).toBe("intelligence");
    expect(reg.list()).toEqual(["transform"]);
  });
});
