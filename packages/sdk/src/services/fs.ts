// ───────────────────────────── ScopedFsService: reales node:fs, auf Präfixe confined (Inv. 14, §11/#1) ─────────────────────────────
// FsService-Impl gegen node:fs/promises, ABER hart auf eine Menge erlaubter Pfad-Präfixe begrenzt:
// jeder Zugriff wird normalisiert (resolve) und muss unter einem erlaubten, ebenfalls normalisierten
// Präfix liegen — Path-Traversal/Escape ("../", absolute Sprünge, Symlink-artige "/a/../../etc") wird
// abgelehnt. Das ist die Backend-Schicht hinter ctx.fs; der Injector wrappt sie zusätzlich in seinen
// eigenen ScopedFsService gegen die resolvten Policy-Pfade (defense in depth: Backend-Confinement +
// policy-gescopte DI). Security by absence bleibt primär — diese Klasse ist die Durchsetzung am Rand.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { FsService } from "@elio/core";

export interface ScopedFsServiceOptions {
  /** Erlaubte Pfad-Präfixe (read+write). Jeder Zugriff muss unter (oder gleich) einem davon liegen. */
  roots: string[];
  /** Bei write fehlende Verzeichnisse anlegen (Default: true). */
  ensureDir?: boolean;
}

/**
 * Confined-fs: reales Lesen/Schreiben, aber nur innerhalb der `roots`. Ein Pfad wird gegen jeden Root
 * (beide via path.resolve normalisiert) geprüft — `path.resolve` kollabiert "../" und absolute Sprünge,
 * sodass "/data/../etc/passwd" zu "/etc/passwd" wird und NICHT unter "/data" liegt -> abgelehnt.
 */
export class ScopedFsService implements FsService {
  private readonly roots: string[];
  private readonly ensureDir: boolean;

  constructor(opts: ScopedFsServiceOptions) {
    // Roots normalisieren (absolute, kollabierte Pfade) — Vergleich erfolgt gegen diese.
    this.roots = opts.roots.map((r) => resolve(r));
    this.ensureDir = opts.ensureDir ?? true;
  }

  /** Normalisiert `p` und prüft, dass es unter einem erlaubten Root liegt. Wirft sonst. */
  private confine(p: string): string {
    const abs = resolve(p);
    const ok = this.roots.some((root) => {
      if (abs === root) return true;
      // Echtes Präfix mit Separator-Grenze, damit "/data2" nicht als unter "/data" gilt.
      const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
      return abs.startsWith(withSep);
    });
    if (!ok) {
      throw new Error(
        `ScopedFsService: path "${p}" (resolved "${abs}") escapes allowed roots [${this.roots.join(", ")}]`,
      );
    }
    return abs;
  }

  async read(p: string): Promise<string> {
    const abs = this.confine(p);
    return readFile(abs, "utf8");
  }

  async write(p: string, c: string): Promise<void> {
    const abs = this.confine(p);
    if (this.ensureDir) {
      await mkdir(dirname(abs), { recursive: true });
    }
    await writeFile(abs, c, "utf8");
  }
}
