#!/usr/bin/env node
// ───────────────────────────── elio-mcp bin — stdio-Transport-Wiring (Inv. 2/19) ─────────────────────────────
// Verbindet den (über createMcpServer gebauten) Server mit einem stdio-Transport: außen ein MCP-Server
// (z.B. Claude Code als MCP-Client), intern ein @elio/sdk-Client (Richtung B, Inv. 19). main() ist
// EXPORTIERT und nimmt einen optionalen vorgebauten Server entgegen, sodass die Verdrahtung testbar
// bleibt; der echte stdio-Connect passiert nur im Executable-Guard ganz unten.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpServer } from "./server";

/**
 * Startet die MCP-Surface über stdio. Baut (falls nicht injiziert) den Server via createMcpServer und
 * verbindet ihn mit einem StdioServerTransport. Läuft, bis der Transport schließt.
 */
export async function main(server: Server = createMcpServer()): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Hinweis an stderr (stdout ist der MCP-JSON-RPC-Kanal — NIE dort loggen).
  process.stderr.write("elio-mcp: stdio MCP-Server verbunden. tools/list für verfügbare Features.\n");
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
  main().catch((e: unknown) => {
    process.stderr.write(`elio-mcp: unerwarteter Fehler: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = 1;
  });
}
