// ───────────────────────────── Demo-FeatureProvider (offline, deterministisch) ─────────────────────────────
// Die zwei MockModel-Demos + der lokale Ollama-Agent als FeatureProvider. Sie wrappen die SDK-Fassaden
// createDemoRuntime / createLocalAgentRuntime (kein eigenes Wiring). Alle drei sind capabilities.model=false:
// die Mock-Demos laufen offline, der local-agent verdrahtet Ollama selbst (nimmt keine Engine-`models`).

import { createDemoRuntime, createLocalAgentRuntime, draftUntilGoodPack, helloPack, localAgentPack, retryThenPassPack } from "@elio/sdk";
import type { FeatureProvider } from "../provider";
import { storeOptFrom } from "../provider";

const DEMO_CAPS = { model: false, db: false, fs: "none", traces: false, ephemeralStore: false } as const;

/** demo.hello — der Aha-Case: der Loop poliert einen Gruß, bis eine Qualitäts-Checkliste besteht (offline). */
export function helloProvider(): FeatureProvider {
  return {
    id: helloPack.metadata.id,
    pack: helloPack,
    capabilities: { ...DEMO_CAPS },
    setup: (ctx) => ({ runtime: createDemoRuntime(storeOptFrom(ctx, DEMO_CAPS)), pack: helloPack }),
  };
}

/** demo.draft-until-good — Outer-Loop draftet, bis ein min-length-Gate passt (MockModel). */
export function draftUntilGoodProvider(): FeatureProvider {
  return {
    id: draftUntilGoodPack.metadata.id,
    pack: draftUntilGoodPack,
    capabilities: { ...DEMO_CAPS },
    setup: (ctx) => ({ runtime: createDemoRuntime(storeOptFrom(ctx, DEMO_CAPS)), pack: draftUntilGoodPack }),
  };
}

/** demo.retry-then-pass — eine einmal flakende Node, die beim Retry passt (MockModel). */
export function retryThenPassProvider(): FeatureProvider {
  return {
    id: retryThenPassPack.metadata.id,
    pack: retryThenPassPack,
    capabilities: { ...DEMO_CAPS },
    setup: (ctx) => ({ runtime: createDemoRuntime(storeOptFrom(ctx, DEMO_CAPS)), pack: retryThenPassPack }),
  };
}

/** demo.local-agent — ein lokaler Ollama-Agent treibt den Outer Loop (Inv. 17). Braucht laufendes Ollama. */
export function localAgentProvider(): FeatureProvider {
  return {
    id: localAgentPack.metadata.id,
    pack: localAgentPack,
    capabilities: { ...DEMO_CAPS },
    setup: (ctx) => ({ runtime: createLocalAgentRuntime(storeOptFrom(ctx, DEMO_CAPS)), pack: localAgentPack }),
  };
}
