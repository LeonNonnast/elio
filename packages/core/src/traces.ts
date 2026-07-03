// ───────────────────────────── Traces: read-only Tape-Capability (Inv. 15, §11/#9) ─────────────────────────────
// ctx.traces ist die read-only Sicht aufs Loop Tape, auf der die Learning/Optimization-Engine sitzt
// (docs/elio-learning-engine.md). Gegated wie secrets (security by absence, Inv. 14): die Capability
// reitet auf den toolPermissions ("traces:read"), der Injector injiziert ctx.traces nur bei mindestens
// einem erlaubten traces-Scope UND verdrahteter Quelle.

import type { TapeFrame } from "./run";
import type { TraceQuery, TracesService } from "./ctx";

const TRACE_TOOL_PREFIX = "traces:";

/**
 * Leitet die erlaubten traces-Scopes aus den resolvten toolPermissions ab (analog `allowedSecretNames`).
 * Ein Node fordert `tools: ["traces:read"]`; die Policy entscheidet per Mengen-Schnitt (tighten-only),
 * welche Scopes überleben. v0.1 kennt nur "read" (read-all); feature-granulare Scopes ("traces:<feature>")
 * sind im Typ vorgesehen, aber v0.1 noch injektions-level (s. ctx.TracesService-Doc).
 */
export function allowedTraceScopes(toolPermissions: readonly string[]): string[] {
  const scopes: string[] = [];
  for (const t of toolPermissions) {
    if (t.startsWith(TRACE_TOOL_PREFIX)) {
      const scope = t.slice(TRACE_TOOL_PREFIX.length);
      if (scope.length > 0) scopes.push(scope);
    }
  }
  return scopes;
}

/**
 * Minimale read-Oberfläche, die der TracesService braucht. `RunStore` erfüllt sie strukturell (es hat
 * `runIds` + `tape`) — der Injector reicht den Store als Quelle durch, ohne dass traces an die volle
 * RunStore-Schreibseite koppelt.
 */
export interface TapeSource {
  runIds(): Promise<string[]>;
  tape(run: string): AsyncIterable<TapeFrame>;
}

/**
 * Policy-Scope der traces-Capability (6b). `readAll` = "traces:read" granted (alle Features lesbar);
 * sonst sind nur die in `features` gelisteten Feature-ids lesbar ("traces:<feature>"). Leer + !readAll =
 * nichts lesbar (dann wird ctx.traces gar nicht erst injiziert).
 */
export interface TraceScope {
  readAll: boolean;
  features: string[];
}

/** Leitet den TraceScope aus den erlaubten traces-Scopes ab ("read" → readAll, sonst Feature-Allowlist). */
export function traceScope(scopes: readonly string[]): TraceScope {
  return { readAll: scopes.includes("read"), features: scopes.filter((s) => s !== "read") };
}

/**
 * TracesService über einer TapeSource (typisch der RunStore). `collect` enumeriert die erlaubten Runs
 * (oder die per Query genannten), iteriert ihre Tapes und filtert auf den aus dem Frame ableitbaren Achsen
 * (feature, nodeType, ts-Fenster). Read-only — kein Schreibpfad.
 *
 * Scope-Durchsetzung (6b): ist `scope` gesetzt und NICHT readAll, liefert collect nur Frames, deren
 * `feature` in der Allowlist liegt (Frames ohne Feature-Stempel werden dann ausgeschlossen — sie sind nicht
 * zuordenbar, security by absence). Ohne `scope` (Default) liest der Service alles (Backcompat / Tests).
 */
export class RunStoreTracesService implements TracesService {
  constructor(
    private readonly source: TapeSource,
    private readonly scope: TraceScope = { readAll: true, features: [] },
  ) {}

  tape(run: string): AsyncIterable<TapeFrame> {
    // Scope ebenso durchsetzen wie collect() (Review-Befund): sonst läse eine traces:<feature>-gescopte
    // Node über tape() doch alle Frames eines Runs (inkl. fremder Features).
    if (this.scope.readAll) return this.source.tape(run);
    const source = this.source;
    const inScope = (f: TapeFrame): boolean => this.inScope(f);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<TapeFrame> {
        for await (const frame of source.tape(run)) {
          if (inScope(frame)) yield frame;
        }
      },
    };
  }

  private inScope(frame: TapeFrame): boolean {
    if (this.scope.readAll) return true;
    return frame.feature !== undefined && this.scope.features.includes(frame.feature);
  }

  async collect(query: TraceQuery = {}): Promise<TapeFrame[]> {
    const runs = query.runs ?? (await this.source.runIds());
    const out: TapeFrame[] = [];
    for (const run of runs) {
      for await (const frame of this.source.tape(run)) {
        if (!this.inScope(frame)) continue; // policy-Scope (traces:<feature>)
        if (query.feature !== undefined && frame.feature !== query.feature) continue;
        if (query.nodeType !== undefined && frame.nodeType !== query.nodeType) continue;
        // ISO-8601-Zeitstempel sortieren lexikografisch — seit/until inklusiv.
        if (query.since !== undefined && frame.ts < query.since) continue;
        if (query.until !== undefined && frame.ts > query.until) continue;
        out.push(frame);
      }
    }
    return out;
  }
}
