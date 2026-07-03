// ───────────────────────────── Sandbox: isolierte Ausführung generierter Skripte (Tier-2, Inv. 20) ─────────────────────────────
// ctx.scripts führt eine vom LLM GENERIERTE — also untrusted — reine Funktion (input)=>output isoliert aus.
// Anders als memo-lookup (Tier-0: reiner Tabellen-Lookup, gefahrlos in-process) führt Tier-2 generierten
// Code AUS und braucht daher eine echte Isolationsgrenze (§11/#1, Inv. 20): die Funktion bekommt KEIN ctx,
// keine ambient authority — nur `input` rein, `output` raus. Gegated wie featurestore/traces/secrets
// (security by absence, Inv. 14): der Injector hängt ctx.scripts NUR bei "scripts:execute"-Grant + Backend an.
//
// Mechanismus (vom Owner gewählt): node:worker_threads (terminierbares Hard-Timeout, eigener Thread,
// resourceLimits gegen Heap-Runaway) + node:vm-Context IM Worker (eingefrorener, capability-freier Scope:
// kein require/process/global). Der Input reist als JSON-STRING in den vm und wird DRIN mit dem vm-eigenen
// JSON geparst — ein als lebendes Host-Objekt übergebener Input wäre ein bekanntes vm-escape
// (`i.constructor.constructor("return process")()` erreicht den Host-Realm), ein String-Primitive nicht.
// Die Ausgabe wird IM vm JSON-serialisiert (plain data, klonbar, kein Host-Realm-Leak) und beim Host geparst.
// Eine REINE sync-Funktion ist die Vorgabe: ein zurückgegebenes Promise/thenable (oder eine async-Funktion)
// ist KEINE reine sync-Transform → wird als OOD behandelt (ok:false → LLM-Fallback), niemals als HIT.
//
// EHRLICHE GRENZE (Doc §9.x): das ist Thread-Isolation + capability-freier Scope + terminierbares Timeout +
// Heap/Output-Cap, KEINE OS/seccomp-Isolation (gemeinsamer Prozess-Heap; node:vm ist kein gehärteter
// Boundary gegen einen determinierten Angreifer — Escape-Techniken/Seitenkanäle bleiben möglich). Für eine
// generierte reine Transform-Funktion angemessen; die zusätzlichen Sicherungen sind der Shadow-Eval
// (held-out), das menschliche Approval und der nie gekappte LLM-Fallback. Ein echter Prozess-/Container-
// Sandbox bleibt vertagt (Roadmap "Echter Worker/VM-Sandbox").

import { Worker } from "node:worker_threads";
import type { ScriptRunnerService, ScriptRunOptions, ScriptRunResult } from "./ctx";

// ───────────────────────────── Scope-Konvention ─────────────────────────────
// scripts reiten auf den toolPermissions (tighten-only Mengen-Schnitt, analog secrets/traces/featurestore):
// ein Node fordert `tools: ["scripts:execute"]`, die Policy entscheidet per Schnitt, welche Scopes überleben.

const SCRIPTS_TOOL_PREFIX = "scripts:";

/** Leitet die erlaubten scripts-Scopes aus den resolvten toolPermissions ab (analog `allowedFeatureStoreScopes`). */
export function allowedScriptScopes(toolPermissions: readonly string[]): string[] {
  const scopes: string[] = [];
  for (const t of toolPermissions) {
    if (t.startsWith(SCRIPTS_TOOL_PREFIX)) {
      const scope = t.slice(SCRIPTS_TOOL_PREFIX.length);
      if (scope.length > 0) scopes.push(scope);
    }
  }
  return scopes;
}

const DEFAULT_TIMEOUT_MS = 200;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB JSON-Ausgabe-Cap (gegen Riesen-Payloads / Host-OOM)
/** Heap-/Code-Caps des Workers: ein Runaway-Allocator wird schnell gekillt → 'error' → ok:false (MISS). */
const DEFAULT_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } as const;

/**
 * Worker-Bootstrap (läuft IM Worker, als eval-String). Lädt vm + parentPort, baut den untrusted Code so,
 * dass `input` DRIN aus einem JSON-String geparst wird (kein lebendes Host-Objekt → kein realm-escape),
 * führt die generierte Funktion unter vm-Timeout aus und postet die IM vm JSON-serialisierte Ausgabe zurück.
 * `source` + `maxOutputBytes` reisen über workerData (structured clone), werden also NICHT in den Bootstrap
 * injiziert — die einzige Konkatenation passiert INNERHALB des capability-freien vm-Contexts. Wurf/Timeout/
 * undefined/thenable/zu-groß/nicht-serialisierbar → `{ ok:false }` (= MISS → LLM-Fallback).
 */
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { source, inputJson, timeoutMs, maxOutputBytes } = workerData;
try {
  const ctx = vm.createContext(Object.create(null));
  ctx.__inputJson = inputJson;
  const code =
    '"use strict";(function(){' +
    'var input=JSON.parse(__inputJson);' +
    'var f=(' + source + ');' +
    'var out=f(input);' +
    'if(out!==null&&(typeof out==="object"||typeof out==="function")&&typeof out.then==="function")' +
    '{throw new Error("script returned a thenable/Promise — not a pure sync function (out of domain)");}' +
    'if(typeof out==="undefined")return undefined;' +
    'var s=JSON.stringify(out);' +
    'if(typeof s==="string"&&s.length>' + maxOutputBytes + ')' +
    '{throw new Error("script output too large (out of domain)");}' +
    'return s;})()';
  const json = vm.runInContext(code, ctx, { timeout: timeoutMs, displayErrors: false });
  if (typeof json !== "string") {
    parentPort.postMessage({
      ok: false,
      error: "script returned undefined/non-serializable output (treated as out-of-domain)",
    });
  } else {
    parentPort.postMessage({ ok: true, json });
  }
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
`;

export interface WorkerScriptRunnerOptions {
  /** Default-Hard-Timeout (ms), falls der Call keins angibt. Default 200. */
  defaultTimeoutMs?: number;
  /** Maximale JSON-Ausgabegröße (Bytes); darüber → ok:false (OOD). Default 256 KB. */
  maxOutputBytes?: number;
  /** Worker-Heap-Limits (node:worker_threads ResourceLimits). Default 64/16 MB old/young gen. */
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  };
}

type WorkerReply = { ok: true; json: string } | { ok: false; error: string };

/**
 * ScriptRunnerService über node:worker_threads + node:vm (s.o.). Pro `run()` ein FRISCHER Worker — saubere
 * Isolation ohne Cross-Call-State; ein Worker-Pool (Perf) ist bewusst aufgeschoben (v1: spawn-per-call).
 * Drei unabhängige Abbruch-Schichten: (1) der vm-`timeout` unterbricht SYNCHRONEN Endlos-Code (der einzige
 * von einer reinen sync-Funktion erreichbare Hänger — der vm-Context hat kein setTimeout/queueMicrotask);
 * (2) `resourceLimits` killt einen Heap-Runaway (→ 'error' → ok:false); (3) der `setTimeout`-Backstop +
 * 'exit'-Listener fangen einen Worker, der aus IRGENDEINEM Grund nie eine Antwort postet (hängender/
 * abstürzender Worker), damit das zurückgegebene Promise IMMER settled.
 */
export class WorkerScriptRunner implements ScriptRunnerService {
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly resourceLimits: WorkerScriptRunnerOptions["resourceLimits"];

  constructor(opts: WorkerScriptRunnerOptions = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.resourceLimits = opts.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
  }

  run(source: string, input: unknown, opts: ScriptRunOptions = {}): Promise<ScriptRunResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    let inputJson: string;
    try {
      // null-Fallback: undefined ist kein gültiges JSON-Top-Level (→ inside vm würde JSON.parse werfen).
      inputJson = JSON.stringify(input ?? null) ?? "null";
    } catch (e) {
      return Promise.resolve({
        ok: false,
        error: `input not JSON-serializable: ${String((e as Error).message)}`,
      });
    }
    return new Promise<ScriptRunResult>((resolve) => {
      let settled = false;
      const worker = new Worker(WORKER_BOOTSTRAP, {
        eval: true,
        workerData: { source, inputJson, timeoutMs, maxOutputBytes: this.maxOutputBytes },
        resourceLimits: this.resourceLimits,
      });
      const finish = (r: ScriptRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        void worker.terminate();
        resolve(r);
      };
      // Backstop: fängt einen Worker, der NIE eine Antwort postet (hängender/abstürzender Worker — NICHT
      // user-async, das der capability-freie vm-Context strukturell ausschließt). (finish referenziert
      // backstop nur im async Callback — die const ist bei jedem finish()-Aufruf längst initialisiert.)
      const backstop = setTimeout(
        () => finish({ ok: false, error: `script timed out after ${timeoutMs}ms (terminated)` }),
        timeoutMs + 50,
      );
      worker.once("message", (m: WorkerReply) => {
        if (m.ok) {
          try {
            finish({ ok: true, output: JSON.parse(m.json) });
          } catch (e) {
            finish({ ok: false, error: `worker returned invalid JSON: ${String((e as Error).message)}` });
          }
        } else {
          finish({ ok: false, error: m.error });
        }
      });
      worker.once("error", (e) => finish({ ok: false, error: String(e.message) }));
      // Worker beendet sich ohne Antwort (z.B. resourceLimits-Kill ohne 'error', nativer Abort) → fail-fast
      // statt auf den Backstop zu warten. finish ist idempotent (settled-Guard), also auf dem Normalpfad
      // (message → terminate → exit) ein No-op.
      worker.once("exit", () => finish({ ok: false, error: "worker exited without posting a result" }));
    });
  }
}
