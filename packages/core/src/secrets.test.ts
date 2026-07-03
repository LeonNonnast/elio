// ───────────────────────────── Secrets + security-by-absence ENFORCEMENT (Inv. 14/15, §11/#8/#9) ─────────────────────────────

import { describe, expect, it } from "vitest";
import {
  allowedSecretNames,
  BudgetTracker,
  createArtifact,
  PolicyInjector,
  rootPolicy,
  ScopedSecretsService,
  TapeRedactor,
} from "@elio/core";
import type {
  Artifact,
  ArtifactType,
  CorrelationId,
  Ctx,
  DbService,
  FsService,
  ModelService,
  NodeDefinition,
  SecretsProvider,
  TapeFrame,
} from "@elio/core";

const type: ArtifactType = { kind: "demo", holders: ["memory"] };
const artifact: Artifact = createArtifact(type, {});
const corr: CorrelationId = { run: "r", branch: "b", step: "s", checkpoint: "c" };

const model: ModelService = { complete: () => Promise.resolve({ text: "hi", cost: {}, confidence: 1 }) };
const fs: FsService = { read: () => Promise.resolve("x"), write: () => Promise.resolve() };
const db: DbService = { query: () => Promise.resolve([]) };

/** Test-Provider: kennt zwei Secrets. */
const provider: SecretsProvider = {
  has: (n) => n === "DB_PASSWORD" || n === "API_KEY",
  get: (n) =>
    n === "DB_PASSWORD" ? "s3cr3t-db-value" : n === "API_KEY" ? "ak-live-12345" : undefined,
};

function node(over: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    type: "test",
    klass: "orchestration",
    handler: () => Promise.resolve({ status: "resolved", output: {}, confidence: 1, cost: {} }),
    ...over,
  };
}

// ───────────────────────────── security by absence (Inv. 14): ABSENT, not blocked-by-check ─────────────────────────────

describe("security by absence — a non-granted capability is UNDEFINED on ctx (Inv. 14)", () => {
  // Backends for EVERYTHING are wired into the injector; the node still gets nothing it didn't earn.
  const injector = new PolicyInjector({
    model,
    fs,
    db,
    secretsProvider: provider,
    budget: new BudgetTracker(10, 4),
  });

  it("no fs grant -> ctx.fs is undefined (calling it is impossible, not runtime-blocked)", () => {
    const ctx: Ctx = injector.buildCtx(node(), rootPolicy(), corr, artifact);
    expect(ctx.fs).toBeUndefined();
    // The proof of "absent by construction": there is no object to call. A runtime check would be a
    // defined object that throws; absence means the method literally cannot be invoked.
    expect(() => (ctx.fs as unknown as { read: unknown }).read).toThrow(TypeError);
  });

  it("no db grant -> ctx.db is undefined", () => {
    const ctx: Ctx = injector.buildCtx(node(), rootPolicy(), corr, artifact);
    expect(ctx.db).toBeUndefined();
    expect(() => (ctx.db as unknown as { query: unknown }).query).toThrow(TypeError);
  });

  it("no model grant -> ctx.model is undefined", () => {
    const ctx: Ctx = injector.buildCtx(node(), rootPolicy(), corr, artifact);
    expect(ctx.model).toBeUndefined();
    expect(() => (ctx.model as unknown as { complete: unknown }).complete).toThrow(TypeError);
  });

  it("no secret grant -> ctx.secrets is undefined", () => {
    // node requests NO secret tools; even though a provider is wired, ctx.secrets is absent.
    const ctx: Ctx = injector.buildCtx(node(), rootPolicy(), corr, artifact);
    expect(ctx.secrets).toBeUndefined();
    expect(() => (ctx.secrets as unknown as { resolve: unknown }).resolve).toThrow(TypeError);
  });

  it("serviceKeys omits every non-granted capability (audit = what was possible)", () => {
    const ctx = injector.buildCtx(node(), rootPolicy(), corr, artifact);
    const keys = PolicyInjector.serviceKeys(ctx);
    expect(keys).not.toContain("fs");
    expect(keys).not.toContain("db");
    expect(keys).not.toContain("model");
    expect(keys).not.toContain("secrets");
  });
});

// ───────────────────────────── ctx.secrets injected ONLY when policy grants a "secret:<name>" tool ─────────────────────────────

describe("ctx.secrets — injected only on a granted secret:<name> tool, scoped to allowed names (§11/#8)", () => {
  it("allowedSecretNames derives names from secret:<name> toolPermissions", () => {
    expect(allowedSecretNames(["read", "secret:DB_PASSWORD", "write", "secret:API_KEY"])).toEqual([
      "DB_PASSWORD",
      "API_KEY",
    ]);
    expect(allowedSecretNames(["read", "write"])).toEqual([]);
    expect(allowedSecretNames(["secret:"])).toEqual([]); // empty name ignored
  });

  it("a node that requests secret:DB_PASSWORD (granted by parent) gets a scoped ctx.secrets", async () => {
    const parent = rootPolicy({ toolPermissions: ["secret:DB_PASSWORD"] });
    const injector = new PolicyInjector({ secretsProvider: provider });
    const ctx = injector.buildCtx(
      node({ requests: { tools: ["secret:DB_PASSWORD"] } }),
      parent,
      corr,
      artifact,
    );
    expect(ctx.secrets).toBeDefined();
    expect(ctx.secrets!.has("DB_PASSWORD")).toBe(true);
    await expect(ctx.secrets!.resolve({ name: "DB_PASSWORD" })).resolves.toBe("s3cr3t-db-value");
  });

  it("ctx.secrets is scoped: a name the policy did NOT grant is invisible (has=false, resolve rejects)", async () => {
    // node requests only DB_PASSWORD; API_KEY is in the provider but NOT in scope.
    const parent = rootPolicy({ toolPermissions: ["secret:DB_PASSWORD", "secret:API_KEY"] });
    const injector = new PolicyInjector({ secretsProvider: provider });
    const ctx = injector.buildCtx(
      node({ requests: { tools: ["secret:DB_PASSWORD"] } }), // only DB_PASSWORD survives the intersection
      parent,
      corr,
      artifact,
    );
    expect(ctx.secrets!.has("DB_PASSWORD")).toBe(true);
    expect(ctx.secrets!.has("API_KEY")).toBe(false); // not requested -> out of scope
    await expect(ctx.secrets!.resolve({ name: "API_KEY" })).rejects.toThrow(/denied|scope/i);
  });

  it("a secret tool the PARENT does not grant is dropped by tighten -> no ctx.secrets", () => {
    const parent = rootPolicy({ toolPermissions: ["read"] }); // no secret:* in parent
    const injector = new PolicyInjector({ secretsProvider: provider });
    const ctx = injector.buildCtx(
      node({ requests: { tools: ["secret:DB_PASSWORD"] } }), // dropped: not in parent
      parent,
      corr,
      artifact,
    );
    expect(ctx.secrets).toBeUndefined();
  });

  it("a granted secret tool but NO provider wired still yields no ctx.secrets", () => {
    const parent = rootPolicy({ toolPermissions: ["secret:DB_PASSWORD"] });
    const injector = new PolicyInjector({}); // no provider
    const ctx = injector.buildCtx(
      node({ requests: { tools: ["secret:DB_PASSWORD"] } }),
      parent,
      corr,
      artifact,
    );
    expect(ctx.secrets).toBeUndefined();
  });
});

// ───────────────────────────── ScopedSecretsService registers resolved values with the redactor (§11/#9) ─────────────────────────────

describe("ScopedSecretsService — auto-redaction: resolved values are registered with the redactor", () => {
  it("resolve() registers the value so the tape redactor scrubs it everywhere", async () => {
    const redactor = new TapeRedactor();
    const svc = new ScopedSecretsService(provider, ["DB_PASSWORD"], redactor);

    expect(redactor.has("s3cr3t-db-value")).toBe(false);
    const value = await svc.resolve({ name: "DB_PASSWORD" });
    expect(value).toBe("s3cr3t-db-value");
    expect(redactor.has("s3cr3t-db-value")).toBe(true);

    // a frame carrying the raw value (in input AND result.output) is fully redacted
    const frame: TapeFrame = {
      correlation: corr,
      nodeType: "db",
      input: { conn: `postgres://user:${value}@host/db`, note: "ok" },
      result: { status: "resolved", output: { echoed: value }, confidence: 1, cost: {} },
      injected: ["secrets", "db"],
      ts: "2026-06-27T00:00:00.000Z",
    };
    const safe = redactor.redactFrame(frame);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("s3cr3t-db-value");
    expect(serialized).toContain("[redacted:secret]");
    expect(safe.redaction?.redactedFields).toContain("input.conn");
    expect(safe.redaction?.redactedFields).toContain("result.output.echoed");
    // untouched fields stay intact
    expect((safe.input as { note: string }).note).toBe("ok");
  });

  it("redactFrame is a no-op (returns the same frame) when no secrets are registered", () => {
    const redactor = new TapeRedactor();
    const frame: TapeFrame = {
      correlation: corr,
      nodeType: "transform",
      input: { x: 1 },
      result: { status: "resolved", output: { y: 2 }, confidence: 1, cost: {} },
      injected: [],
      ts: "2026-06-27T00:00:00.000Z",
    };
    expect(redactor.redactFrame(frame)).toBe(frame);
  });
});
