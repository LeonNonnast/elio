// ───────────────────────────── Demo: local-agent (lokaler Ollama-Agent treibt den Outer Loop) ─────────────────────────────
// Beweist Inv. 17/18 OHNE Cloud und OHNE LangGraph: ein `agent`-Step delegiert an die
// InProcessAgentEngine (transparenter Inner-Loop), deren Modellaufrufe ALLE durch ctx.model fließen —
// und ctx.model hängt hier an einem OllamaModel (lokaler HTTP-Adapter, http://localhost:11434). Der
// Inner-Loop ist elio-eigen (bounded Multi-Turn, Budget/Tiefe geerbt), KEINE externe Agent-Library.
//
// Der Agent schreibt seinen Text als Artefakt-Inhalt (progress); das min-length-Gate aus draft-until-good
// entscheidet den Outer-Loop-Exit (Inv. 1). Eine Self-Edge lässt den Outer Loop den Agenten erneut rufen,
// falls der Entwurf noch zu kurz ist — exakt die ELIO-Kernschleife, nur mit delegierter Intelligenz.
//
// Anders als die anderen Demos ist diese NICHT offline: sie braucht ein laufendes Ollama (oder ein
// injiziertes fetchImpl — so läuft der Test deterministisch ohne Netz). Lokale Modelle -> Cost.usd = 0.

import type {
  ArtifactType,
  FeaturePack,
  GateVerdict,
  InMemoryRunStore,
  NodeDefinition,
  Resolved,
  ResolvedPolicy,
} from "@elio/core";
import { createRuntime } from "../runtime";
import type { Runtime } from "../runtime";
import { OllamaModel } from "../models/ollama";
import type { OllamaModelOptions } from "../models/ollama";
import { InProcessAgentEngine } from "../models/agent-engine";
import { TEXT_DOC_TYPE } from "./draft-until-good";

/** Provider-Profil der Demo (der Worker routet `provider:model` auf dieses Profil). */
export const LOCAL_AGENT_PROVIDER = "ollama";
/** Lokales Modell der Demo (muss in Ollama gepullt sein: `ollama pull llama3`). */
export const LOCAL_AGENT_MODEL = "llama3";
/** Kanonische Spec `provider:model`, wie sie in Policy/Audit erscheint. */
export const LOCAL_AGENT_SPEC = `${LOCAL_AGENT_PROVIDER}:${LOCAL_AGENT_MODEL}`;

/** Gate-Schwelle: ab dieser Länge gilt der Agent-Entwurf als "gut genug". */
export const LOCAL_MIN_LENGTH = 30;

/** Re-Export des geteilten text-doc-Artefakt-Typs (die Demo nutzt denselben wie draft-until-good). */
export { TEXT_DOC_TYPE };

/**
 * Eval-Gate "local-min-length": liest den Agent-Entwurf aus dem Artefakt. Die InProcessAgentEngine
 * liefert ihren Output als `{ text }`, der agent-Node legt ihn unter `content.draft` ab — das Gate
 * akzeptiert sowohl den String als auch die `{ text }`-Form und misst dessen Länge (Inv. 1, §4 Schritt 12).
 */
export const localMinLengthGate: NodeDefinition<{ artifact?: { content?: unknown } }, GateVerdict> = {
  type: "local-min-length",
  klass: "orchestration",
  handler: (input) => {
    const content = input?.artifact?.content as Record<string, unknown> | undefined;
    const draft = content?.["draft"];
    const text =
      typeof draft === "string"
        ? draft
        : draft !== null &&
            typeof draft === "object" &&
            typeof (draft as { text?: unknown }).text === "string"
          ? ((draft as { text: string }).text)
          : "";
    const len = text.length;
    const passed = len >= LOCAL_MIN_LENGTH;
    const verdict: GateVerdict = {
      passed,
      score: Math.min(1, len / LOCAL_MIN_LENGTH),
      failures: passed ? [] : [`agent draft length ${len} < required ${LOCAL_MIN_LENGTH}`],
    };
    const res: Resolved<GateVerdict> = {
      status: "resolved",
      output: verdict,
      confidence: 1,
      cost: { usd: 0 },
    };
    return Promise.resolve(res);
  },
};

/**
 * FeaturePack: ein einziger `agent`-Step "draft", der lokal denkt (ctx.agent -> InProcessAgentEngine ->
 * ctx.model -> Ollama) und seinen Text als Artefakt-progress ablegt; das min-length-Gate exit-et den
 * Outer Loop. Self-Edge: zu kurz -> erneut draften (Inv. 1).
 */
export const localAgentPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "demo.local-agent", version: "0.1.0", owner: "demo" },
  contentHash: "demo.local-agent@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "text-doc", evalGate: "local-min-length" },
    io: { input: {}, output: {} },
    graph: {
      state: {},
      steps: [
        {
          id: "draft",
          type: "agent",
          with: {
            // Provider-Profil + Modell explizit gepinnt (reproduzierbar). Der Node bildet daraus die
            // kanonische Spec `ollama:llama3`; der Worker routet sie auf das Ollama-Profil, der
            // ScopedModelService prüft sie gegen allowedModels — security by absence (Inv. 13/14).
            provider: LOCAL_AGENT_PROVIDER,
            model: LOCAL_AGENT_MODEL,
            system:
              "You are a concise local assistant. Write a short, self-contained paragraph, " +
              'then end your message with the single word "DONE".',
            prompt:
              "In one or two sentences, explain what an artifact-centric loop engine does for a developer.",
            // Inner-Loop-Schranken: bis zu 3 Turns, Stop-Marker "DONE" beendet die Konversation früher.
            maxTurns: 3,
            stopWhen: "DONE",
            // Output unter `draft` -> applyTo schreibt artifact.content.draft (= { text }) -> das Gate liest es.
            as: "draft",
          },
        },
      ],
      // Self-Edge: nach jedem draft erneut draften (Outer Loop), bis das Gate exit-et.
      edges: [{ from: "draft", to: "draft" }],
    },
  },
};

/**
 * Root-Policy der Demo: gibt GENAU das lokale Modell frei. allowedModels nichtleer ist die Bedingung,
 * unter der der Injector ctx.model UND ctx.agent an die agent-Node hängt (Inv. 13/14). allowCloud=false:
 * die Demo bleibt lokal — ein versehentliches `model:"claude"` würde der ScopedModelService ablehnen.
 */
export const LOCAL_AGENT_POLICY: ResolvedPolicy = {
  allowedModels: [LOCAL_AGENT_SPEC],
  allowCloud: false,
  dataClassification: "internal",
  suspendMode: "optional",
  toolPermissions: [],
  dbScopes: [],
  fsPaths: { read: [], write: [] },
};

export interface LocalAgentRuntimeOptions {
  /**
   * Optionen für das OllamaModel (baseUrl, defaultModel, confidence — und fetchImpl, mit dem Tests den
   * HTTP-Call deterministisch ohne echtes Netz stubben). Default: echtes Ollama auf localhost:11434.
   */
  ollama?: OllamaModelOptions;
  /** Persistenter Run-Store (z.B. FileRunStore) — Default: prozess-lokaler In-Memory-Store. */
  store?: InMemoryRunStore;
}

/**
 * Baut eine Runtime, deren ctx.model an einem OllamaModel hängt und deren ctx.agent die transparente
 * InProcessAgentEngine ist — registriert das min-length-Gate + den text-doc-Typ und scoped die Root-Policy
 * auf das lokale Modell. Genau die Verdrahtung, die `demo.local-agent` lauffähig macht.
 */
export function createLocalAgentRuntime(opts: LocalAgentRuntimeOptions = {}): Runtime {
  const ollama = new OllamaModel({ defaultModel: LOCAL_AGENT_MODEL, ...opts.ollama });
  const artifactTypes: Record<string, ArtifactType> = { [TEXT_DOC_TYPE.kind]: TEXT_DOC_TYPE };
  const runtime = createRuntime({
    // Provider unter seinem Profil-Key "ollama" registrieren; defaultModel = kanonische Spec.
    models: { [LOCAL_AGENT_PROVIDER]: ollama },
    defaultModel: LOCAL_AGENT_SPEC,
    agentEngine: new InProcessAgentEngine(),
    artifactTypes,
    rootPolicy: LOCAL_AGENT_POLICY,
    ...(opts.store !== undefined ? { store: opts.store } : {}),
  });
  setupLocalAgent(runtime);
  return runtime;
}

/** Registriert das local-min-length-Gate an einer Runtime und gibt den Pack zurück (agent ist Built-in). */
export function setupLocalAgent(runtime: Runtime): FeaturePack {
  if (!runtime.registry.has("local-min-length")) {
    runtime.registry.register(localMinLengthGate as unknown as NodeDefinition);
  }
  return localAgentPack;
}
