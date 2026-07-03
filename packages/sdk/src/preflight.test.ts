// ───────────────────────────── Tests: Preflight (Provider-Profile vor dem Loop validieren) ─────────────────────────────
// Deterministisch, ohne Netz (OllamaModel mit injiziertem fetchImpl als Erreichbarkeits-Stub).

import { describe, expect, it } from "vitest";
import type { FeaturePack } from "@elio/core";
import { OllamaModel } from "./models/ollama";
import { MockModel } from "./models/mock";
import type { ProviderMap } from "./models/worker";
import { collectModelRefs, preflightFeature } from "./preflight";

/** Minimaler Pack, dessen einziger Step ein Provider-Profil pinnt (oder keines, wenn provider weggelassen). */
function packPinning(provider?: string, model?: string): FeaturePack {
  const withCfg: Record<string, unknown> = { prompt: "hi" };
  if (provider !== undefined) withCfg["provider"] = provider;
  if (model !== undefined) withCfg["model"] = model;
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id: "t.pre", version: "0.0.0" },
    contentHash: "t.pre@0.0.0",
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "always-pass" },
      io: { input: {}, output: {} },
      graph: { state: {}, steps: [{ id: "ask", type: "agent", with: withCfg }], edges: [] },
    },
  } as FeaturePack;
}

/** OllamaModel, dessen /api/tags-Probe ok ODER fehlschlägt (Erreichbarkeit simulieren). */
function ollamaProfile(reachable: boolean): OllamaModel {
  const fetchImpl = (async (): Promise<Response> => {
    if (!reachable) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return new OllamaModel({ baseUrl: "http://localhost:11434", fetchImpl });
}

describe("collectModelRefs", () => {
  it("sammelt Steps mit gepinntem provider, ignoriert Steps ohne provider", () => {
    expect(collectModelRefs(packPinning("ollama", "llama3"))).toEqual([
      { step: "ask", provider: "ollama", model: "llama3" },
    ]);
    expect(collectModelRefs(packPinning(undefined, "llama3"))).toEqual([]);
    expect(collectModelRefs(packPinning())).toEqual([]);
  });
});

describe("preflightFeature", () => {
  it("ok, wenn das gepinnte Profil definiert UND erreichbar ist", async () => {
    const providers: ProviderMap = { mock: new MockModel(), ollama: ollamaProfile(true) };
    const report = await preflightFeature(packPinning("ollama", "llama3"), { providers });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it("Fehler, wenn das gepinnte Profil NICHT konfiguriert ist", async () => {
    const providers: ProviderMap = { mock: new MockModel() };
    const report = await preflightFeature(packPinning("ollama", "llama3"), { providers });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/not configured/);
  });

  it("Fehler, wenn das Profil definiert, aber nicht erreichbar ist", async () => {
    const providers: ProviderMap = { mock: new MockModel(), ollama: ollamaProfile(false) };
    const report = await preflightFeature(packPinning("ollama", "llama3"), { providers });
    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toMatch(/not reachable/);
  });

  it("checkReachable:false prüft nur 'definiert' (kein Probe)", async () => {
    const providers: ProviderMap = { mock: new MockModel(), ollama: ollamaProfile(false) };
    const report = await preflightFeature(packPinning("ollama", "llama3"), {
      providers,
      checkReachable: false,
    });
    expect(report.ok).toBe(true);
  });

  it("ok (trivial), wenn das Feature gar kein Profil pinnt", async () => {
    const providers: ProviderMap = { mock: new MockModel() };
    const report = await preflightFeature(packPinning(), { providers });
    expect(report.ok).toBe(true);
    expect(report.referenced).toEqual([]);
  });
});
