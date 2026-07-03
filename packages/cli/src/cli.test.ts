// ───────────────────────────── elio CLI — AC-Smoke + Approval-Flow (Blueprint §8) ─────────────────────────────
// Treibt die Command-Handler PROGRAMMATISCH (kein Prozess-Spawn, kein TTY): ein InMemoryCliIO sammelt
// die Ausgabe und liefert kanned Antworten an den Approval-Prompt. Die CLI ist jetzt ein dünner Client
// über @elio/engine (LocalEngine) — die Tests injizieren einen EngineService statt einer Runtime.
//   1. AC: `elio run demo.draft-until-good` erreicht run-completed{gate:"passed"} + exit 0.
//   2. AC: `elio runs` listet den Run (über engine.liveStatus()).
//   3. Approval-Flow: migrate.csv-to-db suspendiert am Commit-Approval -> kanned "y" -> resume -> passed.
//   4. main()-Arg-Parsing (run/help/unknown) + correlation-id-Codec.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEngine } from "@elio/engine";
import {
  decodeCorrelation,
  encodeCorrelation,
  InMemoryCliIO,
  main,
  parseAnswer,
  parsePayload,
  parseArgs,
  runCommand,
  runsCommand,
  serveCommand,
  EXIT_OK,
  EXIT_FAIL,
  EXIT_USAGE,
} from "elio";
import type { CorrelationId } from "@elio/core";

describe("elio run <feature> (AC: demo.draft-until-good)", () => {
  it("runs demo.draft-until-good to run-completed{gate:'passed'} with exit 0", async () => {
    const io = new InMemoryCliIO();
    const res = await runCommand(new LocalEngine(), "demo.draft-until-good", io);

    expect(res.exitCode).toBe(EXIT_OK);
    const out = io.output();
    expect(out).toMatch(/run-started/);
    expect(out).toMatch(/run-completed.*gate=passed/);
    expect(out).toMatch(/ERFOLGREICH \(gate passed\)/);
  });

  it("rejects an unknown feature with a clear error and non-zero exit", async () => {
    const io = new InMemoryCliIO();
    const res = await runCommand(new LocalEngine(), "does.not.exist", io);
    expect(res.exitCode).not.toBe(EXIT_OK);
    expect(io.output()).toMatch(/Unbekanntes Feature/);
  });
});

describe("elio runs (AC: the run is listed)", () => {
  it("lists a completed run from engine.liveStatus()", async () => {
    // EIN geteilter Engine-Service: der Run landet im selben Store, den `runs` liest.
    const engine = new LocalEngine();

    const runIo = new InMemoryCliIO();
    const runRes = await main(["run", "demo.draft-until-good"], { io: runIo, engine });
    expect(runRes).toBe(EXIT_OK);

    const listIo = new InMemoryCliIO();
    const res = await runsCommand(engine, listIo);
    expect(res.exitCode).toBe(EXIT_OK);
    const out = listIo.output();
    expect(out).toMatch(/Runs \(\d+\)/);
    expect(out).toMatch(/feature=demo\.draft-until-good/);
    expect(out).toMatch(/phase=(done|running)/);
  });

  it("reports an empty store cleanly", async () => {
    const io = new InMemoryCliIO();
    const res = await runsCommand(new LocalEngine(), io);
    expect(res.exitCode).toBe(EXIT_OK);
    expect(io.output()).toMatch(/Keine Runs im Store/);
  });
});

describe("elio run — Approval-Flow (Approval Inbox, §6)", () => {
  it("suspends migrate.csv-to-db at the commit approval, then resumes on a canned 'y' to gate:'passed'", async () => {
    const io = new InMemoryCliIO(["y"]);
    const res = await runCommand(new LocalEngine(), "migrate.csv-to-db", io);

    expect(res.exitCode).toBe(EXIT_OK);
    const out = io.output();
    expect(out).toMatch(/node-suspended.*mode=blocking/);
    expect(out).toMatch(/APPROVAL REQUIRED/);
    expect(out).toMatch(/Antwort:.*approved/);
    expect(out).toMatch(/run-completed.*gate=passed/);
    expect(out).toMatch(/ERFOLGREICH \(gate passed\)/);
    expect(io.questions.length).toBe(1);
  });

  it("leaves the run suspended (non-zero exit) when no answer is provided", async () => {
    const io = new InMemoryCliIO([]);
    const res = await runCommand(new LocalEngine(), "migrate.csv-to-db", io);
    expect(res.exitCode).not.toBe(EXIT_OK);
    expect(io.output()).toMatch(/SUSPENDIERT/);
    expect(io.output()).toMatch(/elio resume /);
  });

  it("does not prompt when noPrompt is set; leaves the run suspended", async () => {
    const io = new InMemoryCliIO(["y"]);
    const res = await runCommand(new LocalEngine(), "migrate.csv-to-db", io, { noPrompt: true });
    expect(res.exitCode).not.toBe(EXIT_OK);
    expect(io.questions.length).toBe(0);
    expect(io.output()).toMatch(/SUSPENDIERT/);
  });
});

describe("elio run — build-skill (Meta-Vertikale, Interview + Approval over the CLI prompt)", () => {
  it("interviews the missing brief fields on stdin, then writes the skill on approval -> gate passed", async () => {
    const io = new InMemoryCliIO([
      "code-reviewer",
      "Reviews a diff for correctness bugs; use before merging a PR.",
      "Help the author catch correctness bugs before merge.",
      "y",
    ]);
    const res = await runCommand(new LocalEngine(), "build-skill", io);

    expect(res.exitCode).toBe(EXIT_OK);
    const out = io.output();
    expect(io.questions.length).toBe(4);
    expect(out).toMatch(/skill name/i);
    expect(out).toMatch(/Write SKILL\.md to disk/);
    expect(out).toMatch(/skill\.draft_skill/);
    expect(out).toMatch(/run-completed.*gate=passed/);
    expect(out).toMatch(/ERFOLGREICH \(gate passed\)/);
  });

  it("lists the build-skill built-in in the catalog (artifact kind 'skill')", async () => {
    const features = await new LocalEngine().listFeatures();
    const skill = features.find((f) => f.id === "build-skill");
    expect(skill).toBeDefined();
    expect(skill!.artifact.kind).toBe("skill");
  });
});

describe("main() — arg parsing + dispatch", () => {
  it("prints usage on --help (exit 0)", async () => {
    const io = new InMemoryCliIO();
    const code = await main(["--help"], { io });
    expect(code).toBe(EXIT_OK);
    expect(io.output()).toMatch(/elio — ELIO CLI/);
    expect(io.output()).toMatch(/elio run <feature>/);
  });

  it("--help lists the build-skill built-in id", async () => {
    const io = new InMemoryCliIO();
    await main(["--help"], { io });
    const usage = io.output();
    expect(usage).toMatch(/^\s*build-skill$/m);
    expect(usage).toMatch(/build-skill \(Skill-Generator\)/);
  });

  it("prints usage with no args (exit 0)", async () => {
    const io = new InMemoryCliIO();
    const code = await main([], { io });
    expect(code).toBe(EXIT_OK);
    expect(io.output()).toMatch(/Usage:/);
  });

  it("reports an unknown command with exit 2", async () => {
    const io = new InMemoryCliIO();
    const code = await main(["frobnicate"], { io });
    expect(code).toBe(EXIT_USAGE);
    expect(io.output()).toMatch(/Unbekannter Befehl "frobnicate"/);
  });

  it("dispatches `run` and reaches exit 0 for the demo", async () => {
    const io = new InMemoryCliIO();
    // stateDir = temp, damit der persistente Store nicht ins Repo schreibt.
    const code = await main(["run", "demo.retry-then-pass"], {
      io,
      stateDir: mkdtempSync(join(tmpdir(), "elio-cli-state-")),
    });
    expect(code).toBe(EXIT_OK);
    expect(io.output()).toMatch(/run-completed.*gate=passed/);
  });

  it("parseArgs splits command / positionals / flags", () => {
    const a = parseArgs(["run", "demo.draft-until-good", "--csv", "id,x", "--no-prompt"]);
    expect(a.command).toBe("run");
    expect(a.positionals).toEqual(["demo.draft-until-good"]);
    expect(a.flags["csv"]).toBe("id,x");
    expect(a.flags["no-prompt"]).toBe(true);

    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["-h"]).command).toBe("help");
    expect(parseArgs(["bogus"]).command).toBe("unknown");
  });

  const tmpState = (): string => mkdtempSync(join(tmpdir(), "elio-cli-state-"));

  it("`elio runs <feature>` accepts a (now optional) feature positional, exit 0 on an empty store", async () => {
    const io = new InMemoryCliIO();
    const code = await main(["runs", "demo.draft-until-good"], { io, stateDir: tmpState() });
    expect(code).toBe(EXIT_OK);
    expect(io.output()).toMatch(/Keine Runs im Store/);
  });

  it("`elio runs` without a feature now works (the store holds ALL features), exit 0", async () => {
    const io = new InMemoryCliIO();
    const code = await main(["runs"], { io, stateDir: tmpState() });
    expect(code).toBe(EXIT_OK);
    expect(io.output()).toMatch(/Keine Runs im Store/);
  });

  it("`elio resume <feature> <correlation-id> [answer]` detects the correlation-id positional", async () => {
    // Der dokumentierten Syntax folgen (feature davor) darf KEINEN Usage-Fehler geben — die corr-id wird
    // erkannt, egal an welcher Position. Leerer Store -> EXIT_FAIL mit Store-Hinweis (NICHT Usage, NICHT bad corr-id).
    const io = new InMemoryCliIO();
    const corr = "r1/b1/commit#cp1";
    const code = await main(["resume", "demo.draft-until-good", corr, '{"approved":true}'], {
      io,
      stateDir: tmpState(),
    });
    expect(code).not.toBe(EXIT_USAGE);
    expect(io.output()).toMatch(/persistenten Store|\.elio\/runs/);
  });

  it("`elio resume` without a correlation-id gives a usage error", async () => {
    const io = new InMemoryCliIO();
    const code = await main(["resume"], { io, stateDir: tmpState() });
    expect(code).toBe(EXIT_USAGE);
    expect(io.output()).toMatch(/correlation-id/);
  });

  it("cross-process: `elio run --no-prompt` persistiert; ein NEUER `elio runs` (gleicher stateDir) sieht den suspendierten Run", async () => {
    const stateDir = tmpState();
    const ioA = new InMemoryCliIO();
    const codeA = await main(["run", "migrate.csv-to-db", "--no-prompt"], { io: ioA, stateDir });
    expect(codeA).toBe(EXIT_FAIL);
    expect(ioA.output()).toMatch(/SUSPENDIERT/);

    const ioB = new InMemoryCliIO();
    const codeB = await main(["runs", "migrate.csv-to-db"], { io: ioB, stateDir });
    expect(codeB).toBe(EXIT_OK);
    expect(ioB.output()).toMatch(/Runs \(/);
    expect(ioB.output()).toMatch(/suspended/);
  });

  it("USAGE and the parser agree: documented positional form for runs/resume", async () => {
    const io = new InMemoryCliIO();
    await main(["--help"], { io });
    const usage = io.output();
    expect(usage).toMatch(/elio runs <feature>/);
    expect(usage).toMatch(/elio resume <feature> <correlation-id> \[answer\]/);
  });
});

describe("resume — correlation-id codec + answer parsing", () => {
  it("round-trips a correlation-id through encode/decode", () => {
    const c: CorrelationId = { run: "r1", branch: "b1", step: "commit", checkpoint: "cp1" };
    const enc = encodeCorrelation(c);
    expect(enc).toBe("r1/b1/commit#cp1");
    expect(decodeCorrelation(enc)).toEqual(c);
  });

  it("rejects malformed correlation-ids", () => {
    expect(decodeCorrelation("no-hash")).toBeUndefined();
    expect(decodeCorrelation("a/b#cp")).toBeUndefined();
    expect(decodeCorrelation("a/b/c/d#cp")).toBeUndefined();
  });

  it("parses human approval answers into structured values", () => {
    expect(parseAnswer("y")).toEqual({ approved: true });
    expect(parseAnswer("YES")).toEqual({ approved: true });
    expect(parseAnswer("no")).toEqual({ approved: false });
    expect(parseAnswer('{"approved":true,"note":"ok"}')).toEqual({ approved: true, note: "ok" });
    expect(parseAnswer("just text")).toBe("just text");
  });

  it("parsePayload keeps scalar session-ids as raw strings (no approval/number coercion)", () => {
    expect(parsePayload("123")).toBe("123");
    expect(parsePayload("ok")).toBe("ok");
    expect(parsePayload("yes")).toBe("yes");
    expect(parsePayload("true")).toBe("true");
    expect(parsePayload("sess-abc")).toBe("sess-abc");
    expect(parsePayload('{"session_id":"s","tool_name":"Read"}')).toEqual({
      session_id: "s",
      tool_name: "Read",
    });
    expect(parsePayload("[1,2]")).toEqual([1, 2]);
  });

  it("run then resume in the same process: suspend with noPrompt, then resume via main()", async () => {
    // EIN geteilter Engine-Service über run + resume (in-process Active-Run-Cache).
    const engine = new LocalEngine();

    const runIo = new InMemoryCliIO();
    await main(["run", "migrate.csv-to-db", "--no-prompt"], { io: runIo, engine });
    const out = runIo.output();
    const m = out.match(/elio resume (\S+)/);
    expect(m).not.toBeNull();
    const corrStr = (m as RegExpMatchArray)[1] as string;
    expect(decodeCorrelation(corrStr)).toBeDefined();

    const resumeIo = new InMemoryCliIO();
    const code = await main(["resume", corrStr, '{"approved":true}'], { io: resumeIo, engine });
    expect(code).toBe(EXIT_OK);
    expect(resumeIo.output()).toMatch(/run-completed.*gate=passed/);
  });
});

// ───────────────────────────── elio serve + --engine-url (Phase 4: Remote-Engine) ─────────────────────────────
describe("elio serve + --engine-url (remote engine host)", () => {
  it("serveCommand starts a host; `elio run --engine-url <host>` drives a run remotely to gate passed", async () => {
    const engine = new LocalEngine();
    const serveIo = new InMemoryCliIO();
    const { host, address } = await serveCommand(engine, serveIo, 0);
    try {
      expect(serveIo.output()).toMatch(/engine host listening on http:\/\//);

      // The CLI run goes over the wire (EngineClient) against the serve host.
      const io = new InMemoryCliIO();
      const code = await main(["run", "demo.draft-until-good", "--engine-url", address], { io });
      expect(code).toBe(EXIT_OK);
      expect(io.output()).toMatch(/run-completed.*gate=passed/);

      // The run is visible remotely via `elio runs --engine-url <host>` (same host store).
      const listIo = new InMemoryCliIO();
      const listCode = await main(["runs", "--engine-url", address], { io: listIo });
      expect(listCode).toBe(EXIT_OK);
      expect(listIo.output()).toMatch(/feature=demo\.draft-until-good/);
    } finally {
      await host.closeHost();
    }
  });
});

// ───────────────────────────── Process-Mining built-in ids (Doc §3, Slice 3) ─────────────────────────────
describe("elio run pm.* (process-mining built-in ids resolve + run)", () => {
  it("pm.event-log: --payload <hook-event> resolves + runs to gate passed (one events row)", async () => {
    const captureDir = mkdtempSync(join(tmpdir(), "elio-pm-"));
    const io = new InMemoryCliIO();
    const res = await runCommand(new LocalEngine({ captureDir }), "pm.event-log", io, {
      payload: { session_id: "cli-1", seq: 0, tool_name: "Read", tool_input: { f: "x" } },
    });
    expect(res.exitCode).toBe(EXIT_OK);
    const out = io.output();
    expect(out).toMatch(/Lade Feature "pm\.event-log"/);
    expect(out).toMatch(/run-completed.*gate=passed/);
  });

  it("pm.discover: resolves + runs read-only over the (just-written) events table to gate passed", async () => {
    const captureDir = mkdtempSync(join(tmpdir(), "elio-pm-"));

    const logIo = new InMemoryCliIO();
    await runCommand(new LocalEngine({ captureDir }), "pm.event-log", logIo, {
      payload: { session_id: "cli-2", seq: 0, tool_name: "Read" },
    });

    const io = new InMemoryCliIO();
    const res = await runCommand(new LocalEngine({ captureDir }), "pm.discover", io);
    expect(res.exitCode).toBe(EXIT_OK);
    const out = io.output();
    expect(out).toMatch(/Lade Feature "pm\.discover"/);
    expect(out).toMatch(/run-completed.*gate=passed/);
  });

  it("pm.session-summary: --payload <session-id> resolves + runs to gate passed (offline MockModel)", async () => {
    const captureDir = mkdtempSync(join(tmpdir(), "elio-pm-"));

    const logIo = new InMemoryCliIO();
    await runCommand(new LocalEngine({ captureDir }), "pm.event-log", logIo, {
      payload: { session_id: "cli-3", seq: 0, tool_name: "Read" },
    });

    const io = new InMemoryCliIO();
    const res = await runCommand(new LocalEngine({ captureDir }), "pm.session-summary", io, {
      payload: "cli-3",
    });
    expect(res.exitCode).toBe(EXIT_OK);
    expect(io.output()).toMatch(/run-completed.*gate=passed/);
  });

  it("rejects an unknown feature listing the pm ids in the error", async () => {
    const io = new InMemoryCliIO();
    const res = await runCommand(new LocalEngine(), "pm.nope", io);
    expect(res.exitCode).not.toBe(EXIT_OK);
    expect(io.output()).toMatch(/pm\.event-log/);
  });
});
