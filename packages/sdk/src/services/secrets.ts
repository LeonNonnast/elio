// ───────────────────────────── EnvSecretsProvider (§11/#8) ─────────────────────────────
// SecretsProvider-Impl, die Namen aus process.env auflöst. Der pluggable Provider-Seam (SecretsProvider
// in @elio/core) erlaubt es, später einen Vault-Provider ohne Injector-/Runner-Änderung einzudocken.
// Das Policy-Scoping (welche Namen eine Node SEHEN darf) passiert im Injector über ScopedSecretsService;
// dieser Provider weiß nichts von Policies — er ist nur die Auflösungsquelle.

import type { SecretsProvider } from "@elio/core";

export interface EnvSecretsProviderOptions {
  /**
   * Quelle der Umgebungsvariablen (Default: process.env). Tests/Sandboxes können ein eigenes Objekt
   * übergeben, statt den realen Prozess-Env zu mutieren.
   */
  env?: Record<string, string | undefined>;
  /**
   * Optionaler Namens-Präfix (z.B. "ELIO_SECRET_"): ein angefragter Name `DB_PASSWORD` wird dann gegen
   * `ELIO_SECRET_DB_PASSWORD` aufgelöst. Default: kein Präfix (1:1).
   */
  prefix?: string;
}

/**
 * Löst SecretRefs gegen Umgebungsvariablen auf. `has(name)`/`get(name)` sind UNGESCOPT (der Injector
 * scoped darüber auf die policy-erlaubten Namen). Auto-Redaction passiert im ScopedSecretsService des
 * Injectors, nicht hier.
 */
export class EnvSecretsProvider implements SecretsProvider {
  private readonly env: Record<string, string | undefined>;
  private readonly prefix: string;

  constructor(opts: EnvSecretsProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.prefix = opts.prefix ?? "";
  }

  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  has(name: string): boolean {
    return this.env[this.key(name)] !== undefined;
  }

  get(name: string): string | undefined {
    return this.env[this.key(name)];
  }
}
