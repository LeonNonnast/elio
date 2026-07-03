import type { Cost } from "./common";
import type { CorrelationId, Elicitation, SuspendMode } from "./elicitation";
import type { Artifact } from "./artifact";
import type { ResolvedPolicy } from "./policy";
import type { Suspended } from "./node";
import type { SessionContract, SessionResult } from "./session";
import type { TapeFrame } from "./run";
import type { FeaturePack } from "./feature";
export interface ModelService {
    complete(req: unknown): Promise<{
        text: string;
        cost: Cost;
        confidence: number;
    }>;
    /** Streaming speist RunEvents → Studio-Live-Status (Inv. 15). */
    stream?(req: unknown): AsyncIterable<{
        delta: string;
    } | {
        done: {
            cost: Cost;
            confidence: number;
        };
    }>;
}
export interface AgentService {
    session(contract: SessionContract): Promise<SessionResult>;
}
export interface MemoryService {
    slice(): Promise<unknown>;
    write(x: unknown): Promise<void>;
}
export interface LoggerService {
    log(x: unknown): void;
}
export interface AuditService {
    record(x: unknown): void;
}
export interface CostService {
    charge(c: Cost): void;
    remaining(): number;
    /**
     * Aktuelle Rekursionstiefe dieses Scopes (Inv. 21). Optional, weil ein Test-Double nur charge/
     * remaining stellen kann; ein delegierender Node liest depth/maxDepth über die Boundary mit Fallback.
     */
    depth?(): number;
    /** Rekursions-Ceiling (Inv. 21): die Engine bricht bei depth >= maxDepth ab. Optional (s. depth). */
    maxDepth?(): number;
}
export interface FsService {
    read(p: string): Promise<string>;
    write(p: string, c: string): Promise<void>;
}
export interface DbService {
    query(q: string, p?: unknown[]): Promise<unknown[]>;
}
export interface HttpService {
    fetch(url: string, init?: unknown): Promise<unknown>;
}
/** Referenziert ein Secret per Name — NIE inline. Auflösung erst im (gesandboxten) Injector. */
export interface SecretRef {
    name: string;
}
export interface SecretsService {
    resolve(ref: SecretRef): Promise<string>;
    has(name: string): boolean;
}
export interface ElicitService {
    /** Erzeugt ein Suspended-Result; der Runner propagiert es hoch. */
    raise(e: Omit<Elicitation, "mode"> & {
        mode?: SuspendMode;
    }): Suspended;
}
/** Filter für `TracesService.collect`. Aus dem TapeFrame ableitbare Achsen (inkl. dem gestempelten Feature, 6b). */
export interface TraceQuery {
    /** Auf diese Runs einschränken; fehlt → alle (read-)erlaubten Runs. */
    runs?: string[];
    /** Nur Frames dieses Features (TapeFrame.feature). */
    feature?: string;
    /** Nur Frames dieses nodeType. */
    nodeType?: string;
    /** ISO-Zeitstempel, inklusiv (lexikografischer Vergleich auf TapeFrame.ts). */
    since?: string;
    until?: string;
}
/**
 * Read-only Zugriff aufs Loop Tape (Inv. 15) — die Capability, auf der die Learning/Optimization-Engine
 * sitzt (`traces:read`). Gegated wie secrets (security by absence, Inv. 14): nur injiziert, wenn die
 * resolvte Policy einen "traces:*"-toolPermission trägt UND eine Quelle verdrahtet ist.
 *
 * Feature-Scoping (6b): der Runner stempelt das Feature des Runs an jeden `TapeFrame` (`feature`), daher
 * filtert `TraceQuery.feature` und `traces:<feature>` beschränkt (über `RunStoreTracesService`/`TraceScope`)
 * den Zugriff auf das genannte Feature (`traces:read` = alle). Sowohl `collect` als auch `tape` setzen den
 * Scope durch.
 */
export interface TracesService {
    /** Sammelt (gefilterte) Frames über Runs hinweg — die bequeme Methode für Miner. */
    collect(query?: TraceQuery): Promise<TapeFrame[]>;
    /** Frames genau eines Runs (Passthrough zum Store). */
    tape(run: string): AsyncIterable<TapeFrame>;
}
/**
 * Schreibzugriff auf den Feature-Katalog (Inv. 13/14) — die EINZIGE mutierende Capability der
 * Learning-Engine (promote-candidate), gegated via "featurestore:write" (security by absence). `get`/
 * `versions` lesen, `put` schreibt eine neue Pack-Version (v_{n+1}); ein In-Memory- oder persistenter
 * Katalog dockt am selben Interface an. Bewusst entkoppelt vom read-only Retro-Pfad: nur dieses eine
 * Feature trägt den Grant.
 */
export interface FeatureStoreService {
    /** Neueste Version des Packs (oder null). */
    get(id: string): Promise<FeaturePack | null>;
    /** Schreibt eine Pack-Version (Upsert auf metadata.version). */
    put(pack: FeaturePack): Promise<void>;
    /** Alle bekannten Versionen eines Packs (Einfügereihenfolge). */
    versions(id: string): Promise<string[]>;
}
/** Resultat einer sandboxed Skript-Ausführung. `ok:false` (Fehler/OOD/Timeout) → der Aufrufer fällt aufs LLM zurück. */
export type ScriptRunResult =
    | { ok: true; output: unknown }
    | { ok: false; error: string };
/** Optionen für eine einzelne Skript-Ausführung. */
export interface ScriptRunOptions {
    /** Hartes Zeitlimit (ms); bei Überschreitung → `ok:false` (→ Fallback). Default impl-spezifisch. */
    timeoutMs?: number;
}
/**
 * Führt eine vom LLM GENERIERTE — also UNTRUSTED — reine Funktion `(input) => output` ISOLIERT aus
 * (Tier-2, Inv. 20). Anders als memo-lookup (Tier-0: reiner Tabellen-Lookup, gefahrlos in-process) führt
 * Tier-2 generierten Code AUS → er MUSS isoliert laufen (Worker/VM, ohne ambient authority, §11/#1): die
 * einzige Außenverbindung ist `input` rein / `output` raus, KEIN ctx. Gegated via "scripts:execute"
 * (security by absence, Inv. 14) — nur ein Feature mit dem Grant kann generierten Code ausführen.
 * `ok:false` (Wurf, Timeout, OOD, nicht-serialisierbare Ausgabe) ist KEIN Crash, sondern das MISS-Signal
 * → LLM-Fallback (Doc §8: der Fallback wird nie gekappt).
 */
export interface ScriptRunnerService {
    /** `source` = ein Funktions-Ausdruck, z.B. "function (input) { … }" oder "(input) => …". */
    run(source: string, input: unknown, opts?: ScriptRunOptions): Promise<ScriptRunResult>;
}
/**
 * Resume-Kontext (Inv. 11/12, §v0.2). Der Runner setzt ihn NUR am wieder-ausgeführten suspendierten
 * Step: die (vom Menschen) hinterlegte Antwort, die diesen Step fortsetzt. Ein Multi-Turn-Agent (Vela/
 * Claude) reicht sie in seinen `SessionContract.resume` weiter, damit die pausierte Inner-Loop-Session
 * mit der Antwort fortgesetzt wird (statt frisch zu starten). Fehlt er, ist es ein normaler (Erst-)Lauf.
 */
export interface ResumeContext {
    readonly answer: unknown;
}
export interface Ctx {
    readonly correlation: CorrelationId;
    readonly artifact: Artifact;
    /** Nur beim Re-Drive eines suspendierten Steps gesetzt (Inv. 11/12) — siehe ResumeContext. */
    readonly resume?: ResumeContext;
    readonly model?: ModelService;
    readonly agent?: AgentService;
    readonly logger?: LoggerService;
    readonly memory?: MemoryService;
    readonly audit?: AuditService;
    readonly cost?: CostService;
    readonly elicit?: ElicitService;
    readonly fs?: FsService;
    readonly db?: DbService;
    readonly http?: HttpService;
    readonly secrets?: SecretsService;
    /** Read-only Tape-Zugriff (Inv. 15), gegated via "traces:read" — Substrat der Learning-Engine. */
    readonly traces?: TracesService;
    /** Schreibzugriff auf den Feature-Katalog, gegated via "featurestore:write" — nur promote-candidate. */
    readonly featureStore?: FeatureStoreService;
    /**
     * Isolierte Ausführung GENERIERTER reiner Funktionen (Tier-2, Inv. 20), gegated via "scripts:execute".
     * Die script-eval-Node löst eine promotete Aufrufstelle über generierten Code statt das LLM (LLM-Fallback
     * bei OOD/Fehler). Nur ein Feature mit dem Grant trägt sie — security by absence.
     */
    readonly scripts?: ScriptRunnerService;
    readonly policy: ResolvedPolicy;
}
