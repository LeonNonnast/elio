import { describe, expect, it } from "vitest";
import { approvalHandler, approvalNode } from "./approval";
import { DefaultElicitService } from "../injector";
import type { Ctx } from "../ctx";

/** Minimal-ctx mit einem ElicitService (Default-Mode wählbar). */
function ctxWithElicit(defaultMode: "blocking" | "optional" | "parked" | "timeout"): Ctx {
  return { elicit: new DefaultElicitService(defaultMode) } as unknown as Ctx;
}

describe("approval node (Slice 2, Inv. 11/12)", () => {
  it("is registered as an orchestration node", () => {
    expect(approvalNode.type).toBe("approval");
    expect(approvalNode.klass).toBe("orchestration");
  });

  it("raises a Suspended elicitation via ctx.elicit", async () => {
    const res = await approvalHandler(
      { reason: "Commit ins Prod-Ziel", mode: "blocking" },
      ctxWithElicit("optional"),
    );
    expect(res.status).toBe("suspended");
    if (res.status !== "suspended") throw new Error("not suspended");
    expect(res.elicitation.what).toBe("Commit ins Prod-Ziel");
    // explicit mode "blocking" wins over the ElicitService default ("optional")
    expect(res.elicitation.mode).toBe("blocking");
    expect(res.elicitation.whoCanAnswer).toEqual({ users: ["operator"] });
  });

  it("defaults reason/whoCanAnswer and falls back to blocking when no mode given", async () => {
    // no explicit cfg.mode -> the handler defaults to "blocking" itself (approval is an
    // oversight gate), independent of the ElicitService default.
    const res = await approvalHandler({}, ctxWithElicit("optional"));
    if (res.status !== "suspended") throw new Error("not suspended");
    expect(res.elicitation.what).toBe("approval required");
    expect(res.elicitation.whoCanAnswer).toEqual({ users: ["operator"] });
    expect(res.elicitation.mode).toBe("blocking");
  });

  it("passes through a schema when provided", async () => {
    const schema = { type: "object" };
    const res = await approvalHandler({ schema }, ctxWithElicit("blocking"));
    if (res.status !== "suspended") throw new Error("not suspended");
    expect(res.elicitation.schema).toEqual(schema);
  });

  it("throws when ctx.elicit is absent (no silent governance bypass)", () => {
    // the handler throws synchronously (tryWithRetry in the runner catches it into Failed);
    // here we assert the guard directly.
    expect(() => approvalHandler({}, {} as unknown as Ctx)).toThrow(/ctx\.elicit/);
  });
});
