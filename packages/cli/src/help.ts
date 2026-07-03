// ───────────────────────────── elio --help (Usage) ─────────────────────────────
// Die built-in Feature-ids sind hier als Dokumentation inlined — die maßgebliche Quelle ist der
// Engine-Katalog (@elio/engine defaultCatalog()); diese Liste spiegelt ihn nur für die Hilfe.

export const USAGE = `elio — ELIO CLI (dünner Client über @elio/engine)

Usage:
  elio run <feature>                       Feature laden + ausführen, RunEvents streamen,
                                           an einem Approval (node-suspended) interaktiv prompten.
  elio resume <feature> <correlation-id> [answer]
                                           Einen suspendierten Run über die correlation-id resumen
                                           (<feature> optional — der Engine-Service leitet es aus dem Store ab).
  elio runs <feature>                      Runs im Store auflisten (id, feature, phase, waitingOn).
  elio serve [--port <n>]                  Einen dauerlaufenden Engine-Host (HTTP/SSE) starten, gegen den
                                           sich CLI/MCP/Studio als Client andocken (LIVE über alle Prozesse).
  elio --help | -h                         Diese Hilfe.

Remote-Engine: --engine-url <url> (oder $ELIO_ENGINE_URL) lenkt run/resume/runs gegen einen \`elio serve\`-
Host statt eines lokalen In-Process-Engines — so sehen alle Clients denselben Store live.

<feature> ist eine built-in id oder ein Pfad zu einer feature.yaml:
  demo.draft-until-good
  demo.retry-then-pass
  migrate.csv-to-db
  build-skill
  demo.local-agent   (lokaler Ollama-Agent — braucht Ollama auf localhost:11434)
  pm.event-log        (Process-Mining-Logger — AI-frei; --payload <roher Hook-Event>)
  pm.session-summary  (Process-Mining-Summarizer — LLM 1×/Session; --payload <session-id>)
  pm.discover         (Process-Mining-Discoverer — read-only über die events-Tabelle)
  ./path/to/feature.yaml

Flags (run):
  --csv <inhalt>     CSV-Sample für die Migrate-Vertikale (migrate.csv-to-db).
  --out <dir>        Ausgabe-Verzeichnis für build-skill (Default: ein temp-Verzeichnis).
  --model <spec>     Modell/Provider-Profil für JEDES Feature (feature.yaml, migrate.csv-to-db,
                     build-skill), z.B. ollama:llama3, azure-openai:gpt-4o, claude:claude-opus-4-8.
                     Ohne --model/--ollama-url laufen die Vertikalen offline (MockModel).
  --ollama-url <url> Ollama-Basis-URL (Default http://localhost:11434; sonst $OLLAMA_HOST). Gilt für
                     alle Features; aktiviert (wie --model) die Provider-Auflösung der Vertikalen.
  --payload <wert>   Run-Input an den ersten Node (state.input). pm.event-log: roher Hook-Event (JSON);
                     pm.session-summary: Session-id. Gültiges JSON wird geparst, sonst der rohe String.
  --capture-dir <d>  Verzeichnis der file-backed CaptureStore (events/summaries.jsonl) der pm.*-Features
                     (Default .elio/capture, sonst $ELIO_CAPTURE_DIR).
  --no-prompt        An einer node-suspended Elicitation NICHT prompten (suspendiert lassen).

build-skill (Skill-Generator):
  Interviewt den fehlenden Brief (name/description/purpose) an der Elicitation auf stdin
  (interaktiv UND piped), draftet eine SKILL.md, validiert sie und schreibt sie nach einem
  blocking Approval governed nach <out>/<skill-name>/SKILL.md (fs-Write CONFINED, Inv. 14).

Approval (Approval Inbox, Skeleton §6):
  An einer node-suspended Elicitation prompted \`elio run\` auf stdin. Antworten:
    y | yes | approve | ok      -> { "approved": true }
    n | no  | deny | reject     -> { "approved": false }
    <gültiges JSON>             -> der geparste Wert
    <sonstiger Text>            -> der rohe String

correlation-id-Form: run/branch/step#checkpoint (aus \`elio run\`/\`elio runs\`).

Exit-Codes: 0 = gate "passed"; 1 = gestoppt/Fehler; 2 = Usage-Fehler.

Store: Der EngineService nutzt einen persistenten Run-Store (Default .elio/runs, sonst
$ELIO_STATE_DIR). \`elio resume\`/\`elio runs\` in einem NEUEN Prozess sehen Runs eines früheren
Prozesses, sofern sie denselben Store-Pfad nutzen — und für echtes Live-Monitoring über alle
Prozesse hinweg bindet man CLI/Studio an EINEN dauerlaufenden Engine-Host (\`elio serve\`, Phase 4).
`;
