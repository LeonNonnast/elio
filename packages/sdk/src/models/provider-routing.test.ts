// ───────────────────────────── Tests: provider:model-Routing + Resolver + Policy-Wildcards (Phase 1) ─────────────────────────────
// Deterministisch, ohne Netz (injiziertes fetchImpl / capturing ModelService).

import { describe, expect, it } from "vitest";
import type { FeaturePack, RunEvent } from "@elio/core";
import { LlmWorker } from "./worker";
import { MockModel } from "./mock";
import { normalizeRequest } from "./types";
import type { CompletionRequest, CompletionResult, ModelService } from "./types";
import { resolveProviderProfiles } from "./profiles";
import { createRuntime, collectEvents } from "../runtime";
import { alwaysPassGate, NOTE_TYPE } from "../demo/retry-then-pass";

/** ModelService, der jeden Request mitschreibt (um zu beweisen, was der Adapter tatsächlich sieht). */
class CapturingModel implements ModelService {
  readonly calls: CompletionRequest[] = [];
  constructor(private readonly text = "a sufficiently long captured answer DONE") {}
  complete(req: unknown): Promise<CompletionResult> {
    const r = normalizeRequest(req);
    this.calls.push(r);
    return Promise.resolve({
      text: this.text,
      cost: r.model !== undefined ? { usd: 0, model: r.model } : { usd: 0 },
      confidence: 1,
    });
  }
}

/** Erzeugt ein fetch-Stub, das /api/tags mit den gegebenen Modell-Namen (oder einem Fehler) beantwortet. */
function tagsFetch(names: string[] | "fail"): typeof fetch {
  return (async (): Promise<Response> => {
    if (names === "fail") throw new Error("ECONNREFUSED");
    const body = JSON.stringify({ models: names.map((name) => ({ name })) });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("LlmWorker — provider:model-Routing", () => {
  it("splittet provider:model und gibt dem Adapter nur den reinen Modellnamen; cost.model = kanonisch", async () => {
    const ollama = new CapturingModel();
    const worker = new LlmWorker({ providers: { ollama, mock: new MockModel() }, defaultModel: "mock" });

    const res = await worker.complete({ prompt: "hi", model: "ollama:llama3" });
    expect(ollama.calls).toHaveLength(1);
    expect(ollama.calls[0]?.model).toBe("llama3"); // reiner Modellname an den Adapter
    expect(res.cost.model).toBe("ollama:llama3"); // kanonisch im Audit/Tape
  });

  it("splittet nur am ERSTEN Doppelpunkt (Ollama-Tags wie llama3:8b bleiben erhalten)", async () => {
    const ollama = new CapturingModel();
    const worker = new LlmWorker({ providers: { ollama }, defaultModel: "ollama:llama3" });
    await worker.complete({ prompt: "hi", model: "ollama:llama3:8b" });
    expect(ollama.calls[0]?.model).toBe("llama3:8b");
  });

  it("exakter Provider-Key -> Adapter-Default (kein Modellname durchgereicht)", async () => {
    const ollama = new CapturingModel();
    const worker = new LlmWorker({ providers: { ollama, mock: new MockModel() }, defaultModel: "mock" });
    await worker.complete({ prompt: "hi", model: "ollama" });
    expect(ollama.calls[0]?.model).toBeUndefined();
  });

  it("Legacy-Präfix (claude-opus-4-8 -> Provider claude) reicht das volle Modell durch", async () => {
    const claude = new CapturingModel();
    const worker = new LlmWorker({ providers: { claude }, defaultModel: "claude-opus-4-8" });
    await worker.complete({ prompt: "hi", model: "claude-opus-4-8" });
    expect(claude.calls[0]?.model).toBe("claude-opus-4-8");
  });

  it("stream() stempelt cost.model im done-Chunk kanonisch (konsistent zu complete())", async () => {
    // MockModel meldet cost.model = seine eigene id; der Worker muss im done-Chunk auf die kanonische
    // provider:model-Spec stempeln, damit Audit/Tape bei stream + complete dieselbe Identität sehen.
    const worker = new LlmWorker({ providers: { ollama: new MockModel() }, defaultModel: "mock" });
    let doneModel: string | undefined;
    for await (const chunk of worker.stream({ prompt: "hi", model: "ollama:llama3" })) {
      if ("done" in chunk) doneModel = chunk.done.cost.model;
    }
    expect(doneModel).toBe("ollama:llama3");
  });
});

describe("resolveProviderProfiles — Auto-Detect + Env", () => {
  it("Ollama erreichbar -> verfügbar, Default ollama:<modell>, Wildcard ollama:*", async () => {
    const r = await resolveProviderProfiles({ env: {}, fetchImpl: tagsFetch(["llama3:latest", "qwen"]) });
    expect(r.available).toContain("ollama");
    expect(r.defaultModel).toBe("ollama:llama3:latest");
    expect(r.allowedModels).toContain("ollama:*");
    expect(r.allowedModels).toContain("mock");
  });

  it("Ollama NICHT erreichbar -> nur mock", async () => {
    const r = await resolveProviderProfiles({ env: {}, fetchImpl: tagsFetch("fail") });
    expect(r.available).toEqual(["mock"]);
    expect(r.defaultModel).toBe("mock");
  });

  it("disableAutoDetect -> kein Probe, nur mock", async () => {
    const r = await resolveProviderProfiles({
      env: {},
      fetchImpl: tagsFetch(["llama3"]),
      disableAutoDetect: true,
    });
    expect(r.available).toEqual(["mock"]);
  });

  it("ANTHROPIC_API_KEY -> claude verfügbar (+ claude:* Wildcard)", async () => {
    const r = await resolveProviderProfiles({
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fetchImpl: tagsFetch("fail"),
    });
    expect(r.available).toContain("claude");
    expect(r.allowedModels).toContain("claude:*");
  });

  it("explizite ollamaUrl registriert Ollama OHNE Probe", async () => {
    const r = await resolveProviderProfiles({
      env: {},
      ollamaUrl: "http://remote:11434",
      fetchImpl: tagsFetch("fail"),
    });
    expect(r.available).toContain("ollama");
  });

  it("ELIO_MODEL setzt Default + schaltet Auto-Detect ab + zieht den Ollama-Provider nach", async () => {
    const r = await resolveProviderProfiles({
      env: { ELIO_MODEL: "ollama:llama3" },
      fetchImpl: tagsFetch("fail"),
    });
    expect(r.defaultModel).toBe("ollama:llama3");
    expect(r.available).toContain("ollama");
  });
});

describe("Policy-Wildcards (ScopedModelService) end-to-end über eine Runtime", () => {
  const llmPack = {
    apiVersion: "elio/v1",
    kind: "Feature" as const,
    metadata: { id: "t.llm", version: "0.0.0" },
    contentHash: "t.llm@0.0.0",
    feature: {
      autonomy: "static" as const,
      artifact: { kind: "note", evalGate: "always-pass" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [
          {
            id: "ask",
            type: "llm",
            with: { provider: "ollama", model: "llama3", prompt: "hi", as: "note" },
            outputs: { note: "state.note" },
          },
        ],
        edges: [],
      },
    },
  } satisfies FeaturePack;

  it('allowedModels ["ollama:*"] erlaubt ollama:llama3 -> Adapter sieht "llama3", Run passt', async () => {
    const capture = new CapturingModel();
    const runtime = createRuntime({
      models: { ollama: capture, mock: new MockModel() },
      defaultModel: "mock",
      artifactTypes: { note: NOTE_TYPE },
      rootPolicy: {
        allowedModels: ["ollama:*"],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
        dbScopes: [],
        fsPaths: { read: [], write: [] },
      },
    });
    runtime.registry.register(alwaysPassGate as never);

    const events = await collectEvents(runtime.run(llmPack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const completed = events.find(
      (e): e is Extract<RunEvent, { type: "run-completed" }> => e.type === "run-completed",
    );
    expect(completed?.gate).toBe("passed");
    expect(capture.calls[0]?.model).toBe("llama3");
  });

  it('allowedModels ["mock"] verweigert ollama:llama3 (security by absence) -> Adapter NICHT aufgerufen', async () => {
    const capture = new CapturingModel();
    const runtime = createRuntime({
      models: { ollama: capture, mock: new MockModel() },
      defaultModel: "mock",
      artifactTypes: { note: NOTE_TYPE },
      rootPolicy: {
        allowedModels: ["mock"],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
        dbScopes: [],
        fsPaths: { read: [], write: [] },
      },
    });
    runtime.registry.register(alwaysPassGate as never);

    const events = await collectEvents(runtime.run(llmPack, { payload: {}, budget: 1000, maxDepth: 200 }));
    const completed = events.find(
      (e): e is Extract<RunEvent, { type: "run-completed" }> => e.type === "run-completed",
    );
    // Die llm-Node wirft (Modell verweigert) -> Failed -> Run stoppt; der Adapter wurde nie erreicht.
    expect(completed?.gate).toBe("stopped");
    expect(capture.calls).toHaveLength(0);
  });
});
