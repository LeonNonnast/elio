// ───────────────────────────── Tests: Named Provider Profiles (Schema/Loader/Registry + Resolver + Cost) ─────────────────────────────
// Deterministisch, kein Netz (skipProfilesFile + disableAutoDetect + fake Secrets/fetch).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretsProvider } from "@elio/core";
import {
  clearRegisteredProfiles,
  collectProfiles,
  findProfilesFile,
  listRegisteredProfiles,
  loadProfilesFromFile,
  registerProfile,
  validateProfile,
} from "./profile-config";
import { resolveProviderProfiles } from "./profiles";
import { OllamaModel } from "./ollama";
import { ClaudeModel } from "./claude";
import { LlmWorker } from "./worker";
import { MockModel } from "./mock";

/** Fake SecretsProvider über einer Map. */
function fakeSecrets(map: Record<string, string>): SecretsProvider {
  return { has: (n) => n in map, get: (n) => map[n] };
}

beforeEach(() => clearRegisteredProfiles());
afterEach(() => clearRegisteredProfiles());

describe("profile-config: Registry + Validierung", () => {
  it("registerProfile + list + clear", () => {
    registerProfile({ name: "x", kind: "mock" });
    expect(listRegisteredProfiles().map((p) => p.name)).toEqual(["x"]);
    clearRegisteredProfiles();
    expect(listRegisteredProfiles()).toEqual([]);
  });

  it("validateProfile lehnt unbekannten kind + Doppelpunkt im Namen ab", () => {
    expect(() => validateProfile({ name: "a", kind: "bogus" as never }, "t")).toThrow(/unknown kind/);
    expect(() => validateProfile({ name: "a:b", kind: "mock" }, "t")).toThrow(/must not contain ':'/);
  });
});

describe("profile-config: Datei-Loader (YAML map + JSON array)", () => {
  it("lädt die map-Form (name als Key) und die array-Form", () => {
    const dir = mkdtempSync(join(tmpdir(), "elio-profiles-"));
    const yamlPath = join(dir, "elio.profiles.yaml");
    writeFileSync(
      yamlPath,
      "profiles:\n  fast-local:\n    kind: ollama\n    baseUrl: http://h:11434\n    cost: { tier: free }\n",
      "utf8",
    );
    const fromYaml = loadProfilesFromFile(yamlPath);
    expect(fromYaml).toHaveLength(1);
    expect(fromYaml[0]).toMatchObject({ name: "fast-local", kind: "ollama", baseUrl: "http://h:11434" });

    const jsonPath = join(dir, "elio.profiles.json");
    writeFileSync(jsonPath, JSON.stringify({ profiles: [{ name: "p", kind: "claude" }] }), "utf8");
    expect(loadProfilesFromFile(jsonPath).map((p) => p.name)).toEqual(["p"]);
  });

  it("findProfilesFile respektiert $ELIO_PROFILES", () => {
    const dir = mkdtempSync(join(tmpdir(), "elio-profiles-"));
    const p = join(dir, "elio.profiles.yaml");
    writeFileSync(p, "profiles: {}\n", "utf8");
    expect(findProfilesFile({ env: { ELIO_PROFILES: p } })).toBe(p);
    expect(findProfilesFile({ env: {}, cwd: dir })).toBe(p);
  });

  it("collectProfiles merged Registry + explizit (explizit gewinnt)", () => {
    registerProfile({ name: "a", kind: "mock", defaultModel: "from-registry" });
    const merged = collectProfiles({
      skipFile: true,
      profiles: [{ name: "a", kind: "mock", defaultModel: "from-explicit" }],
    });
    expect(merged.find((p) => p.name === "a")?.defaultModel).toBe("from-explicit");
  });
});

describe("resolveProviderProfiles: benannte Profile", () => {
  const noNet = { skipProfilesFile: true, disableAutoDetect: true, env: {} as Record<string, string> };

  it("baut Provider keyed by Profilname + allowedModels-Wildcard + costs aus usdPerMTok", async () => {
    const r = await resolveProviderProfiles({
      ...noNet,
      secrets: fakeSecrets({ azkey: "secret-value" }),
      profiles: [
        {
          name: "prod-azure",
          kind: "azure-openai",
          endpoint: "https://e",
          deployment: "gpt-4o",
          apiKeySecret: "azkey",
          cost: { tier: "high", usdPerMTok: { in: 2.5, out: 10 } },
        },
      ],
    });
    expect(r.available).toContain("prod-azure");
    expect(r.allowedModels).toContain("prod-azure:*");
    expect(r.costs["prod-azure"]).toEqual({ in: 2.5, out: 10 });
    expect(r.profiles.map((p) => p.name)).toContain("prod-azure");
  });

  it("löst apiKeySecret über den SecretsProvider auf (claude isConfigured)", async () => {
    const withKey = await resolveProviderProfiles({
      ...noNet,
      secrets: fakeSecrets({ anthropic: "sk-xyz" }),
      profiles: [{ name: "review", kind: "claude", apiKeySecret: "anthropic" }],
    });
    expect((withKey.providers["review"] as ClaudeModel).isConfigured()).toBe(true);

    const noKey = await resolveProviderProfiles({
      ...noNet,
      secrets: fakeSecrets({}),
      profiles: [{ name: "review", kind: "claude", apiKeySecret: "anthropic" }],
    });
    expect((noKey.providers["review"] as ClaudeModel).isConfigured()).toBe(false);
  });

  it("ein benanntes 'ollama'-Profil gewinnt über den Built-in (eigene baseUrl)", async () => {
    const r = await resolveProviderProfiles({
      ...noNet,
      profiles: [{ name: "ollama", kind: "ollama", baseUrl: "http://custom:9999" }],
    });
    expect((r.providers["ollama"] as OllamaModel).baseUrl).toBe("http://custom:9999");
  });
});

describe("LlmWorker: cost.usd aus Profil-Richtwert", () => {
  it("stempelt cost.usd aus den Token-Counts, wenn ein Richtwert für den Profil-Präfix gesetzt ist", async () => {
    const worker = new LlmWorker({
      providers: { prod: new MockModel() },
      defaultModel: "mock",
      costs: { prod: { in: 2, out: 8 } },
    });
    const res = await worker.complete({ prompt: "hello world", model: "prod:gpt-x" });
    expect(res.cost.model).toBe("prod:gpt-x");
    const tin = res.cost.tokensIn ?? 0;
    const tout = res.cost.tokensOut ?? 0;
    expect(res.cost.usd).toBeCloseTo((tin / 1_000_000) * 2 + (tout / 1_000_000) * 8, 12);
    expect(res.cost.usd).toBeGreaterThan(0);
  });
});
