// ───────────────────────────── CLI-Command-Handler (dünn über @elio/engine, Inv. 2) ─────────────────────────────
// Jeder Handler ist eine reine Funktion über einem injizierten EngineService + CliIO. Die CLI ist jetzt
// ein ECHTER dünner Client: sie kennt KEINE Feature-Auflösung, KEINE Runtime-Konstruktion, KEINE
// Governance mehr (das war features.ts — gelöscht). Sie ruft engine.startRun()/resumeRun()/liveStatus(),
// streamt RunEvents als Zeilen und ist die minimale Approval Inbox (an node-suspended prompten + resumen).

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CorrelationId, Elicitation, RunEvent } from "@elio/core";
import { createEngineHost } from "@elio/engine";
import type { EngineHost, EngineService } from "@elio/engine";
import type { CliIO } from "./io";
import { formatElicitationPrompt, formatEvent, formatRunStatus } from "./format";

/** Exit-Code-Konvention: 0 = Gate "passed", 1 = gestoppt/Fehler, 2 = Usage-Fehler. */
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

/** Ein Command-Handler liefert den gewünschten Prozess-Exit-Code (bin.ts setzt ihn). */
export type CommandResult = { exitCode: number };

// ───────────────────────────── elio run <feature> ─────────────────────────────

export interface RunCommandOptions {
  /** Auf eine node-suspended (Approval) NICHT prompten, sondern den Run suspendiert lassen. */
  noPrompt?: boolean;
  /** Run-Payload an den ersten Node (Default {}). pm.event-log: roher Hook-Event; pm.session-summary: Session-id. */
  payload?: unknown;
  /** Feature-spezifische Eingaben (z.B. { sourceCsv }, { outDir, brief }) — gereicht an den Provider. */
  params?: Record<string, unknown>;
  /** Optionaler harter USD-Ausgaben-Deckel für den Run (§v0.2). Überschritten -> Run stoppt (gate:stopped). */
  maxCostUsd?: number;
}

/**
 * `elio run <feature>`: treibt ein Feature über den EngineService aus, streamt RunEvents als Zeilen und
 * prompted an einer node-suspended Elicitation den Menschen (Approval Inbox, §6) — dann resume über die
 * correlation-id. Wiederholt sich, bis completed (gate passed/stopped) ODER suspendiert bleibt.
 *
 * Exit 0 NUR bei run-completed{gate:"passed"}.
 */
export async function runCommand(
  engine: EngineService,
  feature: string,
  io: CliIO,
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  if (feature.length === 0) {
    io.write('Fehler: `elio run` braucht ein <feature> (z.B. "demo.draft-until-good" oder ./feature.yaml).');
    return { exitCode: EXIT_USAGE };
  }

  io.write(`Lade Feature "${feature}".`);

  // Start des Runs. Budget/Tiefe sind Pflicht (Inv. 21); großzügig dimensioniert. Der EngineService löst
  // Feature/Runtime/Governance serverseitig auf — die CLI reicht nur featureId + Input durch. Fehler
  // (z.B. unbekanntes Feature) entstehen erst beim Iterieren des (lazy) Streams -> hier umfassen.
  const stream = engine.startRun(
    feature,
    {
      payload: opts.payload ?? {},
      budget: 1000,
      maxDepth: 200,
      ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
    },
    opts.params,
  );
  try {
    return await drive(engine, stream, io, opts.noPrompt === true);
  } catch (e) {
    io.write(`Fehler: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: EXIT_FAIL };
  }
}

// ───────────────────────────── geteilter Stream-/Resume-Treiber ─────────────────────────────

type ConsumeOutcome =
  | { kind: "completed"; gate: "passed" | "stopped" }
  | { kind: "suspended-unanswered"; correlation: CorrelationId }
  | { kind: "resumed"; stream: AsyncIterable<RunEvent> }
  | { kind: "ended" };

/** Treibt einen (Start- oder Resume-)Stream bis zum Ruhepunkt, inkl. Folge-Approvals. */
async function drive(
  engine: EngineService,
  initial: AsyncIterable<RunEvent>,
  io: CliIO,
  noPrompt: boolean,
): Promise<CommandResult> {
  let stream = initial;
  for (;;) {
    // Stream-Fehler propagieren zum Aufrufer (runCommand: "Fehler: …"; resumeCommand: Store-Hinweis).
    const outcome = await consumeStream(engine, stream, io, noPrompt);

    if (outcome.kind === "completed") {
      io.write(`\nRun ${outcome.gate === "passed" ? "ERFOLGREICH (gate passed)" : "GESTOPPT (gate stopped)"}.`);
      return { exitCode: outcome.gate === "passed" ? EXIT_OK : EXIT_FAIL };
    }
    if (outcome.kind === "suspended-unanswered") {
      io.write(
        `\nRun SUSPENDIERT — wartet auf Antwort. Resume mit:\n  elio resume ${encodeCorrelation(
          outcome.correlation,
        )} <answer>`,
      );
      return { exitCode: EXIT_FAIL };
    }
    if (outcome.kind === "ended") {
      io.write('\nRun beendet (kein gate:"passed").');
      return { exitCode: EXIT_FAIL };
    }
    stream = outcome.stream; // resumed -> nächsten Stream konsumieren
  }
}

/**
 * Konsumiert einen RunEvent-Stream und schreibt jede Zeile. run-completed -> fertig. node-suspended
 * (Approval, §6) -> Mensch prompten + engine.resumeRun() (oder suspended-unanswered, wenn keine Antwort).
 */
async function consumeStream(
  engine: EngineService,
  stream: AsyncIterable<RunEvent>,
  io: CliIO,
  noPrompt: boolean,
): Promise<ConsumeOutcome> {
  for await (const ev of stream) {
    io.write(formatEvent(ev));

    if (ev.type === "run-completed") {
      return { kind: "completed", gate: ev.gate };
    }

    if (ev.type === "node-suspended") {
      if (noPrompt) {
        return { kind: "suspended-unanswered", correlation: ev.correlation };
      }
      const answer = await promptForElicitation(ev.elicitation, io);
      if (answer === undefined) {
        return { kind: "suspended-unanswered", correlation: ev.correlation };
      }
      io.write(`Antwort: ${JSON.stringify(answer)} -> resume ${encodeCorrelation(ev.correlation)}`);
      return { kind: "resumed", stream: engine.resumeRun(ev.correlation, answer) };
    }
  }
  return { kind: "ended" };
}

/** Prompted den Menschen für eine Elicitation und parst die Antwort. undefined = keine Antwort. */
async function promptForElicitation(e: Elicitation, io: CliIO): Promise<unknown | undefined> {
  io.write(formatElicitationPrompt(e));
  const raw = await io.prompt("> ");
  if (raw === undefined) return undefined;
  return parseAnswer(raw);
}

// ───────────────────────────── elio resume <correlation-id> [answer] ─────────────────────────────

/**
 * `elio resume <correlation-id> [answer]`: resumed einen suspendierten Run über den EngineService. Die
 * correlation-id ist die `run/branch/step#checkpoint`-Form. Das Feature leitet der EngineService aus dem
 * (persistenten) Store ab — die CLI muss es nicht mehr kennen.
 */
export async function resumeCommand(
  engine: EngineService,
  correlation: CorrelationId,
  answer: unknown,
  io: CliIO,
): Promise<CommandResult> {
  io.write(`Resume ${encodeCorrelation(correlation)} mit Antwort ${JSON.stringify(answer)}.`);
  try {
    return await drive(engine, engine.resumeRun(correlation, answer), io, false);
  } catch (e) {
    io.write(
      `\nResume fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}\n` +
        "  Hinweis: cross-process Resume nutzt den persistenten Store (Default .elio/runs, sonst\n" +
        "  $ELIO_STATE_DIR). Prüfe, dass das Verzeichnis zum ursprünglichen `elio run` passt.",
    );
    return { exitCode: EXIT_FAIL };
  }
}

// ───────────────────────────── elio runs ─────────────────────────────

/** `elio runs`: listet die Runs aus dem geteilten Store über engine.liveStatus(). */
export async function runsCommand(engine: EngineService, io: CliIO): Promise<CommandResult> {
  const statuses = await engine.liveStatus();
  if (statuses.length === 0) {
    io.write(
      "Keine Runs im Store.\n" +
        "  Hinweis: Der Run-Store ist persistent (Default .elio/runs, sonst $ELIO_STATE_DIR). Ein leeres\n" +
        "  Ergebnis heißt: in DIESEM Verzeichnis wurde noch nichts gelaufen.",
    );
    return { exitCode: EXIT_OK };
  }
  io.write(`Runs (${statuses.length}):`);
  for (const s of statuses) {
    io.write(`  ${formatRunStatus(s)}`);
  }
  return { exitCode: EXIT_OK };
}

// ───────────────────────────── elio serve (Engine-Host) ─────────────────────────────

/**
 * `elio serve`: startet einen EngineHost über dem gegebenen EngineService — EIN dauerlaufender Prozess,
 * gegen den sich CLI/MCP/Studio als EngineClient andocken und denselben Store LIVE sehen (das löst das
 * in-process-only-subscribe-Limit). Liefert den Host + die gebundene Adresse (der Aufrufer wired Shutdown).
 */
export async function serveCommand(
  engine: EngineService,
  io: CliIO,
  port: number,
): Promise<{ host: EngineHost; address: string }> {
  const host = createEngineHost({ engine });
  const address = await listen(host, port);
  io.write(`elio: engine host listening on ${address}`);
  io.write(`elio: point clients at it with --engine-url ${address} (or $ELIO_ENGINE_URL).`);
  return { host, address };
}

/** Promisifiziert server.listen + bildet die gebundene Adresse als http-URL ab (Port 0 = ephemer). */
function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (addr !== null && typeof addr === "object") {
        const a = addr as AddressInfo;
        const host = a.address === "::" || a.address === "0.0.0.0" ? "localhost" : a.address;
        resolve(`http://${host}:${a.port}`);
      } else {
        resolve(`http://localhost:${String(addr)}`);
      }
    });
  });
}

// ───────────────────────────── Hilfen: correlation-id codec + answer/payload parsing (reine UI) ─────────────────────────────

/** Serialisiert eine correlation-id als `run/branch/step#checkpoint` (CLI-stabil). */
export function encodeCorrelation(c: CorrelationId): string {
  return `${c.run}/${c.branch}/${c.step}#${c.checkpoint}`;
}

/** Parst `run/branch/step#checkpoint` zurück in eine CorrelationId. undefined bei Malformed. */
export function decodeCorrelation(s: string): CorrelationId | undefined {
  const hashAt = s.lastIndexOf("#");
  if (hashAt < 0) return undefined;
  const checkpoint = s.slice(hashAt + 1);
  const rest = s.slice(0, hashAt);
  const parts = rest.split("/");
  if (parts.length !== 3 || checkpoint.length === 0) return undefined;
  const [run, branch, step] = parts as [string, string, string];
  if (run.length === 0 || branch.length === 0 || step.length === 0) return undefined;
  return { run, branch, step, checkpoint };
}

/**
 * Parst eine menschliche Antwort in einen strukturierten Wert (Approval Inbox, §6):
 *  - "y" | "yes" | "approve" | "ok" | "true"  -> { approved: true }
 *  - "n" | "no" | "deny" | "reject" | "false" -> { approved: false }
 *  - gültiges JSON                             -> der geparste Wert
 *  - sonst                                     -> der rohe String
 */
export function parseAnswer(raw: string): unknown {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (["y", "yes", "approve", "ok", "true"].includes(lower)) return { approved: true };
  if (["n", "no", "deny", "reject", "false"].includes(lower)) return { approved: false };
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Parst ein `--payload`-Argument für `elio run` (NICHT über parseAnswer). Nur JSON-Objekte/-Arrays werden
 * übernommen; jedes Skalar bleibt der ROHE String (eine Session-id `123`/`ok` muss der String bleiben).
 */
export function parsePayload(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    // kein JSON → roher String (die häufige Session-id-Form).
  }
  return trimmed;
}
