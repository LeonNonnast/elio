// ───────────────────────────── CLI-IO-Seam (testbar ohne TTY) ─────────────────────────────
// Die CLI ist die minimale Approval Inbox (Skeleton §6): an einer node-suspended Elicitation
// prompted sie den Menschen und resumed mit der Antwort. Damit Tests das OHNE echte TTY treiben
// können, abstrahieren wir Input/Output hinter einem schmalen Seam:
//  - `write(line)`  : eine Zeile nach stdout (oder einen Test-Sink).
//  - `prompt(q)`    : stellt eine Frage und liest EINE Antwort-Zeile (stdin oder eine kanned Queue).
//
// bin.ts verdrahtet die echten Streams; Tests übergeben einen InMemoryIO mit vorgefütterten Antworten.

import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";

/** Ein-/Ausgabe-Seam für die CLI. Kein direkter process.stdout/stdin-Zugriff in den Handlern. */
export interface CliIO {
  /** Schreibt eine Zeile (inkl. Zeilenumbruch) auf den Ausgabe-Kanal. */
  write(line: string): void;
  /**
   * Stellt eine Frage und liefert die nächste Eingabe-Zeile. Ist KEINE Eingabe mehr verfügbar
   * (EOF / leere kanned-Queue), wird `undefined` zurückgegeben — der Aufrufer entscheidet dann
   * (z.B. Default anwenden oder den Branch suspendiert lassen).
   */
  prompt(question: string): Promise<string | undefined>;
}

/**
 * Echte Streams (stdout/stdin) für den `bin`-Pfad. EINE persistente readline-Instanz für ALLE Prompts:
 * ein Feature kann mehrfach nacheinander prompten (Multi-Feld-Interview + Approval, z.B. build-skill).
 * Eine readline-Instanz PRO Prompt würde bei PIPED stdin nach dem ersten Prompt den restlichen Input
 * verschlucken (der erste createInterface puffert alle Zeilen; rl.close() verwirft den Rest) — daher
 * lazy EINE geteilte Instanz + eine Zeilen-Queue, die piped UND interaktiv Zeile für Zeile bedient.
 */
export class StdioCliIO implements CliIO {
  private rl: ReadlineInterface | undefined;
  /** Bereits gelesene, noch nicht ausgegebene Eingabe-Zeilen (Pipe kann schneller liefern als wir fragen). */
  private readonly buffered: string[] = [];
  /** Ein wartender prompt(), der auf die nächste Zeile wartet (höchstens einer zur selben Zeit). */
  private pending: ((line: string | undefined) => void) | undefined;
  /** stdin hat EOF erreicht ('close') — alle künftigen/laufenden Prompts liefern undefined. */
  private closed = false;

  constructor(
    private readonly out: NodeJS.WritableStream = process.stdout,
    private readonly input: NodeJS.ReadableStream = process.stdin,
  ) {}

  write(line: string): void {
    this.out.write(line + "\n");
  }

  /** Lazy die geteilte readline-Instanz bauen + ihre Zeilen-/Close-Events an die Queue koppeln. */
  private ensureReadline(): ReadlineInterface {
    if (this.rl !== undefined) return this.rl;
    const rl = createInterface({ input: this.input, output: this.out });
    rl.on("line", (line: string) => {
      // Wartet bereits ein Prompt -> direkt bedienen; sonst puffern (Pipe liefert evtl. vorab).
      if (this.pending !== undefined) {
        const resolve = this.pending;
        this.pending = undefined;
        resolve(line);
      } else {
        this.buffered.push(line);
      }
    });
    rl.on("close", () => {
      this.closed = true;
      // Ein gerade wartender Prompt bekommt EOF -> undefined (kein Hänger).
      if (this.pending !== undefined) {
        const resolve = this.pending;
        this.pending = undefined;
        resolve(undefined);
      }
    });
    this.rl = rl;
    return rl;
  }

  prompt(question: string): Promise<string | undefined> {
    // Bereits gepufferte Zeile? -> sofort bedienen (Prompt-Text trotzdem ausgeben für Kontext).
    if (this.buffered.length > 0) {
      this.out.write(question);
      return Promise.resolve(this.buffered.shift());
    }
    if (this.closed) return Promise.resolve(undefined);

    const rl = this.ensureReadline();
    this.out.write(question);
    return new Promise<string | undefined>((resolve) => {
      this.pending = resolve;
      // Falls stdin zwischen ensureReadline() und hier bereits geschlossen wurde: nicht hängen bleiben.
      if (this.closed && this.pending !== undefined) {
        this.pending = undefined;
        resolve(undefined);
      }
      void rl; // rl-Events bedienen `this.pending` (line/close); hier nichts weiter zu tun.
    });
  }
}

/**
 * In-Memory-IO für Tests: sammelt geschriebene Zeilen und liefert vorgefütterte Antworten der Reihe
 * nach. Erschöpfte Queue -> prompt() liefert `undefined` (= keine Antwort, kein TTY-Hänger).
 */
export class InMemoryCliIO implements CliIO {
  readonly lines: string[] = [];
  readonly questions: string[] = [];
  private readonly answers: string[];
  private cursor = 0;

  constructor(answers: string[] = []) {
    this.answers = [...answers];
  }

  write(line: string): void {
    this.lines.push(line);
  }

  prompt(question: string): Promise<string | undefined> {
    this.questions.push(question);
    const answer = this.cursor < this.answers.length ? this.answers[this.cursor] : undefined;
    this.cursor += 1;
    return Promise.resolve(answer);
  }

  /** Gesamte Ausgabe als ein String (Test-Komfort). */
  output(): string {
    return this.lines.join("\n");
  }
}
