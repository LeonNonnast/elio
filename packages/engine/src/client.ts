// ───────────────────────────── EngineClient — EngineService über HTTP/SSE (node:http) ─────────────────────────────
// Implementiert dasselbe EngineService-Interface wie LocalEngine, treibt es aber gegen einen dauerlaufenden
// EngineHost (Phase 4). So sind CLI/MCP/Studio EINE Codebasis über zwei Implementierungen: lokal (in-process)
// oder remote (gegen den Host) — und das Studio sieht über /api/stream die Runs ALLER Clients live, weil der
// Host der eine ausführende Prozess ist.
//
// Transport ist node:http (NICHT global fetch): undici-fetch puffert unbegrenzte SSE-Antworten bis zum
// Stream-Ende — Live-subscribe braucht aber INKREMENTELLE Auslieferung. node:http streamt Chunk für Chunk.

import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Artifact, CorrelationId, RunEvent, RunInput, RunStatus, TapeFrame } from "@elio/core";
import type { EngineService, FeatureDescriptor } from "./engine";

export interface EngineClientOptions {
  /** Basis-URL des EngineHost, z.B. "http://localhost:4500". */
  baseUrl: string;
}

export class EngineClient implements EngineService {
  private readonly host: string;
  private readonly port: number;
  private readonly basePath: string;

  constructor(opts: EngineClientOptions) {
    const u = new URL(opts.baseUrl);
    this.host = u.hostname;
    this.port = u.port.length > 0 ? Number(u.port) : 80;
    this.basePath = u.pathname.replace(/\/$/, "");
  }

  async listFeatures(): Promise<FeatureDescriptor[]> {
    return this.getJson<FeatureDescriptor[]>("/api/features");
  }

  async liveStatus(): Promise<RunStatus[]> {
    return this.getJson<RunStatus[]>("/api/runs");
  }

  async *tape(runId: string): AsyncIterable<TapeFrame> {
    const frames = await this.getJson<TapeFrame[]>(`/api/runs/${encodeURIComponent(runId)}/tape`);
    for (const f of frames) yield f;
  }

  async getArtifact(runId: string): Promise<Artifact | undefined> {
    const r = await this.getJson<{ artifact: Artifact | null }>(
      `/api/runs/${encodeURIComponent(runId)}/artifact`,
    );
    return r.artifact ?? undefined;
  }

  startRun(featureId: string, input: RunInput, params?: Record<string, unknown>): AsyncIterable<RunEvent> {
    return this.stream("POST", "/api/runs", { featureId, input, ...(params !== undefined ? { params } : {}) }, true);
  }

  resumeRun(id: CorrelationId, answer: unknown, opts?: { expectedPackVersion?: string }): AsyncIterable<RunEvent> {
    return this.stream("POST", "/api/runs/resume", { correlation: id, answer, ...(opts ?? {}) }, true);
  }

  subscribe(filter?: { run?: string }): AsyncIterable<RunEvent> {
    const qs = filter?.run !== undefined ? `?run=${encodeURIComponent(filter.run)}` : "";
    return this.stream("GET", `/api/stream${qs}`, undefined, false);
  }

  /** Client-seitig ein no-op: der dauerlaufende Host besitzt die Subscriptions; der Client bricht nur seine
   *  eigenen Streams (über return() des Iterators) ab. */
  closeSubscriptions(): void {
    /* no-op */
  }

  // ── intern ──────────────────────────────────────────────────────────────────

  private getJson<T>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = request(
        { host: this.host, port: this.port, path: `${this.basePath}${path}`, method: "GET" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`EngineClient ${path}: HTTP ${res.statusCode} ${raw}`));
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Öffnet einen SSE-Stream und liefert seine RunEvents inkrementell. `terminating` (POST start/resume):
   * Frames { __done } / { __error } beenden bzw. werfen; sonst (Live-subscribe) läuft er bis Client-Close.
   */
  private async *stream(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    terminating: boolean,
  ): AsyncIterable<RunEvent> {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          host: this.host,
          port: this.port,
          path: `${this.basePath}${path}`,
          method,
          headers: {
            accept: "text/event-stream",
            ...(payload !== undefined
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
              : {}),
          },
        },
        resolve,
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });

    if ((res.statusCode ?? 0) >= 400) {
      const raw = await collect(res);
      throw new Error(`EngineClient ${path}: HTTP ${res.statusCode} ${raw}`);
    }

    res.setEncoding("utf8");
    let buffer = "";
    try {
      for await (const chunk of res as AsyncIterable<string>) {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (line === undefined) continue;
          const raw = line.slice("data:".length).trim();
          if (raw.length === 0) continue;
          let obj: unknown;
          try {
            obj = JSON.parse(raw);
          } catch {
            continue; // malformed frame
          }
          if (terminating) {
            const rec = obj as Record<string, unknown>;
            if (rec["__error"] !== undefined) throw new Error(String(rec["__error"]));
            if (rec["__done"] === true) return;
          }
          yield obj as RunEvent;
        }
      }
    } finally {
      res.destroy();
    }
  }
}

/** Sammelt einen IncomingMessage-Body als String (für Fehlertexte). */
function collect(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", () => resolve(""));
  });
}
