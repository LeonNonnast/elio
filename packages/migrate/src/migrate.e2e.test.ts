// ───────────────────────────── @elio/migrate — End-to-End (Dogfood, §7) ─────────────────────────────
// (a) Lädt das kanonische migrate.csv-to-db-feature.yaml, fährt es auf einem kleinen In-Memory-Sample
//     mit dem MockModel (deterministisch) für den Mapping-Agent, erreicht das blocking Commit-Approval,
//     approved -> die Records landen im InMemoryDbService (Ziel-Adapter).

import { describe, it, expect } from "vitest";
import { collectEvents, MockModel } from "@elio/sdk";
import type { CompletionRequest } from "@elio/sdk";
import type { CorrelationId, RunEvent } from "@elio/core";
import { setupMigrate } from "./setup";

// Kleines CSV-Sample (Quelle): full_name/email_addr -> Ziel name/email (Default-Mapping).
const SAMPLE_CSV = `id,full_name,email_addr
u1,Ann Acker,ann@example.com
u2,Bob Boyd,bob@example.com
u3,Cara Cole,cara@example.com
`;

function suspendStep(events: RunEvent[]): CorrelationId | undefined {
  const s = events.find((e) => e.type === "node-suspended");
  return s && s.type === "node-suspended" ? s.correlation : undefined;
}

describe("migrate.csv-to-db — end-to-end load + run + approve (a)", () => {
  it("reaches the blocking commit approval, then commits all records to the target DB on approve", async () => {
    const { runtime, pack, target } = setupMigrate({ source: { content: SAMPLE_CSV } });

    // Sanity: the canonical pack loaded from feature.yaml.
    expect(pack.metadata.id).toBe("migrate.csv-to-db");
    expect(pack.feature.artifact.kind).toBe("migration-script");
    expect(pack.feature.artifact.evalGate).toBe("sample_passes");
    expect(pack.contentHash).toMatch(/^sha256:/);

    // Run 1: drives read_source -> sample -> propose_mapping (agent/MockModel) -> parse_mapping ->
    // stage -> run_on_sample (per-record subworkflow) -> dry_run -> commit (approval, blocking).
    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));

    // The mapping agent ran (intelligence node) and the per-record subworkflow fanned out.
    expect(ev1.some((e) => e.type === "step-started" && e.nodeType === "agent")).toBe(true);
    expect(ev1.some((e) => e.type === "step-started" && e.nodeType === "subworkflow")).toBe(true);

    // The run is suspended at the commit approval (blocking) — NOTHING committed yet (still dry-run).
    const corr = suspendStep(ev1);
    expect(corr).toBeDefined();
    expect(corr?.step).toBe("commit");
    expect(target.rows()).toHaveLength(0);

    // Approve -> commit_write batch writes -> DONE -> gate "sample_passes" passes.
    const ev2 = await collectEvents(runtime.resume(corr as CorrelationId, { approved: true }));
    const completed = ev2.find((e) => e.type === "run-completed");
    expect(completed).toBeDefined();
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("passed");

    // All three records landed in the InMemoryDbService target, exactly once each, fully mapped.
    const rows = target.rows();
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [String(r["id"]), r]));
    expect(byId.get("u1")).toMatchObject({ id: "u1", name: "Ann Acker", email: "ann@example.com" });
    expect(byId.get("u2")).toMatchObject({ id: "u2", name: "Bob Boyd", email: "bob@example.com" });
    expect(byId.get("u3")).toMatchObject({ id: "u3", name: "Cara Cole", email: "cara@example.com" });
  });

  it("the mapping agent receives the prompt-file CONTENT (not the path) and its mapping drives the run", async () => {
    // Capturing model: records the system prompt + last user prompt the agent passes to ctx.model, and
    // returns a real mapping JSON. Proves (a) the loader inlined prompts/*.md CONTENT into with.system/
    // with.prompt (the model never sees a literal "./prompts/...md" path), and (b) a real model output
    // flows through parseMappingProposal (the mapping is not the silent DEFAULT_MAPPING fallback).
    let capturedSystem: string | undefined;
    let capturedUser: string | undefined;
    const capturing = new MockModel({
      transform: (lastUser: string, req: CompletionRequest) => {
        capturedSystem = req.system;
        capturedUser = lastUser;
        // Emit a valid mapping object + DONE so the agent converges on THIS output (not the fallback).
        return 'Here is the mapping: { "fields": { "name": "full_name", "email": "email_addr" } } DONE';
      },
    });

    const { runtime, pack, target } = setupMigrate({ source: { content: SAMPLE_CSV }, model: capturing });
    const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));

    // The agent reached the model with the FILE CONTENT of mapping.system.md / mapping.user.md — NOT the
    // path strings. (mapping.system.md starts with "You are a data-migration mapping agent.")
    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).not.toMatch(/\.\/prompts\//); // never the literal path
    expect(capturedSystem).toMatch(/data-migration mapping agent/i);
    // The user prompt is mapping.user.md CONTENT (its "Source sample rows" header) reaching the model —
    // NOT the literal "./prompts/mapping.user.md" path. The {{state.*}} placeholders were interpolated
    // by the runner (no raw "{{state" tokens survive into the model request).
    expect(capturedUser).not.toMatch(/\.\/prompts\//);
    expect(capturedUser).toMatch(/Source sample rows/i);
    expect(capturedUser).not.toMatch(/\{\{state/); // templates were resolved, not passed verbatim

    // The run still drives to the commit approval and commits all records on approve.
    const corr = suspendStep(ev1);
    expect(corr?.step).toBe("commit");
    await collectEvents(runtime.resume(corr as CorrelationId, { approved: true }));
    expect(target.rows().map((r) => String(r["id"])).sort()).toEqual(["u1", "u2", "u3"]);
  });
});
