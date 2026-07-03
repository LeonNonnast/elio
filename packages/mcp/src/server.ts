// ───────────────────────────── @elio/mcp — MCP-Server-Surface (außen MCP, intern @elio/sdk, Inv. 2/19) ─────────────────────────────
// createMcpServer() baut einen stdio-fähigen MCP-Server, der die verfügbaren ELIO-Feature-Packs als
// MCP-TOOLS exponiert:
//  - tools/list : ein Tool pro entdecktem Feature (name = feature id, description = metadata,
//                 inputSchema aus feature.io.input — normalisiert auf das MCP-{type:"object",…}-Shape).
//  - tools/call : führt das Feature über die @elio/sdk-Runtime (createRuntime().run()) end-to-end aus
//                 und liefert das Ergebnis zurück (finales Artefakt + Gate-Ausgang). Suspendiert der
//                 Run (Elicitation), wird die Elicitation als Tool-Ergebnis (isError) zurückgereicht —
//                 der MCP-Client sieht, worauf der Loop wartet (Richtung B, Inv. 19).
//
// Die Surface ist ein reiner CLIENT (Inv. 2): KEINE Runner-/Injector-/Registry-Logik hier. Sie wählt
// eine Fassade (discoverFeatures -> makeRuntime) und reicht run() durch. Budget/Tiefe sind Pflicht und
// werden an die Runtime durchgereicht + dort dekrementiert (Inv. 21).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Artifact, RunEvent } from "@elio/core";
import { LocalEngine } from "@elio/engine";
import type { EngineService } from "@elio/engine";
import { briefFromArgs, discoverFeatures, indexFeatures } from "./registry";
import type { FeatureInfo } from "./registry";

/** Default-Budget/Tiefe für einen MCP-getriebenen Run (Pflicht, Inv. 21; großzügig für die Demos). */
export const DEFAULT_MCP_BUDGET = 1000;
export const DEFAULT_MCP_MAX_DEPTH = 200;

/** Server-Identität (advertised an den MCP-Client beim Initialize). */
export const MCP_SERVER_NAME = "elio-mcp";
export const MCP_SERVER_VERSION = "0.0.0";

export interface CreateMcpServerOptions {
  /**
   * Der EngineService, den die Surface treibt (Default: ein frischer LocalEngine = zentraler Katalog +
   * geteilter Store). Tests/Hosts können einen eigenen injizieren (z.B. einen EngineClient gegen einen
   * dauerlaufenden Host, Phase 4).
   */
  engine?: EngineService;
  /**
   * Eigene Feature-Liste für tools/list (Default: discoverFeatures() = der zentrale Engine-Katalog). Tests
   * können eine eingeschränkte Liste injizieren.
   */
  features?: FeatureInfo[];
  /** Default-Budget pro Run (Inv. 21). Ein "budget"-Tool-Argument überschreibt es pro Call. */
  defaultBudget?: number;
  /** Default-maxDepth pro Run (Inv. 21). Ein "maxDepth"-Tool-Argument überschreibt es pro Call. */
  defaultMaxDepth?: number;
}

/**
 * Baut einen konfigurierten (noch nicht verbundenen) MCP-Server. Der Aufrufer verbindet ihn mit einem
 * Transport (bin.ts: stdio; Tests: ein In-Memory-Transport-Paar). tools-Capability wird advertised.
 */
export function createMcpServer(opts: CreateMcpServerOptions = {}): Server {
  const engine = opts.engine ?? new LocalEngine();
  const features = opts.features ?? discoverFeatures();
  const byId = indexFeatures(features);
  const budget = opts.defaultBudget ?? DEFAULT_MCP_BUDGET;
  const maxDepth = opts.defaultMaxDepth ?? DEFAULT_MCP_MAX_DEPTH;

  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "ELIO MCP-Surface: exponiert ELIO-Feature-Packs als Tools. tools/list listet die verfügbaren " +
        "Features; tools/call <feature> führt einen governten ELIO-Loop aus und liefert das finale " +
        "Artefakt + den Gate-Ausgang zurück (Inv. 1). Budget/Tiefe sind Pflicht und werden dekrementiert.",
    },
  );

  // tools/list: ein Tool pro Feature (name = feature id).
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools: Tool[] = features.map((f) => featureToTool(f));
    return { tools };
  });

  // tools/call <feature>: das Feature über die SDK-Runtime ausführen.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const entry = byId.get(name);
    if (entry === undefined) {
      return errorResult(
        `Unbekanntes Feature "${name}". Verfügbar: ${features.map((f) => f.id).join(", ")}.`,
      );
    }
    return runFeature(engine, entry, args, budget, maxDepth);
  });

  return server;
}

// ───────────────────────────── tools/list: FeaturePack -> MCP-Tool ─────────────────────────────

/**
 * Bildet einen FeaturePack auf einen MCP-Tool-Deskriptor ab. inputSchema wird aus feature.io.input
 * abgeleitet und auf das von MCP geforderte `{ type: "object", properties?, required? }`-Shape
 * normalisiert (siehe normalizeInputSchema). Die Beschreibung trägt id/version/autonomy + Artefakt-Gate.
 */
export function featureToTool(f: FeatureInfo): Tool {
  const meta = f.pack.metadata;
  const feat = f.pack.feature;
  const description =
    `ELIO-Feature "${meta.id}" v${meta.version} (autonomy=${feat.autonomy}). ` +
    `Führt den Outer Loop aus, bis das Artefakt "${feat.artifact.kind}" das Gate ` +
    `"${feat.artifact.evalGate}" besteht (Inv. 1), und liefert das finale Artefakt + Gate-Ausgang.`;
  return {
    name: f.id,
    description,
    inputSchema: normalizeInputSchema(feat.io.input),
  };
}

/**
 * Normalisiert ein FeaturePack-io.input (beliebiges JSON-Schema-Objekt, §3) auf das MCP-Tool-
 * inputSchema-Shape `{ type: "object", properties?, required? }`. ELIO-Features nehmen ihren Input über
 * `RunInput.payload` (ein offenes Objekt); MCP verlangt ein Objekt-Schema. Ist das deklarierte Schema
 * bereits ein Objekt-Schema, werden properties/required übernommen; sonst ein offenes Objekt-Schema.
 * Zusätzlich werden die MCP-spezifischen Lauf-Parameter (csv/budget/maxDepth) als optionale Properties
 * angeboten, ohne den Run zu erzwingen (alle optional).
 */
export function normalizeInputSchema(input: unknown): Tool["inputSchema"] {
  const base: { type: "object"; properties: Record<string, object>; required?: string[] } = {
    type: "object",
    properties: {},
  };

  if (isPlainObject(input)) {
    const props = input["properties"];
    if (isPlainObject(props)) {
      for (const [k, v] of Object.entries(props)) {
        if (isPlainObject(v)) base.properties[k] = v;
      }
    }
    const req = input["required"];
    if (Array.isArray(req)) {
      const onlyStrings = req.filter((x): x is string => typeof x === "string");
      if (onlyStrings.length > 0) base.required = onlyStrings;
    }
  }

  // MCP-Lauf-Parameter (alle optional): csv (Migrate-Sample), budget/maxDepth (Inv. 21, override).
  base.properties["csv"] = {
    type: "string",
    description: "Optional: CSV-Inhalt für die Migrate-Vertikale (sonst ein Default-Sample).",
  };
  // build-skill-Brief-Felder (alle optional; überschreiben den Default-Sample-Brief). Synchrone
  // v0.1-Tool-Calls können kein Interview führen — ein vollständiger Brief reicht bis zum approve_write.
  base.properties["name"] = {
    type: "string",
    description: "Optional (build-skill): Skill-Name (wird zu kebab-case normalisiert).",
  };
  base.properties["description"] = {
    type: "string",
    description: "Optional (build-skill): einzeilige Beschreibung (was + wann zu nutzen).",
  };
  base.properties["purpose"] = {
    type: "string",
    description: "Optional (build-skill): Zweck des Skills.",
  };
  base.properties["whenToUse"] = {
    type: "string",
    description: "Optional (build-skill): wann der Skill genutzt werden soll.",
  };
  base.properties["instructions"] = {
    type: "string",
    description: "Optional (build-skill): die Skill-Instruktionen (Body).",
  };
  base.properties["budget"] = {
    type: "number",
    description: "Optional: Budget für diesen Run (Inv. 21; überschreibt den Server-Default).",
  };
  base.properties["maxDepth"] = {
    type: "number",
    description: "Optional: maximale Loop-Tiefe für diesen Run (Inv. 21; überschreibt den Default).",
  };
  // Optionale kanonische provider:model-Spec (z.B. "ollama:llama3", "claude:claude-opus-4-8"). Wird von
  // der makeRuntime-Fassade konsumiert (NICHT in den payload gereicht, s. runFeature). Demo-Packs (mock)
  // ignorieren sie (no-op); die Vertikalen lösen daraus eine echte Provider-Config auf, soweit die
  // Root-Policy das zulässt (Inv. 13/14: migrate/build-skill bleiben sonst mock-only). Phase-2-Erweiterung.
  base.properties["model"] = {
    type: "string",
    description:
      "Optional: kanonische provider:model-Spec (z.B. \"ollama:llama3\", \"claude:claude-opus-4-8\"). " +
      "Wählt den Provider für diesen Run; Demo-Packs ignorieren sie (mock-only).",
  };
  // Optionaler Ollama-Endpoint-Override (nur relevant, wenn model auf einen ollama-Provider zeigt).
  base.properties["ollamaUrl"] = {
    type: "string",
    description: "Optional: Ollama-Basis-URL (Override), falls model auf einen ollama-Provider zeigt.",
  };

  return base;
}

// ───────────────────────────── tools/call: Feature über die SDK-Runtime ausführen ─────────────────────────────

/**
 * Führt EIN Feature über seine (frisch gebaute) SDK-Runtime aus: run() konsumieren bis run-completed
 * ODER node-suspended. Bei completed -> das finale Artefakt + Gate-Ausgang als Tool-Ergebnis. Bei
 * suspended -> die Elicitation als (isError) Ergebnis (der Client sieht, worauf der Loop wartet, Inv. 19).
 * Budget/Tiefe werden als Pflicht-RunInput durchgereicht (Default oder per-Call-Override, Inv. 21).
 */
export async function runFeature(
  engine: EngineService,
  entry: FeatureInfo,
  args: Record<string, unknown>,
  defaultBudget: number,
  defaultMaxDepth: number,
): Promise<CallToolResult> {
  const runBudget = typeof args["budget"] === "number" ? (args["budget"] as number) : defaultBudget;
  const runMaxDepth =
    typeof args["maxDepth"] === "number" ? (args["maxDepth"] as number) : defaultMaxDepth;

  // Feature-spezifische Setup-Eingaben (params): csv -> Migrate-Quelle; für build-skill ein vollständiger
  // Brief, damit der synchrone Call ohne Interview bis zum approve_write läuft. Gehen an den Provider,
  // NICHT in den RunInput.payload.
  const params: Record<string, unknown> = {};
  if (typeof args["csv"] === "string") params["sourceCsv"] = args["csv"];
  if (entry.id === "build-skill") params["brief"] = briefFromArgs(args);

  // payload = die Tool-Argumente ohne MCP-spezifische Lauf-/Setup-Parameter (die fließen nicht ins Feature).
  const {
    csv: _csv,
    budget: _b,
    maxDepth: _d,
    model: _m,
    ollamaUrl: _o,
    name: _n,
    description: _de,
    purpose: _p,
    whenToUse: _w,
    instructions: _i,
    ...payload
  } = args;
  void _csv; void _b; void _d; void _m; void _o; void _n; void _de; void _p; void _w; void _i;

  let runId: string | undefined;
  try {
    const stream: AsyncIterable<RunEvent> = engine.startRun(
      entry.id,
      { payload, budget: runBudget, maxDepth: runMaxDepth },
      params,
    );

    for await (const ev of stream) {
      if (runId === undefined) runId = ev.correlation.run;

      if (ev.type === "node-suspended") {
        // Der Loop wartet auf eine Antwort (Approval / fehlender Input, Inv. 11). Die Surface ist v0.1
        // ein synchroner Tool-Call -> wir reichen die Elicitation als Ergebnis hoch (kein Auto-Resolve).
        return suspendedResult(entry, ev, runId ?? ev.correlation.run);
      }

      if (ev.type === "run-completed") {
        const artifact = await engine.getArtifact(ev.correlation.run);
        return completedResult(entry, ev.gate, artifact, ev.correlation.run);
      }
    }

    return errorResult(
      `Feature "${entry.id}" beendet, ohne ein Gate-Ergebnis zu liefern (kein run-completed).`,
    );
  } catch (e) {
    return errorResult(
      `Feature "${entry.id}" fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Erfolgs-/Stop-Ergebnis: finales Artefakt + Gate-Ausgang. isError nur bei gate "stopped". */
function completedResult(
  entry: FeatureInfo,
  gate: "passed" | "stopped",
  artifact: Artifact | undefined,
  run: string,
): CallToolResult {
  const structured: Record<string, unknown> = {
    feature: entry.id,
    run,
    gate,
    artifact:
      artifact !== undefined
        ? { ref: artifact.ref, content: artifact.content, evalState: artifact.evalState }
        : null,
  };
  const headline =
    gate === "passed"
      ? `Feature "${entry.id}" ERFOLGREICH: Gate "${entry.pack.feature.artifact.evalGate}" passed.`
      : `Feature "${entry.id}" GESTOPPT: Gate "${entry.pack.feature.artifact.evalGate}" nicht erreicht ` +
        `(Budget/Tiefe erschöpft oder Dead-Letter).`;
  return {
    content: [{ type: "text", text: `${headline}\n${JSON.stringify(structured, null, 2)}` }],
    structuredContent: structured,
    ...(gate === "stopped" ? { isError: true } : {}),
  };
}

/** Suspend-Ergebnis: die Elicitation, auf die der Loop wartet (Richtung B, Inv. 19). isError = true. */
function suspendedResult(
  entry: FeatureInfo,
  ev: Extract<RunEvent, { type: "node-suspended" }>,
  run: string,
): CallToolResult {
  const structured: Record<string, unknown> = {
    feature: entry.id,
    run,
    status: "suspended",
    mode: ev.mode,
    elicitation: ev.elicitation,
    correlation: ev.correlation,
  };
  return {
    content: [
      {
        type: "text",
        text:
          `Feature "${entry.id}" SUSPENDIERT (mode=${ev.mode}) — wartet auf: ${ev.elicitation.what}.\n` +
          JSON.stringify(structured, null, 2),
      },
    ],
    structuredContent: structured,
    isError: true,
  };
}

/** Einfaches Fehler-Tool-Ergebnis (isError). */
function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
