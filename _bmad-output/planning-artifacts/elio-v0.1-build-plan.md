# ELIO v0.1 — Sequenzierter Build-Plan (Walking-Skeleton-Slices)

> Leitet die flache MUST-Liste aus `elio-v0.1-skeleton.md` §8 in **abhängigkeits-geordnete Slices** ab.
> Jede Slice ist ein lauffähiger „Wirbel" mit eigener Definition-of-Done und beweist konkrete Invarianten.
> Prinzip: **Spine zuerst, Governance härten danach, reale Last (Migrate) zuletzt.** Die offene Pack-Format-Entscheidung (§9 #1) wird bis Slice 6 umgangen, damit der Start nicht blockiert ist.

---

## Slice-Übersicht & kritischer Pfad

| # | Slice | Beweist (Inv.) | Deckt MUSTs | Gate / Risiko |
|---|-------|----------------|-------------|----------------|
| **0** | Scaffold & Typen-Skelett | — (unblockt alles) | — | — |
| **1** | Nackter Outer Loop (1. Wirbel) | 1, 5, 6, 10 | #1, #2(triv), #3(transform/validate), #6(record), #11(min), #14(min), #17, #19(ctx-doubles) | — |
| **2** | Suspend / Resume / Elicitation / Approval | 11, 12 | #3(approval), #4, #5, #19(race-tests) | — |
| **3** | Delegierte Intelligenz: Modelle + LLM-Worker | 7, 9, 17(ctx.model) | #3(llm/agent-stub), #9, #10 | — |
| **4** | Governance härten | 13, 14, 15, 20, 21, 23 | #2(voll), #6(scrub), #13, #14(voll), #15, #16 | Sandbox-Tech-Wahl (Worker vs. VM) |
| **5** | Vela-Adapter (Inner Loop) | 3, 8, 17(ctx.agent), 18 | #8 | **Vela-Contract-Check zuerst** |
| **6** | Migrate-Dogfood end-to-end | 1(voll), 4, 22 | #3(file/db), #7, #11(voll), #12, #18, #19(re-derive) | **§9 #1 (Pack-Format) hier entscheiden** |

**Kritischer Pfad:** `0 → 1 → 2 → 4 → 6`. Slice **3** und **5** hängen an 1/2, aber nicht aneinander → **parallelisierbar**, sobald Slice 2 steht.

```
        ┌────────► 3 (Modelle/Worker) ──┐
0 ─► 1 ─► 2 ─┤                            ├─► 6 (Migrate-Dogfood)
        │   └────────► 4 (Governance) ───┤
        └────────────► 5 (Vela) ─────────┘   (5 braucht 3 für ctx.model)
```

---

## Slice 0 — Scaffold & Typen-Skelett
**Ziel:** Ein Monorepo, in das die erste Zeile geschrieben werden kann; §3 als kompilierende Stubs.

- `git init`; pnpm-Workspace; Pakete `@elio/core`, `@elio/sdk` (leer, mit Abhängigkeitsrichtung sdk→core).
- tsconfig strict, vitest, eslint; CI-Skript `pnpm -r typecheck && pnpm -r test`.
- §3-Interfaces 1:1 als Stubs nach `@elio/core` portieren (`Node`, `NodeResult`, `Ctx`, `CorrelationId`, `Artifact`, `Policy`, `RunStore`, `FeaturePack`, `SessionContract` …) — alles `throw new Error("not implemented")`.
- **DoD:** `pnpm -r build` + `typecheck` grün; leerer `vitest run` grün; `@elio/sdk` importiert Typen aus `@elio/core`.

## Slice 1 — Nackter Outer Loop (der erste Wirbel)
**Ziel:** Runner führt einen statischen Graph aus reinen Funktions-Nodes über ein injiziertes `ctx` aus — gegen ein In-Memory-Artefakt, mit Fehler-/Retry-Pfad. **Kein YAML, kein Sandbox, kein Modell.**

- **#1 Runner:** Outer-Loop-Schleife (§4 Schritte 1–10) für `autonomy: static`; `nextEdge(graph)`.
- **Registry (#3 Teil):** `built-in == custom`; `transform`, `validate` als reine Nodes; `validate` liefert `GateVerdict`.
- **#2 Injector (trivial):** baut `ctx` in-process aus einer erlaubten Service-Teilmenge — **noch kein** Sandbox, aber schon `security by absence` (nicht injiziert = nicht da).
- **#11 Artefakt (minimal):** In-Memory `Artifact` + `applyTo`; Eval-Gate als `validate`-Node-Verdikt (§11/#4).
- **#17 Failed + Retry:** `NodeResult.Failed`, `RetryPolicy`, `tryWithRetry` um den Node-Call (§4 Schritt 8/10b).
- **#14 (minimal):** `budget`/`maxDepth` als Pflichtfelder + simple Dekrement-Zähler (Erschöpfung → Elicitation kommt in Slice 4).
- **#6 (record):** Tape hängt `TapeFrame` an (Scrub erst Slice 4).
- **FeaturePack programmatisch** (TS-Objekt), nicht YAML → umgeht §9 #1.
- **Tests (#19):** Ctx-Double; 2-Node-Graph läuft bis `DONE`; Retry-Pfad; Gate-fail vs. -pass.
- **DoD:** Programmatisches Feature `[transform → validate]` läuft end-to-end, Artefakt wächst, Gate entscheidet Exit. **Inv. 1/5/6/10 bewiesen.**

## Slice 2 — Suspend / Resume / Elicitation / Approval
**Ziel:** Der Loop kann anhalten, hochpropagieren und per correlation-id wieder aufsetzen — inkl. menschlichem Approval über die CLI.

- **#4 Suspend/Resume:** `Checkpoint` + `CorrelationId` im `RunStore` (`save/load/resolveElicitation`); zuerst `blocking`, dann `parked` (Checkpoint + Geschwister weiter).
- **#5 Propagierung:** §4 Schritt 11 + §6 — Policy-Interceptor-Stack (innen→außen), `parentState`-Auto-Resolve, Spitze = Mensch.
- **#3 approval-Node** + `ElicitService.raise`.
- **`elio` CLI (dünn):** `elio run`, Approval als CLI-Prompt (= minimale Inbox), `elio resume <correlation-id>`.
- **Tests (#19):** **Race-Test** parallele `parked`-Branches; `blocking`-Resume-Round-Trip; Auto-Resolve durch Policy.
- **DoD:** Feature mit `approval`-Step suspended → CLI fragt → Antwort resumed bis `DONE`; `parked`-Sibling-Test grün. **Inv. 11/12 bewiesen.**

## Slice 3 — Delegierte Intelligenz: Modelle + LLM-Worker
**Ziel:** Erster echter „Denk"-Pfad über `ctx.model`. *(parallel zu Slice 4/5 möglich nach Slice 2)*

- **#10 LLM-Worker:** concurrency-gated Dispatcher pro Provider; Streaming → `RunEvent`s (`cost-delta`, Deltas).
- **#9 Adapter:** `ollama` + `claude` (Anthropic) hinter `ModelService`.
- **#3 `llm`-Node** (one-shot) + `agent`-Node-Skelett (in-process Loop; Vela kommt in Slice 5).
- **Tests (#19):** Model-Adapter-Doubles; Worker-Concurrency-Gate; Cost-Charge.
- **DoD:** Feature mit `llm`-Node ruft ollama/claude durch den Worker, Cost wird verbucht, Events streamen. **Inv. 7/17(ctx.model) bewiesen.**

## Slice 4 — Governance härten
**Ziel:** Aus „DI-Konvention" wird durchgesetzte Sicherheit; Budget/Tiefe/Secrets/Redaction scharf. *(parallel zu Slice 3)*

- **#2 (voll):** Policy-Interceptor-Stack + **tighten-only-Halbordnung** (§11/#15) maschinell prüfbar.
- **#13 Sandbox:** Node-Ausführung in Worker/VM **ohne Ambient Authority**; `ctx` per RPC/Message-Passing (Inv. 20). → Gate: Worker-Threads vs. isolated-vm wählen.
- **#14 (voll):** Budget/Tiefe über jede Grenze dekrementiert; Erschöpfung → `suspend{elicitation}` (§4 Schritt 4a/9b).
- **#15 Secrets:** `SecretsService`, policy-gescopte `SecretRef`-Handles, pluggable Provider (env/Vault), auto-redacted.
- **#16 Tape-Redaction:** roh nur ≤ Datenklasse, darüber Hash/Ref; **#6 Scrub** (zu Step N zurückspulen, Modell tauschen, vorwärts neu rechnen).
- **Tests (#19):** security-by-absence (Node kann nicht-injizierten Service nicht erreichen); tighten-only Property-Tests; Budget-Erschöpfung → Elicitation.
- **DoD:** Eine Node mit entzogener fs-Capability scheitert *durch Abwesenheit* (nicht durch Check); Tape redaktiert vertrauliche Felder; Budget-Erschöpfung eskaliert sauber. **Inv. 13/14/20/21/23 bewiesen.**

## Slice 5 — Vela-Adapter (Inner Loop)
**Ziel:** `agent`-Nodes laufen über Vela als transparente Inner-Loop-Engine. *(braucht Slice 3 für ctx.model)*

- **Task 5.0 (Gate):** Velas echte Session/Resume-API in `/home/leon/workspaces/vela/packages/vela-sdk-ts` inspizieren — **gegen die reale Oberfläche planen, nicht gegen Annahmen.**
- **#8 `@elio/vela-adapter`:** `SessionContract ↔ Vela`-Start/Resume; Velas identity-based Resume → ELIOs correlation-id; `governance: "transparent"` (Vela-Calls fließen durch `ctx.model` → volle Inv. 14).
- **Tests:** Resume-Mapping-Round-Trip; Elicitation aus Vela propagiert durch ELIOs Stack.
- **DoD:** `agent`-Node mit Vela-Backend fährt eine Inner-Loop-Session; deren Elicitation suspended/resumed über ELIO. **Inv. 3/8/17(ctx.agent)/18(transparent) bewiesen.**

## Slice 6 — Migrate-Dogfood end-to-end (reale Last)
**Ziel:** Die erste echte Vertikale fährt alle Mechanismen gleichzeitig — und zwingt die offene Pack-Format-Entscheidung.

- **Task 6.0 (Gate):** §9 #1 entscheiden — **YAML-deklarativ vs. Code-Handler** (Abgleich mit `enterprise-ai-runtime-platform-feature-pack-sdk.md`). Erst danach Loader.
- **#7 YAML-Loader/Compiler** (`@elio/sdk`): `feature.yaml` → typisierte `FeatureDefinition`; `contentHash` + Pack-Pinning (§11/#14).
- **#3 file/db-Nodes:** `source.csv`/`target.db` als **injizierte Adapter-Services**, nicht als Steps.
- **#11 (voll) DataHolder:** `db-state`-Effect-Ledger (Idempotenz), `progress.md`/`sidecar` mit Concurrency-Strategien (§11/#6); `re-derive` round-trip-fähig.
- **#12 Migrate:** sample-first; `propose_mapping`-`agent`-Node (Vela optional); per-record-Subworkflow auf dem Sample.
- **#18 Batch-Node:** Massen-Commit ohne per-record Sandbox/Checkpoint (§11/#11).
- **Tests (#19):** **re-derive Round-Trip** (serialize→re-derive→identisch); Re-Run verarbeitet nur fehlgeschlagene Records.
- **DoD:** `npx elio init` → CSV→DB auf Sample → Fix-und-Rerun via Tape-Scrub → Commit-Gate (approval) → idempotenter Re-Run. **Inv. 1(voll)/4/22 bewiesen.**

---

## Zwei echte Gates (sonst nichts blockierend)

1. **§9 #1 Pack-Format** — entschieden in **Slice 6 (Task 6.0)**. Bis dahin programmatische `FeaturePack`-Objekte → Start nicht blockiert.
2. **Vela-Contract** — geprüft in **Slice 5 (Task 5.0)**. Kann bei Bedarf vorgezogen werden, ohne den kritischen Pfad zu stören.

## Bewusst aufgeschoben (nicht in v0.1-MUST)
`timeout`/`optional`-Suspend · promote-to-eval + `elio eval` · dynamischer Planner-Node · Live-Event-Stream/Studio · `@elio/mcp` (Richtung B) · opake Agents (Claude Code/Copilot, Richtung A) · Azure-Foundry/OpenAI-Adapter · HTTP-Server. → alle SHOULD/COULD aus §8, bauen additiv auf dem Spine auf.
