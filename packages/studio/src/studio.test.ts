// ───────────────────────────── @elio/studio — AC-Smoke + Surface (Blueprint §8) ─────────────────────────────
// Treibt die Studio-Surface PROGRAMMATISCH über node:http-Requests gegen einen EPHEMEREN Port (port 0),
// kein Browser. Studio ist jetzt ein dünner Client über @elio/engine (EngineService) — die Tests injizieren
// einen LocalEngine und treiben Runs über engine.startRun(). Deckt ab:
//   1. GET /                      -> 200, HTML mit Dashboard-Marker.
//   2. GET /api/runs              -> JSON von engine.liveStatus(); der getriebene Run ist sichtbar.
//   3. GET /api/runs/:id/tape     -> JSON-Array der Tape-Frames des Runs.
//   4. GET /api/features          -> der ZENTRALE Engine-Katalog (projiziert inkl. klass/requests).
//   5. GET /api/stream (SSE)      -> live RunEvents via engine.subscribe().
//   6. POST /api/resume           -> EINZIGER Schreibpfad: Approval beantworten -> Run completed (§2).

import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collectEvents } from "@elio/sdk";
import { LocalEngine } from "@elio/engine";
import type { CorrelationId, RunEvent } from "@elio/core";
import { createStudioServer } from "./server";
import type { StudioServer } from "./server";
import { dashboardHtml, DASHBOARD_MARKER } from "./dashboard";
import { main as studioMain } from "./bin";

const RUN_INPUT = { payload: {}, budget: 1000, maxDepth: 200 };

// ───────────────────────────── node:http test helpers (no browser) ─────────────────────────────

interface HttpResult {
  status: number;
  contentType: string;
  body: string;
}

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  const studio = server as Partial<StudioServer>;
  if (typeof studio.closeStudio === "function") return studio.closeStudio();
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpGet(port: number, path: string): Promise<HttpResult> {
  return httpRequest(port, "GET", path);
}

function httpRequest(port: number, method: string, path: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers:
          payload !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Reads the first N SSE `data:` frames from /api/stream, then aborts the request. */
function readSseFrames(port: number, want: number, timeoutMs = 2000): Promise<unknown[]> {
  return new Promise((resolve) => {
    const frames: unknown[] = [];
    let buffer = "";
    const req = request({ host: "127.0.0.1", port, method: "GET", path: "/api/stream" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (line === undefined) continue;
          try {
            frames.push(JSON.parse(line.slice("data:".length).trim()));
          } catch {
            /* ignore comment / malformed */
          }
          if (frames.length >= want) {
            req.destroy();
            resolve(frames);
            return;
          }
        }
      });
    });
    req.on("error", () => {
      if (frames.length < want) resolve(frames);
    });
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve(frames);
    }, timeoutMs).unref?.();
  });
}

// ───────────────────────────── shared teardown ─────────────────────────────

let openServer: StudioServer | undefined;
afterEach(async () => {
  if (openServer !== undefined) {
    await closeServer(openServer);
    openServer = undefined;
  }
});

async function startBound(engine: LocalEngine): Promise<{ port: number; server: StudioServer }> {
  const server = createStudioServer({ engine });
  openServer = server;
  const port = await listenEphemeral(server);
  return { port, server };
}

// ───────────────────────────── AC: GET / · /api/runs · /api/runs/:id/tape ─────────────────────────────

describe("@elio/studio AC (Blueprint §8): HTTP surface over a shared engine store", () => {
  it("GET / returns 200 HTML with the dashboard marker", async () => {
    const { port } = await startBound(new LocalEngine());

    const res = await httpGet(port, "/");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.body).toContain(DASHBOARD_MARKER);
    expect(res.body).toContain("<!doctype html>");
    expect(res.body).toContain("api/runs");
    expect(res.body).toContain("api/stream");
    expect(res.body).toContain("api/resume");
    expect(res.body).toContain("api/features");

    expect(res.body).toContain('id="timeline-card"');
    expect(res.body).toContain("Loop timeline");
    expect(res.body).toContain('id="inbox-card"');
    expect(res.body).toContain("Approval inbox");
    expect(res.body).toContain('id="tape-card"');
    expect(res.body).toContain("Tape scrubber");
    expect(res.body).toContain('id="catalog-drawer"');
    expect(res.body).toContain("Feature catalog");
    // Phase 5: a notifications panel ("what needs you") + the CLI-resume bridge.
    expect(res.body).toContain('id="notifications-card"');
    expect(res.body).toContain("Notifications");
    expect(res.body).toContain("resume from the CLI");
    expect(res.body).toContain('id="stat-active"');
    expect(res.body).toContain('id="stat-approvals"');
    expect(res.body).toContain('id="stat-features"');

    expect(res.body).not.toMatch(/(?:src|href)="https?:\/\//);
    expect(res.body).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
  });

  it("GET /api/runs returns JSON liveStatus() with the driven run visible", async () => {
    const engine = new LocalEngine();
    const { port } = await startBound(engine);

    const events = await collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));
    expect(events.find((e) => e.type === "run-completed")).toBeDefined();

    const res = await httpGet(port, "/api/runs");
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);
    const runs = JSON.parse(res.body) as Array<{ feature: string; phase: string }>;
    expect(runs.length).toBeGreaterThan(0);
    const draft = runs.find((r) => r.feature === "demo.draft-until-good");
    expect(draft).toBeDefined();
    expect(draft?.phase).toBe("done");
  });

  it("GET /api/runs/:id/tape returns the run's tape frames", async () => {
    const engine = new LocalEngine();
    const { port } = await startBound(engine);

    const events = await collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));
    const runId = events[0]?.correlation.run;
    expect(runId).toBeDefined();

    const res = await httpGet(port, `/api/runs/${encodeURIComponent(runId as string)}/tape`);
    expect(res.status).toBe(200);
    const frames = JSON.parse(res.body) as Array<{ nodeType: string; correlation: CorrelationId }>;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.nodeType === "transform")).toBe(true);
    expect(frames.every((f) => f.correlation.run === runId)).toBe(true);
  });

  it("GET unknown path returns 404 JSON", async () => {
    const { port } = await startBound(new LocalEngine());
    const res = await httpGet(port, "/api/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("Not found") });
  });
});

// ───────────────────────────── GET /api/features: the central engine catalog (read-only — Inv. 2) ─────────────────────────────

interface CatalogStep {
  id: string;
  type: string;
  klass?: "orchestration" | "intelligence";
  requests?: { models?: string[]; db?: string[]; fs?: { read?: string[]; write?: string[] } };
  suspend?: string;
  when?: string;
}
interface CatalogEntry {
  id: string;
  version: string;
  autonomy: "static" | "guided" | "dynamic";
  artifact: { kind: string; evalGate: string };
  io: { input: unknown; output: unknown };
  policies: string[];
  sourcePath?: string;
  graph?: { steps: CatalogStep[]; edges: { from: string; to: string; when?: string }[] };
}

describe("@elio/studio GET /api/features (central engine catalog)", () => {
  it("returns the engine catalog with each feature's definition projected for display", async () => {
    const { port } = await startBound(new LocalEngine());

    const res = await httpGet(port, "/api/features");
    expect(res.status).toBe(200);
    const catalog = JSON.parse(res.body) as CatalogEntry[];

    // The catalog is the ONE central engine catalog (demos + migrate + build-skill + local-agent + pm.*).
    const ids = new Set(catalog.map((c) => c.id));
    expect(ids.has("demo.draft-until-good")).toBe(true);
    expect(ids.has("demo.retry-then-pass")).toBe(true);
    expect(ids.has("migrate.csv-to-db")).toBe(true);
    expect(ids.has("build-skill")).toBe(true);

    for (const entry of catalog) {
      expect(typeof entry.version).toBe("string");
      expect(["static", "guided", "dynamic"]).toContain(entry.autonomy);
      expect(typeof entry.artifact.kind).toBe("string");
      expect(typeof entry.artifact.evalGate).toBe("string");
      expect(entry.io).toBeDefined();
      expect(Array.isArray(entry.policies)).toBe(true);
    }

    // Phase 5: file-loaded features carry where their file lives; code/built-in packs do not.
    const migrate = catalog.find((c) => c.id === "migrate.csv-to-db");
    expect(typeof migrate?.sourcePath).toBe("string");
    expect(migrate?.sourcePath).toMatch(/feature\.ya?ml$/);
    const demo = catalog.find((c) => c.id === "demo.draft-until-good");
    expect(demo?.sourcePath).toBeUndefined();
  });

  it("projects the migrate graph: nodes (id/type/klass/requests), edges, suspend + policies", async () => {
    const { port } = await startBound(new LocalEngine());

    const catalog = JSON.parse((await httpGet(port, "/api/features")).body) as CatalogEntry[];
    const migrate = catalog.find((c) => c.id === "migrate.csv-to-db");
    expect(migrate).toBeDefined();

    expect(migrate?.policies).toContain("commit_requires_approval");
    expect(migrate?.autonomy).toBe("guided");
    expect(migrate?.artifact).toMatchObject({ kind: "migration-script", evalGate: "sample_passes" });

    const steps = migrate?.graph?.steps ?? [];
    const byId = new Map(steps.map((s) => [s.id, s]));

    // klass/requests are resolved CENTRALLY by the engine (against the feature's own registry).
    const commit = byId.get("commit");
    expect(commit?.type).toBe("approval");
    expect(commit?.klass).toBe("orchestration");
    expect(commit?.suspend).toBe("blocking");

    const propose = byId.get("propose_mapping");
    expect(propose?.type).toBe("agent");
    expect(propose?.klass).toBe("intelligence");
    expect(propose?.requests?.models).toBeDefined();

    expect(
      migrate?.graph?.edges.some((e) => e.from === "commit" && e.to === "commit_write" && !!e.when),
    ).toBe(true);
  });

  it("resolves klass for built-in AND vertical node types (engine projects each feature's own registry)", async () => {
    const { port } = await startBound(new LocalEngine());
    const catalog = JSON.parse((await httpGet(port, "/api/features")).body) as CatalogEntry[];

    // A built-in transform node resolves.
    const draft = catalog.find((c) => c.id === "demo.draft-until-good");
    const append = draft?.graph?.steps.find((s) => s.id === "append");
    expect(append?.type).toBe("transform");
    expect(append?.klass).toBe("orchestration");

    // A migrate-specific node ALSO resolves now — the engine knows every feature's nodes (no divergence).
    const migrate = catalog.find((c) => c.id === "migrate.csv-to-db");
    const readSource = migrate?.graph?.steps.find((s) => s.id === "read_source");
    expect(readSource?.type).toBe("migrate.read_source");
    expect(readSource?.klass).toBeDefined();
  });

  it("honors an explicit features id-allowlist (custom catalog view)", async () => {
    const server = createStudioServer({ engine: new LocalEngine(), features: ["demo.draft-until-good"] });
    openServer = server;
    const port = await listenEphemeral(server);

    const catalog = JSON.parse((await httpGet(port, "/api/features")).body) as CatalogEntry[];
    expect(catalog.map((c) => c.id)).toEqual(["demo.draft-until-good"]);
  });
});

// ───────────────────────────── SSE: live RunEvents via engine.subscribe() ─────────────────────────────

describe("@elio/studio SSE stream (live updates)", () => {
  it("GET /api/stream emits live RunEvents while a run is driven", async () => {
    const engine = new LocalEngine();
    const { port } = await startBound(engine);

    const framesPromise = readSseFrames(port, 2);
    await new Promise((r) => setTimeout(r, 50));
    await collectEvents(engine.startRun("demo.draft-until-good", RUN_INPUT));

    const frames = (await framesPromise) as RunEvent[];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => f.type === "run-started")).toBe(true);
  });

  it("closeStudio() completes while a dashboard SSE connection is still OPEN (no hang)", async () => {
    const engine = new LocalEngine();
    const { port, server } = await startBound(engine);

    const sseOpen = new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: "/api/stream" }, (res) => {
        res.setEncoding("utf8");
        res.on("data", () => resolve());
        res.on("error", () => {
          /* expected when the server force-ends the response */
        });
      });
      req.on("error", reject);
      req.end();
    });
    await sseOpen;
    expect(engine.subscriberCount()).toBe(1);

    await Promise.race([
      server.closeStudio(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("closeStudio() hung with an open SSE connection")), 2000).unref?.(),
      ),
    ]);

    expect(engine.subscriberCount()).toBe(0);
    openServer = undefined;
  });
});

// ───────────────────────────── POST /api/resume: the ONLY write path (§2) ─────────────────────────────

describe("@elio/studio POST /api/resume (Inv. 2/§2 — the only write path)", () => {
  it("answers a blocking approval via correlation-id and drives the run to completion", async () => {
    const engine = new LocalEngine();
    const { port } = await startBound(engine);

    // migrate suspends at the blocking commit approval -> populates the approval inbox.
    const events = await collectEvents(engine.startRun("migrate.csv-to-db", RUN_INPUT));
    const suspended = events.find(
      (e): e is Extract<RunEvent, { type: "node-suspended" }> => e.type === "node-suspended",
    );
    expect(suspended).toBeDefined();
    expect(suspended?.correlation.step).toBe("commit");

    // The approval is visible in /api/runs as a suspended run with waitingOn.
    const runs = JSON.parse((await httpGet(port, "/api/runs")).body) as Array<{
      phase: string;
      waitingOn?: unknown;
    }>;
    expect(runs.some((r) => r.phase === "suspended" && r.waitingOn !== undefined)).toBe(true);

    // POST /api/resume with the correlation-id + approval -> commit writes (same cached runtime) -> gate passes.
    const res = await httpRequest(port, "POST", "/api/resume", {
      correlation: suspended?.correlation,
      answer: { approved: true },
    });
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body) as { ok: boolean; outcome: string; gate?: string };
    expect(json.ok).toBe(true);
    expect(json.outcome).toBe("completed");
    expect(json.gate).toBe("passed");
  });

  it("rejects a malformed resume body with 400", async () => {
    const { port } = await startBound(new LocalEngine());
    const res = await httpRequest(port, "POST", "/api/resume", { answer: "y" }); // no correlation
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining("correlation") });
  });
});

// ───────────────────────────── bin.main(): default engine + seed + listen ─────────────────────────────

describe("@elio/studio bin.main() (seeded default engine)", () => {
  it("builds the default engine, seeds runs (demos + migrate + skill approvals), and serves the dashboard", async () => {
    const logs: string[] = [];
    const { server, address } = await studioMain({ port: 0, log: (l) => logs.push(l) });
    openServer = server;

    expect(address).toMatch(/^http:\/\//);
    expect(logs.some((l) => l.includes("listening on"))).toBe(true);

    const port = Number(new URL(address).port);

    const root = await httpGet(port, "/");
    expect(root.status).toBe(200);
    expect(root.body).toContain(DASHBOARD_MARKER);

    const runs = JSON.parse((await httpGet(port, "/api/runs")).body) as Array<{
      feature: string;
      phase: string;
      step?: string;
      waitingOn?: unknown;
      correlation: CorrelationId;
    }>;
    const features = new Set(runs.map((r) => r.feature));
    expect(features.has("demo.draft-until-good")).toBe(true);
    expect(features.has("demo.retry-then-pass")).toBe(true);
    expect(features.has("migrate.csv-to-db")).toBe(true);
    expect(features.has("build-skill")).toBe(true);
    expect(runs.some((r) => r.phase === "suspended" && r.waitingOn !== undefined)).toBe(true);
    const suspendedSteps = runs.filter((r) => r.phase === "suspended").map((r) => r.step);
    expect(suspendedSteps).toContain("commit");
    expect(suspendedSteps).toContain("approve_write");

    const someRun = runs[0]?.correlation.run;
    expect(someRun).toBeDefined();
    const tapeRes = await httpGet(port, `/api/runs/${encodeURIComponent(someRun as string)}/tape`);
    expect(tapeRes.status).toBe(200);
    expect((JSON.parse(tapeRes.body) as unknown[]).length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── dashboardHtml unit ─────────────────────────────

describe("dashboardHtml", () => {
  it("is self-contained (no external http(s) asset references) and carries the marker", () => {
    const html = dashboardHtml("Test Studio");
    expect(html).toContain(DASHBOARD_MARKER);
    expect(html).toContain("<title>Test Studio</title>");
    expect(html).toContain("api/features");
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toMatch(/href="https?:\/\//);
    expect(html).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
  });

  it("renders the dashboard-with-cards layout: stat cards, loop timeline, inbox, tape, catalog", () => {
    const html = dashboardHtml();
    for (const marker of [
      'id="timeline-card"',
      "Loop timeline",
      'id="runs-card"',
      'id="inbox-card"',
      "Approval inbox",
      'id="tape-card"',
      "Tape scrubber",
      'id="catalog-drawer"',
      "Feature catalog",
      'id="notifications-card"',
      "Notifications",
      'id="stat-active"',
      'id="stat-approvals"',
      'id="stat-features"',
    ]) {
      expect(html).toContain(marker);
    }
    // Phase 5: the CLI-resume bridge text + the file-path catalog rendering ship in the inline JS.
    expect(html).toContain("resume from the CLI");
    expect(html).toContain("built-in (SDK)");
    expect(html).toContain("--accent:");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('class="hero"');
    expect(html).toContain("good enough");
    expect(html).toContain('class="flow"');
    expect(html).toContain('id="tape-details"');
    expect(html).toMatch(/<details id="tape-details">/);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
  });
});

// ───────────────────────────── Static preview snapshot (reviewable without a server) ─────────────────────────────

describe("static preview snapshot", () => {
  const previewPath = fileURLToPath(new URL("../preview/dashboard-preview.html", import.meta.url));

  it("exists and is self-contained with inlined sample data (no external requests, no API needed)", () => {
    const html = readFileSync(previewPath, "utf8");
    expect(html).toContain(DASHBOARD_MARKER);
    expect(html).toContain("Loop timeline");
    expect(html).toContain("Approval inbox");
    expect(html).toContain("Tape scrubber");
    expect(html).toContain("Feature catalog");
    expect(html).toContain("ELIO_SAMPLE");
    expect(html).toContain("demo.draft-until-good");
    expect(html).toContain("migrate.csv-to-db");
    // Phase 5: the preview carries the notifications panel + a sample feature's source path.
    expect(html).toContain("Notifications");
    expect(html).toContain("feature.yaml");
    expect(html).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
  });
});
