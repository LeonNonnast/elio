// ───────────────────────────── @elio/mcp — AC-Smoke-Test (Blueprint §8) ─────────────────────────────
// Verbindet einen In-Memory-MCP-Client mit dem Server (kein echter Subprozess, kein Netzwerk — der
// MCP-SDK liefert ein InMemoryTransport-Paar). Prüft die drei AC-Punkte (Blueprint §0.3 / §8):
//   1. Server startet (connect über das Transport-Paar).
//   2. tools/list enthält das Demo-Feature.
//   3. tools/call führt es aus und liefert ein ERFOLGREICHES Ergebnis (gate "passed").

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, discoverFeatures, normalizeInputSchema } from "./index";

/** Baut ein verbundenes Client/Server-Paar über ein In-Memory-Transport-Paar (kein Subprozess). */
async function connectedClient(server = createMcpServer()): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "elio-mcp-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Liest den zusammengefügten Text aller text-Content-Blöcke eines Tool-Ergebnisses. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

describe("@elio/mcp — MCP-Server-Surface (AC, Blueprint §8)", () => {
  it("tools/list enthält das Demo-Feature (name = feature id)", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const ids = tools.map((t) => t.name);
      expect(ids).toContain("demo.draft-until-good");

      const demo = tools.find((t) => t.name === "demo.draft-until-good");
      expect(demo).toBeDefined();
      // inputSchema ist auf das MCP-Objekt-Shape normalisiert.
      expect(demo?.inputSchema.type).toBe("object");
      expect(typeof demo?.description).toBe("string");
    } finally {
      await client.close();
    }
  });

  it("tools/list listet alle entdeckten Features (Demo-Packs + Migrate)", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const ids = new Set(tools.map((t) => t.name));
      for (const f of discoverFeatures()) {
        expect(ids.has(f.id)).toBe(true);
      }
    } finally {
      await client.close();
    }
  });

  it("tools/call demo.draft-until-good führt das Feature aus und liefert gate:passed", async () => {
    const client = await connectedClient();
    try {
      const result = await client.callTool({ name: "demo.draft-until-good", arguments: {} });
      // Erfolg = KEIN isError (gate passed).
      expect(result.isError).toBeFalsy();

      const structured = result.structuredContent as
        | { gate?: string; feature?: string; artifact?: { content?: unknown } }
        | undefined;
      expect(structured?.feature).toBe("demo.draft-until-good");
      expect(structured?.gate).toBe("passed");
      // Das finale Artefakt kreuzt die Surface-Grenze (Inv. 1/4) — progress >= MIN_LENGTH.
      const content = structured?.artifact?.content as { progress?: string } | undefined;
      expect(typeof content?.progress).toBe("string");
      expect((content?.progress ?? "").length).toBeGreaterThanOrEqual(30);

      // Menschenlesbarer Text trägt den Erfolg.
      expect(resultText(result)).toContain("ERFOLGREICH");
    } finally {
      await client.close();
    }
  });

  it("tools/call demo.retry-then-pass läuft über Retry bis gate:passed", async () => {
    const client = await connectedClient();
    try {
      const result = await client.callTool({ name: "demo.retry-then-pass", arguments: {} });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { gate?: string } | undefined;
      expect(structured?.gate).toBe("passed");
    } finally {
      await client.close();
    }
  });

  it("tools/call migrate.csv-to-db führt die Dogfood-Vertikale aus", async () => {
    const client = await connectedClient();
    try {
      const result = await client.callTool({ name: "migrate.csv-to-db", arguments: {} });
      const structured = result.structuredContent as { feature?: string; gate?: string } | undefined;
      // Die Migrate-Vertikale endet mit einem Gate-Ausgang (passed ODER ein klares suspended/stopped) —
      // sie läuft real durch die SDK-Runtime (Inv. 2). Hier: sie liefert ein strukturiertes Ergebnis.
      expect(structured?.feature).toBe("migrate.csv-to-db");
      expect(typeof structured?.gate === "string" || (structured as { status?: string })?.status === "suspended").toBe(
        true,
      );
    } finally {
      await client.close();
    }
  });

  it("tools/list enthält build-skill mit den Brief-Feldern im inputSchema", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      const skill = tools.find((t) => t.name === "build-skill");
      expect(skill).toBeDefined();
      // Die Brief-Felder werden als optionale Run-Parameter angeboten (kein Interview im synchronen Call).
      const props = skill?.inputSchema.properties ?? {};
      expect(props).toHaveProperty("name");
      expect(props).toHaveProperty("description");
      expect(props).toHaveProperty("purpose");
    } finally {
      await client.close();
    }
  });

  it("tools/call build-skill (vollständiger Default-Brief) suspendiert am approve_write-Gate", async () => {
    const client = await connectedClient();
    try {
      // Ein synchroner v0.1-Tool-Call kann kein Interview führen -> der Default-Brief reicht bis zum
      // blocking approve_write-Approval, das (ohne Auto-Resolve) als suspended-Ergebnis zurückkommt.
      const result = await client.callTool({ name: "build-skill", arguments: {} });
      const structured = result.structuredContent as
        | { feature?: string; status?: string; elicitation?: { what?: string } }
        | undefined;
      expect(structured?.feature).toBe("build-skill");
      expect(structured?.status).toBe("suspended");
      expect(structured?.elicitation?.what).toMatch(/Write SKILL\.md to disk/);
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("tools/call mit unbekanntem Feature liefert einen Fehler (isError)", async () => {
    const client = await connectedClient();
    try {
      const result = await client.callTool({ name: "does.not.exist", arguments: {} });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("Unbekanntes Feature");
    } finally {
      await client.close();
    }
  });

  it("tools/list bietet die optionale model-Property im inputSchema jedes Features an", async () => {
    const client = await connectedClient();
    try {
      const { tools } = await client.listTools();
      // Jedes entdeckte Feature trägt die optionale kanonische provider:model-Spec im Schema.
      for (const f of discoverFeatures()) {
        const tool = tools.find((t) => t.name === f.id);
        expect(tool, `tool ${f.id}`).toBeDefined();
        const props = tool?.inputSchema.properties ?? {};
        expect(props, f.id).toHaveProperty("model");
        // model ist optional (nicht in required) — Rückwärtskompatibilität.
        const required = (tool?.inputSchema.required ?? []) as string[];
        expect(required).not.toContain("model");
      }
    } finally {
      await client.close();
    }
  });

  it("tools/call mit explizitem model auf einem Demo-Pack ist ein no-op (gate:passed, kein Netz)", async () => {
    const client = await connectedClient();
    try {
      // Demo-Packs sind mock-only -> ein gesetztes model wird ignoriert und ändert das Ergebnis nicht.
      const result = await client.callTool({
        name: "demo.draft-until-good",
        arguments: { model: "claude:claude-opus-4-8" },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { gate?: string; feature?: string } | undefined;
      expect(structured?.feature).toBe("demo.draft-until-good");
      expect(structured?.gate).toBe("passed");
    } finally {
      await client.close();
    }
  });

  it("tools/call mit model=mock auf der Migrate-Vertikale läuft deterministisch (offline)", async () => {
    const client = await connectedClient();
    try {
      // Ein explizites model=mock wählt den (immer verfügbaren) Mock-Provider; resolveModels schaltet
      // den Ollama-Auto-Detect ab -> garantiert kein Netz. Der Lauf liefert ein strukturiertes Gate-Ergebnis.
      const result = await client.callTool({
        name: "migrate.csv-to-db",
        arguments: { model: "mock" },
      });
      const structured = result.structuredContent as
        | { feature?: string; gate?: string; status?: string }
        | undefined;
      expect(structured?.feature).toBe("migrate.csv-to-db");
      expect(
        typeof structured?.gate === "string" || structured?.status === "suspended",
      ).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("normalizeInputSchema bildet beliebige io.input auf ein MCP-Objekt-Schema ab", () => {
    const empty = normalizeInputSchema({});
    expect(empty.type).toBe("object");
    // Lauf-Parameter (csv/budget/maxDepth/model) sind als optionale Properties angeboten.
    expect(empty.properties).toHaveProperty("budget");
    expect(empty.properties).toHaveProperty("maxDepth");
    expect(empty.properties).toHaveProperty("model");

    const withProps = normalizeInputSchema({
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
    });
    expect(withProps.properties).toHaveProperty("source");
    expect(withProps.required).toContain("source");
  });
});
