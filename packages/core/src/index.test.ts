import { describe, expect, it } from "vitest";
import { ELIO_CORE_VERSION } from "@elio/core";

describe("@elio/core", () => {
  it("exposes a runtime version marker", () => {
    expect(ELIO_CORE_VERSION).toBe("0.0.0");
  });
});
