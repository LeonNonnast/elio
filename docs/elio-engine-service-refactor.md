# ELIO — Engine-Service-Refactoring

**Status:** ✅ UMGESETZT (Phasen 0–5) · **Datum:** 2026-06-28/29 · **Motivation:** CLI/MCP/Studio
sollen echte dünne UI-Layer sein (Inv. 2). Sie hielten dreifach dieselbe Host-Logik, und der
Run-Store wirkte UI-gebunden, obwohl er konzeptionell der Engine gehört.

## Umsetzungsstand

Alle Phasen 0–4 sind implementiert; voller Typecheck + 693 Tests (90 Dateien) grün, inkl. des
echten Built-Bin-Smoke-Tests (spawnt cli/mcp/studio dist). Ergebnis:

- **`@elio/engine`** ist die neue zentrale Schicht: `FeatureProvider` + `FeatureCatalog`
  (`defaultCatalog`) + `EngineService` mit zwei Implementierungen `LocalEngine` (in-process) und
  `EngineClient` (HTTP/SSE gegen `createEngineHost`). Governance (`yamlRootPolicy`), Provider-Profil-
  Auflösung, Pack-Adressierung, Run/Resume-Lifecycle + Katalog-Projektion (klass/requests) liegen jetzt
  hier — an EINER Stelle.
- **CLI**: `features.ts` gelöscht; treibt nur noch einen `EngineService`. Deps `@elio/migrate`/
  `@elio/skill-builder` entfernt. Neu: `elio serve` (Host) + `--engine-url`/`$ELIO_ENGINE_URL` (Client).
- **MCP**: `registry.ts` auf reine MCP-Übersetzung reduziert (Katalog kommt aus `@elio/engine`).
- **Studio**: `createStudioRuntime` + alle `register*`-Internal-Zugriffe entfernt; Server ist ein dünner
  Client über `EngineService`; Katalog-Projektion kommt zentral aus der Engine.
- **Phase 0**: `createRuntime` reicht die `FeatureRegistry` durch; `FeaturePack.metadata.sourcePath`
  wird beim Laden gesetzt (nach dem contentHash, also hash-neutral).

**Phase 5** (Studio-UI-Rework, umgesetzt): Feature-Katalog zeigt jetzt **wo die Datei liegt**
(`sourcePath` bzw. „built-in (SDK)") + die Nodes darunter; neues **Notifications-Panel** („what needs
you" aus suspendierten Runs + Live-Aktivität über SSE); **CLI-Resume-Brücke** in der Approval-Inbox
(copy-paste `elio resume <corr> yes --engine-url <origin>`) — Studio bleibt read-mostly, Schreiben geht
über die CLI. Der statische Preview-Snapshot (`preview/dashboard-preview.html`) ist mitregeneriert.

---

## 1. Problem (durch Audit belegt)

Die Verantwortung **„Feature → verdrahtete Runtime → Run/Resume → Stream"** existiert
**nirgends zentral**. Sie ist dreifach dupliziert und die Schicht darunter folgt keinem Schema.

### 1.1 Dreifache Duplikation derselben Verantwortung

| Verantwortung | cli | mcp | studio |
|---|---|---|---|
| Feature-Auflösung (id → Runtime+Pack) | `features.ts:107-283` | `registry.ts:122-189` | `runtime.ts:92-138` (von Hand) |
| Provider-Profile auflösen | `features.ts:203-209` | `registry.ts:58-84` | — (mock fix) |
| run/resume-Stream konsumieren | `commands.ts:140-272` | `server.ts:199-252` | `runtime.ts` seed* + `server.ts:385-391` |
| CSV-/Brief-Sample-Konstanten | `features.ts:71-75` | `registry.ts:87-114` | `runtime.ts:47-60` |
| Feature-Katalog (Liste der Packs) | if-Kette | `registry.ts:123-187` | `runtime.ts:85-87` |

Jede Datei trägt den Kommentar *„dünner Client, KEINE Engine-Logik"* — keiner hält sich
dran, weil es **kein zentrales Ziel** gibt, an das man andocken könnte.

### 1.2 Konkrete Schicht-Verstöße (Priorität)

1. **Governance im UI** — `yamlRootPolicy` inkl. `allowCloud` in `cli/features.ts:211-223`.
   Eine Sicherheitsentscheidung im Client. **Dringend.**
2. **Studio umgeht die Fassaden** — greift auf `register*`-Internals + hand-gebaute
   `ResolvedPolicy`/`ArtifactType` zu (`studio/runtime.ts:30-44, 101-129`). Tiefste Kopplung.
3. **Hartkodierte Run-Parameter** im Client — `budget:1000, maxDepth:200` (`commands.ts:91-95`).
4. **Direkter Store-Zugriff** aus der CLI — `runtime.store.liveStatus()` (`commands.ts:283`).

### 1.3 Die `setup*`-Fassaden folgen keinem Schema

| Fassade | Rückgabe | Abweichung |
|---|---|---|
| `setupMigrate` | `{runtime, pack, source, target, failCommitIds}` | gegen Runtime registriert; eigene Policy-Reg |
| `setupSkillBuilder` | `{runtime, pack, outDir}` | wirft ohne `outDir` |
| `setupProcessMining` | `{runtime}` | **kein pack**; gegen `registry` registriert |
| `setupEventLog` | `{runtime, captureStore}` | **kein pack**; ephemerer Store; kein Modell |
| `setupSessionSummary` | `{runtime, summaryStore}` | **kein pack**; ephemerer Store |

→ 5 Rückgabe-Formen, 3 ohne `pack`. Agent-Engines (claude/vela) sind eine **orthogonale
Achse** (adaptieren `ctx.agent`, geben kein `{runtime,pack}`).

### 1.4 Strukturelle Lücken in der Engine

- **`createRuntime` reicht die `FeatureRegistry` nicht durch** (`runtime.ts:36-112`) → kein
  zentraler Katalog; `start`/`resume` brauchen das volle `FeaturePack` als Argument.
- **`subscribe()`/Live ist per Design in-process** (`runstore.ts:68-69`,
  `runstore-fs.ts:11-14`). Cross-Process-Live braucht *einen* ausführenden Host-Prozess.
- **Resume nach Prozess-Neustart braucht das `pack` mitgeliefert** (`runner.ts:502-509`).

---

## 2. Zielbild

Eine neue Schicht **`@elio/engine`** besitzt zentral: Feature-Katalog, Runtime-Bau,
Governance/Policy, Provider-Profil-Auflösung und den Run/Resume/Stream-Lebenszyklus. Sie
exponiert ein **`EngineService`-Interface** mit zwei Implementierungen:

- **`LocalEngine`** — direkte In-Process-Aufrufe (CLI-One-Shots, Tests, Einbettung).
- **`EngineClient`** — derselbe Vertrag über HTTP/SSE gegen einen dauerlaufenden **`EngineHost`**
  (Studio-Live + Cross-Process-CLI/MCP).

```
@elio/core      types, runner, stores, registries            (Engine-Internas, unverändert)
@elio/sdk       createRuntime + setup*-Primitive             (Wiring-Bausteine, bleiben)
@elio/engine    EngineService (Interface)                    ← NEU
                FeatureProvider-Registry (1 Katalog)
                LocalEngine   (Katalog + Governance + Lifecycle)
                EngineHost    (HTTP/SSE-Server)
                EngineClient  (HTTP/SSE-Client, impl. EngineService)
@elio/cli       arg-parse + format + treibt EngineService    (dünn — features.ts entfällt)
@elio/mcp       MCP-Protokoll ↔ EngineService                (dünn — registry.ts entfällt)
@elio/studio    Dashboard ↔ EngineService                    (dünn — runtime.ts entfällt)
migrate/skill   werden FeatureProvider                       (ein Schema)
pm.*-setups     werden FeatureProvider (bekommen pack)       (ein Schema)
claude/vela     bleiben EngineAdapter (orthogonale Achse)
```

### 2.1 Kern-Contracts

```ts
// Vereinheitlicht die setup*-Fassaden (behebt §1.3):
interface FeatureProvider {
  readonly id: string;
  readonly pack: FeaturePack;                 // statisch bekannt → Katalog ohne setup()
  readonly capabilities: FeatureCapabilities; // {db, fs:'read'|'write'|'none', traces, model, ephemeralStore}
  setup(ctx: FeatureSetupContext): FeatureSetupResult; // einheitliche Signatur
}
interface FeatureSetupResult { runtime: Runtime; pack: FeaturePack; handles?: Record<string, unknown>; }

// Die RPC-Oberfläche (aus Audit 1). (S) = streaming.
interface EngineService {
  listFeatures(): Promise<FeatureDescriptor[]>;            // ersetzt 3 Kataloge
  startRun(featureId: string, input: RunInput): AsyncIterable<RunEvent>;   // (S)
  resumeRun(id: CorrelationId, answer: unknown, opts?: { expectedPackVersion?: string }): AsyncIterable<RunEvent>; // (S)
  liveStatus(): Promise<RunStatus[]>;
  tape(runId: string): AsyncIterable<TapeFrame>;
  subscribe(filter?: { run?: string }): AsyncIterable<RunEvent>;           // (S)
}
```

Governance, Provider-Profile, `budget/maxDepth`-Defaults und die Pack-Auflösung leben
**hinter** `EngineService` (in `LocalEngine`), nicht mehr im Client.

### 2.2 Wie das die Live-Frage löst

Der **`EngineHost` ist der eine Prozess, der Runs ausführt.** `elio run` gegen einen Remote-Host
→ der Host führt aus, streamt Events über SSE zurück, und `subscribe()` desselben Hosts speist
Studio live — inklusive der per CLI gestarteten Runs. Damit ist „welche Features laufen gerade"
endlich echt (nicht der Schnappschuss eines geteilten FileRunStore).

---

## 3. Phasen

Jede Phase ist eigenständig grün lieferbar.

**Phase 0 — Fundamente (kein Verhaltenswechsel)**
- `FeatureRegistry` durch `createRuntime` durchreichen (Lücke §1.4).
- `sourcePath` an `FeaturePack.metadata` beim Laden mitführen (für „wo liegt die Datei").

**Phase 1 — Provider vereinheitlichen**
- `FeatureProvider`/`FeatureSetupContext`/`Result` in `@elio/engine` definieren.
- Jede bestehende `setup*` als `FeatureProvider` **umhüllen** (kein Rewrite der Internas);
  alle geben jetzt `pack` zurück. Zentralen `FeatureCatalog` bauen → ersetzt die 3 Kataloge.

**Phase 2 — `LocalEngine`**
- `EngineService` als `LocalEngine` implementieren: Katalog + zentrale Governance
  (`yamlRootPolicy` → hierher) + Profil-Auflösung + Lifecycle. Das ist `features.ts` +
  `registry.ts` + `studio/runtime.ts` an *einem* Ort.

**Phase 3 — Die drei Surfaces auf `LocalEngine` umleiten (in-process)**
- CLI: `features.ts` löschen, `LocalEngine` treiben; deps `@elio/migrate`/`@elio/skill-builder` raus.
- MCP: `registry.ts` löschen, `LocalEngine` treiben.
- Studio: `createStudioRuntime`/`studioFeaturePacks`/`seed*` löschen; nicht mehr in `register*`-Internals greifen.
- **Ergebnis: null Duplikation, Governance zentral, alles grün — noch ohne Transport.**

**Phase 4 — Remote-Engine (der Live-Payoff)**
- `EngineHost` (HTTP/SSE, Verallgemeinerung des Studio-Servers) + `EngineClient` (impl. `EngineService`).
- `elio serve` startet den Host. CLI/MCP/Studio zielen per Flag/Env auf einen Remote-Host,
  Fallback `LocalEngine`. Studio am Host → echtes Live, auch für CLI-Runs.

**Phase 5 — Studio-UI-Rework (der ursprüngliche Wunsch)**
- Jetzt mit echten Daten: Feature-Katalog mit Dateipfad + Nodes, laufende Features live,
  Notifikationen, CLI-Resume-Brücke (fertiges `elio resume …`-Kommando zum Kopieren).

**Meilensteine:** 0–3 = Dedup + Governance-Fix (geringes Risiko, kein neuer Transport).
4 = Cross-Process-Live. 5 = UI.
