# ELIO v0.1 — Implementierungs-Blueprint (verbindlicher Build-Anker)

> Dieses Dokument ist **autoritativ für alle Build-Agenten**. Es pinnt, was `elio-v0.1-skeleton.md`
> (§3 Typen, §4 Runner-Loop) offenlässt: Datei-Layout, konkrete Klassen/Signaturen, Demo-Features,
> Test-Konventionen, das Quality-Gate und die bewusst aufgeschobenen Entscheidungen.
> **Lies §3 + §4 des Skeletons + dieses Dokument, bevor du Code schreibst.** Bei Konflikt gewinnt das Skeleton (Typen) und §4 (Algorithmus); dieses Dokument konkretisiert sie, widerspricht ihnen nie.

## 0. Ziel-Definition v0.1 (Done = alle vier wahr)

Das v0.1-Ziel ist **„nutzbar über Clients, CLI und MCP-Server, Dashboard einsehbar"**. Konkret abgenommen, wenn:

1. **SDK-Client** (`@elio/sdk`): `run(pack, input)` / `resume(id, answer)` führen ein reales Feature programmatisch end-to-end aus; YAML-Pack-Loader funktioniert.
2. **CLI** (`elio`): `elio run <feature>`, `elio resume <correlation-id>`, `elio runs`, Approval als CLI-Prompt — real ausführbar via `bin`.
3. **MCP-Server** (`@elio/mcp`): stdio-MCP-Server, der Feature-Packs als MCP-Tools exponiert; intern ein `@elio/sdk`-Client.
4. **Dashboard** (`@elio/studio`): lokaler HTTP-Server + einsehbares Dashboard (Run-Status, Loop-Tape, Live-Updates, Approval-Inbox).

Plus **mindestens ein reales Feature** (Migrate CSV→DB, Sample-first) als Dogfood, damit alle Oberflächen etwas Echtes ausführen.

**Hard Quality-Gate (jede Iteration):** `pnpm -r typecheck && pnpm test` grün. Zusätzlich `pnpm lint` (ab Quality-Tick). Pro Oberfläche: Acceptance-Criteria-Test (siehe §8).

## 1. Paket-Abhängigkeitsrichtung (Inv. 2 — niemand greift unter dem SDK durch)

```
@elio/core  ◄──  @elio/sdk  ◄──  { elio (CLI), @elio/mcp, @elio/studio }
                      ▲
                      └── @elio/vela-adapter, @elio/migrate  (registrieren Nodes/Services am SDK)
```

Neue Pakete: `packages/cli` (name `elio`, bin `elio`), `packages/mcp` (`@elio/mcp`), `packages/studio` (`@elio/studio`), `packages/vela-adapter` (`@elio/vela-adapter`), `packages/migrate` (`@elio/migrate`). Jedes: `package.json` (type module, exports, tsconfig mit references auf Dependencies), wird in `tsconfig.json` (root references) + vitest alias (falls importierbar) ergänzt.

## 2. Datei-Layout (Implementierung)

**`@elio/core`** (Typ-Stubs existieren — NICHT die `*.ts`-Typdateien umschreiben, nur Impl-Dateien hinzufügen + `index.ts` erweitern):
```
src/
  common.ts ids.ts                 # ids.ts: newRunId/newCheckpointId (crypto.randomUUID), corrKey(c): string
  elicitation.ts node.ts ctx.ts policy.ts feature.ts session.ts run.ts artifact.ts   # bestehende Typen
  artifact-impl.ts                 # InMemoryArtifact, Holder (MemoryHolder/ProgressMdHolder/DbStateHolder), applyTo(), reDerive()
  registry.ts                      # NodeRegistry: register(def)/resolve(type)/has(type); built-in == custom
  nodes/{transform,validate,approval,router,condition,llm,agent,file,db,batch}.ts + index.ts(registerBuiltins)
  policy-impl.ts                   # resolveRootPolicy(), tighten(parent,req), applyPolicies(), Halbordnungen (§4 unten)
  cost.ts                          # BudgetTracker: charge(cost)/remaining()/depth; CostService-Impl
  injector.ts                      # PolicyInjector implements Injector; NodeSandbox-Seam + InProcessSandbox
  runstore.ts                      # InMemoryRunStore implements RunStore (runs/checkpoints/tape/subscribe/liveStatus)
  runner.ts                        # OuterLoopRunner implements Runner (async generator; §4)
  index.ts                         # alle neuen Werte zusätzlich exportieren
```
**`@elio/sdk`**:
```
src/
  runtime.ts        # createRuntime({models?, store?, policies?}) -> { run, resume, registry, store }; run()/resume() Fassade
  loader.ts         # loadFeaturePack(path|yamlString) -> FeaturePack (YAML, contentHash via sha256)  [ab YAML-Tick]
  demo/{draft-until-good,retry-then-pass}.ts   # programmatische Demo-FeaturePacks
  index.ts index.test.ts
```

## 3. Konkrete Laufzeit-Contracts (das, was §3 offenlässt)

- **Node-Input-Resolution:** `resolveInput(stepRef, branchState)` = `stepRef.with` mit Template-Auflösung `{{state.x}}` → `branchState.x` (rekursiv über Objekte/Strings). **Output-Mapping:** `stepRef.outputs` z.B. `{ rows: "state.sampleRows" }` schreibt `result.output.rows` nach `branchState.sampleRows`; ohne `outputs` wird `result.output` flach in `branchState` gemerged.
- **`branchState`:** mutierbares Objekt, init = `structuredClone(graph.state ?? {})`. Lebt pro Branch.
- **`nextEdge(graph, lastStepId, branchState)`:** Erststep = Step ohne eingehende Edge (oder `steps[0]`). Sonst erste Edge `from===lastStepId`, deren `when` (falls gesetzt) truthy ist. `when`-Eval v0.1: sichere Auswertung gegen `{state}` via kleiner Prädikat-Helfer (kein roher `eval`); ungesetzt = immer true. Keine Folge-Edge → `DONE`.
- **Eval-Gate:** `feature.artifact.evalGate` benennt einen **registrierten Node-Typ** (built-in==custom). Runner ruft ihn pro Outer-Iteration mit `{artifact}` auf und liest `Resolved<GateVerdict>`. `passed:true` → `run-completed{gate:"passed"}` & break.
- **Outer-Loop (§4) konkret:** `run()` ist ein `async function*` der `RunEvent`s yieldet. Pro Iteration: nächsten Step holen (statischer Graph; `dynamic` erst SHOULD) → `Injector.buildCtx(node, resolvedPolicy, corr, artifact)` → `tryWithRetry(node, input, ctx)` → Tape append → `budget.charge(cost)` & depth → bei `resolved`: state mergen + `applyTo(artifact)` + `artifact-updated` event; bei `failed`: RetryPolicy (`escalate`→Elicitation / `fail`→Dead-Letter); bei `suspended`: Checkpoint + propagate (Slice 2). Nach jedem resolved Step: Gate prüfen. Budget/Tiefe erschöpft → Slice 1: `run-completed{gate:"stopped"}`; Slice 4: `suspend{elicitation}`.
- **`tryWithRetry`:** ruft `node.handler`; fängt throw → `Failed{retryable:true}`; respektiert `node.retry` (default `{maxAttempts:1,onExhausted:"fail"}`); Backoff `none|fixed|exponential` via `baseDelayMs`.
- **Sandbox-Seam (Inv. 20):** `interface NodeSandbox { run(node, input, ctx): Promise<NodeResult> }`. v0.1 Default = `InProcessSandbox` (ruft Handler direkt; Sicherheit kommt aus *security by absence* — der Injector hängt nur erlaubte Services an `ctx`). **Worker/VM-Isolation ist bewusst v0.2** (siehe §7). Der Seam ist da, damit ein Worker-Impl ohne Runner-Änderung eindockt.

## 4. Policy / tighten-only Halbordnungen (Inv. 13/14, §11/#15) — maschinell prüfbar

`tighten(parent, req)` darf NUR verschärfen. Achsen:
- `dataClassification`: `public(0) < internal(1) < confidential(2) < private(3) < regulated(4)` — resolved = `max`(restriktiver gewinnt). Policy kann nur RAISEn.
- `suspendMode`: `optional ⊑ timeout ⊑ parked ⊑ blocking` — resolved = `max` (mehr Oversight = tighter).
- `allowedModels` / `toolPermissions` / `dbScopes`: **Mengen-Schnitt** (`req ∩ parent`), nie Substitution/Hinzufügen.
- `allowCloud`: `parent.allowCloud && (req.cloud ?? false)`.
- `fsPaths.read/write`: gewünschte Pfade ∩ erlaubte Präfixe.
- `maxCostUsd`: `min(parent, req/policy)`.
- **security by absence:** `ctx.model` nur wenn `allowedModels` nichtleer & ModelService vorhanden; `ctx.fs` nur wenn `fsPaths` nichtleer (scoped); `ctx.db` nur bei `dbScopes`; etc. Was nicht resolved → nicht an `ctx`. **Kein** runtime permission-check.
- Property-Test (Slice 4): `tighten` ist idempotent & monoton restriktiv; eine Policy kann nie eine nicht-angeforderte Capability hinzufügen.

## 5. Built-in Nodes (Inv. 6/7 — built-in == custom)

Slice 1: `transform` (reine Daten-Transformation aus `with`), `validate` (prüft Input gegen JSON-Schema/Prädikat → `Resolved<GateVerdict>`). Slice 2: `approval` (`ctx.elicit.raise` → Suspended, mode aus `stepRef.suspend`). Slice 3: `llm` (one-shot über `ctx.model`), `agent` (in-process Multi-Turn; Vela ab Slice 5). Slice 4/6: `router`/`condition` (deterministische Verzweigung), `file` (read/write über `ctx.fs`), `db` (über `ctx.db`), `batch` (Massen-I/O ohne per-record Checkpoint/Sandbox, §11/#11). Jede Node ist eine reine Funktion `(input, ctx) => Promise<NodeResult>`.

## 6. Modelle (Slice 3, Inv. 17)

`ModelService`-Impls: **`MockModel`** (deterministisch, immer verfügbar — Default für Tests + Offline-Demo), `OllamaModel` (HTTP `localhost:11434`), `ClaudeModel` (Anthropic; **vor dem Schreiben des Adapters den `claude-api`-Skill lesen** für aktuelle Model-IDs/SDK — Default-Modell `claude-opus-4-8`). **LLM-Worker:** concurrency-gated Dispatcher pro Provider (`p-limit`-artig, selbst gebaut), Streaming → `RunEvent`s (`cost-delta`). `ctx.model` zeigt auf den Worker, nie direkt auf einen Adapter. Routing via `routing.models` / `ResolvedPolicy.allowedModels`.

## 7. Bewusst aufgeschobene Entscheidungen (dokumentiert, nicht vergessen)

- **Worker/VM-Sandbox (Inv. 20, MUST):** v0.1 nur Seam + `InProcessSandbox`; *security by absence* via Injector bleibt voll wirksam. Worker-Thread-Impl = v0.2. **Grund:** Ziel (nutzbare Oberflächen + Dashboard) hängt nicht an OS-Isolation; voll-RPC-Sandboxing jeder Node ist hohes Risiko/Aufwand.
- **Pack-Format (§9 #1):** v0.1 **hybrid** — programmatische `FeaturePack`-Objekte *und* YAML-Loader; Custom-Logik in registrierten Code-Nodes. Reicht für CLI/MCP-Feature-Discovery.
- **Vela-Adapter (Slice 5):** Best-effort gegen Velas reale API (`/home/leon/workspaces/vela/packages/vela-sdk-ts` zuerst inspizieren). `agent`-Node hat in-process Fallback, falls Vela-Contract nicht v0.1-fertig.
- **Out für v0.1:** opake Agents (Claude Code/Copilot), HTTP-Server `@elio/server`, Azure/OpenAI-Adapter, dynamischer Planner, Pack-Registry, `timeout`/`optional`-Suspend (nur `blocking`+`parked`).

## 8. Test- & Acceptance-Konventionen

- **vitest**, colocated `*.test.ts` neben der Impl. Tests laufen gegen **Source** (vitest-Alias), kein Build nötig.
- **Pflicht-Tests Kern:** 2-Node-Graph läuft bis `DONE`; Retry-Pfad (fail→retry→resolved); Gate fail vs. pass; Budget-Dekrement; `re-derive` Round-Trip (serialize→re-derive→identisch); **Race-Test** parallele `parked`-Branches (Slice 2); Injector security-by-absence (Node kann nicht-injizierten Service nicht erreichen, Slice 4); `tighten`-Property-Tests (Slice 4).
- **Acceptance-Criteria (AC) je Oberfläche** als ausführbarer Test/Smoke:
  - SDK: programmatischer `run()` eines Demo-Packs erreicht `run-completed{gate:"passed"}`.
  - CLI: `elio run demo.draft-until-good` exit 0 + erwartete stdout; `elio runs` listet den Run.
  - MCP: Server startet, `tools/list` enthält das Feature, `tools/call` führt es aus (In-Memory-Client-Test gegen den Server-Handler).
  - Studio: HTTP-GET `/` liefert Dashboard-HTML; `/api/runs` liefert JSON-Status; ein laufender/abgeschlossener Run ist sichtbar.
- Jeder Build-Agent MUSS sein Paket grün machen (`pnpm -r typecheck && pnpm test`) **bevor** er zurückmeldet, und im Report `filesChanged`, `testsAdded`, `gate: pass|fail`, `deviations` liefern.

## 9. Tooling / Lint

Quality-Tick fügt eslint (flat config, `typescript-eslint`) + root-Script `"lint": "eslint ."` hinzu, damit CLAUDE.md-Gate `npm test && npm run lint` erfüllt ist. Bis dahin ist `tsc -b` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) das harte Typ-Gate. **Keine** unnötigen Runtime-Deps; bevorzugt Node-Builtins (`crypto`, `node:http`, `node:fs`). Erlaubte neue Deps: `@modelcontextprotocol/sdk` (MCP), `yaml` (Loader), ggf. `commander` (CLI) — sonst hand-rolled.
