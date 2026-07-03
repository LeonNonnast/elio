// ───────────────────────────── Multi-Branch Scheduler + Child-Branch Executor (Inv. 12, §6, §11/#6) ─────────────────────────────
// Slice 2 part B: der OuterLoopRunner führt mehr als einen nebenläufigen Branch aus.
//
// Jeder Branch hat eine eigene correlation (branch id) und einen eigenen branchState (KEIN Aliasing
// zwischen Branches); alle Branches teilen sich das Run-Artefakt über dessen Data-Holder (Inv. 22).
// Trifft ein Branch auf eine `parked`-Elicitation, wird ein Checkpoint gespeichert und die übrigen
// runnable Branches laufen WEITER (der Run hält nicht an, §6 / Inv. 12). Parked Branches sind später
// per correlation-id via runner.resume() resumebar. Sind ALLE Branches parked, meldet der Run
// `suspended` via liveStatus() — ohne zu hängen oder busy-zu-spinnen.
//
// Mechanismus, keine Migrate-Vertikale: der per-record Effect-Ledger / Batch-Commit bleibt Slice 6.
// Hier liegt nur das nebenläufige Branch-Primitiv + ein disjoint-key Write-Pfad (§11/#6).

import type { CorrelationId } from "./elicitation";
import type { FeaturePack, GraphDefinition } from "./feature";
import type { RunEvent } from "./run";

/**
 * Ausgang einer Branch-Ausführung (eine Iteration des Schedulers über genau einen Branch).
 *  - completed: der Branch lief bis DONE/Gate-pass/stop durch (kein offener Checkpoint).
 *  - suspended: der Branch traf eine Elicitation (blocking/parked) und hinterließ einen Checkpoint
 *               unter `correlation`; resumebar via runner.resume(correlation, answer).
 */
export type BranchOutcome =
  | { kind: "completed"; gate: "passed" | "stopped" }
  | { kind: "suspended"; mode: import("./elicitation").SuspendMode; correlation: CorrelationId };

/**
 * Spezifikation eines Kind-Branches, den eine subworkflow-Node fächert (Inv. 8 — nested Outer Loop).
 * Jeder Kind-Branch bekommt eine disjunkte branch id und einen eigenen, frischen branchState
 * (NO aliasing). Die Steps sind das `with.steps` der subworkflow-Node.
 */
export interface ChildBranchSpec {
  /** Disjunkte branch id = parentBranch + "/" + (item.id ?? index). */
  branch: string;
  /** Eigener branchState des Kind-Branches (kein Alias auf Parent/Sibling). */
  initialState: Record<string, unknown>;
  /** Die linear auszuführenden Steps des Kind-Branches (subworkflow.with.steps). */
  steps: import("./feature").StepRef[];
  /**
   * Voller Kind-Graph statt linearer `steps` (feature-ref subworkflow, §3): wird er gesetzt, fährt der
   * Runner den Kind-Branch gegen DIESEN Graphen (statt linearGraph(steps)). Damit läuft ein referenziertes
   * Sub-Feature mit seiner echten Topologie (Edges/Loops).
   */
  graph?: GraphDefinition;
  /**
   * Pack des referenzierten Sub-Features (feature-ref): wird es gesetzt, fährt der Kind-Branch unter
   * DESSEN Governance (Policies/Version), nicht der des Parent-Features. Gate-los wie jeder Kind-Branch.
   */
  pack?: FeaturePack;
}

/**
 * Read-only Auflösung eines Feature-Packs per id (feature-ref subworkflow, §3 registry-driven fan-out).
 * Vom Runner pro Run bereitgestellt (wie der ChildBranchExecutor) — die feature-ref-Node greift sie via
 * `ctx.correlation.run` ab, ohne den Ctx-Contract zu erweitern.
 */
export interface FeatureResolver {
  resolve(id: string): FeaturePack | undefined;
}

interface ResolverEntry {
  resolver: FeatureResolver;
  refs: number;
}
const resolvers = new Map<string, ResolverEntry>();

/** Registriert den FeatureResolver eines Runs (refcounted wie der ChildExecutor — concurrent Resumes). */
export function registerFeatureResolver(runId: string, resolver: FeatureResolver): void {
  const entry = resolvers.get(runId);
  if (entry === undefined) resolvers.set(runId, { resolver, refs: 1 });
  else entry.refs += 1;
}

export function getFeatureResolver(runId: string): FeatureResolver | undefined {
  return resolvers.get(runId)?.resolver;
}

export function unregisterFeatureResolver(runId: string): void {
  const entry = resolvers.get(runId);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs <= 0) resolvers.delete(runId);
}

/**
 * Vom Runner pro Run bereitgestellte Fähigkeit, einen Kind-Branch bis completion-or-park
 * auszuführen. Die subworkflow-Node greift sie über `ctx.correlation.run` ab (siehe Registry unten),
 * ohne den policy-gescopten `Ctx`-Contract (§3) zu erweitern — der Executor ist eine Runner-interne
 * Kollaboration, kein injizierter Service.
 *
 * `runChild` sammelt die RunEvents des Kind-Branches (der Aufrufer re-emittiert sie in den
 * Run-Stream), liefert den BranchOutcome und den finalen branchState des Kindes (Quelle des
 * per-item-Ergebnisses; bei `suspended` der Stand zum Park-Zeitpunkt). Ein parked Kind blockt die
 * Geschwister NICHT: der Aufrufer (subworkflow) fährt mit dem nächsten Kind fort.
 */
export interface ChildBranchExecutor {
  runChild(
    spec: ChildBranchSpec,
  ): Promise<{ events: RunEvent[]; outcome: BranchOutcome; finalState: Record<string, unknown> }>;
}

/**
 * Per-Run-Registry der Child-Branch-Executors. Der Runner registriert vor dem Antreiben eines Runs
 * seinen Executor unter der run id; die subworkflow-Node liest ihn via ctx.correlation.run und
 * entfernt nichts (mehrere subworkflow-Nodes pro Run teilen denselben Executor). Der Runner räumt
 * nach run()/resume() auf.
 *
 * Modul-lokaler Zustand statt Ctx-Erweiterung: hält den Ctx-Contract (§3) unverändert und vermeidet
 * eine zirkuläre Runner<->Node-Abhängigkeit (die Node-Registry kennt den Runner nicht).
 *
 * REFERENCE-COUNTED pro Run (nicht last-writer-wins + first-finisher-delete): EIN Run kann mehrere
 * gleichzeitige Driver haben — der root run() UND jedes resume() eines parked Kindes desselben Runs.
 * Würde der Executor in jedem drive()-finally unbedingt gelöscht, risse der zuerst fertige Resume ihn
 * den noch laufenden Geschwister-Resumes unter den Füßen weg (ein danach laufender subworkflow-Step
 * fände keinen Executor mehr, Inv. 8/12). Daher: register() zählt hoch (der ERSTE Driver setzt den
 * Executor; spätere concurrent Driver erhöhen nur den Refcount), unregister() zählt runter und
 * entfernt den Executor erst, wenn der LETZTE Driver dieses Runs raus ist. So sind parked Branches
 * über den Executor-Seam hinweg wirklich unabhängig resumebar.
 */
interface ExecutorEntry {
  exec: ChildBranchExecutor;
  refs: number;
}
const executors = new Map<string, ExecutorEntry>();

export function registerChildExecutor(runId: string, exec: ChildBranchExecutor): void {
  const entry = executors.get(runId);
  if (entry === undefined) {
    executors.set(runId, { exec, refs: 1 });
    return;
  }
  // Ein Executor für diesen Run existiert bereits (ein concurrenter Driver hält ihn). Nur den
  // Refcount erhöhen — der bestehende Executor (auf demselben Run-Artefakt) bleibt der Owner.
  entry.refs += 1;
}

export function getChildExecutor(runId: string): ChildBranchExecutor | undefined {
  return executors.get(runId)?.exec;
}

export function unregisterChildExecutor(runId: string): void {
  const entry = executors.get(runId);
  if (entry === undefined) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    executors.delete(runId);
  }
}
