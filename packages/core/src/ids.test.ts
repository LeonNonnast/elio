import { describe, expect, it } from "vitest";
import { corrKey, newBranchId, newRunId, newStepCheckpointId } from "@elio/core";

describe("ids", () => {
  it("generates prefixed unique ids", () => {
    const r1 = newRunId();
    const r2 = newRunId();
    expect(r1).toMatch(/^run_/);
    expect(newBranchId()).toMatch(/^branch_/);
    expect(newStepCheckpointId()).toMatch(/^cp_/);
    expect(r1).not.toBe(r2);
  });

  it("corrKey is deterministic over the full correlation tuple", () => {
    const c = { run: "run_1", branch: "b", step: "s", checkpoint: "cp" };
    expect(corrKey(c)).toBe("run_1::b::s::cp");
    expect(corrKey(c)).toBe(corrKey({ ...c }));
    expect(corrKey(c)).not.toBe(corrKey({ ...c, step: "s2" }));
  });
});
