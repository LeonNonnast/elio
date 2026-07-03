# ELIO — Process Mining (Capture + Discovery)

> **These (ein Absatz):** ELIO ist ein **Loop-Orchestrator** — mit zwei aufsitzenden, read-only Disziplinen auf
> demselben Tape-Substrat: **Process Mining** (entdecken & prüfen, *was wirklich läuft*) und der **Learning
> Engine** (das Gelernte zurückschreiben). Sein Kern: **das Loop Tape *ist* ein Event-Log** (`case = run`,
> `activity = nodeType`, `timestamp = ts`, `resource/cost = result`). Weil Elio den **FeaturePack-Graph als
> normatives Soll-Modell *und* den Tape-Log co-versioniert** (`contentHash`) hat, ist Conformance *exakt* statt
> approximativ. **Discovery** ist der bisher fehlende Schritt — aus einem Log *ohne* vordeklariertes Modell ein
> Modell entdecken: der **Cold-Start des Autonomie-Dials (Inv. 9), rückwärts** —
> `unknown process → discovery → feature → loop → learning`.
>
> **Architektur-Leitsatz (Inv. 6, `built-in == custom`; Zuständigkeiten sauber trennen):** alles ist ein
> **Feature**, jedes mit *einer* Zuständigkeit. Capture/Discovery sind **drei** Feature-Packs (§3): ein
> **Logger** (AI-frei, hook-getriggert), ein **Session-Summarizer** (LLM, einmal pro Session) und ein
> **Discoverer** (read-only, intervall-getriggert). Die Trigger-Verdrahtung (§7) ist der *letzte* Schritt.
>
> Anschluss: baut auf `docs/elio-learning-engine.md` (Retro-Miner, Candidate-Store, `ctx.traces`) und
> `docs/elio-v0.1-skeleton.md` (Invarianten). Slice-Scope: **Claude-only, deterministische Discovery +
> Conformance-Router** — Ollama, Promotion/Synthese und Studio sind spätere Slices.

---

## 1. Das Substrat — PM auf demselben Tape

| PM-Säule (van der Aalst) | Elio | Diese Doc |
|---|---|---|
| **Discovery** (Log → Modell) | — | §6 `mineDfg` · `mineVariants` |
| **Conformance** (Realität vs. Soll) | implizit (`dead-step`) | §5 Router (Trace-Klassifikation) |
| **Enhancement / Performance** | `model-right-sizing`, `fail-fast`, `aggregateCost` | (vorhanden) |
| **Automation / RPA-Kandidaten** | `determinism-miner` (Anker) | (vorhanden) |

**Elios Alleinstellung:** klassisches PM hat *nur* den Log und muss ein unscharfes Modell raten. Elio hat den
**expliziten Graphen** — Conformance ist ein exakter Replay der Activity-Sequenz gegen `graph.edges`.

---

## 2. Capture-Schicht (vendor-neutral)

Vendor-Neutralität lebt **in der Capture-Schicht und nirgends sonst** — die Mining-Engine sieht nur `TapeFrame`s.
Zwei Modi, ein Ziel: die `events`-**Tabelle** (§4).

```
   CAPTURE (vendor-spezifisch)            KANON                MINING (vendor-agnostisch)
 ┌──────────────────────────────┐   ┌──────────────┐   ┌─────────────────────────────┐
 │ PUSH / live („mitschreiben")  │   │ Logger-       │   │  Discoverer-Feature          │
 │  • Claude Code → Hook          │──▶│  FEATURE      │──▶│  (intervall-getriggert)      │
 │  • Ollama      → HTTP-Proxy    │   │ → events      │   │  mine (variants/dfg)         │
 │  • generisch   → record-Tool   │   │   (ctx.db)    │   │  → PromotionCandidate         │
 ├──────────────────────────────┤   ├──────────────┤   │  (liest via ctx.traces)      │
 │ PULL / async (Import)         │   │ Summarizer-   │   │                             │
 │  • Claude .jsonl · Copilot-Log │──▶│  FEATURE (LLM)│──▶│  (bestehende Retro-Engine)  │
 └──────────────────────────────┘   │ → summaries   │   └─────────────────────────────┘
                                     └──────────────┘
```

**Regel: Tap auf der Orchestrator-Ebene, nicht der Modell-Ebene.** Claude Code *ist* einer → Hooks geben den
ganzen Prozess. Ollama ist es nicht → ein Proxy gibt nur Model-Telemetrie.

| Tool | Tap | Live? | Erfasst | Status |
|---|---|---|---|---|
| **Claude Code** | Hooks → Logger/Summarizer-Feature | live | voll | **Slice 1** |
| **Ollama** | Reverse-Proxy `:11434` | live | nur Model-Calls (keine native `session_id`) | später |
| **Copilot CLI** | Hook *falls vorhanden*, sonst Log-Import | ? | offen | geparkt |
| **beliebig** | `record`-Tool / SDK-Push | live | so viel wie gepusht | später |

### 2.1 Verifizierte Claude-Code-Hook-Fakten

- ✅ **`session_id` in *jedem* Event** → unsere `case id`.
- ⚠️ **Kein `timestamp`** → der Logger stempelt (`received_at`).
- ✅ **`async: true`** → Hook blockt die Session **nicht**.
- ✅ `tool_name`/`tool_input`/`tool_output` (PostToolUse), `user_prompt` (UserPromptSubmit), `exit_reason` + `transcript_path` (SessionEnd).
- ❌ **Web (claude.ai/code) hat keine Hooks** — nur CLI/Desktop/IDE, **lokal pro Maschine**.
- Bewusst **kein `PreToolUse`** (kann via exit 2 blocken). `PostToolUse` trägt Input *und* Output → reicht.

---

## 3. Die drei Features (eine Zuständigkeit je Feature)

### 3.1 `pm.event-log` — der Logger (AI-frei, **pro Event**, hook-getriggert)

**Zweck:** *einen* Capture-Event aufnehmen und als **Zeile in `events`** schreiben. **Null Intelligenz** → kein
Modell-Call → der Hot-Path ist deterministisch und schnell.

```yaml
metadata: { id: pm.event-log, version: 0.1.0 }
feature:
  autonomy: static
  artifact: { kind: capture-receipt, evalGate: event-logged }
  io: { input: { type: object }, output: { type: object } }   # roher Hook-Event → Quittung {session, seq}
  policies: [ capture-db-write ]                               # NUR db:write, gescopt auf events (Inv. 14)
  graph:
    steps:
      - id: normalize   # transform: Hook-Payload → kanonische Zeile, ts stempeln, sensible Felder hashen/redacten
        type: transform
      - id: append      # batch: idempotenter Insert in events (id = Event-Inhalts-Hash → Re-Delivery dupliziert nicht)
        type: batch
    edges: [ { from: normalize, to: append } ]
```

- Kein `llm`/`agent` → **AI-frei, schnell** (nur Node-Start + sqlite-Insert).
- **Ephemer getaped** (§3.4 / Vorschlag zu offener Frage #3).

### 3.2 `pm.session-summary` — der Summarizer (**LLM**, einmal pro Session, SessionEnd-getriggert)

**Zweck:** beim `SessionEnd` die Events *einer* Session zu einer `SessionSummary` verdichten. Hier ist ein **LLM**
erlaubt und sinnvoll — es läuft **einmal pro Session**, nicht pro Tool-Call, also ist die Performance kein Thema.
Saubere Trennung *innerhalb* des Features: das Deterministische bleibt deterministisch, das LLM macht nur das
**semantische `intent`/Summary**.

```yaml
metadata: { id: pm.session-summary, version: 0.1.0 }
feature:
  autonomy: static
  artifact: { kind: session-summary, evalGate: summary-well-formed }
  io: { input: { type: object }, output: { type: object } }   # { session } → SessionSummary
  policies: [ traces-read, summaries-db-write, summary-model ] # liest events, schreibt summaries, ein gepinntes Profil
  graph:
    steps:
      - id: stats       # transform (deterministisch): variant, fingerprint, toolHistogram, cost, durationMs
        type: transform
      - id: label       # llm (intelligence): semantisches intent[] + NL-Summary aus den Events
        type: llm
        with: { provider: claude, model: claude-haiku-4-5, prompt: <ref> }
      - id: persist     # batch: SessionSummary-Zeile in summaries (idempotent über session)
        type: batch
    edges: [ { from: stats, to: label }, { from: label, to: persist } ]
```

- **Das einzige Feature mit AI** — bewusst isoliert, einmal pro Session, gepinntes Profil explizit am Step.
- Profil: `mock` offline / `claude:claude-haiku-4-5` für echte semantische Labels (austauschbar, am Step gepinnt).

### 3.3 `pm.discover` — der Discoverer (read-only, intervall-getriggert)

**Zweck:** die akkumulierten Events lesen und die deterministischen Miner fahren.

```yaml
metadata: { id: pm.discover, version: 0.1.0 }
feature:
  autonomy: static
  artifact: { kind: promotion-candidate-set, evalGate: discovery-complete }
  io: { input: { type: object }, output: { type: object } }   # { window?: {since, until}, source? } → { candidates }
  policies: [ traces-read ]                                    # READ-ONLY — schreibt NIE ein Feature/Policy
  graph:
    steps:
      - id: route       # router: jede Session gegen den processes-Katalog klassifizieren (known vs unknown)
        type: router
      - id: mine        # retro-miner: miners [variants, dfg] über die UNKNOWN Sessions (groupByRun = pro Session)
        type: retro-miner
        with: { miners: [variants, dfg] }
    edges: [ { from: route, to: mine, when: "state.classification == 'unknown'" } ]
  # Gate discovery-complete: candidates-Array im Artefakt (wie retro-complete)
```

- **Read-only** (`traces:read`), **AI-frei**, **intervall-getriggert** → entkoppelt von der Session-Lebensdauer.
- **Conformance-Router `route` (§5):** klassifiziert jede Session gegen den `processes`-Katalog; `known` → conformance
  (`support++` / Abweichung), `unknown` → `mine`. Deterministisch (Directly-Follows-Jaccard), kein LLM.
- **Lose gekoppelt:** mint die `events`-Tabelle direkt. Die LLM-`intent`-Labels der Summaries enrichen einen
  *späteren*, semantischen Router; v0.1 klassifiziert rein strukturell.

### 3.4 Vorschlag zur offenen Frage #3 — wie der Logger sich nicht selbst minet

Der Logger läuft als echtes Feature, aber auf einem **ephemeren In-Memory-Run-Store**: sein eigenes Tape
verdunstet, der **durable Output ist allein die `events`-Zeile** (via `ctx.db`). Damit:
- **kein Run-Store-Rauschen** (tausende Mini-Logging-Runs persistieren nicht);
- **strukturell kein Selbst-Mining** — der Discoverer liest die **`events`-Tabelle**, *nicht* den Elio-Run-Store;
  der Logger kann also gar nicht in den Discovery-Input geraten.
- **Prozess-Start-Kosten** (Node-Start pro Tool-Call, `async`) bleiben — für v0.1 lokal akzeptiert; ein
  Daemon/Socket (Hook = dünner Client) ist die spätere Optimierung.

---

## 4. Tabellen (statt loser JSONL)

Elio hat die `db`-Capability schon (`ctx.db`, `db`/`batch`-Node — wie `migrate`). Lokal **sqlite**: Tabellen-
Semantik, null Server, eine Datei; ein DB-Server dockt später am selben `DbService`-Contract an.

**`events`** (Logger schreibt, Discoverer liest):

| Spalte | Bedeutung |
|---|---|
| `id` (PK) | Inhalts-Hash → idempotenter Insert |
| `session` | **case id** (`session_id`) |
| `seq` | Reihenfolge in der Session |
| `ts` | `received_at` (vom Logger gestempelt) |
| `source` | `claude-code` \| `ollama` \| … |
| `activity` | normalisiert: `tool_name` (Abstraktions-Stellschraube, §9) |
| `input_hash` / `output_hash` | redacted/gehasht am Boundary (Inv. 23) |
| `cost_json` | `{ model, tokensIn, tokensOut, usd }` |
| `raw_json` | Provenance (redacted Vollform) |

**`summaries`** (Summarizer schreibt; spätere Clusterung/Router liest): die `SessionSummary` (§5) je Session.

**Was die Tabelle löst:** Dateiwachstum/Sharding (→ Zeilen+Index), echte `TraceQuery` (SQL), nebenläufige
Schreibzugriffe, Cross-Machine über geteilte DB. Discovery liest `events` über eine **table-backed `TapeSource`**
hinter `ctx.traces`.

---

## 5. `SessionSummary` + (späterer) Conformance-Router

```ts
interface SessionSummary {
  session: string; source: string; window: { start: string; end: string };
  intent: string[];        // LLM (label-Step) — Clustering-Schlüssel #1
  variant: string[];       // deterministisch (stats-Step) — Schlüssel #2
  fingerprint: string;     // hashValue(variant)
  stats: { steps: number; cost: { usd: number; tokens: number }; durationMs: number; toolHistogram: Record<string, number> };
  outcome: "passed" | "stopped" | "abandoned";   // aus exit_reason inferiert (§9)
  evidence: { eventRef: string };                  // Provenance → events-Zeilen
}
```

**Router (`route`-Step in `pm.discover`):** klassifiziert jede Session — *bekannter* Prozess oder *neuer*?

*Korrektur an einer früheren Skizze:* ein Replay gegen Elios eigene Feature-Graphen passt **nicht** — eine
Dev-Session spricht ein anderes Activity-Vokabular (`Read`/`Edit`/`Bash`) als Elios Verticals
(`transform`/`agent`). Verglichen wird gegen einen **`processes`-Katalog** (die schon entdeckten/promoteten Muster).

Identifikation, deterministisch und billig (nutzt den DFG-Footprint, den `mineDfg` eh berechnet):
- **Signatur** je Session = `variant` (Activity-Sequenz) + **Directly-Follows-Set** (`a→b`-Paare).
- **(1) exakt:** `fingerprint = hashValue(variant)` → identische Wiederholungen gratis.
- **(2) fuzzy:** Directly-Follows-**Jaccard** gegen jeden Katalog-Eintrag; bester Match ≥ θ → `known` (welcher
  Prozess, `support++`, Abweichung notieren), sonst `unknown` → `mine` (neuer `process-variant`-Kandidat).
- *(später: semantisch über `intent` + echter Conformance-Replay.)*

**Bootstrapping:** der Katalog startet **leer** → erste Sessions alle `unknown` → Discovery befüllt → ab dann wird
klassifiziert. Router und Discovery ko-evolvieren.

**Read-only gewahrt:** `pm.discover` *liest* den Katalog; einen neuen Prozess *hineinschreiben* ist eine gegatete
Promotion (späterer Slice). Ehrliche v0.1-Folge: leerer Katalog → alles `unknown` (erwartet, kein Bug).

---

## 6. Discovery-Core (deterministisch — kein LLM)

```ts
// packages/core/src/retro/miners.ts (neu)
interface DfgEdge { from: string; to: string; freq: number; medianLatencyMs?: number; medianCost?: Cost; }
export function mineDfg(frames: readonly TapeFrame[], opts?: ProcessDiscoveryOptions): PromotionCandidate[];
export function mineVariants(frames: readonly TapeFrame[], opts?: ProcessDiscoveryOptions): PromotionCandidate[];
```

Beide: `groupByRun(frames)` (= pro Session) → `nodeType`-Folge → DFG-Kanten bzw. Trace-Varianten →
`makeCandidate({ kind: "process-variant", … })`. Neue `CandidateKind`: `process-variant` + `process-conformance`
(Abweichung known-Prozess ↔ Session).

Der Router teilt sich die Ähnlichkeits-Primitive mit den Minern:

```ts
export function directlyFollows(variant: readonly string[]): Set<string>;        // {"a→b", …}
export function jaccard(a: Set<string>, b: Set<string>): number;                  // [0,1]
export function classifySession(                                                  // der Router-Kern
  sig: { variant: string[]; follows: Set<string> },
  catalog: readonly ProcessSignature[], theta = 0.8,
): { classification: "known" | "unknown"; matched?: string; similarity: number };
```

### 6.1 Engine/Profil pro Feature

| Feature/Stufe | Engine | Modell/Profil |
|---|---|---|
| **`pm.event-log`** (normalize+append) | deterministisch | **keins** |
| **`pm.session-summary`** · stats/persist | deterministisch | **keins** |
| **`pm.session-summary`** · label | **`llm`** | **ja** — gepinnt am Step (`mock` / `claude:claude-haiku-4-5`) |
| **`pm.discover`** (mineDfg/mineVariants) | reine Funktionen | **keins** |
| feature-draft-Synthese | *späterer Slice* | naiv → inductive-lite → LLM | keins bis LLM-Variante |

**Logger + Discovery sind komplett modell-frei; AI ist allein im Summarizer isoliert** (einmal pro Session).

---

## 7. Trigger-Verdrahtung (der LETZTE Schritt — gegated)

Die Features sind über CLI/SDK getestet *und* real demonstriert (s. u.). Trigger sind dünne Verbindungen und werden
**bewusst nicht automatisch scharfgeschaltet** — `.claude/` ist git-ignored, ein aktiver Hook feuert bei *jedem*
Tool-Call. Geliefert sind **aktivierungsbereite** Artefakte:

- **Glue:** `scripts/pm-capture-hook.mjs` (getrackt) — liest das Hook-Event (JSON auf stdin) und ruft fire-and-forget
  (detached, immer `exit 0`) das passende Feature: `SessionEnd → pm.session-summary --payload <session_id>`, sonst
  `pm.event-log --payload <event-json>` (beide `--capture-dir <repo>/.elio/capture`).
- **Hook-Config:** `elio.pm-hooks.example.json` (getrackt, **nicht aktiv**) — der fertige `hooks`-Block
  (`UserPromptSubmit`/`PostToolUse`/`PostToolUseFailure`/`SessionEnd`, alle `async: true`).

**Aktivieren (dein expliziter Knopf):** (1) `pnpm build`; (2) den `hooks`-Block aus `elio.pm-hooks.example.json` in
`.claude/settings.json` mergen (projekt-lokal); (3) Session neu starten. **Deaktivieren** = Block löschen. Reversibel.

**Cron → Discovery:** Elio braucht keinen eigenen Scheduler — jeder externe Scheduler triggert `pm.discover`. Beispiel:

```cron
*/30 * * * * cd /home/leon/workspaces/elio && node packages/cli/dist/bin.js run pm.discover --capture-dir .elio/capture
```

> **Verifiziert (echter Lauf):** zwei via CLI geloggte Sessions (`Read→Edit→Bash→Read`) → `pm.discover` rekonstruiert
> (über `runtime.runner.getArtifact(...)`) die Prozess-Variante (100% Traffic) **und** den Directly-Follows-Graph
> (`Read→Edit (2)`, `Edit→Bash (2)`, `Bash→Read (2)`), `candidateCount: 2`, `gate=passed`.

---

## 8. Implementierungs-Plan (4 Slices, je grün/lauffähig)

### Slice 1 — Deterministischer Core (pure functions, kein Hot-Path)
**Ziel:** die Discovery-Engine + den Router-Kern als reine Funktionen, trivial testbar.
- `retro/candidate.ts` — `CandidateKind` += `process-variant` | `process-conformance`; Proposals
  `ProcessVariantProposal` / `ProcessDfgProposal` / `ProcessConformanceProposal`.
- `retro/process.ts` (neu) — `ProcessSignature`, `directlyFollows(variant)`, `jaccard(a,b)`,
  `classifySession(sig, catalog, θ=0.8)`.
- `retro/miners.ts` — `mineDfg`, `mineVariants` (+ `ProcessDiscoveryOptions`), auf `groupByRun`/`hashValue`/`makeCandidate`.
- `index.ts` — exportieren.
- Tests: `retro/process.test.ts` + `miners.test.ts` erweitern (Positiv/Negativ/Schwellwert, id-Idempotenz, classify known/unknown).
- **Akzeptanz:** `pnpm test` grün, typecheck/lint clean, keine Regression.

### Slice 2 — Tabelle + TapeSource
**Ziel:** Events durable in eine Tabelle, lesbar über `ctx.traces`.
- **DB-Substrat entscheiden** (Risiko): sqlite via `better-sqlite3` (neue Dep) **oder** der bestehende `DbService`,
  falls er eine echte Tabelle backt — *zuerst klären*.
- `events`-Tabelle (Schema §4) + `CaptureStore` (Insert idempotent über `id`).
- `TableTapeSource implements TapeSource` (`runIds`/`tape`) über `events`; Zeile → `TapeFrame`.
- In `RunStoreTracesService` wickeln → hinter `ctx.traces` (policy-gegated `traces:read`).
- Tests: Zeile→`TapeFrame`, `TraceQuery`-Filter, end-to-end Miner über geseedete Tabelle.
- **Akzeptanz:** `ctx.traces.collect()` liefert gemappte Frames; Slice-1-Miner laufen drüber.

### Slice 3 — Die 3 Feature-Packs + Policies + CLI
**Ziel:** Logger/Summarizer/Discoverer als lauffähige Features.
- Custom-Nodes: `normalize` (Logger), `process-route` (liest `processes`-Katalog, ruft `classifySession`);
  `RetroMinerName` um `dfg`/`variants` erweitern (`ALL_MINERS` + `retroMinerHandler`-Dispatch).
- `pm.event-log` (normalize→append; `capture-db-write`; **ephemerer In-Memory-Store**, §3.4).
- `pm.session-summary` (stats→llm-label→persist; `traces-read`+`summaries-db-write`+`summary-model`; `summaries`-Tabelle).
- `pm.discover` (route→mine; `traces-read`; liest `processes`-Katalog).
- Built-in registrieren + CLI-ids.
- Tests: je Feature end-to-end; Logger ohne durables Tape; discover mit leerem Katalog → alles unknown → Kandidaten.
- **Akzeptanz:** `elio run pm.discover` über geseedete `events` → Kandidaten; `pm.event-log` schreibt Zeile;
  `pm.session-summary` schreibt Summary.

### Slice 4 — Trigger-Verdrahtung (zuletzt, bewusst gegated)
**Ziel:** der Dogfood-Payoff.
- Hook-Glue: `.claude/settings.json` → `PostToolUse`/`UserPromptSubmit` → `elio run pm.event-log`;
  `SessionEnd` → `pm.session-summary` (`async`).
- Cron/Intervall → `elio run pm.discover`.
- **Aktivierung erst nach Bestätigung** (ändert laufende CC-Config).
- **Akzeptanz:** eine echte CC-Session schreibt Events; ein Intervall-`discover` zeigt die Dev-Prozess-Varianten.

**Offene Entscheidungen während der Umsetzung:** DB-Substrat (Slice 2) · `normalize`/`route` als Custom-Node vs
built-in `transform` (Slice 1/3) · exakter Ephemer-Store-Mechanismus des Loggers (Slice 3).

---

## 9. Offene Fäden / ehrliche Grenzen

- **Activity-Abstraktion ist das ganze Spiel.** `activity = tool_name` ist v0.1-grob (`Bash` zu grob → später
  `Bash(test)` vs `Bash(git)`-Klassifikator). Design-Frage Nr. 1.
- **Redaction am Logger-Boundary.** `tool_input`/`tool_output`/`user_prompt` hashen/redacten, **bevor** die Zeile
  geschrieben wird. Der eigene `redaction-leak-sniffer` wacht.
- **`exit_reason` ≠ Outcome.** `outcome` ist Inferenz (z. B. letztes Test-Ergebnis) — ein `stats`/`label`-Job.
- **Router-Schwelle θ** (Default 0.8) + **Katalog-Persistenz** (`processes`-Tabelle, befüllt via gegatete
  Promotion) — Werte/Form noch zu tunen.
- **Logger-Taping: Vorschlag** ephemerer In-Memory-Store (§3.4) — noch zu bestätigen.
- **Crash-Sicherheit des Summarizers:** feuert `SessionEnd` nicht (Crash), fehlt die Summary → optionaler
  Intervall-Sweep, der un-summarizte Sessions nachzieht (später).
- **Lokal pro Maschine** — Hooks + DB lokal; Cross-Machine braucht eine geteilte DB.
- **Ollama ohne native `session_id`** — Korrelations-Header / Conversation-Continuity / Zeitfenster (Proxy-Slice).

---

## 10. See also

- [docs/elio-learning-engine.md](elio-learning-engine.md) — Retro-Miner, Candidate-Store, `ctx.traces`, Promotion.
- [docs/elio-usage.md](elio-usage.md) — Surfaces, Modell-Profile, `db`/`batch`-Node.
- [docs/elio-v0.1-skeleton.md](elio-v0.1-skeleton.md) — Invarianten, Tape/Checkpoint/Correlation.
