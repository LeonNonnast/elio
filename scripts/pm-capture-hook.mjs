#!/usr/bin/env node
// ELIO process-mining capture hook (Slice 4 — trigger glue).
//
// Reads a Claude Code hook event (JSON on stdin) and forwards it to the matching
// process-mining feature via the CLI. Fire-and-forget: spawns detached and ALWAYS
// exits 0, so a logging error can never block or disturb the Claude Code session.
//
// Wire it from .claude/settings.json (see elio.pm-hooks.example.json and
// docs/elio-process-mining.md §7). NOT active until you opt in.
import { spawn } from "node:child_process";
import { join } from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  try {
    const e = JSON.parse(raw || "{}");
    const repo = process.cwd(); // Claude Code runs hooks in the project root
    const bin = join(repo, "packages", "cli", "dist", "bin.js");
    const captureDir = join(repo, ".elio", "capture");
    const args =
      e.hook_event_name === "SessionEnd"
        ? ["run", "pm.session-summary", "--payload", String(e.session_id ?? ""), "--capture-dir", captureDir]
        : ["run", "pm.event-log", "--payload", JSON.stringify(e), "--capture-dir", captureDir];
    spawn(process.execPath, [bin, ...args], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // never disturb the session
  }
  process.exit(0);
});
