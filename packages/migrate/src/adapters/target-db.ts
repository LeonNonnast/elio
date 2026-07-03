// ───────────────────────────── Target-Adapter: DB (injizierter Service, side-effect-gescopt, §7) ─────────────────────────────
// Das ZIEL einer Migration ist ein injizierter Adapter-Service, kein Graph-Step (§7-Inv.): der Commit
// schreibt seine Side-Effects über ctx.db (= das vom Injector gescopte ScopedDbService über dem hier
// verdrahteten InMemoryDbService-Backend). Der Adapter kapselt die DURABLE Ziel-Tabelle + dient als
// EFFECT-LEDGER (§11/#11): welche record.ids bereits angewandt sind. Er überlebt — anders als das
// per-Run frisch erzeugte Artefakt — über mehrere Runs hinweg (real: die echte Prod-DB). Damit ist
// Idempotenz testbar: ein Re-Run liest den Ledger und verarbeitet NUR neue/fehlgeschlagene Records.

import { InMemoryDbService } from "@elio/sdk";
import type { DbService } from "@elio/core";

export interface TargetDbOptions {
  /** Ziel-Tabelle, in die die Records committed werden (Default "target"). */
  table?: string;
  /** Optionaler Seed (bereits vorhandene Records — z.B. ein vorheriger Teil-Run). */
  seed?: Record<string, unknown>[];
}

/**
 * Ziel-DB-Adapter über ein InMemoryDbService-Backend. Liefert das Backend für die Runtime-Verdrahtung
 * (`ctx.db`-Backend) UND Helfer für den Effect-Ledger (applied ids, idempotenter Upsert). Die
 * Commit-Node schreibt über ctx.db; dieser Adapter ist die durable Quelle der Wahrheit für "schon
 * angewandt?" über Run-Grenzen hinweg.
 */
export class TargetDbAdapter {
  readonly table: string;
  private readonly db: InMemoryDbService;

  constructor(opts: TargetDbOptions = {}) {
    this.table = opts.table ?? "target";
    this.db = new InMemoryDbService({
      scopes: [this.table],
      ...(opts.seed !== undefined ? { seed: { [this.table]: opts.seed } } : {}),
    });
  }

  /** Das DbService-Backend für die Runtime (`createRuntime({ db: adapter.backend })`). */
  get backend(): DbService {
    return this.db;
  }

  /** Aktueller Stand der Ziel-Tabelle (Test/Diagnose). */
  rows(): Record<string, unknown>[] {
    return this.db.rows(this.table);
  }

  /** Set der bereits angewandten record.ids (Effect-Ledger, §11/#11). */
  appliedIds(): Set<string> {
    return new Set(this.rows().map((r) => String(r["id"])));
  }

  /** Ob ein record.id bereits committed wurde (Idempotenz-Check). */
  has(id: string): boolean {
    return this.appliedIds().has(id);
  }
}
