#!/usr/bin/env node
// ───────────────────────────── elio-studio bin — Server-Start + Demo-Seed (Inv. 2) ─────────────────────────────
// Baut die geteilte Studio-Runtime (Migrate-verdrahtet + Demo-Packs registriert), treibt ein paar Runs
// durch ihren Store (damit das Dashboard sofort etwas zeigt: zwei completed Demo-Runs + ein bis zum
// Commit-Approval suspendierter Migrate-Run für die Approval-Inbox), startet den node:http-Server und
// loggt die URL. main() ist EXPORTIERT + nimmt Optionen (Port/Seed), sodass die Verdrahtung testbar
// bleibt; der echte listen()-Start passiert nur im Executable-Guard ganz unten.

import type { Server } from "node:http";
import { LocalEngine } from "@elio/engine";
import { createStudioServer } from "./server";
import type { StudioServer } from "./server";
import { seedStudioRuns } from "./runtime";

/** Default-Port der Studio-Surface (override über $PORT oder das main()-Argument). */
export const DEFAULT_STUDIO_PORT = 4123;

export interface StudioMainOptions {
  /** Port, auf dem gelauscht wird (Default: $PORT oder DEFAULT_STUDIO_PORT; 0 = ephemer). */
  port?: number;
  /** Runs vorab durch den Store treiben, damit das Dashboard etwas zeigt (Default: true). */
  seed?: boolean;
  /** Senke für die Start-Logs (Default: process.stdout). Tests injizieren einen Sammler. */
  log?: (line: string) => void;
}

/**
 * Startet die Studio-Surface: Runtime bauen, (optional) Demo-/Migrate-Runs seeden, Server starten,
 * URL loggen. Liefert den laufenden Server + die gebundene Runtime zurück (Tests können beide nutzen
 * und den Server wieder schließen).
 */
export async function main(opts: StudioMainOptions = {}): Promise<{ server: StudioServer; address: string }> {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const envPort = process.env["PORT"];
  const port =
    opts.port ?? (envPort !== undefined && envPort.length > 0 ? Number(envPort) : DEFAULT_STUDIO_PORT);

  const engine = new LocalEngine();

  if (opts.seed !== false) {
    // Zwei Demo-Runs (completed) + ein Migrate-Run (suspendiert am Commit-Approval) + ein build-skill-Run
    // (suspendiert am approve_write-Approval) -> beide Approvals füllen die Approval-Inbox.
    const { migrate, skill } = await seedStudioRuns(engine);
    if (migrate !== undefined) {
      log(`elio-studio: migrate run ${migrate.run} waiting on approval at step "${migrate.step}".`);
    }
    if (skill !== undefined) {
      log(`elio-studio: build-skill run ${skill.run} waiting on approval at step "${skill.step}".`);
    }
  }

  const server = createStudioServer({ engine, port });

  const address = await listen(server, port);
  log(`elio-studio: dashboard listening on ${address}`);
  log(`elio-studio: open ${address} in your browser (Run status · Loop tape · Live updates · Approval inbox).`);

  return { server, address };
}

/** Promisifiziert server.listen + bildet die gebundene Adresse als http-URL ab. */
function listen(server: Server, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (addr !== null && typeof addr === "object") {
        // Bei 0.0.0.0/:: für die anzeigbare URL auf localhost zurückfallen.
        const host = addr.address === "::" || addr.address === "0.0.0.0" ? "localhost" : addr.address;
        resolve(`http://${host}:${addr.port}`);
      } else {
        resolve(`http://localhost:${String(addr)}`);
      }
    });
  });
}

// ───────────────────────────── Executable-Guard ─────────────────────────────
// Nur wenn die Datei direkt als Programm läuft (nicht beim Import durch Tests).
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
  main()
    .then(({ server }) => {
      // Sauberer Shutdown auf SIGINT/SIGTERM: closeStudio() beendet offene SSE-Antworten zuerst, sodass
      // der Server auch dann terminiert, wenn ein Browser auf dem Dashboard sitzt (sonst hinge close()).
      let shuttingDown = false;
      const shutdown = (sig: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stderr.write(`\nelio-studio: ${sig} — fahre Server herunter…\n`);
        server
          .closeStudio()
          .then(() => {
            process.exitCode = 0;
          })
          .catch((e: unknown) => {
            process.stderr.write(`elio-studio: Shutdown-Fehler: ${e instanceof Error ? e.message : String(e)}\n`);
            process.exitCode = 1;
          });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((e: unknown) => {
      process.stderr.write(`elio-studio: unerwarteter Fehler: ${e instanceof Error ? e.stack : String(e)}\n`);
      process.exitCode = 1;
    });
}
