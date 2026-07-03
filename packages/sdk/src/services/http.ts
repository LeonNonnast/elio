// ───────────────────────────── ScopedHttpService: reales fetch, auf Hosts confined (Inv. 14, §v0.2) ─────────────────────────────
// HttpService-Impl gegen das globale fetch (Node 18+/undici), ABER hart auf eine Menge erlaubter Hosts
// begrenzt: jede URL wird geparst und ihr Host muss in `hosts` liegen ("*" = jeder Host). Das ist die
// Backend-Schicht hinter ctx.http; der Injector wrappt sie zusätzlich in seinen eigenen
// ScopedHttpService gegen die resolvten Policy-Hosts (defense in depth: Backend-Confinement +
// policy-gescopte DI). Security by absence bleibt primär — diese Klasse ist die Durchsetzung am Rand.

import type { HttpService } from "@elio/core";

export interface ScopedHttpServiceOptions {
  /** Erlaubte Hosts (z.B. "api.example.com") oder "*" für jeden Host. Case-insensitive. */
  hosts: string[];
  /**
   * Optionaler fetch-Ersatz (Tests/Offline). Default: der globale `fetch`. Signatur bewusst schmal
   * gehalten (url, init) — die HttpService-Fassade gibt ohnehin `unknown` zurück.
   */
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
}

/**
 * Confined-http: reales `fetch`, aber nur gegen die erlaubten `hosts`. Eine nicht-parsebare URL wird
 * abgelehnt (kein stiller Durchlass). Der Host-Vergleich ist case-insensitive auf `URL.hostname`.
 */
export class ScopedHttpService implements HttpService {
  private readonly anyHost: boolean;
  private readonly hosts: Set<string>;
  private readonly fetchImpl: (url: string, init?: unknown) => Promise<unknown>;

  constructor(opts: ScopedHttpServiceOptions) {
    this.anyHost = opts.hosts.includes("*");
    this.hosts = new Set(opts.hosts.map((h) => h.toLowerCase()));
    this.fetchImpl =
      opts.fetchImpl ??
      ((url: string, init?: unknown) => fetch(url, init as RequestInit | undefined));
  }

  async fetch(url: string, init?: unknown): Promise<unknown> {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error(`ScopedHttpService: "${url}" is not a valid absolute URL`);
    }
    if (!this.anyHost && !this.hosts.has(host)) {
      throw new Error(
        `ScopedHttpService: host "${host}" escapes allowed hosts [${[...this.hosts].join(", ")}]`,
      );
    }
    return this.fetchImpl(url, init);
  }
}
