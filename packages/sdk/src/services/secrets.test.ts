// ───────────────────────────── EnvSecretsProvider + end-to-end tape redaction (§11/#8/#9) ─────────────────────────────

import { describe, expect, it } from "vitest";
import { EnvSecretsProvider } from "./secrets";
import { createRuntime, collectEvents } from "../runtime";
import type { Ctx, FeaturePack, NodeDefinition } from "@elio/core";

describe("EnvSecretsProvider", () => {
  it("resolves names from a provided env map (ungescoped)", () => {
    const p = new EnvSecretsProvider({ env: { DB_PASSWORD: "pw", OTHER: "x" } });
    expect(p.has("DB_PASSWORD")).toBe(true);
    expect(p.get("DB_PASSWORD")).toBe("pw");
    expect(p.has("MISSING")).toBe(false);
    expect(p.get("MISSING")).toBeUndefined();
  });

  it("supports a name prefix (e.g. ELIO_SECRET_)", () => {
    const p = new EnvSecretsProvider({ env: { ELIO_SECRET_API_KEY: "ak" }, prefix: "ELIO_SECRET_" });
    expect(p.has("API_KEY")).toBe(true);
    expect(p.get("API_KEY")).toBe("ak");
  });

  it("defaults to process.env when no env is given", () => {
    process.env["ELIO_TEST_SECRET_XYZ"] = "from-process";
    try {
      const p = new EnvSecretsProvider();
      expect(p.get("ELIO_TEST_SECRET_XYZ")).toBe("from-process");
    } finally {
      delete process.env["ELIO_TEST_SECRET_XYZ"];
    }
  });
});

describe("end-to-end: a secret resolved in a node never appears raw in the tape", () => {
  function packUsingSecret(): FeaturePack {
    return {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.secret-user", version: "1", owner: "t" },
      contentHash: "t.secret-user@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: {
          state: {},
          steps: [{ id: "use-secret", type: "use-secret" }],
          edges: [],
        },
      },
    };
  }

  it("the resolved value is auto-redacted from input + output in the persisted tape", async () => {
    const SECRET = "s3cr3t-db-value-987";
    const rt = createRuntime({
      secretsProvider: new EnvSecretsProvider({ env: { DB_PASSWORD: SECRET } }),
      // grant the secret tool at the root so tighten lets the node have it
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "confidential",
        suspendMode: "optional",
        toolPermissions: ["secret:DB_PASSWORD"],
      },
    });

    // a node that resolves the secret and echoes it into its output (the worst case for leakage)
    const useSecret: NodeDefinition = {
      type: "use-secret",
      klass: "orchestration",
      requests: { tools: ["secret:DB_PASSWORD"] },
      handler: async (_input: unknown, ctx: Ctx) => {
        if (ctx.secrets === undefined) throw new Error("expected ctx.secrets to be present");
        const value = await ctx.secrets.resolve({ name: "DB_PASSWORD" });
        return {
          status: "resolved" as const,
          output: { connectionString: `postgres://u:${value}@h/db`, raw: value },
          confidence: 1,
          cost: { usd: 0 },
        };
      },
    };
    rt.registry.register(useSecret);
    rt.registry.register({
      type: "pass-gate",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({ status: "resolved" as const, output: { passed: true, failures: [] }, confidence: 1, cost: {} }),
    });

    const events = await collectEvents(rt.run(packUsingSecret(), { payload: {}, budget: 100, maxDepth: 5 }));
    const started = events.find((e) => e.type === "run-started");
    const runId = started!.correlation.run;

    const tape = rt.store.getTape(runId);
    const serialized = JSON.stringify(tape);
    // the raw secret value MUST NOT appear anywhere in the persisted tape
    expect(serialized).not.toContain(SECRET);
    // it IS redacted in place
    expect(serialized).toContain("[redacted:secret]");

    // the use-secret frame carries the redaction projection
    const frame = tape.find((f) => f.nodeType === "use-secret");
    expect(frame).toBeDefined();
    expect(frame!.redaction?.redactedFields.length).toBeGreaterThan(0);
    // and audit shows the secrets capability was injected (what was possible)
    expect(frame!.injected).toContain("secrets");
  });

  it("a secret echoed in a Failed.error.message is redacted in the DEAD-LETTER frame (§11/#8, Inv. 15)", async () => {
    const SECRET = "dead-letter-secret-pw-4242";
    const rt = createRuntime({
      secretsProvider: new EnvSecretsProvider({ env: { DB_PASSWORD: SECRET } }),
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "confidential",
        suspendMode: "optional",
        toolPermissions: ["secret:DB_PASSWORD"],
      },
    });

    // Node resolves the secret, then THROWS an error whose message echoes it (e.g. a DB error echoing a
    // templated secret in the SQL). retry exhausts with onExhausted:"fail" -> the runner writes a
    // dead-letter frame. The dead-letter result is the full Failed, so error.message carries the secret;
    // it MUST be redacted before persistence (the leak this fix closes — writeDeadLetter now goes through
    // the redactor).
    const leaky: NodeDefinition = {
      type: "leaky-fail",
      klass: "orchestration",
      requests: { tools: ["secret:DB_PASSWORD"] },
      retry: { maxAttempts: 1, onExhausted: "fail" },
      handler: async (_input: unknown, ctx: Ctx) => {
        const value = await ctx.secrets!.resolve({ name: "DB_PASSWORD" });
        throw new Error(`cannot parse INSERT: "INSERT INTO t (pw) VALUES ('${value}')"`);
      },
    };
    rt.registry.register(leaky);
    rt.registry.register({
      type: "pass-gate",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({ status: "resolved" as const, output: { passed: true, failures: [] }, confidence: 1, cost: {} }),
    });

    const pack: FeaturePack = {
      apiVersion: "elio/v1",
      kind: "Feature",
      metadata: { id: "t.leaky-deadletter", version: "1", owner: "t" },
      contentHash: "t.leaky-deadletter@1",
      feature: {
        autonomy: "static",
        artifact: { kind: "note", evalGate: "pass-gate" },
        io: { input: {}, output: {} },
        graph: { state: {}, steps: [{ id: "x", type: "leaky-fail" }], edges: [] },
      },
    };

    const events = await collectEvents(rt.run(pack, { payload: {}, budget: 100, maxDepth: 5 }));
    const runId = events.find((e) => e.type === "run-started")!.correlation.run;
    const tape = rt.store.getTape(runId);

    // there IS a dead-letter frame (onExhausted=fail)
    const dead = tape.find((f) => f.nodeType === "dead-letter");
    expect(dead).toBeDefined();
    // the secret MUST NOT appear raw ANYWHERE in the tape — including the dead-letter frame
    const serialized = JSON.stringify(tape);
    expect(serialized).not.toContain(SECRET);
    // the dead-letter frame's error.message specifically is masked
    if (dead!.result.status === "failed") {
      expect(dead!.result.error.message).toContain("[redacted:secret]");
      expect(dead!.result.error.message).not.toContain(SECRET);
    }
  });
});
