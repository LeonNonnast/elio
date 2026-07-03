// ───────────────────────────── pm.discover — Setup-Fassade (Runtime + TableTapeSource + Nodes) ─────────────────────────────
// Verdrahtet die Process-Mining-Discovery-Vertikale (Doc §3.3, Slice 3a): baut eine Runtime, deren ctx.traces
// auf einer `TableTapeSource` über der gegebenen `CaptureStore` (Slice-2 events-Tabelle) sitzt, gewährt der
// Root-Policy "traces:read" (security by absence, Inv. 14) und registriert die katalog-gebundenen pm.discover-
// Nodes (process-route + discovery-complete).
//
// `setupProcessMining(opts)` ist die Fassade (mirror von setupMigrate): baut die Runtime + registriert. Die
// TapeSource MUSS bei der Injector-Konstruktion verdrahtet werden (createRuntime ⇒ tracesSource-Option), darum
// die Fassade — `registerProcessMining(rt, …)` allein kann eine schon gebaute Runtime nicht nachträglich auf
// eine andere TapeSource umhängen (es registriert nur die Nodes).

import { rootPolicy, TableTapeSource } from "@elio/core";
import type { CaptureStore, ProcessSignature, ResolvedPolicy } from "@elio/core";
import { registerProcessMiningNodes } from "@elio/core";
import { createRuntime } from "./runtime";
import type { Runtime } from "./runtime";

export interface SetupProcessMiningOptions {
  /** Die durable events-Tabelle (Slice 2), hinter die TableTapeSource. Pflicht. */
  captureStore: CaptureStore;
  /** Prozess-Katalog hinter der process-route-Node. Default: leer ⇒ alle Sessions unknown (Bootstrapping). */
  catalog?: readonly ProcessSignature[];
  /** Root-Policy-Override. Default: gewährt "traces:read" (sonst kein ctx.traces — security by absence). */
  rootPolicy?: ResolvedPolicy;
}

export interface ProcessMiningSetup {
  runtime: Runtime;
}

/** Optionen der reinen Node-Registrierung an einer bestehenden Runtime. */
export interface RegisterProcessMiningOptions {
  /** Prozess-Katalog hinter der process-route-Node (per Closure gebunden). Default: leer. */
  catalog?: readonly ProcessSignature[];
}

/**
 * Registriert die pm.discover-Nodes (process-route + discovery-complete) an einer bestehenden Runtime —
 * idempotent (bereits registrierte Typen bleiben unangetastet). Verdrahtet NICHT die TapeSource (die muss bei
 * der Runtime-Konstruktion gesetzt sein — s. setupProcessMining/createRuntime({ tracesSource })).
 */
export function registerProcessMining(rt: Runtime, opts: RegisterProcessMiningOptions = {}): void {
  registerProcessMiningNodes(rt.registry, opts.catalog !== undefined ? { catalog: opts.catalog } : {});
}

/**
 * Baut eine vollständig verdrahtete Process-Mining-Discovery-Runtime: ctx.traces hinter einer TableTapeSource
 * über der CaptureStore, Root-Policy mit "traces:read", die pm.discover-Nodes registriert. Der pm.discover-Pack
 * (`pmDiscoverPack`, @elio/core) läuft dann über `runtime.run(pmDiscoverPack, …)`.
 */
export function setupProcessMining(opts: SetupProcessMiningOptions): ProcessMiningSetup {
  const runtime = createRuntime({
    tracesSource: new TableTapeSource(opts.captureStore),
    rootPolicy: opts.rootPolicy ?? rootPolicy({ toolPermissions: ["traces:read"] }),
  });
  registerProcessMining(runtime, opts.catalog !== undefined ? { catalog: opts.catalog } : {});
  return { runtime };
}
