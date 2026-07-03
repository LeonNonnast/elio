// ───────────────────────────── Demo-Test: local-agent (lokaler Ollama-Agent, deterministisch ohne Netz) ─────────────────────────────
// Beweist die end-to-end-Verdrahtung "InProcessAgentEngine + OllamaModel" OHNE echtes Netz und OHNE
// LangGraph: ein injiziertes fetchImpl stubbt Ollamas POST /api/chat, sodass der Outer Loop deterministisch
// bis gate=passed läuft. Geprüft wird, DASS der Ollama-HTTP-Pfad wirklich getroffen wurde (der Agent denkt
// also über ctx.model -> Ollama), dass lokale Kosten usd:0 sind, und dass das min-length-Gate exit-et.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "@elio/core";
import { collectEvents } from "../runtime";
import {
  createLocalAgentRuntime,
  localAgentPack,
  LOCAL_AGENT_SPEC,
} from "./local-agent";

/**
 * Stubt Ollamas /api/chat (non-stream): liefert eine echte Response mit dem Ollama-JSON-Schema
 * ({ message.content, prompt_eval_count, eval_count }). Zählt die Calls + sammelt die URLs, damit der
 * Test beweisen kann, dass der lokale HTTP-Adapter (nicht der Mock) bedient wurde.
 */
function stubOllama(reply: string): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: unknown): Promise<Response> => {
    urls.push(String(input));
    const body = JSON.stringify({
      message: { role: "assistant", content: reply },
      prompt_eval_count: 12,
      eval_count: 8,
      done: true,
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("demo.local-agent (Ollama hinter der InProcessAgentEngine — kein LangGraph)", () => {
  // Antwort >= 30 Zeichen (min-length-Gate) und enthält "DONE" -> der Inner-Loop stoppt nach 1 Turn.
  const REPLY = "An artifact-centric loop engine re-runs the work until a gate says it is good enough. DONE";

  it("treibt den Outer Loop über einen lokalen Ollama-Call bis gate=passed", async () => {
    const { fetchImpl, urls } = stubOllama(REPLY);
    const runtime = createLocalAgentRuntime({ ollama: { fetchImpl } });

    const events = await collectEvents(
      runtime.run(localAgentPack, { payload: {}, budget: 1000, maxDepth: 200 }),
    );

    // Outer-Loop-Exit über das Eval-Gate (Inv. 1).
    const completed = events.find(
      (e): e is Extract<RunEvent, { type: "run-completed" }> => e.type === "run-completed",
    );
    expect(completed).toBeDefined();
    expect(completed?.gate).toBe("passed");

    // Der Ollama-HTTP-Pfad wurde wirklich getroffen (der Agent dachte über ctx.model -> Ollama).
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.endsWith("/api/chat"))).toBe(true);
  });

  it("verbucht lokale Kosten als usd:0 und reicht Ollamas Token-Counts durch (Inv. 17/§6)", async () => {
    const { fetchImpl } = stubOllama(REPLY);
    const runtime = createLocalAgentRuntime({ ollama: { fetchImpl } });

    const events = await collectEvents(
      runtime.run(localAgentPack, { payload: {}, budget: 1000, maxDepth: 200 }),
    );

    // Der agent-Step (intelligence) resolved mit den akkumulierten Engine-Kosten: lokal -> usd 0.
    const agentResolved = events.find(
      (e): e is Extract<RunEvent, { type: "node-resolved" }> =>
        e.type === "node-resolved" && e.correlation.step === "draft",
    );
    expect(agentResolved).toBeDefined();
    expect(agentResolved?.cost?.usd).toBe(0);
    expect(agentResolved?.cost?.tokensIn).toBeGreaterThan(0);
    expect(agentResolved?.cost?.tokensOut).toBeGreaterThan(0);
    // cost.model trägt die kanonische provider:model-Spec (Audit zeigt Profil + Modell).
    expect(agentResolved?.cost?.model).toBe(LOCAL_AGENT_SPEC);
  });

  it("ist security-by-absence-konform: ein zu kurzer Entwurf hält den Outer Loop, bis er besteht", async () => {
    // Erster Versuch zu kurz (< 30), danach lang genug: die Self-Edge muss den Agenten erneut rufen,
    // bis das min-length-Gate exit-et (Outer-Loop-Konvergenz mit delegierter Intelligenz).
    let call = 0;
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      call += 1;
      // Turn 1 des 1. Outer-Steps ist zu kurz UND enthält "DONE" (Inner-Loop stoppt), der 2. Outer-Step
      // liefert einen langen Entwurf -> Gate passt. So iteriert der OUTER Loop nachweislich > 1x.
      const content = call <= 1 ? "too short DONE" : "A sufficiently long local draft that passes the gate. DONE";
      const body = JSON.stringify({
        message: { content },
        prompt_eval_count: 5,
        eval_count: 5,
        done: true,
      });
      void input;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const runtime = createLocalAgentRuntime({ ollama: { fetchImpl } });
    const events = await collectEvents(
      runtime.run(localAgentPack, { payload: {}, budget: 1000, maxDepth: 200 }),
    );

    const completed = events.find(
      (e): e is Extract<RunEvent, { type: "run-completed" }> => e.type === "run-completed",
    );
    expect(completed?.gate).toBe("passed");
    // Mehr als ein agent-Step resolved -> der Outer Loop lief mehrfach (Self-Edge bis Gate-Exit).
    const drafts = events.filter(
      (e) => e.type === "node-resolved" && e.correlation.step === "draft",
    );
    expect(drafts.length).toBeGreaterThan(1);
    expect(call).toBeGreaterThan(1);
  });
});
