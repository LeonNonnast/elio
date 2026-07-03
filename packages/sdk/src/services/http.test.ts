// ───────────────────────────── ScopedHttpService + http-node wiring (Inv. 14, §v0.2) ─────────────────────────────

import { describe, expect, it } from "vitest";
import { ScopedHttpService } from "./http";
import { collectEvents, createRuntime } from "../runtime";
import type { FeaturePack, TapeFrame } from "@elio/core";

// ───────────────────────────── ScopedHttpService: real fetch confined to hosts ─────────────────────────────

describe("ScopedHttpService — fetch confined to allowed hosts; out-of-host rejected", () => {
  // A recording fetch double so no real network is touched.
  function recording() {
    const calls: string[] = [];
    const fetchImpl = (url: string) => {
      calls.push(url);
      return Promise.resolve({ url, body: "ok" });
    };
    return { calls, fetchImpl };
  }

  it("allows an in-scope host and returns the backend response", async () => {
    const { calls, fetchImpl } = recording();
    const http = new ScopedHttpService({ hosts: ["api.example.com"], fetchImpl });
    await expect(http.fetch("https://api.example.com/v1/x")).resolves.toEqual({
      url: "https://api.example.com/v1/x",
      body: "ok",
    });
    expect(calls).toEqual(["https://api.example.com/v1/x"]);
  });

  it("rejects an out-of-host request WITHOUT calling the backend", async () => {
    const { calls, fetchImpl } = recording();
    const http = new ScopedHttpService({ hosts: ["api.example.com"], fetchImpl });
    await expect(http.fetch("https://evil.com/steal")).rejects.toThrow(/escapes allowed hosts/i);
    expect(calls).toEqual([]); // never reached the backend
  });

  it("rejects a non-URL string", async () => {
    const { fetchImpl } = recording();
    const http = new ScopedHttpService({ hosts: ["*"], fetchImpl });
    await expect(http.fetch("not-a-url")).rejects.toThrow(/valid absolute URL/i);
  });

  it('"*" allows any host', async () => {
    const { fetchImpl } = recording();
    const http = new ScopedHttpService({ hosts: ["*"], fetchImpl });
    await expect(http.fetch("https://anything.test/x")).resolves.toBeDefined();
  });
});

// ───────────────────────────── end-to-end: http node through the runtime ─────────────────────────────

function passGate() {
  return {
    type: "pass-gate",
    klass: "orchestration" as const,
    handler: () =>
      Promise.resolve({
        status: "resolved" as const,
        output: { passed: true, failures: [] },
        confidence: 1,
        cost: {},
      }),
  };
}

function httpPack(id: string): FeaturePack {
  return {
    apiVersion: "elio/v1",
    kind: "Feature",
    metadata: { id, version: "1", owner: "t" },
    contentHash: `${id}@1`,
    feature: {
      autonomy: "static",
      artifact: { kind: "note", evalGate: "pass-gate" },
      io: { input: {}, output: {} },
      graph: {
        state: {},
        steps: [{ id: "f", type: "http", with: { url: "https://api.example.com/v1/data", as: "resp" } }],
        edges: [],
      },
    },
  };
}

describe("end-to-end: built-in http node is host-gated through the runtime", () => {
  it("runs when the policy grants the host, and records the response in the tape", async () => {
    const rt = createRuntime({
      http: new ScopedHttpService({
        hosts: ["api.example.com"],
        fetchImpl: (url: string) => Promise.resolve({ url, status: 200 }),
      }),
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
        httpHosts: ["api.example.com"],
      },
    });
    rt.registry.register(passGate());

    const events = await collectEvents(rt.run(httpPack("t.http-ok"), { payload: {}, budget: 100, maxDepth: 5 }));
    const runId = events.find((e) => e.type === "run-started")!.correlation.run;
    const frame = rt.store.getTape(runId).find((f: TapeFrame) => f.nodeType === "http");
    expect(frame?.result.status).toBe("resolved");
    expect(events.some((e) => e.type === "run-completed")).toBe(true);
  });

  it("FAILS BY ABSENCE when the policy grants no host — ctx.http is never injected", async () => {
    const rt = createRuntime({
      http: new ScopedHttpService({ hosts: ["api.example.com"], fetchImpl: () => Promise.resolve({}) }),
      rootPolicy: {
        allowedModels: [],
        allowCloud: false,
        dataClassification: "internal",
        suspendMode: "optional",
        toolPermissions: [],
        httpHosts: [], // nothing granted
      },
    });
    rt.registry.register(passGate());

    const events = await collectEvents(rt.run(httpPack("t.http-deny"), { payload: {}, budget: 100, maxDepth: 5 }));
    const runId = events.find((e) => e.type === "run-started")!.correlation.run;
    const frame = rt.store.getTape(runId).find((f: TapeFrame) => f.nodeType === "http");
    expect(frame?.result.status).toBe("failed");
    if (frame?.result.status === "failed") {
      expect(frame.result.error.message).toMatch(/security by absence|ctx\.http ist nicht injiziert/i);
    }
    // No host granted -> the run cannot complete its http step -> gate stopped.
    const end = events[events.length - 1];
    expect(end?.type).toBe("run-completed");
    if (end?.type === "run-completed") expect(end.gate).toBe("stopped");
  });
});
