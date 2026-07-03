import { describe, expect, it } from "vitest";
import { hashValue, memoLookupHandler } from "@elio/core";
import type { Ctx, MemoLookupWith, NodeResult } from "@elio/core";

const CTX = {} as unknown as Ctx; // memo-lookup uses no ctx services

function out(r: NodeResult): Record<string, unknown> {
  if (r.status !== "resolved") throw new Error(`expected resolved, got ${r.status}`);
  return r.output as Record<string, unknown>;
}

describe("nodes/memo — memo-lookup", () => {
  const lookup = [{ inputHash: hashValue({ prompt: "x" }), output: { text: "MEMOIZED" } }];

  it("returns the memoized output + hit flag true on a hit (key order independent)", async () => {
    const cfg: MemoLookupWith = { probe: { prompt: "x" }, lookup, hitFlag: "__h" };
    const o = out(await memoLookupHandler(cfg, CTX));
    expect(o["text"]).toBe("MEMOIZED");
    expect(o["__h"]).toBe(true);
  });

  it("returns only hit flag false on a miss (out of domain)", async () => {
    const cfg: MemoLookupWith = { probe: { prompt: "z" }, lookup, hitFlag: "__h" };
    const o = out(await memoLookupHandler(cfg, CTX));
    expect(o["__h"]).toBe(false);
    expect(o["text"]).toBeUndefined();
  });

  it("defaults the hit flag to __memoHit and wraps a non-object memoized value under {value}", async () => {
    const cfg: MemoLookupWith = {
      probe: 42,
      lookup: [{ inputHash: hashValue(42), output: "SCALAR" }],
    };
    const o = out(await memoLookupHandler(cfg, CTX));
    expect(o["__memoHit"]).toBe(true);
    expect(o["value"]).toBe("SCALAR");
  });

  it("decodes a base64 lookup (lookupB64) and serves template-looking outputs verbatim", async () => {
    // A memoized LLM answer containing template syntax must survive verbatim (the reason for base64).
    const memoized = { text: "use {{state.x}} here" };
    const b64 = Buffer.from(JSON.stringify([{ inputHash: hashValue({ prompt: "x" }), output: memoized }]), "utf8").toString("base64");
    const o = out(await memoLookupHandler({ probe: { prompt: "x" }, lookupB64: b64, hitFlag: "__h" }, CTX));
    expect(o["text"]).toBe("use {{state.x}} here");
    expect(o["__h"]).toBe(true);
  });
});
