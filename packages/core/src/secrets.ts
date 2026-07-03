// ───────────────────────────── Secrets: policy-gescopte Handles (§11/#8, Inv. 15) ─────────────────────────────
// ctx.secrets liefert SecretRef-Handles, die NIE inline im Pack/Tape stehen. Aufgelöst wird erst im
// (gesandboxten) Injector über einen pluggable Provider (env/Vault). Nur policy-erlaubte Namen sind
// sichtbar (security by absence). Jeder aufgelöste Wert wird mit dem Tape-Redactor registriert, sodass
// er auto-redacted aus dem Loop Tape verschwindet (§11/#9).

import type { SecretRef, SecretsService } from "./ctx";
import type { Redactor } from "./redaction";

/**
 * Pluggable Secret-Backend (env in Slice 4; Vault später). `has`/`get` sprechen ROHE Namen an — das
 * Policy-Scoping passiert in ScopedSecretsService DARÜBER, nicht im Provider. Ein Provider weiß also
 * nichts von Policies; er ist nur die Auflösungsquelle.
 */
export interface SecretsProvider {
  /** Ob der Provider einen Wert für diesen Namen liefern könnte (ungescopt). */
  has(name: string): boolean;
  /** Roh-Auflösung (ungescopt). Wirft/undefined, wenn unbekannt — der Scoped-Wrapper prüft zuerst. */
  get(name: string): string | undefined;
}

/**
 * Policy-gescopte SecretsService-Sicht (§11/#8). Nur Namen aus `allowed` (= die von der Policy
 * erlaubten Secret-Namen) sind sichtbar — `has()`/`resolve()` außerhalb davon verhalten sich, als
 * existierte das Secret nicht (security by absence: nicht "blockiert per Check", sondern "nicht in der
 * erlaubten Menge"). Jeder aufgelöste Wert wird mit dem Redactor registriert (auto-redacted aus dem
 * Tape, §11/#9).
 */
export class ScopedSecretsService implements SecretsService {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly provider: SecretsProvider,
    allowed: readonly string[],
    private readonly redactor?: Redactor,
  ) {
    this.allowed = new Set(allowed);
  }

  has(name: string): boolean {
    return this.allowed.has(name) && this.provider.has(name);
  }

  resolve(ref: SecretRef): Promise<string> {
    const name = ref.name;
    if (!this.allowed.has(name)) {
      return Promise.reject(
        new Error(`secret "${name}" denied (not in policy-allowed scope)`),
      );
    }
    const value = this.provider.get(name);
    if (value === undefined) {
      return Promise.reject(new Error(`secret "${name}" not found in provider`));
    }
    // Auto-Redaction (§11/#9): den aufgelösten Wert beim Redactor anmelden, BEVOR er die Node erreicht.
    this.redactor?.register(value);
    return Promise.resolve(value);
  }
}

// ───────────────────────────── Secret-Scope-Konvention ─────────────────────────────
// Secrets reiten auf den toolPermissions (tighten-only Mengen-Schnitt, bereits getestet): ein Node
// fordert `tools: ["secret:DB_PASSWORD"]`, die Policy entscheidet per Schnitt, welche überleben. Der
// Injector liest die resolvten "secret:*"-Tools, leitet die erlaubten Secret-NAMEN ab und injiziert
// ctx.secrets NUR, wenn mindestens einer übrig ist. So bleibt ResolvedPolicy (LAW-Typ) unverändert.

const SECRET_TOOL_PREFIX = "secret:";

/** Leitet die erlaubten Secret-Namen aus den resolvten toolPermissions ab. */
export function allowedSecretNames(toolPermissions: readonly string[]): string[] {
  const names: string[] = [];
  for (const t of toolPermissions) {
    if (t.startsWith(SECRET_TOOL_PREFIX)) {
      const name = t.slice(SECRET_TOOL_PREFIX.length);
      if (name.length > 0) names.push(name);
    }
  }
  return names;
}
