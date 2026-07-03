// ───────────────────────────── @elio/studio — HTTP-Server-Surface (Inv. 2 — dünner @elio/engine-Client) ─────────────────────────────
// createStudioServer({ engine }) baut einen node:http-Server, der an einen EngineService gebunden ist. Die
// Surface ist read-mostly (Inv. 2: KEINE Runner-/Injector-/Registry-/Katalog-Logik mehr hier — das war
// createStudioRuntime, entfernt) und schreibt ausschließlich über den Elicitation-Resume-Pfad zurück (§2).
//
// Endpunkte:
//   GET  /                       -> das Dashboard-HTML (vanilla JS, das die API pollt/streamt)
//   GET  /api/runs               -> JSON von engine.liveStatus()
//   GET  /api/runs/:id/tape      -> JSON-Array der Tape-Frames des Runs (engine.tape)
//   GET  /api/features           -> JSON des ZENTRALEN Engine-Katalogs (engine.listFeatures, read-only)
//   GET  /api/stream  (SSE)      -> live RunEvents via engine.subscribe()
//   POST /api/resume             -> beantwortet eine Elicitation per correlation-id (EINZIGER Schreibweg)

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { CorrelationId, RunEvent, RunStatus, TapeFrame } from "@elio/core";
import type { EngineService, FeatureDescriptor } from "@elio/engine";
import { dashboardHtml } from "./dashboard";

export interface CreateStudioServerOptions {
  /**
   * Der EngineService, an den der Server gebunden ist. Studio liest über engine
   * (liveStatus/tape/subscribe/listFeatures) und schreibt NUR über engine.resumeRun (§2).
   */
  engine: EngineService;
  /** Port-Hint (nur Diagnose; createStudioServer ruft NICHT selbst listen). */
  port?: number;
  /** Titel im Dashboard (<title> + Header). Default "ELIO Studio". */
  dashboardTitle?: string;
  /**
   * Optionale id-Allowlist für /api/features (Default: der volle Engine-Katalog). Nur LESE-Filter über die
   * bereits vom EngineService projizierten Descriptors — der Server projiziert/verdrahtet selbst nichts.
   */
  features?: string[];
}

/**
 * Ein Studio-Server mit explizitem, NICHT hängendem Shutdown-Pfad. `closeStudio()` beendet zuerst alle
 * offenen SSE-Antworten, schließt die Engine-Subscriptions und ruft DANN das native `server.close()`.
 */
export interface StudioServer extends Server {
  closeStudio(): Promise<void>;
}

export function createStudioServer(opts: CreateStudioServerOptions): StudioServer {
  const { engine } = opts;
  const html = dashboardHtml(opts.dashboardTitle ?? "ELIO Studio");
  const featureFilter = opts.features;

  // Registry der aktuell offenen SSE-Antworten (für serverseitigen force-close beim Shutdown).
  const sseResponses = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void handleRequest(req, res, engine, html, sseResponses, featureFilter).catch((e: unknown) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  }) as StudioServer;

  server.on("close", () => {
    engine.closeSubscriptions();
  });

  server.closeStudio = (): Promise<void> => {
    // 1) Offene SSE-Antworten serverseitig beenden — sonst hält server.close() für immer (eine
    //    EventSource-Verbindung endet sonst nur clientseitig).
    for (const res of [...sseResponses]) {
      try {
        res.end();
      } catch {
        // bereits beendet/zerstört — ignorieren.
      }
    }
    sseResponses.clear();
    // 2) Engine-Subscriptions schließen (Iteratoren terminieren).
    engine.closeSubscriptions();
    // 3) Verbleibende Keep-alive-Verbindungen hart kappen (Node >=18).
    server.closeAllConnections?.();
    // 4) Native close — feuert jetzt zuverlässig.
    return new Promise<void>((resolve, reject) => {
      server.close((err) => (err !== undefined && err !== null ? reject(err) : resolve()));
    });
  };

  return server;
}

// ───────────────────────────── Request-Routing ─────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  engine: EngineService,
  html: string,
  sseResponses: Set<ServerResponse>,
  featureFilter: string[] | undefined,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (method === "GET" && path === "/") {
    sendHtml(res, 200, html);
    return;
  }

  if (method === "GET" && path === "/api/runs") {
    const statuses: RunStatus[] = await engine.liveStatus();
    sendJson(res, 200, statuses);
    return;
  }

  // GET /api/features -> der ZENTRALE Engine-Katalog (read-only, Inv. 2), optional auf eine id-Allowlist gefiltert.
  if (method === "GET" && path === "/api/features") {
    let catalog: FeatureDescriptor[] = await engine.listFeatures();
    if (featureFilter !== undefined) {
      const allow = new Set(featureFilter);
      catalog = catalog.filter((c) => allow.has(c.id));
    }
    sendJson(res, 200, catalog);
    return;
  }

  // GET /api/runs/:id/tape  -> die Tape-Frames eines Runs.
  const tapeMatch = path.match(/^\/api\/runs\/([^/]+)\/tape$/);
  if (method === "GET" && tapeMatch) {
    const runId = decodeURIComponent(tapeMatch[1] as string);
    const frames = await collectTape(engine.tape(runId));
    sendJson(res, 200, frames);
    return;
  }

  if (method === "GET" && path === "/api/stream") {
    streamEvents(req, res, engine, sseResponses);
    return;
  }

  if (method === "POST" && path === "/api/resume") {
    await handleResume(req, res, engine);
    return;
  }

  sendJson(res, 404, { error: `Not found: ${method} ${path}` });
}

// ───────────────────────────── GET /api/runs/:id/tape ─────────────────────────────

async function collectTape(iter: AsyncIterable<TapeFrame>): Promise<TapeFrame[]> {
  const out: TapeFrame[] = [];
  for await (const frame of iter) out.push(frame);
  return out;
}

// ───────────────────────────── GET /api/stream (SSE) ─────────────────────────────

/**
 * Server-Sent-Events-Stream: abonniert engine.subscribe() und schreibt jedes RunEvent als SSE-Frame.
 * Reiner LESE-Pfad (Inv. 2): der Stream spiegelt nur die Engine-Events, er treibt sie nicht.
 */
function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  engine: EngineService,
  sseResponses: Set<ServerResponse>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": elio-studio stream open\n\n");

  sseResponses.add(res);

  const subscription = engine.subscribe();
  const iterator = subscription[Symbol.asyncIterator]();
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
      .then((result) => {
        if (closed) return;
        if (result.done) {
          stop();
          return;
        }
        const ev: RunEvent = result.value;
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
        pump();
      })
      .catch(() => {
        stop();
      });
  };
  pump();
}

// ───────────────────────────── POST /api/resume (EINZIGER Schreibpfad, §2) ─────────────────────────────

/**
 * Beantwortet eine Elicitation per correlation-id — der EINZIGE Schreibweg der Studio-Surface (Inv. 2/§2).
 * Body = { correlation, answer }. Konsumiert den resume-Stream der Engine bis zum nächsten Ruhepunkt.
 */
async function handleResume(
  req: IncomingMessage,
  res: ServerResponse,
  engine: EngineService,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { error: `Invalid JSON body: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }

  const correlation = parseCorrelation(isRecord(body) ? body["correlation"] : undefined);
  if (correlation === undefined) {
    sendJson(res, 400, {
      error: "Body needs a valid `correlation` { run, branch, step, checkpoint } and an `answer`.",
    });
    return;
  }
  const answer = isRecord(body) ? body["answer"] : undefined;

  try {
    const outcome = await consumeResume(engine.resumeRun(correlation, answer));
    sendJson(res, 200, { ok: true, correlation, ...outcome });
  } catch (e) {
    sendJson(res, 409, {
      ok: false,
      error: `Resume failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

interface ResumeOutcome {
  outcome: "completed" | "suspended" | "ended";
  gate?: "passed" | "stopped";
  waitingOn?: string;
}

/** Konsumiert einen resume-Stream bis completed / erneut suspendiert / Ende (dünner Durchreicher). */
async function consumeResume(stream: AsyncIterable<RunEvent>): Promise<ResumeOutcome> {
  for await (const ev of stream) {
    if (ev.type === "run-completed") return { outcome: "completed", gate: ev.gate };
    if (ev.type === "node-suspended") return { outcome: "suspended", waitingOn: ev.elicitation.what };
  }
  return { outcome: "ended" };
}

// ───────────────────────────── HTTP-Hilfen ─────────────────────────────

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** Liest den Request-Body und parst ihn als JSON (max. ~1 MiB). */
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
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on("error", (e) => reject(e));
  });
}

/** Validiert ein eingehendes correlation-Objekt zu einer typisierten CorrelationId (oder undefined). */
function parseCorrelation(raw: unknown): CorrelationId | undefined {
  if (!isRecord(raw)) return undefined;
  const run = raw["run"];
  const branch = raw["branch"];
  const step = raw["step"];
  const checkpoint = raw["checkpoint"];
  if (
    typeof run !== "string" ||
    typeof branch !== "string" ||
    typeof step !== "string" ||
    typeof checkpoint !== "string" ||
    run.length === 0 ||
    branch.length === 0 ||
    step.length === 0 ||
    checkpoint.length === 0
  ) {
    return undefined;
  }
  return { run, branch, step, checkpoint };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
