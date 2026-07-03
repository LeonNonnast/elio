// ───────────────────────────── Built-in: file (Inv. 6/7/14, klass "orchestration") ─────────────────────────────
// Datei-I/O über ctx.fs (Klasse 1, kein Denken). Path-gescopt: ctx.fs ist der vom Injector gebaute
// ScopedFsService — ein Pfad außerhalb der policy-erlaubten Präfixe wird abgelehnt (defense in depth
// über die DI hinaus). FAILS BY ABSENCE (Inv. 14): wurde ctx.fs nicht injiziert (Policy gab keine
// fsPaths frei ODER kein FsService verdrahtet), wirft die Node — kein stiller No-op, kein runtime
// permission-check: das Fehlen IST die Durchsetzung. tryWithRetry im Runner fängt den throw in ein Failed.
//
// Die Node FORDERT fs (requests.fs) mit "*"-Wildcard auf read+write an; der getightenete Policy-Schnitt
// (gewünschte Pfade ∩ erlaubte Präfixe) entscheidet, ob/welche Pfade überleben. Ein Feature/Author kann
// die Definition mit ENGEREN Pfaden überschreiben (tighten-only, Inv. 13).

import type { Node, NodeDefinition, Resolved } from "../node";

/**
 * Konfiguration einer file-Node. `with`/`input` ist via resolveInput bereits template-aufgelöst.
 *  - { op: "read", path: "/data/in.csv", as? }        -> Resolved<{ [as|content]: string }>
 *  - { op: "write", path: "/data/out.txt", content }  -> Resolved<{ path, bytes }>
 * `op` ist optional: fehlt es, wird "read" angenommen, wenn `content` fehlt, sonst "write".
 */
export interface FileWith {
  op?: "read" | "write";
  path?: string;
  content?: string;
  /** Output-Feldname für read (Default "content"). */
  as?: string;
}

function resolveOp(cfg: FileWith): "read" | "write" {
  if (cfg.op === "read" || cfg.op === "write") return cfg.op;
  return cfg.content === undefined ? "read" : "write";
}

/**
 * file-Handler: liest/schreibt über ctx.fs. Wirft, wenn ctx.fs fehlt (security by absence, Inv. 14)
 * oder `path` fehlt. Der ScopedFsService wirft selbst bei einem Out-of-Scope-Pfad (Pfad-Schnitt) —
 * der throw fließt durch tryWithRetry in ein Failed.
 */
export const fileHandler: Node<FileWith, unknown> = async (input, ctx) => {
  const cfg = (input ?? {}) as FileWith;
  if (ctx.fs === undefined) {
    throw new Error(
      "file node: ctx.fs ist nicht injiziert — security by absence (Inv. 14): diese Node wurde nicht " +
        "für Datei-Zugriff freigegeben (Policy gab keine fsPaths frei ODER kein FsService verdrahtet).",
    );
  }
  const path = cfg.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("file node: `path` fehlt (string erwartet).");
  }

  const op = resolveOp(cfg);
  if (op === "read") {
    const content = await ctx.fs.read(path);
    const key = cfg.as ?? "content";
    const result: Resolved = {
      status: "resolved",
      output: { [key]: content },
      confidence: 1,
      cost: { usd: 0 },
    };
    return result;
  }

  // write
  const content = typeof cfg.content === "string" ? cfg.content : String(cfg.content ?? "");
  await ctx.fs.write(path, content);
  const result: Resolved = {
    status: "resolved",
    output: { path, bytes: content.length },
    confidence: 1,
    cost: { usd: 0 },
  };
  return result;
};

/**
 * Registrierbare Definition der built-in file-Node. `requests.fs` mit "*"-Wildcard auf read+write
 * signalisiert dem Injector "diese Node will Datei-Zugriff"; der getightenete Pfad-Schnitt entscheidet,
 * welche Pfade tatsächlich erlaubt sind (Inv. 13/14). Leerer Schnitt -> kein ctx.fs -> die Node failt
 * by absence.
 */
export const fileNode: NodeDefinition<FileWith, unknown> = {
  type: "file",
  klass: "orchestration",
  handler: fileHandler,
  requests: { fs: { read: ["*"], write: ["*"] } },
};
