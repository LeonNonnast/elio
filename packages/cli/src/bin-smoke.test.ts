// ───────────────────────────── Built-bin smoke test (executes dist/*.js under Node) ─────────────────────────────
// The unit suites run against package SOURCE (vitest aliases every package to its src), so they never
// exercise the emitted dist — which is exactly how the green gate previously masked that every `bin`
// crashed on launch (ERR_MODULE_NOT_FOUND / ERR_UNSUPPORTED_DIR_IMPORT from extensionless ESM imports).
//
// This test closes that gap: it BUILDS the workspace (tsc -b + the post-build ESM extension rewrite)
// and then actually SPAWNS the built executables with `node`, asserting they run — not just that main()
// works against source. This is the real deliverable from Blueprint §0.2/§8 ("elio run <feature> … real
// ausführbar via `bin`", exit 0 + erwartete stdout) and the regression guard for the build/module-
// resolution config defect.

import { describe, it, expect, beforeAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const cliBin = resolve(repoRoot, "packages/cli/dist/bin.js");
const mcpBin = resolve(repoRoot, "packages/mcp/dist/bin.js");
const studioBin = resolve(repoRoot, "packages/studio/dist/bin.js");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns `node <bin> <args>`, optionally feeding stdin, and collects exit code + output. */
function runNode(bin: string, args: string[], stdin?: string, timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      // Persistenten Run-Store in ein temp-Verzeichnis lenken, damit der Smoke-Test nicht ins Repo schreibt.
      env: { ...process.env, ELIO_STATE_DIR: mkdtempSync(join(tmpdir(), "elio-smoke-state-")) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms (stdout so far: ${stdout.slice(0, 200)})`));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

// Build once before the smoke tests so dist reflects the current source (incremental tsc is fast).
beforeAll(() => {
  const built = spawnSync("pnpm", ["build"], { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  if (built.status !== 0) {
    throw new Error(`pnpm build failed (status ${String(built.status)}):\n${built.stdout}\n${built.stderr}`);
  }
  expect(existsSync(cliBin)).toBe(true);
  expect(existsSync(mcpBin)).toBe(true);
  expect(existsSync(studioBin)).toBe(true);
}, 120_000);

describe("built bins run under Node (no ERR_MODULE_NOT_FOUND / ERR_UNSUPPORTED_DIR_IMPORT)", () => {
  it("`node elio/dist/bin.js run demo.draft-until-good` exits 0 with gate=passed", async () => {
    const res = await runNode(cliBin, ["run", "demo.draft-until-good"]);
    expect(res.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    expect(res.stdout).toMatch(/run-completed.*gate=passed/);
    expect(res.stdout).toMatch(/ERFOLGREICH \(gate passed\)/);
    expect(res.code).toBe(0);
  });

  it("`node elio/dist/bin.js --help` exits 0 and prints USAGE", async () => {
    const res = await runNode(cliBin, ["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/elio — ELIO CLI/);
    // The process-mining built-in ids are listed in USAGE (Doc §3, Slice 3).
    expect(res.stdout).toMatch(/pm\.event-log/);
    expect(res.stdout).toMatch(/pm\.discover/);
  });

  it("`node elio/dist/bin.js run pm.event-log --payload … && run pm.discover` resolve + run to gate=passed", async () => {
    // The pm.* built-in ids resolve through the dist build and actually run (capture dir under the smoke
    // temp state dir so nothing is written into the repo). First log one event, then discover over it.
    const captureDir = mkdtempSync(join(tmpdir(), "elio-smoke-capture-"));
    const logged = await runNode(cliBin, [
      "run",
      "pm.event-log",
      "--capture-dir",
      captureDir,
      "--payload",
      JSON.stringify({ session_id: "smoke-1", seq: 0, tool_name: "Read" }),
    ]);
    expect(logged.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    expect(logged.stdout).toMatch(/run-completed.*gate=passed/);
    expect(logged.code).toBe(0);

    const discovered = await runNode(cliBin, ["run", "pm.discover", "--capture-dir", captureDir]);
    expect(discovered.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    expect(discovered.stdout).toMatch(/run-completed.*gate=passed/);
    expect(discovered.code).toBe(0);
  });

  it("`node elio-mcp/dist/bin.js` answers initialize + tools/list over stdio", async () => {
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke", version: "0" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      "",
    ].join("\n");
    const res = await runNode(mcpBin, [], lines, 15_000);
    expect(res.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
    // The stdio JSON-RPC channel returned the initialize result and the feature tools list.
    expect(res.stdout).toMatch(/"serverInfo"/);
    expect(res.stdout).toMatch(/demo\.draft-until-good/);
  });

  it("`node elio-studio/dist/bin.js` serves the dashboard then shuts down on SIGTERM", async () => {
    // Start on an ephemeral port, wait for the listening URL, GET /, then SIGTERM and assert clean exit.
    const child = spawn(process.execPath, [studioBin], {
      cwd: repoRoot,
      env: { ...process.env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolvePromise, reject) => {
        let out = "";
        const t = setTimeout(() => reject(new Error(`studio did not log a URL; got: ${out}`)), 15_000);
        t.unref?.();
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c: string) => {
          out += c;
          const m = out.match(/listening on (http:\/\/\S+)/);
          if (m) {
            clearTimeout(t);
            resolvePromise(m[1] as string);
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c: string) => {
          if (/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/.test(c)) {
            clearTimeout(t);
            reject(new Error(`studio bin crashed: ${c}`));
          }
        });
        child.on("error", reject);
      });

      // GET / over real HTTP.
      const body = await new Promise<{ status: number; text: string }>((resolvePromise, reject) => {
        void import("node:http").then(({ get }) => {
          get(url, (r) => {
            let text = "";
            r.setEncoding("utf8");
            r.on("data", (c: string) => (text += c));
            r.on("end", () => resolvePromise({ status: r.statusCode ?? 0, text }));
          }).on("error", reject);
        });
      });
      expect(body.status).toBe(200);
      expect(body.text).toContain("<!doctype html>");

      // SIGTERM must shut the server down cleanly (the close-with-open-connections fix).
      const exit = await new Promise<number | null>((resolvePromise) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise(-1);
        }, 5_000);
        t.unref?.();
        child.on("close", (code) => {
          clearTimeout(t);
          resolvePromise(code);
        });
        child.kill("SIGTERM");
      });
      // 0 (graceful) is required; -1 would mean it hung and had to be SIGKILLed.
      expect(exit).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
