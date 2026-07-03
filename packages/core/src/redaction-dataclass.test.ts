// ───────────────────────────── Tape-Redaction: data-class projection + scrub (Inv. 15/16/23, §11/#9) ─────────────────────────────

import { describe, expect, it } from "vitest";
import { redact, refHash, scrubTape, TapeRedactor } from "@elio/core";
import type { CorrelationId, TapeFrame } from "@elio/core";

const corr: CorrelationId = { run: "r", branch: "b", step: "s", checkpoint: "c" };

function frame(input: unknown, output: unknown, level?: TapeFrame["redaction"]): TapeFrame {
  const f: TapeFrame = {
    correlation: corr,
    nodeType: "transform",
    input,
    result: { status: "resolved", output, confidence: 1, cost: {} },
    injected: [],
    ts: "2026-06-27T00:00:00.000Z",
  };
  if (level !== undefined) f.redaction = level;
  return f;
}

describe("redact(value, dataClassification) — raw up to the class, hashed above it (§11/#9)", () => {
  it("a confidential field is hashed/redacted while a public field stays raw", () => {
    // threshold = internal: confidential (rank 2) > internal (rank 1) -> projected; public stays raw.
    const value = { publicNote: "visible", confidentialSalary: 95000 };
    const { value: projected, redactedFields } = redact(value, "internal");
    const out = projected as Record<string, unknown>;
    expect(out["publicNote"]).toBe("visible"); // <= threshold -> raw
    expect(typeof out["confidentialSalary"]).toBe("string");
    expect(out["confidentialSalary"]).toMatch(/^\[redacted:[0-9a-f]{12}\]$/); // hash ref
    expect(redactedFields).toContain("confidentialSalary");
    expect(redactedFields).not.toContain("publicNote");
  });

  it("raising the threshold keeps a confidential field raw", () => {
    const value = { confidentialSalary: 95000 };
    const { value: projected, redactedFields } = redact(value, "confidential");
    // threshold = confidential: confidential field is NOT above the threshold -> raw.
    expect((projected as Record<string, unknown>)["confidentialSalary"]).toBe(95000);
    expect(redactedFields).toEqual([]);
  });

  it("a classified container projects its whole subtree as one ref (no leak through)", () => {
    const value = { privateRecord: { ssn: "111-22-3333", name: "Jane" } };
    const { value: projected } = redact(value, "internal");
    // privateRecord is "private" (> internal) -> the WHOLE object becomes one ref string.
    expect(typeof (projected as Record<string, unknown>)["privateRecord"]).toBe("string");
    expect(JSON.stringify(projected)).not.toContain("111-22-3333");
    expect(JSON.stringify(projected)).not.toContain("Jane");
  });

  it("refHash is stable for equal content", () => {
    expect(refHash({ a: 1 })).toBe(refHash({ a: 1 }));
    expect(refHash("x")).not.toBe(refHash("y"));
  });
});

describe("TapeRedactor — data-class projection via configured threshold or frame.redaction.level", () => {
  it("projects above the configured threshold and records redaction", () => {
    const redactor = new TapeRedactor({ dataClassification: "internal" });
    const safe = redactor.redactFrame(
      frame({ publicX: "ok", confidentialY: "hush" }, { result: "fine" }),
    );
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("hush");
    expect((safe.input as Record<string, unknown>)["publicX"]).toBe("ok");
    expect(safe.redaction?.level).toBe("internal");
    expect(safe.redaction?.redactedFields).toContain("input.confidentialY");
  });

  it("falls back to the frame's stamped redaction.level as the threshold", () => {
    // No configured threshold; the runner-stamped level drives projection.
    const redactor = new TapeRedactor();
    const safe = redactor.redactFrame(
      frame({ confidentialZ: "leak" }, {}, { level: "public", redactedFields: [] }),
    );
    // public threshold: confidential is above it -> projected.
    expect(JSON.stringify(safe)).not.toContain("leak");
    expect(safe.redaction?.redactedFields).toContain("input.confidentialZ");
  });

  it("no threshold and no stamp -> no projection (backward compatible, secret-only)", () => {
    const redactor = new TapeRedactor();
    const f = frame({ confidentialZ: "still-here" }, {});
    expect(redactor.redactFrame(f)).toBe(f); // unchanged
  });

  it("a registered secret is ALWAYS masked regardless of data class", () => {
    const SECRET = "top-secret-value-123";
    // threshold = regulated (the loosest projection: nothing is above it) -> data-class projection is OFF,
    // but the secret must STILL be masked.
    const redactor = new TapeRedactor({ dataClassification: "regulated" });
    redactor.register(SECRET);
    const safe = redactor.redactFrame(frame({ publicConn: `db://${SECRET}` }, {}));
    expect(JSON.stringify(safe)).not.toContain(SECRET);
    expect(JSON.stringify(safe)).toContain("[redacted:secret]");
    expect(safe.redaction?.redactedFields).toContain("input.publicConn");
  });
});

describe("scrubTape — rewind the tape to step N (Inv. 15)", () => {
  const tape: TapeFrame[] = [0, 1, 2, 3, 4].map((i) =>
    frame({ step: i }, { i }),
  );

  it("returns the first N frames", () => {
    expect(scrubTape(tape, 3)).toHaveLength(3);
    expect((scrubTape(tape, 3)[2]!.input as { step: number }).step).toBe(2);
  });

  it("clamps: n<=0 -> [], n>=length -> all, and does not mutate the source", () => {
    expect(scrubTape(tape, 0)).toEqual([]);
    expect(scrubTape(tape, 99)).toHaveLength(5);
    expect(tape).toHaveLength(5); // unchanged
  });
});
