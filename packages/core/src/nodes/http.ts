// ───────────────────────────── Built-in: http (Inv. 6/7/14, klass "orchestration") ─────────────────────────────
// HTTP-I/O über ctx.http (Klasse 1, kein Denken). Host-gegated: ctx.http ist der vom Injector gebaute
// ScopedHttpService — er wird NUR injiziert, wenn die getightenete Policy mindestens einen httpHost
// trägt (gewünschte ∩ erlaubte Hosts) UND ein HttpService-Backend verdrahtet ist. FAILS BY ABSENCE
// (Inv. 14): wurde ctx.http nicht injiziert, wirft die Node — kein stiller No-op. tryWithRetry fängt
// den throw. Die Node FORDERT http (requests.http) mit "*"-Wildcard an; der getightenete Host-Schnitt
// entscheidet, welche Hosts überleben (tighten-only, Inv. 13); der ScopedHttpService prüft zusätzlich
// pro Call, dass die konkrete URL auf einen erlaubten Host zeigt.

import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer http-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst.
 *  - { url: "https://…", init?, as? } -> Resolved<{ [as|response]: unknown }>
 * `init` wird verbatim an ctx.http.fetch durchgereicht (Methode/Header/Body — Backend-abhängig).
 */
export interface HttpWith {
  url?: string;
  init?: unknown;
  /** Output-Feldname (Default "response"). */
  as?: string;
}

/**
 * http-Handler: ruft ctx.http.fetch(url, init). Wirft, wenn ctx.http fehlt (security by absence,
 * Inv. 14) oder `url` fehlt. Der ScopedHttpService ist auf die erlaubten Hosts gebunden.
 */
export const httpHandler: Node<HttpWith, unknown> = async (input, ctx) => {
  const cfg = (input ?? {}) as HttpWith;
  if (ctx.http === undefined) {
    throw new Error(
      "http node: ctx.http ist nicht injiziert — security by absence (Inv. 14): diese Node wurde nicht " +
        "für HTTP-Zugriff freigegeben (Policy gab keinen httpHost frei ODER kein HttpService verdrahtet).",
    );
  }
  const url = cfg.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("http node: `url` fehlt (string erwartet).");
  }

  const response = await ctx.http.fetch(url, cfg.init);
  const key = cfg.as ?? "response";
  const result: Resolved = {
    status: "resolved",
    output: { [key]: response },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

/**
 * Registrierbare Definition der built-in http-Node. `requests.http` mit "*"-Wildcard signalisiert dem
 * Injector "diese Node will HTTP-Zugriff"; der getightenete Host-Schnitt (req ∩ parent) entscheidet,
 * welche Hosts erlaubt sind (Inv. 13/14). Leerer Schnitt -> kein ctx.http -> die Node failt by absence.
 */
export const httpNode: NodeDefinition<HttpWith, unknown> = {
  type: "http",
  klass: "orchestration",
  handler: httpHandler,
  requests: { http: ["*"] },
};
