// ───────────────────────────── Migrate-spezifische Nodes + registerMigrate (Inv. 6 — built-in == custom) ─────────────────────────────
// Die Migrations-Vertikale registriert ihre Fach-Nodes wie jede Custom-Node an der Runtime-Registry
// (built-in == custom, Inv. 6). Quelle/Ziel sind INJIZIERTE ADAPTER-SERVICES, KEINE Steps (§7):
// registerMigrate(runtime, { source, target }) bindet sie per Closure in die Fach-Nodes.
//
// Mechanik (an die @elio/core-Engine angepasst, KEINE Core-Änderung):
//  - Der subworkflow-Mechanismus fächert pro Quell-Record EINEN Kind-Branch; die Kind-branch-id ist
//    `<parentBranch>/<record.id>`, und alle Kinder teilen sich das Run-Artefakt (Inv. 4/22). Templates
//    in den Kind-Steps werden gegen den PARENT-State aufgelöst, bevor die Kinder fächern — ein
//    `{{state.record}}` (kind-lokal) überlebt das also NICHT. Daher lesen die per-record-Nodes ihren
//    Record + das Mapping aus dem GETEILTEN ARTEFAKT (ctx.artifact.content, von `migrate.stage` befüllt)
//    und identifizieren ihren Record über die Kind-branch-id (ctx.correlation.branch). Das ist Inv.-konform:
//    das Artefakt ist die durable, session-übergreifende Quelle des Stands (Inv. 4).
//
// Nodes:
//  - migrate.read_source      : liest die Quell-Records über den injizierten SourceCsvAdapter (Klasse 1).
//  - migrate.parse_mapping    : faltet den (vom agent gelieferten) Mapping-Vorschlag in ein Mapping-Objekt.
//  - migrate.stage            : schreibt sampleRows + mapping ins geteilte Artefakt (Quelle für die Kinder).
//  - migrate.transform_record : per-record (im subworkflow) — wendet das Mapping auf SEINEN Record an.
//  - migrate.validate_record  : per-record — prüft den transformierten Record gegen das Ziel-Schema.
//  - migrate.commit           : BATCH-Massenschreiben ins Ziel über ctx.db OHNE per-record Checkpoint
//                               (§11/#11), idempotent über den Effect-Ledger (applied record.ids skip).
//  - sample_passes            : das Eval-Gate (Inv. 1) — bestanden, wenn alle validen Sample-Records
//                               im Ziel committed sind (hält den Loop bis NACH dem Commit-Approval offen).

import type { GateVerdict, NodeDefinition, Resolved } from "@elio/core";
import type { Runtime } from "@elio/sdk";
import type { CsvRecord } from "./adapters/source-csv";
import type { SourceCsvAdapter } from "./adapters/source-csv";
import type { TargetDbAdapter } from "./adapters/target-db";

// ───────────────────────────── Mapping ─────────────────────────────

/**
 * Ein Mapping bildet Quell-Spalten auf Ziel-Felder ab: `fields[targetField] = sourceColumn`.
 * `id` ist immer durchgereicht (per-record-Schlüssel, §11/#11) — das Mapping muss es nicht nennen.
 */
export interface Mapping {
  fields: Record<string, string>;
}

/** Das kanonische Default-Mapping der Demo-Vertikale (Quelle full_name/email_addr -> Ziel name/email). */
export const DEFAULT_MAPPING: Mapping = {
  fields: { name: "full_name", email: "email_addr" },
};

/**
 * Extrahiert ein Mapping aus dem (template-aufgelösten) agent-Output. Akzeptiert ein geformtes
 * { fields: {...} } oder einen JSON-String, der so etwas trägt; liefert sonst DEFAULT_MAPPING
 * (deterministischer Offline-Fallback mit MockModel).
 */
export function parseMappingProposal(proposal: unknown): Mapping {
  const fromObj = (v: unknown): Mapping | undefined => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const fields = (v as { fields?: unknown }).fields;
      if (typeof fields === "object" && fields !== null && !Array.isArray(fields)) {
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(fields)) {
          if (typeof val === "string") out[k] = val;
        }
        if (Object.keys(out).length > 0) return { fields: out };
      }
    }
    return undefined;
  };

  const direct = fromObj(proposal);
  if (direct !== undefined) return direct;

  if (typeof proposal === "string") {
    const match = /\{[\s\S]*\}/.exec(proposal);
    if (match !== null) {
      try {
        const parsed: unknown = JSON.parse(match[0]);
        const fromStr = fromObj(parsed);
        if (fromStr !== undefined) return fromStr;
      } catch {
        // kein valides JSON -> Default
      }
    }
  }

  return DEFAULT_MAPPING;
}

/** Wendet ein Mapping auf EINEN Quell-Record an. `id` wird immer durchgereicht. */
export function applyMapping(record: CsvRecord, mapping: Mapping): Record<string, unknown> {
  const out: Record<string, unknown> = { id: record.id };
  for (const [targetField, sourceCol] of Object.entries(mapping.fields)) {
    out[targetField] = record[sourceCol];
  }
  return out;
}

// ───────────────────────────── Ziel-Schema-Validierung (per-record) ─────────────────────────────

/** Die Pflichtfelder des Ziel-Schemas (analog schemas/target.schema.json). */
export const TARGET_REQUIRED_FIELDS = ["id", "name", "email"] as const;

/** Prüft einen transformierten Record: alle Pflichtfelder vorhanden + nichtleer. */
export function validateTargetRecord(record: Record<string, unknown>): string[] {
  const failures: string[] = [];
  for (const field of TARGET_REQUIRED_FIELDS) {
    const v = record[field];
    if (v === undefined || v === null || (typeof v === "string" && v.trim().length === 0)) {
      failures.push(`missing required field "${field}"`);
    }
  }
  return failures;
}

// ───────────────────────────── geteilter Artefakt-Stand (sampleRows + mapping) ─────────────────────────────

/** Form des im Artefakt-content gestageten Migrations-Stands (Quelle für die per-record-Kinder). */
interface MigrateStaged {
  sampleRows?: CsvRecord[];
  mapping?: Mapping;
}

/** Liest den gestageten Stand aus dem geteilten Artefakt-content (Inv. 4). */
function readStaged(content: unknown): MigrateStaged {
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const c = content as MigrateStaged;
    return {
      sampleRows: Array.isArray(c.sampleRows) ? c.sampleRows : [],
      ...(c.mapping !== undefined ? { mapping: c.mapping } : {}),
    };
  }
  return { sampleRows: [] };
}

/** Item-id eines per-record-Kind-Branches = letztes "/"-Segment der Kind-branch-id. */
function recordIdFromBranch(branch: string): string {
  const i = branch.lastIndexOf("/");
  return i >= 0 ? branch.slice(i + 1) : branch;
}

// ───────────────────────────── Registrierungs-Optionen ─────────────────────────────

export interface RegisterMigrateOptions {
  /** Der injizierte Quell-Adapter (CSV). Die read_source-Node liest über ihn. */
  source: SourceCsvAdapter;
  /** Der injizierte Ziel-Adapter (DB). commit nutzt seinen Effect-Ledger (applied ids). */
  target: TargetDbAdapter;
  /**
   * Optionale Menge von record.ids, deren Commit FEHLSCHLÄGT (simuliert einen transienten Ziel-Fehler).
   * Diese Records werden NICHT geschrieben und als `failed` gemeldet — beim Re-Run (mit geleertem Set)
   * werden GENAU sie (+ neue) verarbeitet, die bereits angewandten via Ledger übersprungen (§11/#11).
   * Ein Set, damit ein Test es zwischen Runs mutieren kann.
   */
  failCommitIds?: Set<string>;
}

// ───────────────────────────── registerMigrate ─────────────────────────────

/**
 * Registriert die Migrate-spezifischen Nodes + das Eval-Gate an einer Runtime. Quelle/Ziel sind
 * injizierte Adapter (§7) — über Closures gebunden, nicht als Steps deklariert. Idempotent:
 * bereits registrierte Typen werden nicht doppelt registriert.
 */
export function registerMigrate(runtime: Runtime, opts: RegisterMigrateOptions): void {
  const { source, target } = opts;
  const failCommitIds = opts.failCommitIds ?? new Set<string>();

  const reg = (def: NodeDefinition): void => {
    if (!runtime.registry.has(def.type)) runtime.registry.register(def);
  };

  // ── migrate.read_source: liest die Quell-Records über den injizierten SourceCsvAdapter (§7). ──
  // Fordert fs an ("*" = die von der Policy erlaubten Pfade, security by absence, Inv. 14): nur dann
  // hängt der Injector ctx.fs an, sodass der path-basierte SourceCsvAdapter real über die policy-
  // gescopte fs lesen kann. content-basierte Quellen (Fixture) brauchen ctx.fs nicht.
  const readSourceNode: NodeDefinition<unknown, { rows: CsvRecord[] }> = {
    type: "migrate.read_source",
    klass: "orchestration",
    requests: { fs: { read: ["*"] } },
    handler: async (_input, ctx): Promise<Resolved<{ rows: CsvRecord[] }>> => {
      const rows = await source.rows(ctx.fs);
      return { status: "resolved", output: { rows }, confidence: 1, cost: { usd: 0 } };
    },
  };

  // ── migrate.parse_mapping: faltet den agent-Vorschlag in ein nutzbares Mapping (deterministisch). ──
  const parseMappingNode: NodeDefinition<{ proposal?: unknown }, { mapping: Mapping }> = {
    type: "migrate.parse_mapping",
    klass: "orchestration",
    handler: (input): Promise<Resolved<{ mapping: Mapping }>> => {
      const proposal = (input ?? {}) as { proposal?: unknown };
      const mapping = parseMappingProposal(proposal.proposal);
      return Promise.resolve({
        status: "resolved",
        output: { mapping },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  // ── migrate.stage: schreibt sampleRows + mapping ins GETEILTE Artefakt (Quelle für die Kinder). ──
  // Der Artefakt-content ist über alle Branches eines Runs geteilt (Inv. 4); die per-record-Kinder
  // lesen ihren Record + das Mapping von hier (sie können kind-lokale Templates nicht beziehen, s.o.).
  const stageNode: NodeDefinition<
    { rows?: CsvRecord[]; mapping?: Mapping },
    { staged: number }
  > = {
    type: "migrate.stage",
    klass: "orchestration",
    handler: (input, ctx): Promise<Resolved<{ staged: number }>> => {
      const cfg = (input ?? {}) as { rows?: CsvRecord[]; mapping?: Mapping };
      const rows = Array.isArray(cfg.rows) ? cfg.rows : [];
      const content = ctx.artifact.content as Record<string, unknown>;
      content["sampleRows"] = rows;
      content["mapping"] = cfg.mapping ?? DEFAULT_MAPPING;
      return Promise.resolve({
        status: "resolved",
        output: { staged: rows.length },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  // ── migrate.transform_record: per-record (im subworkflow) — Mapping auf SEINEN Record anwenden. ──
  // Liest Record + Mapping aus dem geteilten Artefakt; SEIN Record über die Kind-branch-id.
  const transformRecordNode: NodeDefinition<unknown, { transformed: Record<string, unknown> | null }> = {
    type: "migrate.transform_record",
    klass: "orchestration",
    handler: (_input, ctx): Promise<Resolved<{ transformed: Record<string, unknown> | null }>> => {
      const id = recordIdFromBranch(ctx.correlation.branch);
      const staged = readStaged(ctx.artifact.content);
      const record = (staged.sampleRows ?? []).find((r) => r.id === id);
      const mapping = staged.mapping ?? DEFAULT_MAPPING;
      const transformed = record !== undefined ? applyMapping(record, mapping) : null;
      return Promise.resolve({
        status: "resolved",
        output: { transformed },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  // ── migrate.validate_record: per-record — prüft den transformierten Record gegen das Ziel-Schema. ──
  // Re-derived den transformierten Record aus dem geteilten Artefakt (kind-lokale Outputs sind nicht
  // template-beziehbar, s.o.); liefert ein GateVerdict ({passed, failures}) wie die built-in validate.
  const validateRecordNode: NodeDefinition<
    unknown,
    GateVerdict & { transformed: Record<string, unknown> | null }
  > = {
    type: "migrate.validate_record",
    klass: "orchestration",
    handler: (_input, ctx): Promise<Resolved<GateVerdict & { transformed: Record<string, unknown> | null }>> => {
      const id = recordIdFromBranch(ctx.correlation.branch);
      const staged = readStaged(ctx.artifact.content);
      const record = (staged.sampleRows ?? []).find((r) => r.id === id);
      const mapping = staged.mapping ?? DEFAULT_MAPPING;
      const transformed = record !== undefined ? applyMapping(record, mapping) : null;
      const failures = transformed === null ? ["no source record for branch"] : validateTargetRecord(transformed);
      const passed = failures.length === 0;
      return Promise.resolve({
        status: "resolved",
        output: { passed, score: passed ? 1 : 0, failures, transformed },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  // ── migrate.commit: BATCH-Massenschreiben ins Ziel über ctx.db, idempotent über den Effect-Ledger. ──
  // KONTRAST zum per-record subworkflow: EIN Node-Call schreibt ALLE validen Records in-process, EIN
  // Checkpoint für die Charge (§11/#11) — kein per-record Branch. Idempotenz:
  //  - id bereits im Ledger (target.appliedIds) -> ÜBERSPRINGEN (kein Doppel-Schreiben).
  //  - id in failCommitIds -> simulierter transienter Fehler, NICHT geschrieben, als `failed` gemeldet.
  //  - sonst INSERT über ctx.db (security by absence, Inv. 14: fehlt ctx.db, wirft die Node).
  // Nur VALIDE Records (alle Pflichtfelder) werden überhaupt geschrieben.
  const commitNode: NodeDefinition<
    unknown,
    { committed: string[]; skipped: string[]; failed: string[]; invalid: string[]; processed: number }
  > = {
    type: "migrate.commit",
    klass: "orchestration",
    requests: { db: ["*"] },
    handler: async (
      _input,
      ctx,
    ): Promise<
      Resolved<{ committed: string[]; skipped: string[]; failed: string[]; invalid: string[]; processed: number }>
    > => {
      if (ctx.db === undefined) {
        throw new Error(
          "migrate.commit: ctx.db ist nicht injiziert — security by absence (Inv. 14): der Lauf wurde " +
            "nicht für DB-Zugriff freigegeben (Policy gab keinen dbScope frei ODER kein DbService verdrahtet).",
        );
      }
      const staged = readStaged(ctx.artifact.content);
      const records = staged.sampleRows ?? [];
      const mapping = staged.mapping ?? DEFAULT_MAPPING;

      const applied = target.appliedIds(); // Effect-Ledger: was schon committed ist (§11/#11)
      const committed: string[] = [];
      const skipped: string[] = [];
      const failed: string[] = [];
      const invalid: string[] = [];

      // Massen-I/O in-process (Batch-Klasse): pro Record EIN INSERT, KEIN per-record Checkpoint.
      for (const rec of records) {
        const id = rec.id;
        const transformed = applyMapping(rec, mapping);
        if (validateTargetRecord(transformed).length > 0) {
          invalid.push(id); // invalide Records werden nie committed
          continue;
        }
        if (applied.has(id)) {
          skipped.push(id); // schon angewandt -> idempotent überspringen
          continue;
        }
        if (failCommitIds.has(id)) {
          failed.push(id); // simulierter transienter Ziel-Fehler -> nicht schreiben
          continue;
        }
        const cols = Object.keys(transformed);
        const placeholders = cols.map((_c, i) => `$${i + 1}`).join(", ");
        const params = cols.map((c) => transformed[c]);
        await ctx.db.query(
          `INSERT INTO ${target.table} (${cols.join(", ")}) VALUES (${placeholders})`,
          params,
        );
        committed.push(id);
        applied.add(id); // lokalen Ledger-Spiegel aktualisieren (Doppel innerhalb DERSELBEN Charge vermeiden)
      }

      return {
        status: "resolved",
        output: { committed, skipped, failed, invalid, processed: records.length },
        confidence: 1,
        cost: { usd: 0 },
      };
    },
  };

  // ── sample_passes: das Eval-Gate (Inv. 1). ──
  // Bestanden, sobald JEDER valide Sample-Record im Ziel committed ist (Effect-Ledger). Das hält den
  // Outer Loop bewusst bis NACH dem Commit-Approval + Batch-Write offen (der Runner prüft das Gate nach
  // JEDEM resolved Step; ein zu früh bestehendes Gate würde dry_run/commit überspringen). Ein Re-Run mit
  // noch fehlenden (zuvor fehlgeschlagenen) Records bleibt "nicht bestanden", bis auch sie committed sind.
  const sampleGate: NodeDefinition<{ artifact?: { content?: unknown } }, GateVerdict> = {
    type: "sample_passes",
    klass: "orchestration",
    handler: (input): Promise<Resolved<GateVerdict>> => {
      const staged = readStaged(input?.artifact?.content);
      const records = staged.sampleRows ?? [];
      const mapping = staged.mapping ?? DEFAULT_MAPPING;
      const applied = target.appliedIds();

      const validIds = records
        .filter((r) => validateTargetRecord(applyMapping(r, mapping)).length === 0)
        .map((r) => r.id);

      const failures: string[] = [];
      if (validIds.length === 0) {
        failures.push("no valid sample records committed yet");
      }
      for (const id of validIds) {
        if (!applied.has(id)) failures.push(`record "${id}" not yet committed to target`);
      }
      const passed = failures.length === 0;
      return Promise.resolve({
        status: "resolved",
        output: { passed, score: passed ? 1 : 0, failures },
        confidence: 1,
        cost: { usd: 0 },
      });
    },
  };

  reg(readSourceNode as unknown as NodeDefinition);
  reg(parseMappingNode as unknown as NodeDefinition);
  reg(stageNode as unknown as NodeDefinition);
  reg(transformRecordNode as unknown as NodeDefinition);
  reg(validateRecordNode as unknown as NodeDefinition);
  reg(commitNode as unknown as NodeDefinition);
  reg(sampleGate as unknown as NodeDefinition);
}
