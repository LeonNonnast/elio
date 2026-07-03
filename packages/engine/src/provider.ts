// ───────────────────────────── FeatureProvider — EIN Schema für alle Vertikalen ─────────────────────────────
// Vereinheitlicht die heterogenen setup*-Fassaden (setupMigrate/setupSkillBuilder/setupEventLog/…), die
// heute 5 verschiedene Rückgabe-Formen haben (3 ohne `pack`) und in CLI/MCP/Studio dreifach von Hand
// aufgelöst werden. Ein FeatureProvider deklariert seine id + sein statisch bekanntes Pack + seine
// Capabilities und baut auf Anforderung über EINE einheitliche setup(ctx)-Signatur eine verdrahtete
// Runtime. Der zentrale Katalog (catalog.ts) hält sie; der EngineService (engine.ts) treibt sie.
//
// WICHTIG (Inv. 2): Provider WRAPPEN die bestehenden setup*-Fassaden — sie re-implementieren KEIN
// Engine-Wiring (das war genau Studios Sünde: register*-Internals von Hand). Sie übersetzen nur den
// einheitlichen FeatureSetupContext in die feature-spezifischen setup*-Optionen.

import type { FeaturePack, InMemoryRunStore, ResolvedPolicy } from "@elio/core";
import type { ProviderMap, Runtime } from "@elio/sdk";

/**
 * Was eine Vertikale hinter ihrem Pack braucht — deklarativ, damit der EngineService einheitlich
 * vorbereiten kann (Modelle auflösen ja/nein, ephemerer vs. geteilter Store, …) statt dass jede Fassade
 * still ihre Sonderfälle versteckt (z.B. pm.event-log ignoriert heute stillschweigend den `store`).
 */
export interface FeatureCapabilities {
  /** Braucht ein echtes Modell (→ EngineService löst Provider-Profile auf und reicht `models` durch). */
  model: boolean;
  /** Braucht ctx.db (z.B. Migrate-Ziel-Backend). */
  db: boolean;
  /** Braucht ctx.fs — und in welcher Richtung (Migrate liest, Skill-Builder schreibt). */
  fs: "read" | "write" | "none";
  /** Braucht ctx.traces (Process-Mining liest das Loop Tape über eine CaptureStore). */
  traces: boolean;
  /**
   * Nutzt bewusst einen EPHEMEREN Run-Store statt des geteilten (pm.event-log/session-summary, Doc §3.4):
   * der durable Output ist die jsonl-Zeile, nicht das Run-Tape. Der EngineService reicht solchen Providern
   * den geteilten Store NICHT durch.
   */
  ephemeralStore: boolean;
}

/**
 * Der einheitliche Kontext, den der EngineService jedem Provider beim setup() reicht. Die geteilten
 * Runtime-Stellschrauben (Store, aufgelöste Modelle, Governance-Policy) destilliert der Service zentral;
 * feature-spezifische Eingaben (CSV-Quelle, outDir, captureDir, Brief) kommen über `params`/`captureDir`.
 */
export interface FeatureSetupContext {
  /** Geteilter Run-Store (EIN Store über alle Features → liveStatus/tape/subscribe sehen alle Runs).
   *  Wird Providern mit capabilities.ephemeralStore NICHT durchgereicht. */
  store?: InMemoryRunStore;
  /** Zentral aufgelöste Provider-Map (nur an capabilities.model-Provider). */
  models?: ProviderMap;
  /** Kanonische Default-Modell-Spec. */
  defaultModel?: string;
  /** Policy-Freigaben je Profil (Wildcards) — fließt in die Root-Policy. */
  allowedModels?: string[];
  /** Grobe Kosten-Richtwerte je Profil ($/MTok) für den cost-Stempel. */
  providerCosts?: Record<string, { in: number; out: number }>;
  /** Root-Policy-Override (Governance). Setzt der EngineService zentral — NICHT mehr die CLI (§1.2). */
  rootPolicy?: ResolvedPolicy;
  /** Verzeichnis der file-backed CaptureStore (Process-Mining). */
  captureDir?: string;
  /** Feature-spezifische Eingaben/Overrides (z.B. { sourceCsv }, { outDir, brief }). Provider liefert Defaults. */
  params?: Record<string, unknown>;
}

/**
 * Das Ergebnis von setup(): eine verdrahtete Runtime + das (jetzt IMMER vorhandene) Pack. `handles`
 * trägt optionale Neben-Ausgaben einer Vertikale (source/target/captureStore/outDir), die ein Aufrufer
 * für Diagnose/Tests braucht — kein Pflicht-Vertrag.
 */
export interface FeatureSetupResult {
  runtime: Runtime;
  pack: FeaturePack;
  handles?: Record<string, unknown>;
}

/**
 * Ein Feature, das der zentrale Katalog kennt. `pack` ist statisch bekannt (für listFeatures ohne setup);
 * `setup(ctx)` baut on demand die Runtime über die zugrundeliegende setup*-Fassade.
 */
export interface FeatureProvider {
  readonly id: string;
  readonly pack: FeaturePack;
  readonly capabilities: FeatureCapabilities;
  setup(ctx: FeatureSetupContext): FeatureSetupResult;
}

/** Helfer: die Modell-Stellschrauben aus dem Context in setup*-Optionen spreaden (nur gesetzte Felder). */
export function modelOptsFrom(ctx: FeatureSetupContext): {
  models?: ProviderMap;
  defaultModel?: string;
  allowedModels?: string[];
  providerCosts?: Record<string, { in: number; out: number }>;
} {
  return {
    ...(ctx.models !== undefined ? { models: ctx.models } : {}),
    ...(ctx.defaultModel !== undefined ? { defaultModel: ctx.defaultModel } : {}),
    ...(ctx.allowedModels !== undefined ? { allowedModels: ctx.allowedModels } : {}),
    ...(ctx.providerCosts !== undefined ? { providerCosts: ctx.providerCosts } : {}),
  };
}

/** Helfer: geteilten Store nur durchreichen, wenn der Provider nicht ephemer ist. */
export function storeOptFrom(
  ctx: FeatureSetupContext,
  caps: FeatureCapabilities,
): { store?: InMemoryRunStore } {
  if (caps.ephemeralStore || ctx.store === undefined) return {};
  return { store: ctx.store };
}
