// ───────────────────────────── InMemoryRunStore (Inv. 12/15) ─────────────────────────────
// Run Store + Checkpoints (keyed by corrKey) + Loop Tape + Live-Stream (subscribe/liveStatus).
// In-Memory; persistente Stores docken am gleichen Interface an.

import { corrKey, newRunId } from "./ids";
import type { Checkpoint, CorrelationId } from "./elicitation";
import type {
  RunEvent,
  RunInput,
  RunRecord,
  RunStatus,
  RunStore,
  TapeFrame,
} from "./run";

interface ResolvedAnswer {
  answer: unknown;
  at: string;
}

/** Async-iterable Multi-Consumer-Kanal: buffer + waiters (für subscribe). */
class EventChannel {
  private readonly buffer: RunEvent[] = [];
  private readonly waiters: ((v: IteratorResult<RunEvent>) => void)[] = [];
  private closed = false;

  push(ev: RunEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: ev, done: false });
    } else {
      this.buffer.push(ev);
    }
  }

  close(): void {
    this.closed = true;
    let waiter = this.waiters.shift();
    while (waiter !== undefined) {
      waiter({ value: undefined, done: true });
      waiter = this.waiters.shift();
    }
  }

  iterator(): AsyncIterator<RunEvent> {
    return {
      next: (): Promise<IteratorResult<RunEvent>> => {
        const next = this.buffer.shift();
        if (next !== undefined) {
          return Promise.resolve({ value: next, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<RunEvent>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<RunEvent>> => {
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class InMemoryRunStore implements RunStore {
  // protected: ein persistenter Subclass (FileRunStore) hydratisiert + persistiert über diese Maps; der
  // In-Memory-Hot-State bleibt die Quelle für Runner/SSE (Live-Subscribe ist und bleibt in-process).
  protected readonly runs = new Map<string, { record: RunRecord; input: RunInput }>();
  protected readonly checkpoints = new Map<string, Checkpoint>();
  protected readonly answers = new Map<string, ResolvedAnswer>();
  protected readonly tapes = new Map<string, TapeFrame[]>();
  protected readonly statuses = new Map<string, RunStatus>();
  private readonly channels = new Set<{ filter?: { run?: string; active?: boolean }; ch: EventChannel }>();

  createRun(input: RunInput): Promise<RunRecord> {
    const record: RunRecord = { id: newRunId() };
    this.runs.set(record.id, { record, input });
    this.tapes.set(record.id, []);
    return Promise.resolve(record);
  }

  /** Alle bekannten Run-IDs (read-only Enumeration, Einfügereihenfolge) — speist TracesService.collect. */
  runIds(): Promise<string[]> {
    return Promise.resolve([...this.runs.keys()]);
  }

  /** Der bei createRun hinterlegte RunInput (budget/maxDepth/payload) — speist die cross-process Resume-
   *  Rekonstruktion des Run-Kontexts (Budget-Totals). undefined, wenn der Run unbekannt ist. */
  getRunInput(runId: string): RunInput | undefined {
    return this.runs.get(runId)?.input;
  }

  saveCheckpoint(cp: Checkpoint): Promise<void> {
    this.checkpoints.set(corrKey(cp.correlation), cp);
    return Promise.resolve();
  }

  loadCheckpoint(id: CorrelationId): Promise<Checkpoint | null> {
    return Promise.resolve(this.checkpoints.get(corrKey(id)) ?? null);
  }

  /** Antwort adressiert die correlation-id -> für Resume hinterlegt (Inv. 12). */
  resolveElicitation(id: CorrelationId, answer: unknown): Promise<void> {
    this.answers.set(corrKey(id), { answer, at: new Date().toISOString() });
    return Promise.resolve();
  }

  /** Test/Resume-Helfer: hinterlegte Antwort zu einer correlation-id lesen (sync). */
  getAnswer(id: CorrelationId): ResolvedAnswer | undefined {
    return this.answers.get(corrKey(id));
  }

  appendTape(run: string, frame: TapeFrame): Promise<void> {
    const tape = this.tapes.get(run);
    if (tape === undefined) {
      this.tapes.set(run, [frame]);
    } else {
      tape.push(frame);
    }
    return Promise.resolve();
  }

  /** Persistiertes Tape eines Runs (fertige Runs), async iterable. */
  tape(run: string): AsyncIterable<TapeFrame> {
    const frames = [...(this.tapes.get(run) ?? [])];
    return {
      [Symbol.asyncIterator](): AsyncIterator<TapeFrame> {
        let i = 0;
        return {
          next(): Promise<IteratorResult<TapeFrame>> {
            if (i < frames.length) {
              const value = frames[i] as TapeFrame;
              i += 1;
              return Promise.resolve({ value, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  /** Sync-Helfer für Tests: gibt das volle Tape eines Runs als Array. */
  getTape(run: string): TapeFrame[] {
    return [...(this.tapes.get(run) ?? [])];
  }

  /**
   * Live-Stream laufender Runs (gleiche Events wie das Tape, Inv. 15). buffer+waiters.
   *
   * Der zurückgegebene Iterator räumt sich selbst auf: bricht ein Consumer früh aus
   * `for await (… of subscribe())` aus (break/throw/return), entfernt `return()` den Kanal aus
   * `this.channels` und schließt ihn — sonst würde `publish()` für immer in einen verwaisten
   * Buffer pushen (Ressourcen-Leak). `closeSubscriptions()` bleibt der globale Shutdown-Pfad.
   */
  subscribe(filter?: { run?: string; active?: boolean }): AsyncIterable<RunEvent> {
    const ch = new EventChannel();
    const entry = filter === undefined ? { ch } : { filter, ch };
    this.channels.add(entry);
    const channels = this.channels;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => {
        const inner = ch.iterator();
        const cleanup = (): void => {
          channels.delete(entry);
          ch.close();
        };
        return {
          next: (): Promise<IteratorResult<RunEvent>> => inner.next(),
          return: (): Promise<IteratorResult<RunEvent>> => {
            cleanup();
            return Promise.resolve({ value: undefined, done: true });
          },
          throw: (e?: unknown): Promise<IteratorResult<RunEvent>> => {
            cleanup();
            return Promise.reject(e instanceof Error ? e : new Error(String(e)));
          },
        };
      },
    };
  }

  /**
   * Publiziert ein RunEvent in alle passenden Subscriber-Kanäle. Wird vom Runner aufgerufen,
   * sobald er ein Event yieldet (gleiche Quelle wie das Tape).
   */
  publish(ev: RunEvent): void {
    for (const { filter, ch } of this.channels) {
      if (filter?.run !== undefined && filter.run !== ev.correlation.run) continue;
      ch.push(ev);
    }
  }

  /** Schließt alle Subscriber-Kanäle (z.B. Shutdown). */
  closeSubscriptions(): void {
    for (const { ch } of this.channels) ch.close();
    this.channels.clear();
  }

  /** Anzahl aktuell registrierter Subscriber-Kanäle (Diagnose / Leak-Check). */
  subscriberCount(): number {
    return this.channels.size;
  }

  /** Status pro Run/Branch setzen (vom Runner aktualisiert). */
  setStatus(status: RunStatus): void {
    this.statuses.set(corrKey(status.correlation), status);
  }

  /**
   * Entfernt den Status-Eintrag einer correlation-id (Slice 2B). Genutzt, wenn ein parked Branch
   * resumed wird — sein "suspended"-Eintrag soll nicht neben dem späteren "done"-Eintrag liegen
   * bleiben (sonst meldet liveStatus() den Branch fälschlich weiter als wartend).
   */
  clearStatus(id: CorrelationId): void {
    this.statuses.delete(corrKey(id));
  }

  /**
   * Entfernt alle auf "suspended" stehenden Status-Einträge eines Runs (Slice 2B). Aufgerufen beim
   * sauberen Run-Abschluss, sobald keine parked Branches mehr offen sind (Inv. 12: resolved -> done) —
   * damit liveStatus() keinen Phantom-"suspended" neben dem frischen "done"-Eintrag mehr zeigt.
   * "done"/"running"-Einträge bleiben unberührt.
   */
  clearSuspendedForRun(runId: string): void {
    for (const [key, status] of this.statuses) {
      if (status.correlation.run === runId && status.phase === "suspended") {
        this.statuses.delete(key);
      }
    }
  }

  /** Momentaufnahme: welche Runs/Branches laufen, worauf warten sie (Inv. 15). */
  liveStatus(): Promise<RunStatus[]> {
    return Promise.resolve([...this.statuses.values()]);
  }
}
