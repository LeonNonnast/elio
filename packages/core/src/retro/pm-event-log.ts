// ───────────────────────────── pm.event-log — der Logger (AI-frei, pro Event, Doc §3.1, Slice 3b) ─────────────────────────────
// Ein FeaturePack, das EINEN rohen Capture-Event (Hook-Payload) zu EINER normalisierten `events`-Zeile
// verdichtet und idempotent in die durable `CaptureStore` schreibt. NULL Intelligenz → kein Modell-Call →
// der Hot-Path ist deterministisch und schnell (Node-Start + Map/JSONL-Insert). Lauffähig über den
// OuterLoopRunner; der durable Output ist allein die `events`-Zeile (das Run-Tape verdunstet, §3.4).
//
// Graph (normalize → append):
//   normalize  (custom)  stempelt `received_at`, hasht Input/Output am Boundary (Inv. 23), mappt den rohen
//                        Hook-Payload (aus `state.input` = RunInput.payload) → CaptureEvent → `state.normalized`.
//   append     (custom)  closure-bindet die CaptureStore, liest `{{state.normalized}}`, ruft `store.append`
//                        (idempotent über den Inhalts-Hash `id`) und schreibt eine Quittung {session, seq, eventId}
//                        ins Artefakt-content. Das `event-logged`-Gate liest die Quittung.
//
// Warum CUSTOM-Nodes (nicht built-in transform/batch)? Der built-in `transform` kann nur set/append/take/map
// (+ Passthrough, transform.ts) — er kann weder `received_at`/Hashes stempeln noch eine CaptureStore-Closure
// halten. Das ist exakt das migrate-Closure-Muster (registerMigrate): ein register*-Fn, das den injizierten
// Service per Closure in die Fach-Nodes bindet.
//
// Capability: `append` FORDERT `tools: ["capture:write"]` an; die Root-Policy des Laufs muss den Grant tragen
// (security by absence, Inv. 14). Da die CaptureStore per Closure gebunden ist (NICHT über ctx.db), setzt die
// Node die Durchsetzung AKTIV durch: fehlt `capture:write` in der resolvten Policy, wirft sie — fail-closed.

import type { ArtifactType } from "../artifact";
import type { FeaturePack } from "../feature";
import type { GateVerdict, Node, NodeDefinition, Resolved } from "../node";
import type { NodeRegistry } from "../registry";
import { hashValue } from "./canon";
import type { CaptureEvent, CaptureStore, StoredCaptureEvent } from "./capture";

/** Node-Typen + Gate-id des pm.event-log-Packs. */
export const PM_NORMALIZE_TYPE = "capture-normalize";
export const PM_APPEND_TYPE = "capture-append";
export const PM_EVENT_LOGGED_TYPE = "event-logged";

/** Die Capability, die der Logger zum Schreiben einer events-Zeile braucht (Doc §3.1 capture-db-write). */
export const CAPTURE_WRITE_PERMISSION = "capture:write";

/** Artefakt-Typ des Loggers: die Quittung IST das Artefakt (Inv. 1). Append-only Provenance + content. */
export const CAPTURE_RECEIPT_TYPE: ArtifactType = { kind: "capture-receipt", holders: ["memory"] };

/**
 * Die rohe Hook-Payload-Form (Doc §2.1). NUR `session` ist Pflicht (Claude-Hooks tragen `session_id` in JEDEM
 * Event); alles andere ist optional/best-effort. Der Logger stempelt `received_at` selbst (Hooks tragen keinen
 * timestamp). Felder spiegeln die verifizierten Claude-Code-Hook-Fakten (tool_name/tool_input/tool_output/…).
 */
export interface RawHookEvent {
  /** case id (`session_id`) → CaptureEvent.session. Pflicht (jedes Hook-Event trägt sie). */
  session_id?: string;
  /** Alias, falls der Caller schon normalisierte Keys liefert. */
  session?: string;
  /** Reihenfolge in der Session (vom Hook-Glue gezählt). Fehlt → die append-Node weist eine monoton-steigende
   * per-Session-seq via `store.nextSeq` zu (kollisionsfrei; NICHT die Konstante 0). */
  seq?: number;
  /** Quelle: `claude-code` | `ollama` | … Default "claude-code". */
  source?: string;
  /** `tool_name` (PostToolUse) → activity (Invariante: activity == nodeType). */
  tool_name?: string;
  /** Aliase. */
  activity?: string;
  /** roher Tool-Input (PostToolUse) — wird am Boundary gehasht (Inv. 23). */
  tool_input?: unknown;
  /** roher Tool-Output (PostToolUse) — wird am Boundary gehasht (Inv. 23). */
  tool_output?: unknown;
  /** user_prompt (UserPromptSubmit) — als Input gehasht, falls kein tool_input. */
  user_prompt?: unknown;
  /** Kosten, falls der Hook sie trägt: { model, tokensIn, tokensOut, usd }. */
  cost?: { model?: string; tokensIn?: number; tokensOut?: number; usd?: number };
  /** Optionaler, vom Caller vor-gestempelter Empfangs-Zeitstempel (Test-Determinismus). */
  received_at?: string;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Sentinel-`seq`, wenn der rohe Hook-Payload KEIN `seq` trägt: die append-Node ersetzt ihn durch
 * `store.nextSeq(session)` (monoton, kollisionsfrei). NIE eine echte events-Zeile (negativ ⇒ erkennbar). */
export const SEQ_UNASSIGNED = -1;

/**
 * Mappt einen rohen Hook-Event → CaptureEvent (Doc §2.1/§4): stempelt `ts` (received_at), hasht den
 * sensiblen Input/Output am Boundary (Inv. 23 — NUR Hashes überleben), übernimmt session/seq/source/activity.
 * Deterministisch: ein optional vorgestempeltes `received_at` (Tests) gewinnt, sonst `nowIso`.
 *
 * Fehlt `seq` im Payload, trägt das Event den Sentinel `SEQ_UNASSIGNED` (NICHT die Konstante 0): die
 * append-Node weist dann eine monoton-steigende per-Session-`seq` über `store.nextSeq` zu, sodass zwei
 * seq-lose Events DERSELBEN Session nicht auf dem (session, 0)-Slot kollidieren (sonst würfe `append` und
 * der zweite Event ginge verloren). Trägt der Payload ein `seq` (Slice-4-Hook-Glue), bleibt es unverändert.
 */
export function normalizeHookEvent(raw: RawHookEvent, nowIso: string): CaptureEvent {
  const session = raw.session ?? raw.session_id ?? "";
  const seq = typeof raw.seq === "number" ? raw.seq : SEQ_UNASSIGNED;
  const source = raw.source ?? "claude-code";
  const activity = raw.activity ?? raw.tool_name ?? "";
  const ts = raw.received_at ?? nowIso;

  // Boundary-Redaction (Inv. 23): den ROHEN Input/Output NIE durchreichen — nur den stabilen Inhalts-Hash.
  const rawInput = raw.tool_input ?? raw.user_prompt;
  const rawOutput = raw.tool_output;

  const event: CaptureEvent = { session, seq, ts, source, activity };
  if (rawInput !== undefined) event.inputHash = hashValue(rawInput);
  if (rawOutput !== undefined) event.outputHash = hashValue(rawOutput);
  if (raw.cost !== undefined) {
    const cost: NonNullable<CaptureEvent["cost"]> = {};
    if (typeof raw.cost.model === "string") cost.model = raw.cost.model;
    if (typeof raw.cost.tokensIn === "number") cost.tokensIn = raw.cost.tokensIn;
    if (typeof raw.cost.tokensOut === "number") cost.tokensOut = raw.cost.tokensOut;
    if (typeof raw.cost.usd === "number") cost.usd = raw.cost.usd;
    if (Object.keys(cost).length > 0) event.cost = cost;
  }
  // raw als (redacted) Provenance NICHT mitführen: die Hashes genügen v0.1 und der raw-Payload könnte
  // unredacted PII tragen (der Logger ist der Redaction-Boundary). Bewusst weggelassen.
  return event;
}

/** Quittung, die `append` ins Artefakt-content schreibt — der `event-logged`-Gate liest sie. */
export interface CaptureReceipt {
  session: string;
  seq: number;
  eventId: string;
}

/**
 * Eval-Gate des pm.event-log (mirror von retro-/discovery-complete): bestätigt, dass eine events-Zeile
 * geschrieben wurde (eine `eventId`-tragende Quittung steht im Artefakt-content). Reiner Artefakt-Read.
 */
export const eventLoggedHandler: Node<unknown, GateVerdict> = (_input, ctx) => {
  const content = ctx.artifact.content;
  const eventId = isRecord(content) ? content["eventId"] : undefined;
  const verdict: GateVerdict =
    typeof eventId === "string" && eventId.length > 0
      ? { passed: true, score: 1, failures: [] }
      : { passed: false, score: 0, failures: ["event-logged: keine events-Zeile geschrieben (keine Quittung)"] };
  return Promise.resolve({ status: "resolved", output: verdict, confidence: 1, cost: {} });
};

/** Built-in Eval-Gate-Node für den pm.event-log-Pack (reiner Artefakt-Read, kein requests). */
export const eventLoggedNode: NodeDefinition<unknown, GateVerdict> = {
  type: PM_EVENT_LOGGED_TYPE,
  klass: "orchestration",
  handler: eventLoggedHandler,
};

/** Optionen der pm.event-log-Node-Registrierung. */
export interface RegisterEventLogOptions {
  /** Die durable events-Tabelle (Slice 2), per Closure in `append` gebunden. Pflicht. */
  captureStore: CaptureStore;
}

/**
 * Registriert die pm.event-log-Nodes (normalize + append + event-logged-Gate) an einer NodeRegistry —
 * idempotent (bereits registrierte Typen bleiben unangetastet, das migrate-`reg`-Muster). Die CaptureStore
 * wird per Closure in `append` gebunden (NICHT über ctx.db — der Store ist die events-Tabelle inkl.
 * Idempotenz + JSONL-Durability, capture.ts).
 */
export function registerEventLog(registry: NodeRegistry, opts: RegisterEventLogOptions): void {
  const { captureStore } = opts;
  const reg = (def: NodeDefinition): void => {
    if (!registry.has(def.type)) registry.register(def);
  };

  // ── normalize: roher Hook-Payload (state.input via {{state.input}}) → CaptureEvent (state.normalized). ──
  // KEIN requests: rein deterministische Transformation, kein Service-Zugriff (kein Modell, kein Tape, keine DB).
  const normalizeNode: NodeDefinition<{ event?: unknown }, { normalized: CaptureEvent }> = {
    type: PM_NORMALIZE_TYPE,
    klass: "orchestration",
    handler: (input): Promise<Resolved<{ normalized: CaptureEvent }>> => {
      const cfg = (input ?? {}) as { event?: unknown };
      const raw = (isRecord(cfg.event) ? cfg.event : {}) as RawHookEvent;
      const normalized = normalizeHookEvent(raw, new Date().toISOString());
      return Promise.resolve({
        status: "resolved",
        output: { normalized },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  // ── append: closure-gebundene CaptureStore; idempotenter Insert + Quittung ins Artefakt. ──
  // FORDERT capture:write an (Doc §3.1). Da die Store per Closure (nicht ctx.db) gebunden ist, setzt die Node
  // die Durchsetzung AKTIV durch: fehlt der Grant in der resolvten Policy, wirft sie (fail-closed, Inv. 14).
  const appendNode: NodeDefinition<{ event?: unknown }, CaptureReceipt> = {
    type: PM_APPEND_TYPE,
    klass: "orchestration",
    requests: { tools: [CAPTURE_WRITE_PERMISSION] },
    handler: async (input, ctx): Promise<Resolved<CaptureReceipt>> => {
      if (!ctx.policy.toolPermissions.includes(CAPTURE_WRITE_PERMISSION)) {
        throw new Error(
          `capture-append node: "${CAPTURE_WRITE_PERMISSION}" nicht gewährt — security by absence (Inv. 14): ` +
            "der Lauf wurde nicht zum Schreiben der events-Tabelle freigegeben (Root-Policy gewährt den " +
            "capture:write-toolPermission nicht).",
        );
      }
      const cfg = (input ?? {}) as { event?: unknown };
      const event = (isRecord(cfg.event) ? cfg.event : {}) as unknown as CaptureEvent;
      // Seq-los gelieferte Events (Sentinel): eine monoton-steigende per-Session-seq zuweisen, damit zwei
      // distinkte seq-lose Events derselben Session nicht auf demselben (session, seq)-Slot kollidieren
      // (sonst würfe append und der zweite Event ginge verloren). Mit Hook-gezähltem seq bleibt es unverändert.
      const toAppend: CaptureEvent =
        event.seq === SEQ_UNASSIGNED ? { ...event, seq: await captureStore.nextSeq(event.session) } : event;
      const stored: StoredCaptureEvent = await captureStore.append(toAppend);
      const receipt: CaptureReceipt = { session: stored.session, seq: stored.seq, eventId: stored.id };
      return { status: "resolved", output: receipt, confidence: 1, cost: { usd: 0 } };
    },
  };

  reg(normalizeNode as unknown as NodeDefinition);
  reg(appendNode as unknown as NodeDefinition);
  reg(eventLoggedNode as unknown as NodeDefinition);
}

/**
 * Das pm.event-log-Feature-Pack (autonomy static, artifact capture-receipt, evalGate event-logged). AI-FREI:
 * kein llm/agent-Node. Der rohe Hook-Event reist als `RunInput.payload` → `state.input` (Runner) → die
 * normalize-Node liest ihn via `{{state.input}}`.
 *
 * KEIN `policies`-Feld: "capture:write" ist KEINE Pack-Policy (eine id im PolicyRegistry), sondern ein
 * Root-Policy-`toolPermission` (wie "traces:read" beim pm.discover-Pack). Die append-Node FORDERT den Grant
 * an; die Root-Policy des Laufs muss ihn tragen (setupEventLog setzt rootPolicy({ toolPermissions:
 * ["capture:write"] })). Ein `policies: ["capture:write"]` würde den Runner werfen lassen (keine so benannte
 * Policy registriert) — exakt wie der pm.discover-Pack daher auch kein `policies`-Feld trägt.
 */
export const pmEventLogPack: FeaturePack = {
  apiVersion: "elio/v1",
  kind: "Feature",
  metadata: { id: "pm.event-log", version: "0.1.0", owner: "process-mining" },
  contentHash: "pm.event-log@0.1.0",
  feature: {
    autonomy: "static",
    artifact: { kind: "capture-receipt", evalGate: PM_EVENT_LOGGED_TYPE },
    io: { input: {}, output: {} },
    graph: {
      steps: [
        // normalize: roher Hook-Event (state.input) → CaptureEvent (state.normalized).
        { id: "normalize", type: PM_NORMALIZE_TYPE, with: { event: "{{state.input}}" }, outputs: { normalized: "state.normalized" } },
        // append: CaptureEvent (state.normalized) → idempotenter Insert + Quittung ins Artefakt.
        { id: "append", type: PM_APPEND_TYPE, with: { event: "{{state.normalized}}" } },
      ],
      edges: [{ from: "normalize", to: "append" }],
    },
  },
};
