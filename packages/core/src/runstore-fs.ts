// ───────────────────────────── FileRunStore: durabler, prozessübergreifender Run Store (Inv. 12/15) ─────────────────────────────
// Erweitert den InMemoryRunStore: der In-Memory-Hot-State bleibt die Quelle für Runner + Live-Subscribe/SSE
// (Live-Streaming ist und bleibt IN-PROCESS), aber jede Mutation wird zusätzlich auf die Platte geschrieben,
// und beim Start lädt der Store den persistierten Stand wieder ein. So sehen `elio resume`/`elio runs` in
// einem NEUEN Prozess die Runs/Checkpoints/Tape eines früheren `elio run` (die größte offene v0.1-Grenze).
//
// Layout pro Run unter <dir>/<runId>/:
//   meta.json    -> { record, input }                (einmalig bei createRun)
//   tape.jsonl   -> ein TapeFrame als JSON pro Zeile (append-only)
//   state.json   -> { checkpoints[], statuses[], answers[] } (bei jeder Mutation neu geschrieben)
//
// Bewusst NICHT persistiert: die Live-Subscribe-Kanäle (in-process). Cross-process Live-Streaming ist
// kein Ziel — Durability für resume/runs ist es. Eine DB-basierte Impl kann später am SELBEN Contract
// eindocken (FileRunStore ist die erste durable Impl, kein Endzustand).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { corrKey } from "./ids";
import { InMemoryRunStore } from "./runstore";
import type { Checkpoint, CorrelationId } from "./elicitation";
import type { RunInput, RunRecord, RunStatus, TapeFrame } from "./run";

interface PersistedAnswer {
  key: string;
  answer: unknown;
  at: string;
}

interface PersistedState {
  checkpoints: Checkpoint[];
  statuses: RunStatus[];
  answers: PersistedAnswer[];
}

/** Dateisystem-sicherer Datei-/Verzeichnisname für eine id (Run-id oder corrKey). */
function enc(id: string): string {
  return encodeURIComponent(id);
}

export class FileRunStore extends InMemoryRunStore {
  private readonly dir: string;

  constructor(dir: string) {
    super();
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.hydrate();
  }

  // ───────────────────────────── Hydration beim Start ─────────────────────────────

  private hydrate(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const runDir = join(this.dir, entry);
      const metaPath = join(runDir, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { record: RunRecord; input: RunInput };
        this.runs.set(meta.record.id, { record: meta.record, input: meta.input });
        this.tapes.set(meta.record.id, this.readTape(runDir));
        const state = this.readState(runDir);
        for (const cp of state.checkpoints) this.checkpoints.set(corrKey(cp.correlation), cp);
        for (const st of state.statuses) this.statuses.set(corrKey(st.correlation), st);
        for (const a of state.answers) this.answers.set(a.key, { answer: a.answer, at: a.at });
      } catch {
        // Beschädigter/teilweiser Run-Ordner -> überspringen (kein harter Start-Crash).
        continue;
      }
    }
  }

  private readTape(runDir: string): TapeFrame[] {
    const tapePath = join(runDir, "tape.jsonl");
    if (!existsSync(tapePath)) return [];
    const out: TapeFrame[] = [];
    for (const line of readFileSync(tapePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(JSON.parse(trimmed) as TapeFrame);
      } catch {
        // unvollständige letzte Zeile o.ä. -> überspringen
      }
    }
    return out;
  }

  private readState(runDir: string): PersistedState {
    const path = join(runDir, "state.json");
    if (!existsSync(path)) return { checkpoints: [], statuses: [], answers: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedState>;
      return {
        checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
        statuses: Array.isArray(parsed.statuses) ? parsed.statuses : [],
        answers: Array.isArray(parsed.answers) ? parsed.answers : [],
      };
    } catch {
      return { checkpoints: [], statuses: [], answers: [] };
    }
  }

  // ───────────────────────────── Persistenz-Helfer ─────────────────────────────

  private runDir(runId: string): string {
    const d = join(this.dir, enc(runId));
    mkdirSync(d, { recursive: true });
    return d;
  }

  /** Schreibt state.json eines Runs aus dem aktuellen In-Memory-Stand (checkpoints/statuses/answers). */
  private persistState(runId: string): void {
    const checkpoints: Checkpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.correlation.run === runId) checkpoints.push(cp);
    }
    const statuses: RunStatus[] = [];
    for (const st of this.statuses.values()) {
      if (st.correlation.run === runId) statuses.push(st);
    }
    const answers: PersistedAnswer[] = [];
    for (const [key, val] of this.answers.entries()) {
      if (key.startsWith(`${runId}/`)) answers.push({ key, answer: val.answer, at: val.at });
    }
    const state: PersistedState = { checkpoints, statuses, answers };
    writeFileSync(join(this.runDir(runId), "state.json"), JSON.stringify(state), "utf8");
  }

  // ───────────────────────────── Überschriebene Mutationen (super + persistieren) ─────────────────────────────

  override async createRun(input: RunInput): Promise<RunRecord> {
    const record = await super.createRun(input);
    writeFileSync(join(this.runDir(record.id), "meta.json"), JSON.stringify({ record, input }), "utf8");
    return record;
  }

  override async saveCheckpoint(cp: Checkpoint): Promise<void> {
    await super.saveCheckpoint(cp);
    this.persistState(cp.correlation.run);
  }

  override async resolveElicitation(id: CorrelationId, answer: unknown): Promise<void> {
    await super.resolveElicitation(id, answer);
    this.persistState(id.run);
  }

  override async appendTape(run: string, frame: TapeFrame): Promise<void> {
    await super.appendTape(run, frame);
    appendFileSync(join(this.runDir(run), "tape.jsonl"), `${JSON.stringify(frame)}\n`, "utf8");
  }

  override setStatus(status: RunStatus): void {
    super.setStatus(status);
    this.persistState(status.correlation.run);
  }

  override clearStatus(id: CorrelationId): void {
    super.clearStatus(id);
    this.persistState(id.run);
  }

  override clearSuspendedForRun(runId: string): void {
    super.clearSuspendedForRun(runId);
    this.persistState(runId);
  }
}
