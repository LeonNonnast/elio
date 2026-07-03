# ELIO v0.2 — Roadmap & Ideen

> Sammelpunkt für die Arbeit nach v0.1 (v0.1-Stand: `docs/elio-v0.1-acceptance.md`). Konsolidiert die
> ursprüngliche `ideas.md` und die geplanten nächsten Bausteine (Claude-Adapter, Studio-Redesign).

## Open-Topics-Katalog (Status)

Der zentrale Backlog der offenen/erledigten Themen — Quelle der Wahrheit für „was steht noch an". Status:
**done** (gebaut + getestet), **in progress**, **deferred** (bewusst später), **declined** (bewusst nicht),
**idea** (Vision, noch nicht geplant). Read-only-Surfacing dieses Katalogs in Studio ist selbst ein
deferred-Eintrag (Studio bleibt vorerst nur Live-Monitoring).

| Thema | Status | Notiz / Begründung |
|---|---|---|
| **Provider-Schicht (`provider:model`, Worker-Routing, Wildcards)** | ✅ done | Phase 1. `LlmWorker` routet kanonische Specs; `ScopedModelService`-Wildcards (`*`, `<provider>:*`). |
| **Azure-OpenAI-Adapter** | ✅ done | Phase 2. `complete()` + SSE `stream()`, OpenAI-kompatibel. |
| **Named Provider Profiles** (`elio.profiles.yaml` + SDK, Secrets-Referenz, Cost-Richtwerte) | ✅ done | Phase 3. Profilname = portabler Routing-Key; Credentials via `SecretsProvider`; `cost: { tier, usdPerMTok? }` statt Pricing-Tabelle. |
| **Persistenter Run-Store** (FileRunStore, cross-process `runs`/`resume`) | ✅ done | Phase 4. `$ELIO_STATE_DIR` / `.elio/runs`. Resume rekonstruiert Kontext aus Checkpoint-Artefakt-Snapshot + persistiertem Input + `<feature>`-Pack. |
| **Budget/Kosten-Enforcement** (`maxCostUsd`, geschätzte Run-Kosten anzeigen/begrenzen) | ✅ done | Harter USD-Deckel auf `RunInput.maxCostUsd`; `BudgetTracker.isOverCostCap()`; der Runner stoppt am Outer-Loop-Kopf HART (gate:stopped, kein Grant-Dialog — anders als `budget`/Tiefe). Reist über Resume mit; CLI-Flag `--max-cost-usd`. Greift bei echten `cost.usd` (Profil mit `usdPerMTok`); Token-only bleibt der Iterations-Bound das Backstop. |
| **DB-basierter Run-Store** (SQLite/Postgres) | ⏳ deferred | FileRunStore zuerst (bewusste Entscheidung). Dockt am selben `RunStore`-Contract an — kein Runner-Umbau nötig. |
| **Cross-process Live-`subscribe()`/SSE** | ⏳ deferred | Aktuell in-process (Studio). Durability für `runs`/`resume` ist abgedeckt; Live-Streaming über Prozessgrenzen ist eigenständig. |
| **Vela suspend/resume** | ✅ done (real-verifiziert) | Genereller Core-Seam: die Resume-Antwort reist über `ctx.resume` → `SessionContract.resume` zur Engine (der Runner setzt sie NUR am wieder-ausgeführten suspendierten Step). Vela-Bridge: **zwei reale Workflow-Formen** — Default = Single-Delegate (resolved in einem Turn); **opt-in `awaitHuman` / Resume = freeform-GATE → DELEGATE mit `depends_on`**, das auf echtem Vela wirklich pausiert (`advance`→`blocked`, Run bleibt ACTIVE geparkt, kein Modell-Call/Cost auf dem Suspend-Turn). Persistenter (turn-übergreifender) Store + resume-stabiler Identity-Key (`run::branch::step`) → `findByIdentity` re-findet den Run; Resume schreibt die Antwort in `stateData` + hüpft `currentStep` via `store.updateStep` → `advance` läuft das Modell einmal, RESOLVED. Voller Roundtrip gegen das faithful Double UND **gegen das echte `vela-sdk`-dist** (guarded Test `ELIO_RUN_REAL_VELA=1` + `ELIO_VELA_SDK_PATH`) bewiesen. `vela-sdk` bleibt Nicht-Dependency (Inv. 2). |
| **Echter Worker/VM-Sandbox** | 🟡 teilweise | Für **Tier-2 generierte Skripte** real: `ctx.scripts`/`WorkerScriptRunner` (worker_threads + node:vm, capability-freier Scope, resourceLimits/Timeout) — siehe Learning-Engine §9.9. Der `NodeSandbox`-Seam für **alle** Nodes bleibt `InProcessSandbox`; OS/seccomp-Isolation weiterhin offen. |
| **`ctx.http`-Enforcement** | ✅ done | `CapabilityRequest.http` = Host-Liste (wie db-Scopes); `ResolvedPolicy.httpHosts`; `tighten()`/`enforceTightenOnly()` schneiden (tighten-only, Inv. 13). Injector wired `ScopedHttpService` mit per-Call Host-Check (defense in depth wie fs), gegated by security-by-absence. SDK-Backend (reales fetch, host-confined) + built-in `http`-Node (fail-by-absence). Unit-Gating, `*`-no-widening, Backend- und vertikaler Deny-e2e-Test. |
| **`@elio/claude-adapter`** (opaker Claude-Agent als `agent`-Node) | ✅ done | Siehe §1. HULL-Mapping/Parse beider realer Transports jetzt OFFLINE getestet (AgentSdk via injizierbarem `loadQuery`-Stub, ClaudeCli via Fake-Bin); echte Live-Calls env-guarded (`ELIO_RUN_REAL_CLAUDE[_CLI]`). SDK ist `optionalDependency` (lazy, nicht hart verdrahtet). |
| **Studio: Provider/Profile-UI** (wählen/konfigurieren) | 🚫 declined | Studio bleibt vorerst NUR read-only Live-Monitoring (explizite Entscheidung). |
| **Studio: read-only Open-Topics/Roadmap-Surface** | 💡 idea | Diesen Katalog später read-only im Dashboard zeigen — passt zum Monitoring-Charakter. |
| **Dynamic Features / Meta-Orchestrierung** | 💡 idea/Vision | Siehe §0 — Outer-Agent injiziert/erzeugt Features zur Laufzeit. |

## 0. Leitidee — Dynamic Features / Meta-Orchestrierung (aus `ideas.md`)

Original-Notiz (verbatim):

> „Folgende Idee, wenn loops ausführbare workflows mit context sind, dann sollten wir einen skill anbieten,
> sodass, wenn ein user über claude oder github copilot oder andere agents dieses nutzt, generisch ein
> feature injecten kann. Dynamic Features. Durch diese Injection, bekommt der outer agent die möglichkeit
> dynamisch elio. Subworkflows können natürlich weiterhin elios sein.
> wenn ein node ein agent ist, kann claude selbständig sein eigenes feature designen."

**Interpretation / Anschluss an die Architektur:**
- Ein **Feature ist ein ausführbarer Workflow mit Kontext** → man kann es zur Laufzeit *injizieren*. Ein Outer-Agent (Claude Code / Copilot / …) ruft ELIO via `@elio/mcp` (**Richtung B**, Inv. 19) und übergibt/erzeugt dynamisch ein Feature-Pack — eine „governte Insel" in der ansonsten opaken Coding-CLI.
- **Dynamic Features**: nicht nur fix registrierte Packs, sondern zur Laufzeit gelieferte/zusammengesetzte. Subworkflows bleiben normale ELIO-Loops (Rekursion).
- **„Claude designt sein eigenes Feature"**: wenn ein `agent`-Node ein echter Claude-Agent ist (siehe §1), kann er innerhalb eines Loops ein *neues* Feature entwerfen → das ist die Brücke `build-feature`/`build-skill` × opaker Agent. B→A→B-Rekursion über die Mensch/Tool-Grenze.
- Konkrete erste Schritte dorthin: das gerade gebaute **`build-skill`**-Feature (Feature → Skill) und ein **feature-author-Skill** (Claude-Code-Skill, der ELIO-Features per Interview erzeugt). Beide zusammen + der Claude-Adapter (§1) ergeben „Claude baut sich sein Werkzeug".

## 1. `@elio/claude-adapter` — opaker Claude-Agent als `agent`-Node (Richtung A)

Macht **Flow 2** real: ein Step IST eine echte Claude-Session (z. B. Brainstorming), deren Ergebnis in den nächsten Step fließt.

- `ClaudeAgentEngine implements AgentEngine`, `id: "claude-code"`, `governance: "opaque"` (Inv. 18) — Struktur + Honesty-Disziplin wie `@elio/vela-adapter`.
- **Austauschbarer Transport** (schmale interne `ClaudeTransport`-Schnittstelle), damit die Auth-Frage entkoppelt ist:
  - **`AgentSdkTransport`** — `@anthropic-ai/claude-agent-sdk` (**Default / bevorzugt**). Credential-Resolution wie Claude Code (API-Key *oder* `ant auth login`-OAuth-Profil).
  - **`ClaudeCliTransport`** — `claude -p` Subprozess (Abo-tauglich, kein API-Key; nutzt die Claude-Code-Session). Fallback per Config-Flag.
  - (später optional) Messages-API-tool-loop.
- `run(contract, ctx)`: SessionContract → Claude-Session (input/prompt + memorySlice) → `SessionResult` (`result | elicitation`). **Hüllen-Governance**: cwd, injizierte Creds/Scopes (über `ctx.secrets`), Task-Prompt, **Budget/Tiefe geerbt** (Inv. 21, nie frisch), Output-Gate. Keine per-Call-Modell-Governance (opak, bewusst).
- **Offline-Tests**: Fake-`ClaudeTransport`-Double (kein Key/kein echter Aufruf) für Contract/Mapping/Budget/Elicitation-Roundtrip; reale Transports guarded.
- Wiring: `routing.agentEngine: "claude-code"` an einem `agent`-Node; `registerClaudeAdapter(runtime)`. Danach `build-skill`s `draft`-Step optional darauf umstellbar (= Flow 2 live).
- **Ehrliche Grenzen** (dokumentieren): `claude -p` ist one-shot → mid-session-Elicitation aus der opaken Session ist begrenzt; Per-Token-Cost bei Abo-Auth nicht sichtbar (Cost ggf. ~0/approx).

## 2. Studio v0.2 — Redesign + neue Views

**Layout:** „Dashboard mit Cards" (gewählt) — eine Seite: Cards für *Active Runs* / *Approvals* / *Features* oben, darunter die **Loop-Timeline** des gewählten Runs.

**Neue Inhalte:**
1. **Feature-Katalog mit Detail** — Liste registrierter Features → Detail = gerenderte `FeatureDefinition`: Graph (Steps+Edges), je Node `type`+Klasse+angeforderte Caps, `policies`, `io`, `evalGate`, `autonomy`. Neuer read-only Endpoint `/api/features`.
2. **Loop deutlicher** — Outer-Loop-Iterationen als Timeline: pro Iteration Step, **Artefakt-Version**, **Gate-Verdikt/Score** (Exit-Bedingung sichtbar), **Budget-Burndown**, Suspend/Resume-Marker. Artefakt im Zentrum + „Warum"-Holder.
3. **Approval-Inbox** aufwerten (Kontext + Antwortformular → Resume).
4. **Tape-Scrubber** ausbauen (Node/Input/Result/injizierte Caps = Audit, Redaction sichtbar).

**Design-System:** clean, einfach, modern, **verspielt**, **wenig Farben** — 1 Akzent + Neutrals/Graustufen, viel Weißraum, runde Cards, weiche Schatten (sparsam), Dark-Mode; system-ui-Sans + Monospace für ids/cost/tape; dezente Micro-Interactions (sanfte Transitions, Puls am aktiven Step). Bleibt **self-contained** (node:http + inline HTML/CSS/JS, kein Framework/CDN). Write weiterhin nur via Elicitation-Resume (Inv. 2).

## 3. Weitere bewusste Deferrals (aus v0.1)

- **Echte Worker/VM-Sandbox** (Inv. 20) — v0.1 = Seam + InProcess.
- **Vela suspend/resume** (multi-step + persistenter Store) — v0.1 = nur resolved-Pfad real.
- **Cross-process CLI-/Run-Store** (file-backed) — v0.1 = prozess-lokal.
- **Dynamischer Planner-Node** (`autonomy: dynamic`) — v0.1 = static/guided.
- **`maxCostUsd` / `http`-Capability** enforced/injiziert.
- **Approval-deny safe-by-default** — v0.1 fixt `build-skill` + `migrate` pro Feature (Edge-Guard `when: "state.answer.approved == true"` + Regressionstest „deny → kein Write"). v0.2: platform-weite Absicherung (Konvention/Lint oder Runner-Support), damit eine Approval→Side-Effect-Edge nicht ungeguarded durchfallen kann.
- **Trigger-Surface** — Cron/Webhook/Event als weitere Clients der Runtime (teilen Policy/Logging/Cost) — die „Trigger"-Hälfte der Loop-Ontologie.
- **Explizites `self_update`/`lifecycle`-Policy-Flag** — steuert, ob ein Feature eigene Pack-Version/Lessons zurückschreiben darf (+ `elio eval`/promote-to-eval, episodic memory, Inv. 15) — die „Self-Update"-Hälfte.

## 4. Reihenfolge

Nach Abschluss von `build-skill` (läuft): **sequenziell** — (1) `@elio/claude-adapter`, dann (2) Studio v0.2 (kann den neuen `claude-code`-Engine dann gleich im Feature-Katalog/Run-Detail mit anzeigen).
