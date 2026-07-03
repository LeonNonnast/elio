// ───────────────────────────── Demo: retry-then-pass (Failed -> Retry -> Resolved) ─────────────────────────────
// Zeigt den Fehlerpfad + Retry (§11/#7): ein Custom-Node wirft beim 1. Versuch und resolved beim
// 2. (node.retry.maxAttempts=2). Danach exit-et ein immer-bestehendes Gate "always-pass".
// Demonstriert: tryWithRetry, Failed -> retry -> resolved, Gate-Exit.

import type {
  ArtifactType,
  FeaturePack,
  GateVerdict,
  InMemoryRunStore,
  NodeDefinition,
  Resolved,
} from "@elio/core";
import { createRuntime } from "../runtime";
import type { Runtime } from "../runtime";
import { setupDraftUntilGood, TEXT_DOC_TYPE } from "./draft-until-good";

/** Pro Runtime: zählt die Versuche der flaky-Node (sodass jeder Run frisch startet). */
const ATTEMPTS = new WeakMap<object, number>();

/** Artefakt-Typ für die Retry-Demo: einfacher note-Typ mit progress.md. */
export const NOTE_TYPE: ArtifactType = { kind: "note", holders: ["progress.md"] };

/**
 * Custom-Node "flaky-once": wirft beim 1. Aufruf (pro Run-Schlüssel), resolved ab dem 2.
 * Der Zähler hängt am ctx.artifact (stabil pro Run) — so ist jeder Run unabhängig.
 * node.retry = { maxAttempts: 2 } -> tryWithRetry wiederholt einmal und bekommt das resolved.
 */
export const flakyOnceNode: NodeDefinition<unknown, { note: string }> = {
  type: "flaky-once",
  klass: "orchestration",
  retry: { maxAttempts: 2, backoff: "none", onExhausted: "fail" },
  handler: (_input, ctx) => {
    const key = ctx.artifact as unknown as object;
    const seen = ATTEMPTS.get(key) ?? 0;
    ATTEMPTS.set(key, seen + 1);
    if (seen === 0) {
      // 1. Versuch: hart werfen -> tryWithRetry fängt es als Failed{retryable:true}.
      throw new Error("flaky-once: transient failure on attempt 1");
    }
    const res: Resolved<{ note: string }> = {
      status: "resolved",
      output: { note: "recovered on retry" },
      confidence: 1,
      cost: { usd: 0.01 },
    };
    return Promise.resolve(res);
  },
};

/** Gate "always-pass": besteht immer (liefert Resolved<GateVerdict passed:true>). */
export const alwaysPassGate: NodeDefinition<unknown, GateVerdict> = {
  type: "always-pass",
  klass: "orchestration",
  handler: () => {
    const verdict: GateVerdict = { passed: true, score: 1, failures: [] };
    const res: Resolved<GateVerdict> = {
      status: "resolved",
      output: verdict,
      confidence: 1,
      cost: { usd: 0 },
    };
    return Promise.resolve(res);
  },
};

/** FeaturePack: ein einziger flaky-Step; danach DONE -> Gate always-pass -> run-completed{passed}. */
export const retryThenPassPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "demo.retry-then-pass", version: "0.1.0", owner: "demo" },
  contentHash: "demo.retry-then-pass@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "note", evalGate: "always-pass" },
    io: { input: {}, output: {} },
    graph: {
      state: {},
      steps: [
        {
          id: "do-work",
          type: "flaky-once",
          outputs: { note: "state.note" },
        },
      ],
      // keine Folge-Edge -> nach do-work ist nextEdge "DONE" -> Gate läuft -> passed.
      edges: [],
    },
  },
};

/** Registriert flaky-once + always-pass an einer Runtime und gibt den Pack zurück. */
export function setupRetryThenPass(runtime: Runtime): FeaturePack {
  if (!runtime.registry.has("flaky-once")) {
    runtime.registry.register(flakyOnceNode as unknown as NodeDefinition);
  }
  if (!runtime.registry.has("always-pass")) {
    runtime.registry.register(alwaysPassGate as unknown as NodeDefinition);
  }
  return retryThenPassPack;
}

/**
 * Baut eine frische Runtime mit ALLEN Demo-Nodes + Artefakt-Typen registriert.
 * Zentraler Einstieg für Tests/CLI/MCP, die die Demo-Features ausführen wollen.
 */
export function createDemoRuntime(opts: { store?: InMemoryRunStore } = {}): Runtime {
  const runtime = createRuntime({
    artifactTypes: {
      "text-doc": TEXT_DOC_TYPE,
      note: NOTE_TYPE,
    },
    ...(opts.store !== undefined ? { store: opts.store } : {}),
  });
  setupDraftUntilGood(runtime);
  setupRetryThenPass(runtime);
  return runtime;
}
