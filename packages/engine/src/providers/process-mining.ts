// ───────────────────────────── Process-Mining-FeatureProvider (Doc §3) ─────────────────────────────
// Die drei pm.*-Features als FeatureProvider. Wichtig: die setup*-Fassaden geben heute KEIN `pack` zurück
// (die größte Schema-Abweichung, Audit §1.3) — der Provider hängt es jetzt einheitlich an (pmEventLogPack/
// pmSessionSummaryPack/pmDiscoverPack aus @elio/core). pm.event-log + pm.session-summary nutzen bewusst
// einen EPHEMEREN Store (ephemeralStore=true) — der durable Output ist die jsonl-Zeile (Doc §3.4).

import { join } from "node:path";
import {
  InMemoryCaptureStore,
  pmDiscoverPack,
  pmEventLogPack,
  pmSessionSummaryPack,
  setupEventLog,
  setupProcessMining,
  setupSessionSummary,
} from "@elio/sdk";
import type { FeaturePack } from "@elio/core";
import type { FeatureProvider, FeatureSetupContext } from "../provider";
import { modelOptsFrom } from "../provider";

/** Default-Verzeichnis der file-backed CaptureStore, falls der EngineService keins durchreicht. */
function captureDirOf(ctx: FeatureSetupContext): string {
  return ctx.captureDir ?? join(process.cwd(), ".elio", "capture");
}

/** pm.event-log — schreibt eine events.jsonl-Zeile (AI-frei, ephemerer Store). */
export function eventLogProvider(): FeatureProvider {
  return {
    id: (pmEventLogPack as FeaturePack).metadata.id,
    pack: pmEventLogPack,
    capabilities: { model: false, db: false, fs: "none", traces: false, ephemeralStore: true },
    setup: (ctx) => {
      const setup = setupEventLog({
        captureDir: captureDirOf(ctx),
        ...(ctx.rootPolicy !== undefined ? { rootPolicy: ctx.rootPolicy } : {}),
      });
      return { runtime: setup.runtime, pack: pmEventLogPack, handles: { captureStore: setup.captureStore } };
    },
  };
}

/** pm.session-summary — fasst eine Session per LLM zusammen (liest CaptureStore, ephemerer Run-Store). */
export function sessionSummaryProvider(): FeatureProvider {
  return {
    id: (pmSessionSummaryPack as FeaturePack).metadata.id,
    pack: pmSessionSummaryPack,
    capabilities: { model: true, db: false, fs: "none", traces: true, ephemeralStore: true },
    setup: (ctx) => {
      const captureDir = captureDirOf(ctx);
      const captureStore = new InMemoryCaptureStore({ dir: captureDir });
      const setup = setupSessionSummary({
        captureStore,
        summaryDir: captureDir,
        ...modelOptsFrom(ctx),
        ...(ctx.rootPolicy !== undefined ? { rootPolicy: ctx.rootPolicy } : {}),
      });
      return { runtime: setup.runtime, pack: pmSessionSummaryPack, handles: { summaryStore: setup.summaryStore } };
    },
  };
}

/** pm.discover — entdeckt Prozess-Signaturen aus dem Capture-Log (liest CaptureStore). */
export function discoverProvider(): FeatureProvider {
  return {
    id: (pmDiscoverPack as FeaturePack).metadata.id,
    pack: pmDiscoverPack,
    capabilities: { model: false, db: false, fs: "none", traces: true, ephemeralStore: false },
    setup: (ctx) => {
      const captureStore = new InMemoryCaptureStore({ dir: captureDirOf(ctx) });
      const setup = setupProcessMining({
        captureStore,
        ...(ctx.rootPolicy !== undefined ? { rootPolicy: ctx.rootPolicy } : {}),
      });
      return { runtime: setup.runtime, pack: pmDiscoverPack };
    },
  };
}
