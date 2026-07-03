// ───────────────────────────── Source-Adapter: CSV (injizierter Service, NICHT als Step, §7) ─────────────────────────────
// Die QUELLE einer Migration ist ein injizierter Adapter-Service, kein Graph-Step (§7-Inv.): das
// Migrationsskript IST das Artefakt; die Quelle ist eine Capability, die der Lauf gescopt bekommt.
// source-csv liest Zeilen aus einem CSV — entweder aus einem Fixture-String (Tests/Offline-Demo) oder
// aus einer Datei über ctx.fs (real). Ein hand-gerollter, abhängigkeitsfreier CSV-Parser (Node-only,
// §9: keine unnötigen Runtime-Deps) genügt für die Vertikale: Komma-getrennt, "quoted" Felder mit
// eingebetteten Kommas/Quotes, erste Zeile = Header. Jede Zeile wird zu einem Record-Objekt
// { <header>: <value> } gemappt; eine `id`-Spalte (oder die erste Spalte) liefert die per-record id
// (= correlation-key/Effect-Ledger-Key, §11/#11).

/** Ein geparster Quell-Record: Header -> Zellwert. Trägt eine stabile `id` für Idempotenz (§11/#11). */
export type CsvRecord = { id: string } & Record<string, string>;

export interface SourceCsvOptions {
  /** Roher CSV-Inhalt (Fixture/Inline). Alternative zu `path`. */
  content?: string;
  /** Pfad zu einer CSV-Datei; gelesen über einen FsService (real). Alternative zu `content`. */
  path?: string;
  /** Spaltenname, der die per-record id trägt (Default "id"; fehlt sie, wird die erste Spalte genutzt). */
  idColumn?: string;
}

/** Minimaler FsService-Shape (read) — lokal gehalten, damit der Adapter nicht hart an @elio/core hängt. */
export interface CsvFsReader {
  read(path: string): Promise<string>;
}

/**
 * Zerlegt EINE CSV-Zeile in ihre Felder. Beherrscht "quoted" Felder mit eingebetteten Kommas und
 * verdoppelten Quotes (""). Kein Zeilenumbruch innerhalb von Feldern (v0.1-Grenze — reicht fürs Sample).
 */
function parseLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1; // verdoppeltes Quote -> ein literales Quote
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      fields.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  fields.push(cur);
  return fields;
}

/**
 * Parst rohen CSV-Text in Records. Erste nicht-leere Zeile = Header. Jede Folgezeile -> ein Record
 * { <header>: <cell> }. Die `id` jedes Records kommt aus `idColumn` (Default "id"); fehlt diese Spalte,
 * wird der Wert der ersten Spalte genutzt, und fehlt auch der, der Zeilen-Index.
 */
export function parseCsv(content: string, idColumn = "id"): CsvRecord[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseLine(lines[0] as string).map((h) => h.trim());
  const records: CsvRecord[] = [];
  for (let r = 1; r < lines.length; r += 1) {
    const cells = parseLine(lines[r] as string);
    const row: Record<string, string> = {};
    header.forEach((col, i) => {
      row[col] = (cells[i] ?? "").trim();
    });
    const idCol = idColumn in row ? row[idColumn] : row[header[0] as string];
    const id = idCol !== undefined && idCol.length > 0 ? idCol : String(r - 1);
    records.push({ ...row, id });
  }
  return records;
}

/**
 * Injizierter Quell-Adapter-Service. `rows(fs?)` liefert die geparsten Records — aus dem Fixture-String
 * ODER (wenn nur `path` gesetzt ist) aus einer Datei über den übergebenen FsReader (ctx.fs). So ist die
 * Quelle eine Capability am Lauf-Kontext, kein Step.
 */
export class SourceCsvAdapter {
  private readonly content: string | undefined;
  private readonly path: string | undefined;
  private readonly idColumn: string;

  constructor(opts: SourceCsvOptions) {
    this.content = opts.content;
    this.path = opts.path;
    this.idColumn = opts.idColumn ?? "id";
  }

  /** Der konfigurierte Datei-Pfad (falls path-basiert) — die Setup-Fassade leitet daraus den fs-Scope ab. */
  get sourcePath(): string | undefined {
    return this.path;
  }

  /** Geparste Records. Braucht `content` ODER (`path` + ein FsReader). Wirft sonst (security by absence). */
  async rows(fs?: CsvFsReader): Promise<CsvRecord[]> {
    if (this.content !== undefined) {
      return parseCsv(this.content, this.idColumn);
    }
    if (this.path !== undefined) {
      if (fs === undefined) {
        throw new Error(
          `SourceCsvAdapter: path "${this.path}" gesetzt, aber kein FsReader (ctx.fs) übergeben — ` +
            `security by absence (Inv. 14): der Lauf wurde nicht für Datei-Zugriff freigegeben.`,
        );
      }
      const text = await fs.read(this.path);
      return parseCsv(text, this.idColumn);
    }
    throw new Error("SourceCsvAdapter: weder `content` noch `path` gesetzt.");
  }
}
