// ───────────────────────────── Skill-Logik: Brief, deterministische SKILL.md-Konstruktion, Validierung ─────────────────────────────
// Reine, deterministische Funktionen (keine ctx-/IO-Abhängigkeit) — die Bausteine der build-skill-Nodes.
// Ein Claude-Code-SKILL ist ein Verzeichnis mit einer SKILL.md: YAML-Frontmatter (name + description) +
// markdown-Body. Diese Datei IST das Artefakt der Vertikale (Inv. 1). Die deterministische Skelett-
// Konstruktion muss OFFLINE (MockModel) bereits ein STRUKTURELL VALIDES SKILL.md liefern; ein reales
// Modell reichert nur den Body an (es ersetzt nie das Frontmatter).

/** Der Skill-Brief: die Eingabe der Vertikale. name/description/purpose sind Pflicht (-> Interview). */
export interface SkillBrief {
  name?: string;
  description?: string;
  purpose?: string;
  whenToUse?: string;
  instructions?: string;
  outDir?: string;
}

/** Die Pflichtfelder des Briefs (fehlt eines -> collect_brief raised eine Elicitation = das Interview). */
export const REQUIRED_BRIEF_FIELDS = ["name", "description", "purpose"] as const;
export type RequiredBriefField = (typeof REQUIRED_BRIEF_FIELDS)[number];

/** Der ELIO-Artefakt-Typ-`kind` der Vertikale. */
export const SKILL_ARTIFACT_KIND = "skill";

/** Default-Modell-id hinter dem Draft-Schritt (MockModel -> deterministisch offline). */
export const SKILL_BUILDER_MODEL = "mock";

/** Die Basis-Frage für ein fehlendes Pflichtfeld. */
function baseQuestionFor(field: RequiredBriefField): string {
  switch (field) {
    case "name":
      return "What is the skill name? (kebab-case: lowercase letters, digits, dashes)";
    case "description":
      return "Describe the skill in one line (what it does AND when to use it).";
    case "purpose":
      return "What is the purpose of this skill? (what is it for?)";
    default:
      return `Please provide "${field}".`;
  }
}

/**
 * Eine menschenlesbare Frage für ein fehlendes Pflichtfeld (-> elicitation.what). `attempt` (1-basiert)
 * variiert das `what` bei einem ERNEUTEN Versuch (>= 2) — der Runner keyt eine Antwort unter `what`,
 * also stellt ein anderes `what` sicher, dass eine STALE (abgelehnte, leere) Antwort den Re-Raise nicht
 * auto-resolved (silent-bypass-Fix). Zugleich bessere UX: der Re-Ask sagt, dass eine nichtleere Antwort
 * nötig ist. Der Feldname bleibt sichtbar (die Frage referenziert das Feld unverändert).
 */
export function questionFor(field: RequiredBriefField, attempt = 1): string {
  const base = baseQuestionFor(field);
  if (attempt <= 1) return base;
  return `${base} (a non-empty answer is required — attempt ${attempt})`;
}

/** Ob ein Brief-Feld gesetzt + nichtleer ist. */
function hasValue(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Erstes noch fehlendes Pflichtfeld (oder undefined, wenn der Brief vollständig ist). */
export function firstMissingField(brief: SkillBrief): RequiredBriefField | undefined {
  for (const field of REQUIRED_BRIEF_FIELDS) {
    if (!hasValue(brief[field])) return field;
  }
  return undefined;
}

/** Ob alle Pflichtfelder gesetzt sind. */
export function briefIsComplete(brief: SkillBrief): boolean {
  return firstMissingField(brief) === undefined;
}

// ───────────────────────────── kebab-case Normalisierung ─────────────────────────────

/** kebab-case-Prüfung: ausschließlich [a-z0-9] mit einfachen Bindestrichen, keine Rand-/Doppel-Dashes. */
export function isKebabCase(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/**
 * Normalisiert einen freien Namen zu kebab-case (deterministisch): Kleinbuchstaben, Nicht-Alnum -> "-",
 * gequetschte/Rand-Dashes entfernt. So liefert die deterministische Skelett-Konstruktion auch aus einem
 * "My Skill"-Brief ein valides Frontmatter-`name` (offline-valide, ohne Modell).
 */
export function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Eine description zu EINER Zeile glätten (Frontmatter-`description` ist einzeilig). */
export function toSingleLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

// ───────────────────────────── SKILL.md-Konstruktion ─────────────────────────────

/**
 * Die Platzhalter, auf die buildSkillMd/buildSkillBody zurückfallen, wenn ein Pflichtfeld LEER ist.
 * Ein SKILL.md, das diese trägt, ist ein degeneriertes Skelett aus einem KOLLABIERTEN Brief (das darf
 * das Gate nie passieren — vgl. validateSkillMd-Safety-Net). minLength-1-Pflicht aus brief.schema.json.
 */
export const PLACEHOLDER_NAME = "skill";
export const PLACEHOLDER_DESCRIPTION = "A Claude-Code skill.";
export const PLACEHOLDER_PURPOSE = "(no purpose given)";

/** Baut den deterministischen markdown-BODY aus dem Brief (Offline-Fallback ohne Modell). */
export function buildSkillBody(brief: SkillBrief): string {
  const purpose = hasValue(brief.purpose) ? brief.purpose.trim() : PLACEHOLDER_PURPOSE;
  const whenToUse = hasValue(brief.whenToUse)
    ? brief.whenToUse.trim()
    : hasValue(brief.description)
      ? toSingleLine(brief.description)
      : "(no trigger given)";
  const instructions = hasValue(brief.instructions) ? brief.instructions.trim() : "";

  const lines: string[] = [];
  lines.push("## Purpose", "", purpose, "");
  lines.push("## When to use", "", whenToUse, "");
  lines.push("## Instructions", "");
  if (instructions.length > 0) {
    lines.push(instructions);
  } else {
    lines.push(`1. Apply ${hasValue(brief.name) ? brief.name : "this skill"} to the task at hand.`);
    lines.push("2. Follow the purpose above and keep the output focused.");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Baut das vollständige, strukturell VALIDE SKILL.md (Frontmatter + Body). `name` wird auf kebab-case
 * normalisiert, `description` auf eine Zeile geglättet — so ist das Ergebnis IMMER valide (auch offline).
 * `body` (optional) überschreibt den deterministischen Body (z.B. die model-angereicherte Variante);
 * das Frontmatter wird IMMER deterministisch erzeugt (das Modell fasst es nie an).
 */
export function buildSkillMd(brief: SkillBrief, body?: string): string {
  const name = toKebabCase(hasValue(brief.name) ? brief.name : PLACEHOLDER_NAME);
  const description = toSingleLine(hasValue(brief.description) ? brief.description : PLACEHOLDER_DESCRIPTION);
  const finalBody = body !== undefined && body.trim().length > 0 ? body.trim() : buildSkillBody(brief).trim();
  return ["---", `name: ${name}`, `description: ${description}`, "---", "", finalBody, ""].join("\n");
}

/** Der kanonische SKILL.md-Name = kebab-case Brief-Name (= Verzeichnisname). */
export function skillNameFrom(brief: SkillBrief): string {
  return toKebabCase(hasValue(brief.name) ? brief.name : "skill");
}

// ───────────────────────────── SKILL.md-Validierung (skill_well_formed-Bausteine) ─────────────────────────────

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  /** alle frontmatter-Keys (Diagnose). */
  keys: string[];
}

/** Das Ergebnis der SKILL.md-Strukturprüfung. */
export interface SkillValidation {
  passed: boolean;
  failures: string[];
  frontmatter?: ParsedFrontmatter;
  body?: string;
}

/**
 * Parst ein SKILL.md in (Frontmatter, Body). Erwartet einen `---`-delimitierten YAML-Block am Anfang
 * mit einfachen `key: value`-Zeilen (für name/description ausreichend — kein voller YAML-Parser nötig,
 * security by simplicity). Liefert undefined, wenn kein abgeschlossener Frontmatter-Block existiert.
 */
export function parseSkillMd(md: string): { frontmatter: ParsedFrontmatter; body: string } | undefined {
  const normalized = md.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;

  const fm: ParsedFrontmatter = { keys: [] };
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    const key = m[1] as string;
    let value = (m[2] ?? "").trim();
    // optionale Quotes entfernen
    const q = /^["'](.*)["']$/.exec(value);
    if (q !== null) value = q[1] as string;
    fm.keys.push(key);
    if (key === "name") fm.name = value;
    if (key === "description") fm.description = value;
  }
  const body = lines.slice(end + 1).join("\n").trim();
  return { frontmatter: fm, body };
}

/**
 * Validiert ein SKILL.md strukturell (skill_well_formed-Bausteine):
 *  - Frontmatter parsebar (abgeschlossener ---/--- Block).
 *  - name vorhanden + kebab-case (und, falls expectedName gesetzt, identisch — = Verzeichnisname).
 *  - description vorhanden, nichtleer, EINE Zeile.
 *  - Body nichtleer.
 * Sammelt alle Verstöße (failures listed).
 */
export function validateSkillMd(md: string, expectedName?: string): SkillValidation {
  const failures: string[] = [];
  if (typeof md !== "string" || md.trim().length === 0) {
    return { passed: false, failures: ["SKILL.md is empty"] };
  }
  const parsed = parseSkillMd(md);
  if (parsed === undefined) {
    return { passed: false, failures: ["frontmatter not parseable (missing ---/--- block)"] };
  }
  const { frontmatter, body } = parsed;

  if (!hasValue(frontmatter.name)) {
    failures.push('frontmatter "name" is missing or empty');
  } else if (!isKebabCase(frontmatter.name)) {
    failures.push(`frontmatter "name" is not kebab-case: "${frontmatter.name}"`);
  } else if (expectedName !== undefined && frontmatter.name !== expectedName) {
    failures.push(`frontmatter "name" ("${frontmatter.name}") does not match directory name ("${expectedName}")`);
  }

  if (!hasValue(frontmatter.description)) {
    failures.push('frontmatter "description" is missing or empty');
  } else if (/\r?\n/.test(frontmatter.description)) {
    failures.push('frontmatter "description" must be a single line');
  }

  if (!hasValue(body)) {
    failures.push("body is empty");
  }

  // Safety-Net (silent-bypass-Schutz): ein SKILL.md, das die buildSkillMd-Platzhalter trägt, stammt aus
  // einem KOLLABIERTEN Brief (Pflichtfelder leer durchgerutscht). Das ist strukturell "valide", aber
  // bedeutungslos — es darf das Gate nie passieren. Wir failen, wenn name UND description die exakten
  // Platzhalter sind (beide Fallbacks gefeuert = beide Pflichtfelder waren leer).
  if (frontmatter.name === PLACEHOLDER_NAME && frontmatter.description === PLACEHOLDER_DESCRIPTION) {
    failures.push(
      "brief collapsed to placeholder defaults (name/description were empty) — the interview did not " +
        "collect the required fields",
    );
  }

  return {
    passed: failures.length === 0,
    failures,
    frontmatter,
    body,
  };
}

// ───────────────────────────── Body-Extraktion aus model-Output ─────────────────────────────

/**
 * Marker aus dem Draft-Prompt selbst (prompts/draft.{system,user}.md). Tragen diese im "Body" noch
 * auf, dann ist der model-Output kein echter Skill-Body, sondern ein Echo/Leak des Prompts (z.B. der
 * MockModel-Default `echo: <prompt>`). So ein Output wird verworfen -> deterministischer Fallback.
 */
const PROMPT_SCAFFOLD_MARKERS = [
  /produce the markdown body only/i,
  /end (?:your message )?with (?:the token )?done/i,
  /draft the skill\.md body/i,
  /you are a claude-code skill author/i,
] as const;

/**
 * Ein plausibler Skill-Body trägt mindestens eine `## `-Sektion (## Purpose / ## When to use /
 * ## Instructions, vgl. buildSkillBody + draft.system.md). Fehlt jede Markdown-Sektion, ist der
 * Text kein nutzbarer Body (z.B. ein roher Prompt-Echo) -> deterministischer Fallback.
 */
function looksLikeSkillBody(text: string): boolean {
  return /(^|\n)##\s+\S/.test(text);
}

/**
 * Zieht den nutzbaren Body aus einem (rohen) model-Output: entfernt einen finalen DONE-Token, ein
 * umschließendes ```-Codefence und etwaiges vom Modell mit-emittiertes Frontmatter (wir erzeugen das
 * Frontmatter deterministisch). Liefert undefined, wenn nichts STRUKTURELL Brauchbares übrig bleibt —
 * dann fällt draft_skill auf den deterministischen buildSkillBody zurück (Offline/MockModel-valide,
 * analog migrate.parseMappingProposal -> DEFAULT_MAPPING). "Brauchbar" heißt hier: der Text trägt
 * KEINE Prompt-Scaffolding-Marker (kein roher Prompt-Echo) UND mindestens eine `## `-Markdown-Sektion.
 */
export function extractBodyFromModel(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  let out = text.trim();
  // finalen DONE-Token entfernen
  out = out.replace(/\bDONE\s*$/i, "").trim();
  // umschließendes Codefence ```...``` entfernen
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```$/.exec(out);
  if (fence !== null) out = (fence[1] ?? "").trim();
  // vom Modell mit-emittiertes Frontmatter abschneiden (wir setzen es selbst)
  const parsed = parseSkillMd(out);
  if (parsed !== undefined) out = parsed.body;
  if (out.length === 0) return undefined;
  // Prompt-Echo/Leak verwerfen: trägt der "Body" noch Prompt-Scaffolding ODER keine `## `-Sektion,
  // ist er kein echter Skill-Body -> undefined (deterministischer Fallback greift).
  if (PROMPT_SCAFFOLD_MARKERS.some((re) => re.test(out))) return undefined;
  if (!looksLikeSkillBody(out)) return undefined;
  return out;
}
