#!/usr/bin/env node
// ───────────────────────────── elio bin — Arg-Parsing + main() (Inv. 2) ─────────────────────────────
// Hand-gerolltes Arg-Parsing (keine Dep nötig). main() ist EXPORTIERT und nimmt argv + einen injizierbaren
// CliIO + einen optionalen EngineService entgegen, sodass Tests die Command-Handler OHNE Prozess-Spawn/TTY
// treiben können. process.exit() passiert NUR im Executable-Guard ganz unten.
//
// Befehle:
//   elio run <feature> [--csv|--out|--model|--ollama-url|--capture-dir|--payload|--no-prompt]
//   elio resume [<feature>] <correlation-id> [answer]   (feature optional — Engine leitet es aus dem Store ab)
//   elio runs [<feature>]                                (feature optional — der Store hält ALLE Features)
//   elio --help | -h
//
// Die CLI baut einen LocalEngine über einem persistenten FileRunStore (Default .elio/runs bzw.
// $ELIO_STATE_DIR) und treibt ausschließlich engine.startRun()/resumeRun()/liveStatus(). KEINE
// Feature-Auflösung, KEINE Runtime-Konstruktion, KEINE Governance mehr in der CLI (Inv. 2).

import { join } from "node:path";
import { EngineClient, LocalEngine } from "@elio/engine";
import type { EngineService } from "@elio/engine";
import { FileRunStore } from "@elio/sdk";
import type { InMemoryRunStore } from "@elio/sdk";
import { StdioCliIO } from "./io";
import type { CliIO } from "./io";
import {
  decodeCorrelation,
  parseAnswer,
  parsePayload,
  resumeCommand,
  runCommand,
  runsCommand,
  serveCommand,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_USAGE,
} from "./commands";
import { USAGE } from "./help";

/** Default-Port des Engine-Host (override über --port, $ELIO_ENGINE_PORT; 0 = ephemer). */
export const DEFAULT_ENGINE_PORT = 4500;

export interface ParsedArgs {
  command: "run" | "resume" | "runs" | "serve" | "help" | "unknown";
  positionals: string[];
  flags: Record<string, string | boolean>;
  raw?: string;
}

/**
 * Hand-gerolltes Arg-Parsing. Erstes Token = Befehl; Rest sind Positionsargumente, außer `--flag [value]`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  if (argv.length === 0) return { command: "help", positionals, flags };

  const [head, ...rest] = argv as [string, ...string[]];
  if (head === "--help" || head === "-h") return { command: "help", positionals, flags };

  let command: ParsedArgs["command"];
  switch (head) {
    case "run":
      command = "run";
      break;
    case "resume":
      command = "resume";
      break;
    case "runs":
      command = "runs";
      break;
    case "serve":
      command = "serve";
      break;
    case "help":
      command = "help";
      break;
    default:
      return { command: "unknown", positionals, flags, raw: head };
  }

  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i] as string;
    if (tok === "--help" || tok === "-h") return { command: "help", positionals, flags };
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(tok);
  }

  return { command, positionals, flags };
}

export interface MainOptions {
  /** IO-Seam (Default: echte stdout/stdin). Tests injizieren InMemoryCliIO. */
  io?: CliIO;
  /** Injizierter EngineService (Tests / eingebettet). Ist er gesetzt, ignoriert main() store/stateDir/Profile. */
  engine?: EngineService;
  /** Verzeichnis des persistenten Run-Stores (FileRunStore). Default: $ELIO_STATE_DIR ?? <cwd>/.elio/runs. */
  stateDir?: string;
  /** Expliziter Store-Override (gewinnt vor stateDir). Ignoriert, wenn `engine` injiziert ist. */
  store?: InMemoryRunStore;
}

/** Liest eine Remote-Engine-URL aus --engine-url ODER $ELIO_ENGINE_URL (leer = lokal). */
function engineUrl(parsed: ParsedArgs): string | undefined {
  const flag = typeof parsed.flags["engine-url"] === "string" ? parsed.flags["engine-url"] : undefined;
  const url = flag ?? process.env["ELIO_ENGINE_URL"];
  return url !== undefined && url.length > 0 ? url : undefined;
}

/** Baut den EngineService für diese Invocation: injiziert > Remote-Client (--engine-url) > lokaler Host. */
function buildEngine(opts: MainOptions, parsed: ParsedArgs): EngineService {
  if (opts.engine !== undefined) return opts.engine;
  const url = engineUrl(parsed);
  if (url !== undefined) return new EngineClient({ baseUrl: url });
  return buildLocalEngine(opts, parsed);
}

/** Baut einen LocalEngine (persistenter FileRunStore + Profile + captureDir aus den Flags). */
function buildLocalEngine(opts: MainOptions, parsed: ParsedArgs): LocalEngine {
  const store =
    opts.store ??
    new FileRunStore(opts.stateDir ?? process.env["ELIO_STATE_DIR"] ?? join(process.cwd(), ".elio", "runs"));
  const profiles: { model?: string; ollamaUrl?: string } = {};
  if (typeof parsed.flags["model"] === "string") profiles.model = parsed.flags["model"];
  if (typeof parsed.flags["ollama-url"] === "string") profiles.ollamaUrl = parsed.flags["ollama-url"];
  const captureDir =
    typeof parsed.flags["capture-dir"] === "string" ? parsed.flags["capture-dir"] : undefined;
  return new LocalEngine({ store, profiles, ...(captureDir !== undefined ? { captureDir } : {}) });
}

/**
 * Programmatischer CLI-Einstieg. Parst argv, baut den EngineService, dispatcht auf die Command-Handler
 * und liefert den Exit-Code zurück (ohne process.exit — das macht nur der Executable-Guard unten).
 */
export async function main(argv: string[], opts: MainOptions = {}): Promise<number> {
  const io = opts.io ?? new StdioCliIO();
  const parsed = parseArgs(argv);

  if (parsed.command === "help") {
    io.write(USAGE);
    return EXIT_OK;
  }
  if (parsed.command === "unknown") {
    io.write(`Unbekannter Befehl "${parsed.raw}".\n`);
    io.write(USAGE);
    return EXIT_USAGE;
  }

  // serve hostet IMMER einen lokalen Engine (ein Client kann nicht serviert werden) — der dauerlaufende
  // Host hält den Prozess über den Listening-Socket am Leben; SIGINT/SIGTERM fahren ihn sauber herunter.
  if (parsed.command === "serve") {
    const engine = opts.engine ?? buildLocalEngine(opts, parsed);
    const portFlag = typeof parsed.flags["port"] === "string" ? Number(parsed.flags["port"]) : undefined;
    const envPort = process.env["ELIO_ENGINE_PORT"];
    const port = portFlag ?? (envPort !== undefined && envPort.length > 0 ? Number(envPort) : DEFAULT_ENGINE_PORT);
    const { host } = await serveCommand(engine, io, port);
    const shutdown = (): void => {
      void host.closeHost();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return EXIT_OK;
  }

  const engine = buildEngine(opts, parsed);

  switch (parsed.command) {
    case "run": {
      const feature = parsed.positionals[0] ?? "";
      const params: Record<string, unknown> = {};
      if (typeof parsed.flags["csv"] === "string") params["sourceCsv"] = parsed.flags["csv"];
      if (typeof parsed.flags["out"] === "string") params["outDir"] = parsed.flags["out"];
      const runOpts: {
        noPrompt?: boolean;
        payload?: unknown;
        params?: Record<string, unknown>;
      } = { noPrompt: parsed.flags["no-prompt"] === true };
      if (typeof parsed.flags["payload"] === "string") runOpts.payload = parsePayload(parsed.flags["payload"]);
      if (Object.keys(params).length > 0) runOpts.params = params;
      const res = await runCommand(engine, feature, io, runOpts);
      return res.exitCode;
    }

    case "resume": {
      // correlation-id ist das Positional, das als run/branch/step#checkpoint dekodiert (egal ob ein
      // <feature> davor steht — das ist jetzt optional, der Engine-Service leitet das Feature aus dem Store ab).
      const corrIdx = parsed.positionals.findIndex((p) => decodeCorrelation(p) !== undefined);
      if (corrIdx < 0) {
        io.write(
          "Fehler: `elio resume [<feature>] <correlation-id> [answer]` — gültige <correlation-id> " +
            "(run/branch/step#checkpoint) fehlt. Sie stammt aus `elio run`/`elio runs`. Der Run kommt aus dem " +
            "persistenten Store (Default .elio/runs, sonst $ELIO_STATE_DIR).",
        );
        return EXIT_USAGE;
      }
      const correlation = decodeCorrelation(parsed.positionals[corrIdx] as string);
      if (correlation === undefined) return EXIT_USAGE; // unerreichbar (findIndex garantiert), Typ-Guard
      const answerArg = parsed.positionals[corrIdx + 1];
      const answer = answerArg !== undefined ? parseAnswer(answerArg) : { approved: true };
      const res = await resumeCommand(engine, correlation, answer, io);
      return res.exitCode;
    }

    case "runs": {
      const res = await runsCommand(engine, io);
      return res.exitCode;
    }

    default: {
      const _exhaustive: never = parsed.command;
      io.write(`Unbehandelter Befehl: ${String(_exhaustive)}`);
      return EXIT_USAGE;
    }
  }
}

// ───────────────────────────── Executable-Guard ─────────────────────────────
const isMain = (() => {
  try {
    const invoked = process.argv[1];
    if (invoked === undefined) return false;
    const here = new URL(import.meta.url).pathname;
    return here === invoked || here.endsWith(invoked) || invoked.endsWith("bin.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e: unknown) => {
      process.stderr.write(`elio: unerwarteter Fehler: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exitCode = EXIT_FAIL;
    });
}
