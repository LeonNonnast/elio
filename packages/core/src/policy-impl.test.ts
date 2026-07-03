import { describe, expect, it } from "vitest";
import {
  applyPolicy,
  DATA_CLASSIFICATION_ORDER,
  dataClassRank,
  maxDataClass,
  maxSuspendMode,
  rootPolicy,
  SUSPEND_MODE_ORDER,
  suspendModeRank,
  tighten,
} from "@elio/core";
import type { CapabilityRequest, Policy, ResolvedPolicy } from "@elio/core";

describe("orderings", () => {
  it("data classification order is public<internal<confidential<private<regulated", () => {
    expect([...DATA_CLASSIFICATION_ORDER]).toEqual([
      "public",
      "internal",
      "confidential",
      "private",
      "regulated",
    ]);
    expect(dataClassRank("public")).toBeLessThan(dataClassRank("regulated"));
    expect(maxDataClass("internal", "regulated")).toBe("regulated");
    expect(maxDataClass("private", "public")).toBe("private");
  });

  it("suspend mode order is optional<timeout<parked<blocking (more oversight = tighter)", () => {
    expect([...SUSPEND_MODE_ORDER]).toEqual(["optional", "timeout", "parked", "blocking"]);
    expect(suspendModeRank("optional")).toBeLessThan(suspendModeRank("blocking"));
    expect(maxSuspendMode("optional", "blocking")).toBe("blocking");
    expect(maxSuspendMode("parked", "timeout")).toBe("parked");
  });
});

describe("rootPolicy", () => {
  it("is permissive-by-default loosest root", () => {
    const root = rootPolicy();
    expect(root.allowCloud).toBe(false);
    expect(root.dataClassification).toBe("internal");
    expect(root.suspendMode).toBe("optional");
    expect(root.allowedModels).toEqual([]);
    expect(root.toolPermissions).toEqual([]);
  });

  it("accepts overrides for grants and defensively copies the set axes", () => {
    const models = ["gpt", "ollama"];
    const root = rootPolicy({ allowedModels: models });
    expect(root.allowedModels).toEqual(["gpt", "ollama"]);
    models.push("leak");
    expect(root.allowedModels).toEqual(["gpt", "ollama"]); // not aliased to caller array
  });
});

describe("tighten — monotone restrictive (Inv. 13)", () => {
  const parent: ResolvedPolicy = rootPolicy({
    allowedModels: ["ollama", "claude"],
    allowCloud: true,
    toolPermissions: ["read", "write"],
    dbScopes: ["sales", "hr"],
    fsPaths: { read: ["/data"], write: ["/data/out"] },
    maxCostUsd: 10,
  });

  it("model/tool/db are set-INTERSECTION with parent, never substitution", () => {
    const req: CapabilityRequest = {
      models: ["claude", "azure"], // azure not in parent -> dropped
      tools: ["write", "exec"], // exec not in parent -> dropped
      db: ["hr", "finance"], // finance not in parent -> dropped
    };
    const r = tighten(parent, req);
    expect(r.allowedModels).toEqual(["claude"]);
    expect(r.toolPermissions).toEqual(["write"]);
    expect(r.dbScopes).toEqual(["hr"]);
  });

  it("cannot add an unrequested capability (security by absence)", () => {
    const r = tighten(parent, {}); // requests nothing
    expect(r.allowedModels).toEqual([]);
    expect(r.toolPermissions).toEqual([]);
    expect(r.dbScopes).toBeUndefined();
    expect(r.fsPaths).toBeUndefined();
    // a node that asks for nothing gets nothing — even though parent grants plenty.
  });

  it("allowCloud = parent.allowCloud && !!req.cloud (cannot turn cloud on against parent)", () => {
    const noCloudParent = rootPolicy({ allowCloud: false });
    expect(tighten(noCloudParent, { cloud: true }).allowCloud).toBe(false); // parent denies
    expect(tighten(parent, { cloud: true }).allowCloud).toBe(true);
    expect(tighten(parent, { cloud: false }).allowCloud).toBe(false);
    expect(tighten(parent, {}).allowCloud).toBe(false);
  });

  it("fsPaths are prefix-intersection of wanted paths with allowed prefixes", () => {
    const r = tighten(parent, {
      fs: { read: ["/data/sub/file.csv", "/etc/passwd"], write: ["/data/out/x", "/tmp/y"] },
    });
    expect(r.fsPaths).toEqual({
      read: ["/data/sub/file.csv"], // /etc/passwd not under /data
      write: ["/data/out/x"], // /tmp/y not under /data/out
    });
  });

  it("maxCostUsd is min(parent, ...) and data/suspend cannot be loosened by a request", () => {
    const r = tighten(parent, { models: ["claude"] });
    expect(r.maxCostUsd).toBe(10);
    // a request never lowers data-class or suspend-mode below the parent
    expect(r.dataClassification).toBe(parent.dataClassification);
    expect(r.suspendMode).toBe(parent.suspendMode);
  });

  it("is idempotent / monotone: tighten of an already-tightened policy never re-grants", () => {
    const once = tighten(parent, { models: ["claude"], tools: ["write"], db: ["hr"] });
    // re-tighten with the SAME request against the tightened policy as parent
    const twice = tighten(once, { models: ["claude", "ollama"], tools: ["write", "read"], db: ["hr", "sales"] });
    // ollama/read/sales were dropped by the first tighten -> cannot reappear
    expect(twice.allowedModels).toEqual(["claude"]);
    expect(twice.toolPermissions).toEqual(["write"]);
    expect(twice.dbScopes).toEqual(["hr"]);
  });
});

describe("applyPolicy — interceptor can only tighten", () => {
  const parent = rootPolicy({
    allowedModels: ["ollama", "claude"],
    allowCloud: true,
    toolPermissions: ["read", "write"],
    dataClassification: "internal",
    suspendMode: "optional",
  });

  it("a well-behaved policy that restricts is applied", () => {
    const restrict: Policy = {
      id: "no-cloud-raise-oversight",
      scope: (_req, p): ResolvedPolicy => ({
        ...p,
        allowCloud: false,
        suspendMode: "blocking",
        dataClassification: "confidential",
      }),
    };
    const out = applyPolicy(parent, restrict);
    expect(out.allowCloud).toBe(false);
    expect(out.suspendMode).toBe("blocking");
    expect(out.dataClassification).toBe("confidential");
  });

  it("a misbehaving policy that tries to LOOSEN is defensively clamped", () => {
    const loosen: Policy = {
      id: "evil-loosen",
      scope: (_req, p): ResolvedPolicy => ({
        ...p,
        allowedModels: [...p.allowedModels, "azure-secret"], // try to ADD a model
        allowCloud: true,
        suspendMode: "optional", // try to lower oversight
        dataClassification: "public", // try to lower classification
        toolPermissions: [...p.toolPermissions, "exec"], // try to ADD a tool
      }),
    };
    const tightParent = rootPolicy({
      allowedModels: ["ollama"],
      allowCloud: false,
      toolPermissions: ["read"],
      dataClassification: "confidential",
      suspendMode: "blocking",
    });
    const out = applyPolicy(tightParent, loosen);
    expect(out.allowedModels).toEqual(["ollama"]); // azure-secret rejected
    expect(out.toolPermissions).toEqual(["read"]); // exec rejected
    expect(out.allowCloud).toBe(false); // cannot turn cloud on
    expect(out.suspendMode).toBe("blocking"); // cannot lower oversight
    expect(out.dataClassification).toBe("confidential"); // cannot lower classification
  });
});
