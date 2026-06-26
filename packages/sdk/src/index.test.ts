import { describe, expect, it } from "vitest";
import { ELIO_CORE_VERSION, ELIO_SDK_VERSION } from "@elio/sdk";

describe("@elio/sdk", () => {
  it("re-exports @elio/core and exposes its own version", () => {
    expect(ELIO_CORE_VERSION).toBe("0.0.0"); // proves sdk -> core wiring at runtime
    expect(ELIO_SDK_VERSION).toBe("0.0.0");
  });
});
