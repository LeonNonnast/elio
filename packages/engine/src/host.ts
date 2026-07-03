// ───────────────────────────── EngineHost — EngineService über HTTP/SSE ─────────────────────────────
// Macht EINEN dauerlaufenden EngineService prozessübergreifend erreichbar: CLI/MCP/Studio können sich als
// EngineClient andocken und sehen DENSELBEN Store live (das löst das in-process-only-subscribe-Limit:
// es gibt jetzt EINEN ausführenden Prozess — den Host). `elio serve` startet ihn.
//
// Protokoll (bewusst minimal, JSON + SSE):
//   GET  /api/features            -> FeatureDescriptor[]
//   GET  /api/runs                -> RunStatus[]
//   GET  /api/runs/:id/tape       -> TapeFrame[]
//   GET  /api/runs/:id/artifact   -> { artifact: Artifact | null }
//   GET  /api/stream    (SSE)     -> live RunEvents (subscribe)
//   POST /api/runs      (SSE)     -> { featureId, input, params? } -> RunEvent-Stream (startRun)
//   POST /api/runs/resume (SSE)   -> { correlation, answer, expectedPackVersion? } -> RunEvent-Stream
//
// SSE-Frames sind `data: <json>`. Für die POST-Streams ist <json> entweder ein RunEvent, ein
// { __done: true } (sauberes Ende) oder ein { __error: msg } (Fehler) — der EngineClient mappt das zurück.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { CorrelationId, RunEvent } from "@elio/core";
import type { EngineService } from "./engine";

export interface EngineHost extends Server {
  /** Graceful Shutdown: offene SSE-Antworten beenden -> Engine-Subscriptions schließen -> server.close(). */
  closeHost(): Promise<void>;
}

export interface CreateEngineHostOptions {
  engine: EngineService;
}

export function createEngineHost(opts: CreateEngineHostOptions): EngineHost {
  const { engine } = opts;
  const sseResponses = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void handle(req, res, engine, sseResponses).catch((e: unknown) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  }) as EngineHost;

  server.on("close", () => engine.closeSubscriptions());

  server.closeHost = (): Promise<void> => {
    for (const res of [...sseResponses]) {
      try {
        res.end();
      } catch {
        /* already ended */
      }
    }
    sseResponses.clear();
    engine.closeSubscriptions();
    server.closeAllConnections?.();
    return new Promise<void>((resolve, reject) => {
      server.close((err) => (err !== undefined && err !== null ? reject(err) : resolve()));
    });
  };

  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  engine: EngineService,
  sseResponses: Set<ServerResponse>,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (method === "GET" && path === "/api/features") {
    sendJson(res, 200, await engine.listFeatures());
    return;
  }
  if (method === "GET" && path === "/api/runs") {
    sendJson(res, 200, await engine.liveStatus());
    return;
  }
  const tapeMatch = path.match(/^\/api\/runs\/([^/]+)\/tape$/);
  if (method === "GET" && tapeMatch) {
    const runId = decodeURIComponent(tapeMatch[1] as string);
    const frames = [];
    for await (const f of engine.tape(runId)) frames.push(f);
    sendJson(res, 200, frames);
    return;
  }
  const artMatch = path.match(/^\/api\/runs\/([^/]+)\/artifact$/);
  if (method === "GET" && artMatch) {
    const runId = decodeURIComponent(artMatch[1] as string);
    sendJson(res, 200, { artifact: (await engine.getArtifact(runId)) ?? null });
    return;
  }
  if (method === "GET" && path === "/api/stream") {
    streamSubscribe(req, res, engine, sseResponses);
    return;
  }
  if (method === "POST" && path === "/api/runs") {
    await streamRun(req, res, engine, sseResponses, "start");
    return;
  }
  if (method === "POST" && path === "/api/runs/resume") {
    await streamRun(req, res, engine, sseResponses, "resume");
    return;
  }
  sendJson(res, 404, { error: `Not found: ${method} ${path}` });
}

/** Live-Subscribe-SSE (endlos bis Client-Close). */
function streamSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  engine: EngineService,
  sseResponses: Set<ServerResponse>,
): void {
  openSse(res, sseResponses);
  const iterator = engine.subscribe()[Symbol.asyncIterator]();
  let closed = false;
  const stop = (): void => {
    if (closed) return;
    closed = true;
    sseResponses.delete(res);
    void iterator.return?.(undefined);
    res.end();
  };
  req.on("close", stop);
  res.on("close", stop);
  const pump = (): void => {
    iterator
      .next()
      .then((r) => {
        if (closed) return;
        if (r.done) return stop();
        res.write(`data: ${JSON.stringify(r.value)}\n\n`);
        pump();
      })
      .catch(stop);
  };
  pump();
}

/** start/resume-SSE: konsumiert den Engine-Stream, schreibt jedes Event als data-Frame, dann __done/__error. */
async function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  engine: EngineService,
  sseResponses: Set<ServerResponse>,
  kind: "start" | "resume",
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  const b = isRecord(body) ? body : {};

  let stream: AsyncIterable<RunEvent>;
  if (kind === "start") {
    const featureId = typeof b["featureId"] === "string" ? b["featureId"] : "";
    const input = b["input"] as Parameters<EngineService["startRun"]>[1];
    const params = isRecord(b["params"]) ? (b["params"] as Record<string, unknown>) : undefined;
    if (featureId.length === 0 || !isRecord(input)) {
      sendJson(res, 400, { error: "POST /api/runs needs { featureId, input: RunInput, params? }." });
      return;
    }
    stream = engine.startRun(featureId, input, params);
  } else {
    const correlation = parseCorrelation(b["correlation"]);
    if (correlation === undefined) {
      sendJson(res, 400, { error: "POST /api/runs/resume needs { correlation, answer }." });
      return;
    }
    const opts = typeof b["expectedPackVersion"] === "string" ? { expectedPackVersion: b["expectedPackVersion"] } : undefined;
    stream = engine.resumeRun(correlation, b["answer"], opts);
  }

  openSse(res, sseResponses);
  let closed = false;
  const stop = (): void => {
    if (closed) return;
    closed = true;
    sseResponses.delete(res);
    res.end();
  };
  req.on("close", stop);
  try {
    for await (const ev of stream) {
      if (closed) break;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    if (!closed) res.write(`data: ${JSON.stringify({ __done: true })}\n\n`);
  } catch (e) {
    if (!closed) {
      res.write(`data: ${JSON.stringify({ __error: e instanceof Error ? e.message : String(e) })}\n\n`);
    }
  } finally {
    stop();
  }
}

function openSse(res: ServerResponse, sseResponses: Set<ServerResponse>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": elio-engine stream open\n\n");
  sseResponses.add(res);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new Error("Body too large (>1 MiB)."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on("error", (e) => reject(e));
  });
}

function parseCorrelation(raw: unknown): CorrelationId | undefined {
  if (!isRecord(raw)) return undefined;
  const { run, branch, step, checkpoint } = raw as Record<string, unknown>;
  if (
    typeof run !== "string" || typeof branch !== "string" ||
    typeof step !== "string" || typeof checkpoint !== "string" ||
    run.length === 0 || branch.length === 0 || step.length === 0 || checkpoint.length === 0
  ) {
    return undefined;
  }
  return { run, branch, step, checkpoint };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
