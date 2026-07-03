# ELIO — Learning / Optimization Engine (Retro-Miner)

> **These (ein Absatz):** Das **Loop Tape ist schon der Trainingsdatensatz** (Inv. 15). Eine Learning-Engine
> ist deshalb kein neuer Mechanismus, sondern ein **eigenes Feature**, das die Tapes vergangener Runs liest,
> Determinismus/Muster entdeckt und **Kandidaten** vorschlägt: deterministische Stellen, die heute über ein
> LLM laufen, künftig über ein Skript zu lösen — oder Policies/Graphen zu verschärfen. Der heiße Pfad wird
> **nie** angefasst: Miner sind read-only Analysatoren (`traces:read`), und die einzige mutierende Aktion
> (neue Pack-Version) ist ein entkoppeltes, menschlich gegatetes `promote-candidate`-Feature
> (`featureStore:write`). Weil „built-in == custom" gilt (Inv. 6), ist jeder Miner eine normale Node-Komposition,
> und ein gelerntes Skript ist eine normale Node. Die Engine ist damit ELIO, das ELIO optimiert.

Anschluss: konkretisiert den Roadmap-Deferral „`self_update`/`lifecycle`-Policy-Flag" (`docs/elio-v0.2-roadmap.md` §3)
und die Leitidee Meta-Orchestrierung (§0). Baut auf den Invarianten des Skeletons (`docs/elio-v0.1-skeleton.md` §1).

---

## 1. Das Substrat — warum ELIO das „schon kann"

Drei vorhandene Bausteine machen die Engine billig:

1. **Das Tape ist der Datensatz.** Jeder Schritt wird als `TapeFrame { correlation, nodeType, input, result, injected, redaction, ts }` persistiert (`run.ts`/`runstore.ts`). Input + Output + Kosten + Confidence pro Schritt — schon strukturiert. `result` ist `Resolved {output, confidence, cost}` | `Suspended {elicitation}` | `Failed {retryable, attempts}`.
2. **`built-in == custom` (Inv. 6).** Ein gelerntes Skript registriert sich im `NodeRegistry` wie jede Node. Die Engine schleust nichts ein — sie *registriert* und schreibt den Graphen um.
3. **`klass` ist die Zielmetrik (Inv. 7).** `"intelligence"` (LLM, teuer, nichtdeterministisch) → `"orchestration"` (deterministisch, ~gratis). Das Ziel formuliert sich präzise als Klassen-Verschiebung einzelner Call-Sites.

**Call-Site-Key** = `(feature.id@version, step.id, nodeType)`. Direkt aus `TapeFrame.correlation` (`{run, branch, step, checkpoint}`) + `nodeType` ableitbar.

---

## 2. Versionierung — erzwungen, nicht optional

Sobald ein Kandidat den **Graphen** ändert (LLM-Step → `router` + Skript + Fallback), ändert sich der `contentHash`
per Definition. `Checkpoint.packVersion` pinnt den contentHash; Resume rehydriert gegen **diese** Version. Ein
suspendierter In-Flight-Run **muss** gegen den alten Graphen weiterlaufen → man *kann* ein Pack nicht in-place
mutieren, ohne laufende Resumes zu brechen.

Versionierung fällt damit aus dem Resume-Invariant (Inv. 12) und gibt das richtige Rollout gratis:

- In-Flight-Checkpoints laufen auf `v_n` zu Ende (gepinnt).
- Neue Runs starten auf `v_{n+1}`.
- Rollback = Traffic zurück auf `v_n`. Canary = Traffic-Split.

| Weg | contentHash | Versionierung | Wann |
|---|---|---|---|
| **A — transparenter Node-Cache** | stabil | nein | nur Tier-0-Memo, Provenance egal |
| **B — Graph-Rewrite (Router+Fallback)** | neu | ja (erzwungen) | **Default** — auditierbar, pinbar, rollbackbar |

**Entscheidung: Weg B.** Tier-0-Cache (Weg A) nur als bewusster Sonderfall.

---

## 3. Architektur — Retro-Orchestrator + Subworkflows

Ein einziges Feature wird angebunden; „Fähigkeiten dazulernen" = ein weiteres Retro-Pack registrieren. Der
Orchestrator-Graph fächert über eine **Registry (Daten)** auf, nicht über fest verdrahtete Steps — dadurch
bleibt sein `contentHash` stabil, egal wie viele Retros dazukommen.

```ts
// feature: retro.orchestrator   — einmal anbinden, dann nur Retros registrieren
const retroOrchestrator: FeatureDefinition = {
  autonomy: "guided",
  artifact: { kind: "retro-report", evalGate: "all-retros-complete" },
  policies: ["traces:read"],                       // KEINE Mutation hier
  io: { input: /* { target: "feature@v", scope?, window? } */, output: /* aggregierter Report */ },
  graph: {
    steps: [
      { id: "discover", type: "list-retros",       // tag-basiert, KEIN Hardcoding
        with: { tag: "retro", scope: "{{payload.scope}}" },
        outputs: { retros: "state.retros" } },
      { id: "run", type: "batch",                  // Fan-out: jede Retro als subworkflow (Inv. 8)
        with: { over: "{{state.retros}}", run: "subworkflow",
                input: { target: "{{payload.target}}", window: "{{payload.window}}" } },
        outputs: { reports: "state.reports" } },
      { id: "aggregate", type: "transform",
        with: { reports: "{{state.reports}}" },
        outputs: { summary: "artifact" } },
    ],
    edges: [/* discover → run → aggregate */],
  },
};
```

Jede Retro läuft als `subworkflow` mit **geerbtem Restbudget/Tiefe** (Inv. 21, `childDepth = depth+1`) — ein
Retro-Run kann nicht weglaufen. Der Orchestrator-Run wird selbst getaped → ein späterer Run kann die
Retro-Runs mitanalysieren (`retro-of-retros`, der Loop schließt sich).

```
retro.orchestrator
  └─ batch(subworkflow) ──► determinism-miner    (Anker, §6 unten / siehe auch frühere Skizze)
                          ├► elicitation-eliminator
                          ├► over-grant-detector
                          ├► redaction-leak-sniffer
                          ├► flaky-retry-miner
                          ├► dead-step-pruner
                          ├► fail-fast-reorder
                          ├► loop-bound-miner
                          └► model-right-sizing
```

---

## 4. Trennung: read-only Retro vs. mutierende Promotion

**Retros sind reine Analysatoren.** Sie lesen Tapes (`traces:read`) und schreiben **Kandidaten** in einen
Candidate-Store. Sie mutieren **nie** ein Feature/Policy → deckt „nicht am heißen Pfad anfassen" ab und macht
den ganzen Loop schedulebar/harmlos.

**Promotion ist entkoppelt + menschlich gegated.** Die gefährliche Schreiboperation (neue Pack-Version,
Policy-Tighten) ist ein separates `promote-candidate`-Feature mit `featureStore:write` (= der Roadmap-Deferral
`self_update`/`lifecycle`).

```
<retro> (read-only):   collect → analyze → (synthesize) → (shadow-eval) → write-candidate → Candidate-Store
promote-candidate:     load-candidate → approval(blocking) → emit/apply  → v_{n+1} | tightened policy
```

Ein `approval` im Fan-out wäre fatal (blockiert Geschwister) — deshalb gehört es **nicht** in die Retro,
sondern in die entkoppelte Promotion.

---

## 5. Candidate-Store — eine Schnittstelle, mehrere Kandidaten-Sorten

Die Retros schlagen unterschiedliche Dinge vor; der Store muss alle tragen. Gemeinsamer Rahmen
(Provenance ist Pflicht — jede Aussage ist an die Tape-Slice + den `contentHash` gebunden, aus dem sie stammt):

```ts
interface PromotionCandidate {
  id: string;
  source: string;                 // welche Retro
  callSite?: { feature: string; step: string; nodeType: string };
  kind: "node-replacement"        // Skript ersetzt/ergänzt eine intelligence-Node (→ Graph-Rewrite)
      | "node-config"             // Node-Parameter ändern (Modell, RetryPolicy, maxTurns)
      | "graph-edit"              // Step entfernen / Reihenfolge / Edge tighten
      | "policy-tighten"          // engerer CapabilityRequest / Interceptor / Default (Inv. 13)
      | "alert";                  // kein Vorschlag, sondern Incident (z. B. PII-Leak)
  support: number;                // # Beobachtungen, auf denen die Aussage beruht
  evidence: { runs: string[]; window: { since?: string; until?: string } };  // Provenance
  estImpact: { usd?: number; tokens?: number; latencyMs?: number; toilReduced?: number };
  verdict?: GateVerdict;          // aus shadow-eval (falls die Retro eines fährt)
  proposal: unknown;              // sorten-spezifisch (Skript-Source, Policy-Diff, Graph-Diff …)
}
```

---

## 6. Retro-Katalog

Template je Retro: **Signal** (Tape-Felder/Events) · **Erkennung** · **Kandidat** (Sorte) · **Invariante**.
Anker bleibt der `determinism-miner` (Skript ersetzt LLM, `node-replacement`); die folgenden acht sind die
nächsten vielversprechenden.

### 6.1 `elicitation-eliminator` — gelernte Autonomie

- **Signal:** `RunEvent` `elicitation-resolved {by: "policy" | "parent" | "human"}` + die zugehörige `Elicitation` (`what`, `schema`) + die hinterlegte Antwort im Run Store.
- **Erkennung:** Gruppiere Elicitations nach `(feature, step, what-Schema)`. Finde (a) Asks, die ein Mensch **immer identisch** beantwortet (Antwort-Entropie ≈ 0 bei hohem Support); (b) Asks, die eine Policy `intercept` ohnehin schon auto-resolved (`by:"policy"`-Anteil → 100 %) und damit redundant sind.
- **Kandidat (`policy-tighten`):** einen Policy-Interceptor oder `default`/`optional`-Suspend-Mode vorschlagen, der die Frage automatisch beantwortet — der Mensch wird aus der Schleife genommen.
- **Invariante:** treibt den **Autonomie-Dial (Inv. 9)** `guided → dynamic` aus Daten statt von Hand; nutzt Inv. 11/12 (Elicitation/Interceptor).

### 6.2 `over-grant-detector` — gelebte Least-Privilege

- **Signal:** `NodeDefinition.requests` (`CapabilityRequest`) vs. `TapeFrame.injected: string[]` (was tatsächlich gescopt verfügbar war) + welche Services im Verlauf *konsequent* waren.
- **Erkennung:** Pro Node: angeforderte Capabilities, die über alle Runs hinweg **nie ausgeübt** wurden (z. B. `fs.write` angefragt, nie geschrieben; `models:["*"]`, aber nur ein Modell je genutzt).
- **Kandidat (`policy-tighten`):** engeren `CapabilityRequest` / engere Modell-Whitelist vorschlagen.
- **Invariante:** direkter Security-Win; füttert **tighten-only (Inv. 13/14)** und „security by absence" mit echten Daten statt Bauchgefühl.

### 6.3 `redaction-leak-sniffer` — Compliance-Wächter & Effizienz zugleich

- **Signal:** `TapeFrame.redaction {level, redactedFields}` vs. der tatsächliche `input`/`result`-Inhalt + die deklarierte `dataClassification` (`ResolvedPolicy`).
- **Erkennung:** (a) **Leak:** Felder, die wie sensible Daten aussehen (PII-Heuristik/Klassifikator), aber unter zu *niedriger* Klasse ungeredacted im Tape liegen. (b) **Über-strikt:** Felder, die geredacted werden, aber downstream nie gebraucht/gelesen werden.
- **Kandidat:** (a) `alert` (Incident, eskaliert sofort — kein stiller Vorschlag); (b) `policy-tighten` mit *niedrigerer* Klasse (lockern bis Hard-Cap `≤ internal`, Inv. 23) bzw. höherer Klasse beim Leak.
- **Invariante:** Inv. 23 (Plattform meldet an der Grenze, Policy verschärft) + Inv. 13.

### 6.4 `flaky-retry-miner` — getunte Resilienz

- **Signal:** `Failed {retryable, attempts}` in `TapeFrame.result` + die `RetryPolicy` der Node. (Exakt das `retry-then-pass`-Demo-Signal.)
- **Erkennung:** Nodes mit häufigem **fail-then-succeed** (succeed bei `attempts > 1`). Verteilung der nötigen Attempts; Cluster der `error.code`/`message`. Unterscheide *transiente* Flakiness (Retry hilft) von *systematischem* Fehler (Retry hilft nie → escalate/Dead-Letter dominiert).
- **Kandidat (`node-config`):** getunte `RetryPolicy` (`maxAttempts`, `backoff: "exponential"`, `baseDelayMs`); bei systematischem Fehler stattdessen `alert` (z. B. flaky http-Dependency) oder ein deterministischer Precondition-Guard.
- **Invariante:** Failed-Pfad / RetryPolicy (§11/#7, Inv. 10).

### 6.5 `dead-step-pruner` — Graph-Hygiene

- **Signal:** `TapeFrame.result.output` pro Step vs. nachfolgende `artifact-updated`-Events / welche `state.*`/`outputs`-Felder downstream je gelesen werden (Edges des Graphen).
- **Erkennung:** Steps, deren Output **keine** Downstream-Edge speist und das Artefakt nie ändert — toter Code im Graphen. (Achtung: Steps mit reinem Seiteneffekt/Gate-Funktion ausnehmen — `validate`/`approval` „produzieren" bewusst wenig Output.)
- **Kandidat (`graph-edit`):** Step entfernen → kürzerer Graph, weniger Kosten/Latenz, neue Version.
- **Invariante:** Kosten/Tiefe (Inv. 21); kürzt den Loop ohne Verhaltensänderung.

### 6.6 `fail-fast-reorder` — billige Gates nach vorn

- **Signal:** Reihenfolge der `step-started`-Events vs. welcher Step das `run-completed {gate: "stopped"}` (bzw. eine frühe Gate-Ablehnung) auslöst, plus `cost` der davor laufenden Steps.
- **Erkennung:** Ein billiges `validate`/`condition`, das **häufig ablehnt**, läuft *nach* einem teuren `agent`/`llm`. Erwartete Einsparung = `P(früher Abbruch) × Kosten der vorgezogenen teuren Steps`.
- **Kandidat (`graph-edit`):** Gate vor den teuren Step ziehen (Reihenfolge/Edges umschreiben). Nur vorschlagen, wenn keine Datenabhängigkeit das Vorziehen verbietet.
- **Invariante:** Inv. 1 (Exit = „gut genug"), Kosten (Inv. 21).

### 6.7 `loop-bound-miner` — realistische Schranken

- **Signal:** `BudgetTracker.iterationCount` / Tiefe pro Run bis zum `run-completed {gate:"passed"}` (Self-Edge-Muster wie `draft-until-good`), vs. konfiguriertes `maxDepth`/`budget`.
- **Erkennung:** Verteilung der real benötigten Iterationen bis zur Konvergenz. Wenn p99 deutlich unter dem konfigurierten Ceiling liegt → das Ceiling ist verschwenderisch (bzw. ungenutzter Puffer für Eskalation).
- **Kandidat (`node-config`):** engeren `maxDepth`/`budget`-Default vorschlagen (schnelleres Fail-/Escalate-Verhalten, klarere Budgets).
- **Invariante:** Inv. 21 (Budget/Tiefe Pflicht & propagiert).

### 6.8 `model-right-sizing` — günstigeres Modell, wenn das Gate weiter passt

- **Signal:** `Resolved.cost {model, tokensIn, tokensOut, usd}` + `Resolved.confidence` der intelligence-Node + das nachgelagerte `GateVerdict`/`run-completed {gate}`.
- **Erkennung:** Call-Sites mit teurem Modell + konsistent hohem Gate-Pass. **Shadow-Replay** der getapten Inputs gegen ein billigeres Modell; messe Agreement / Gate-Pass-Rate auf einem Held-out-Split.
- **Kandidat (`node-config`):** Modell-Downgrade an der Node (`with.model`), sofern Shadow-Pass über Schwelle bleibt — LLM-Pfad bleibt erhalten, nur billiger.
- **Invariante:** Inv. 7/17 (delegierte Intelligenz, `ctx.model`-Routing); Kosten (Inv. 21).

### Übersicht

| Retro | Primär-Signal | Kandidaten-Sorte | Invariante |
|---|---|---|---|
| determinism-miner *(Anker)* | `inputHash→{outputHashes}` | `node-replacement` | 6/7 |
| elicitation-eliminator | `elicitation-resolved {by}` | `policy-tighten` | 9/11/12 |
| over-grant-detector | `requests` vs. `injected[]` | `policy-tighten` | 13/14 |
| redaction-leak-sniffer | `redaction` vs. Inhalt | `alert` / `policy-tighten` | 23/13 |
| flaky-retry-miner | `Failed {retryable, attempts}` | `node-config` / `alert` | 10 (§11/#7) |
| dead-step-pruner | Output vs. `artifact-updated` | `graph-edit` | 21 |
| fail-fast-reorder | `step-started`-Reihenfolge vs. `gate:"stopped"` | `graph-edit` | 1/21 |
| loop-bound-miner | `iterationCount` bis Konvergenz | `node-config` | 21 |
| model-right-sizing | `cost.model` + `confidence` + Gate | `node-config` | 7/17/21 |

---

## 7. Neue Capabilities (das einzige echte Architektur-Delta)

Alles andere komponiert aus vorhandenen Nodes (`batch`, `subworkflow`, `transform`, `validate`, `approval`,
`agent`/`llm`). Genuin neu sind **zwei policy-gegatete Capabilities** + wenige Custom-Nodes:

- **`ctx.traces` (read)** — Zugriff aufs Tape. Liegt heute hinter `RunStore`, **nicht** in `Ctx`. Read-only, policy-gescopt auf erlaubte Feature-Tapes. **Data-Classification greift durch** (Inv. 23): oberhalb der Schwelle stehen im Tape Hashes/Refs statt Rohdaten → Tier-0-Determinismus bleibt erkennbar, aber Tier-2-Codegen (Skript aus Roh-I/O) braucht eine „learning-allowed"-Datenklasse oder eine Enklave.
- **`ctx.featureStore` (write)** — nur im `promote-candidate`-Feature. Schreibt `v_{n+1}` (Graph-Rewrite mit Router+Fallback) bzw. wendet einen Policy-Tighten an, registriert das Skript, bumpt Version + contentHash. = Roadmap-Deferral `self_update`/`lifecycle`.

Custom-Nodes (klein): `list-retros`, `collect-tapes`, je Retro eine Analyse-Node (oder `transform`-Kompositionen),
`shadow-eval` (Variante von `validate`), `write-candidate`, `emit-feature-version`/`apply-policy`.

---

## 8. Offene Fäden (bewusst noch nicht entschieden)

- **Input-Kanonisierung** je Call-Site (Whitespace/Feldreihenfolge/irrelevante Felder) — sonst falscher Nicht-Determinismus. Könnte selbst gelernt werden.
- **OOD-Sicherheit:** jedes gelernte Skript deklariert seine Domäne (bekannte Input-Hashes / Guard-Prädikat / Schema) und **defert ans LLM** außerhalb. `mergeOutput → applyTo(artifact)` läuft sonst genauso unwiderruflich mit falschem Skript-Output → der Shadow-Gate ist nicht optional.
- **Drift-Monitor / Demotion:** nach Promotion weiter einen Traffic-Anteil durchs LLM schatten; sinkende Agreement-Rate → Auto-Demote/Re-Synthese.
- **`retro-of-retros`:** den Candidate-Store selbst minen (welche Promotions wurden demoted? welche Kandidaten immer wieder abgelehnt?) → justiert Miner-Schwellwerte. Die Engine lernt, besser zu lernen.
- **Determinismus ≠ Korrektheit:** ein reproduzierbares LLM kann reproduzierbar falsch sein. Nur dort ersetzen, wo ein `validate`/`judge`-Gate oder Ground Truth existiert; LLM-Fallback nie kappen.

---

## 9. Implementierung — Slice 1: das wiederverwertbare Substrat (`@elio/core`)

> **Leitidee dieses Slices:** Tools **und** Services als Funktionen bündeln, damit jeder Miner sie komponiert,
> statt Tape-Lesen/Hashen/Gruppieren/Kandidaten je neu zu implementieren. Geliefert: das Toolkit + die
> `traces`-Capability + zwei Anker-Miner als reine Funktionen. **Read-only, off the hot path** — keine
> Mutation am Runner-Pfad, keine neue Runtime-Dependency (node:crypto only).

### 9.1 Toolkit (`packages/core/src/retro/`) — reine Funktionen

| Modul | Funktionen / Typen | Zweck |
|---|---|---|
| `canon.ts` | `canonicalize` · `canonicalJson` · `hashValue` | Ordnungs-stabile Kanonisierung + stabiler Hash — gleiche Bedeutung ⇒ gleicher Hash (Grundlage der Determinismus-Erkennung). |
| `callsite.ts` | `CallSiteKey` · `callSiteKey` · `callSiteKeyString` · `groupByCallSite` | Aufrufstelle `(feature, step, nodeType)` + Bucketing der Frames; `feature` kommt per `featureOf`-Callback (nicht im Frame). |
| `stats.ts` | `determinismStats` · `aggregateCost` · `resolvedFrames` · `failedFrames` · `uniqueRuns` · `ResolvedFrame`/`FailedFrame` | Determinismus-Kennzahlen (support/distinctInputs/**determinism**/domain/perInput), n-stellige Cost-Summe, getypte Frame-Filter, Provenance. |
| `candidate.ts` | `PromotionCandidate` · `CandidateKind` · `makeCandidate` · `CandidateStore` · `InMemoryCandidateStore` | Kandidaten-Schema (§5) + Store-Contract. `makeCandidate` leitet die `id` als Inhalts-Hash ab → **idempotent** (re-mining vervielfältigt nicht; `add` ist Upsert). |
| `miners.ts` | `mineDeterminism` · `mineFlakyRetry` (+ `*Proposal`/`*Options`) | Zwei Anker-Miner, die das Toolkit komponieren (s. 9.3). |

### 9.2 Service: `ctx.traces` (Capability `traces:read`)

- **Contract** in `ctx.ts`: `TracesService { collect(query?): Promise<TapeFrame[]>; tape(run): AsyncIterable<TapeFrame> }` + `TraceQuery { runs?, nodeType?, since?, until? }`.
- **Impl** in `traces.ts`: `RunStoreTracesService` über einer `TapeSource` (= `RunStore`, das jetzt `runIds()` trägt). `allowedTraceScopes(toolPermissions)` leitet die Scopes ab — exakt analog `allowedSecretNames`.
- **Gating** im `PolicyInjector` (security by absence, Inv. 14): `ctx.traces` wird **nur** injiziert, wenn die resolvte Policy einen `traces:*`-toolPermission trägt **und** eine Quelle (`tracesSource ?? store`) verdrahtet ist. Die Capability reitet auf `toolPermissions` (tighten-only Mengen-Schnitt) — `ResolvedPolicy` (LAW-Typ) bleibt unverändert.
- **v0.1-Grenze (ehrlich):** `feature` steht nicht im `TapeFrame` (nur im `run-started`-Event) → kein Feature-Filter, kein feature-granulares Scoping. v0.1 gated auf Injektions-Ebene (read-all der getapten Runs), analog dem db-Scoping (§3). `traces:<feature>` ist im Typ vorgesehen, aber noch nicht durchgesetzt.

### 9.3 Die zwei Anker-Miner (read-only Funktionen)

- **`mineDeterminism(frames, opts)`** → `node-replacement` (§6.0 Anker). Gruppiert nach Call-Site, betrachtet nur `intelligenceNodeTypes` (Default `["llm","agent"]`), und schlägt bei `support ≥ minSupport` (20) **und** `determinism ≥ minDeterminism` (0.98) eine Tier-0-Memo-Tabelle (nur Inputs mit eindeutigem Output) + LLM-Fallback vor. `determinism` ist **pro distinktem Input** (Anteil der Input-Hashes mit eindeutigem Output), nicht traffic-gewichtet — die Domäne ist stabil sortiert, damit re-mining idempotent dedupliziert. `estImpact.usd` = aggregierte LLM-Kosten **nur der memoisierbaren (domain) Frames** (nicht-deterministische Inputs fallen aufs LLM zurück, werden also nicht eingespart).
- **`mineFlakyRetry(frames, opts)`** → `node-config` | `alert` (§6.4). **Ehrliche Signal-Grenze:** der Runner tapet **ein** Frame pro Step mit dem *finalen* Result — fail-then-succeed wird in ein `resolved` absorbiert. Beobachtbar sind **erschöpfte `Failed`-Frames**. Überwiegt `retryable` → `node-config` (RetryPolicy hochsetzen); überwiegt non-retryable → `alert` (error.code-Histogramm). Dieser Miner mint also bewusst die Failed-Frames, nicht das (nicht getapte) transiente Zwischenresultat.

Beide beweisen die Wiederverwertbarkeit über **zwei verschiedene Tape-Signale** (`resolved` vs. `failed`) und **drei Kandidaten-Sorten** auf demselben Toolkit. Sie sind reine Funktionen (nicht Nodes) — trivial testbar; das Wrappen als `retro`-Subworkflow-Node (§3/§4) ist der **nächste Slice**, ebenso `promote-candidate` mit `featureStore:write`.

### 9.4 Tests

`retro/{canon,callsite,stats,candidate,miners}.test.ts` + `traces.test.ts` (Service-`collect`-Filter, `allowedTraceScopes`, Injector-Gating in vier Fällen: granted / nicht angefordert / Parent verbietet / keine Quelle). Gesamtsuite grün, keine Regression an den geänderten Interfaces (`RunStore.runIds`, `Ctx.traces`).

## 9.5 Slice 2 — die read-only Orchestrator-Schicht (lauffähig)

> **Leitidee:** Die Miner aus dem Substrat als echte, im Engine lauffähige Nodes verfügbar machen — ohne
> den heißen Pfad anzufassen und ohne mutierenden Schreibpfad. Aus dem Toolkit wird ein **lauffähiger
> Retro-Loop**: `runner.run(retroOrchestratorPack, …)` → Kandidaten im durable Artefakt.

**Nodes (`packages/core/src/nodes/retro.ts`, built-in registriert):**
- **`retro-miner`** (klass `orchestration`, `requests: { tools: ["traces:read"] }`): liest das Tape über `ctx.traces.collect()`, fährt die konfigurierten Miner (`with.miners`, Default beide) und gibt `{ candidates, candidateCount }` zurück (Output-Key fest `candidates` — daran ist der Gate gekoppelt). Akkumuliert `with.prior` und **dedupliziert per Kandidaten-id**. **Schließt eigene Infrastruktur-Frames** (`retro-miner`/`retro-complete`/`dead-letter`) vom Mining aus → kein Selbst-Mining (sonst würde ein späterer Run einen flaky-Kandidaten über die Miner-Node selbst minten). Ohne Tape-Grant ist `ctx.traces` nicht injiziert → die Node failt klar (security by absence, Inv. 14). **Mutiert nichts.**
- **`retro-complete`** (Eval-Gate, Inv. 1): mining ist **ein-Schuss** (kein Konvergenz-Loop), der Gate bestätigt nur, dass ein `candidates`-Array im Artefakt liegt.

**Feature (`packages/core/src/retro/orchestrator.ts`):** `retroOrchestratorPack` — `autonomy: "static"`, Artefakt `promotion-candidate-set`, ein `mine`-Step + Gate `retro-complete`. Der Step-Output wird via `applyTo` flach ins `content` gefaltet → die Kandidaten liegen im durable Artefakt (`runner.getArtifact(runId).content.candidates`).

**Wiring-Fix:** Der `OuterLoopRunner` baut seinen Default-Injector jetzt mit dem `store` als `TapeSource` (`new PolicyInjector({ store: deps.store })`) — so ist `ctx.traces` auch über den nackten Runner verfügbar, nicht nur über die SDK. Bleibt policy-gegated (nur bei `traces:read`-Grant injiziert).

**Tests:** `nodes/retro.test.ts` (Miner-Auswahl, prior-Dedup, `runs`-Filter-Forwarding, `feature`-Attribution, Infra-Ausschluss, security-by-absence-throw, Gate pass/fail) + `retro/orchestrator.test.ts` (end-to-end: geseedetes Tape → 2 Kandidaten im Artefakt, `gate:"passed"`; **fail-closed**: ohne `traces:read`-Grant → mine-Node failt → `gate:"stopped"`, kein `node-resolved`; **kein Selbst-Mining**: nach 3 fail-closed-Runs mint ein granteter Run keinen Kandidaten über `retro-miner@mine`).

**v0.1-Form & ehrliche Grenze:** Der Orchestrator fährt die Miner-Suite in **einer** Node (nicht ein `subworkflow` pro Retro-Feature). Die echte Registry-getriebene Fan-out-Form (Doc §3) braucht den feature-ref-`subworkflow` (v0.2 — der heutige `subworkflow` fährt nur inline-Steps, kein Feature-per-id). Bis dahin ist die Suite über `with.miners` erweiterbar.

## 9.6 Slice 3 — der geschlossene Loop: promote-candidate (Punkte 1+2+6c)

> **Das Ziel erreicht:** eine deterministische Aufrufstelle wird jetzt **über ein Skript (Memo) statt über
> das LLM** gelöst — mit LLM-Fallback für Out-of-Domain, hinter einem menschlichen Approval-Gate,
> versioniert und Shadow-validiert. Read→propose→validate→approve→rewrite ist durchgängig lauffähig.

**Graph-Rewrite (`packages/core/src/retro/promotion.ts`):**
- `applyCandidate(pack, candidate)` — fügt für eine `node-replacement`-Aufrufstelle einen `memo-lookup`-Step vor den LLM-Step, biegt eingehende Edges auf das Memo um, legt `memo→llm when "!state.<hitFlag>"` (Miss) und `memo→<llm-Ziele> when "state.<hitFlag>"` (Hit, LLM übersprungen), bumpt die Version und vergibt einen frischen `contentHash`. **Pure**, Original unangetastet (Versionierung, Doc §2). Guards: nur `node-replacement`; kein bedingt-ausgehender Ziel-Step; **kein Doppel-Rewrite** (bereits promotet → Fehler); Proposal-Shape validiert.
- `shadowEval(candidate, frames)` — validiert auf **held-out** Frames (die Mining-Runs `candidate.evidence.runs` werden ausgeschlossen — sonst wäre die Prüfung eine Tautologie). `passed` = held-out-Abdeckung > 0 **und** Agreement ≥ Schwelle (Tier-0: exakt). `heldOut`-Flag macht „re-bestätigt" von „unabhängig validiert" unterscheidbar.

**Nodes:** `memo-lookup` (hasht den probe-Input, schlägt in der **base64-kodierten** Tier-0-Tabelle nach — base64 entgeht der Runner-Template-Auflösung, sonst würde `{{…}}` in memoisierten Outputs korrumpiert; Hit → memoisierte Ausgabe + Routing-Flag, Miss → nur Flag). `promote-apply` (gegated `featurestore:write`+`traces:read`; shadow-evaluiert, schreibt **nur bei Pass** via `ctx.featureStore.put`). `promote-complete`-Gate (drei Ausgänge sauber getrennt: promoted=true → `passed`; promoted=false (Shadow-Eval lehnte ab) → `stopped`; kein apply (Deny) → `stopped`).

**Capability:** `ctx.featureStore` (`FeatureStoreService` + `InMemoryFeatureStore`) — die **einzige mutierende** Capability, gegated via `featurestore:write` (security by absence, Inv. 14), nur das `promote-candidate`-Feature trägt den Grant. `applyTo` faltet `__`-präfixierte Control-Felder (Memo-Hit-Flag) **nicht** ins durable `content` → Shape-Parität zum Original bleibt erhalten.

**Feature (`retro/promote.ts`):** `promoteCandidatePack` — `approval(blocking)` → Edge `when "state.answer.approved == true"` → `promote-apply`. Kandidat reist im `RunInput.payload` (Runner legt ihn unter `state.input` ab — neuer Enabler) und wird via `{{state.input}}` gelesen. **Deny-safe:** ohne Zustimmung greift der Edge nicht → kein Write.

**Tests:** Memo-Hit überspringt das LLM (`calls()===0`), Miss fällt zurück; non-terminaler Ziel-Step → Hit überspringt LLM, Graph läuft weiter; Approve→v_{n+1}, Deny→nichts, Approve-aber-Shadow-Eval-Fail→nichts+`stopped`, Re-Promotion→kein zweiter Rewrite; held-in/held-out Shadow-Eval; base64-Lookup serviert template-artige Outputs verbatim; `__`-Flag leakt nicht ins content.

**Reviewt:** adversarialer Review (15 Befunde, 11 bestätigt) — alle behoben (Template-Korruption der Lookup-Outputs, content-Leak des Hit-Flags, Gate-Verwechslung promoted/abgelehnt, held-in-Tautologie der Shadow-Eval, Proposal-Validierung, Doppel-Promotion, + 3 Test-Lücken).

**v0.1-Grenzen (ehrlich):** Shadow-Eval-Frames waren anfangs nur `(step, nodeType)`-gescopt — **mit §9.8 (6b) behoben**: der Frame trägt jetzt das Feature, Shadow-Eval filtert `(feature, step, nodeType)`. Promotion deckt `node-replacement` ab; `node-config`/`policy-tighten` sind spätere Promotion-Pfade.

## 9.7 Slice 4 — Miner-Breite (Punkt 3)

> **Fünf weitere tape-getreue Miner** auf demselben Toolkit; alle in die `retro-miner`-Node verdrahtet
> (`RetroMinerName`), der `retro.orchestrator` fährt jetzt die **volle Suite** (kein `with.miners` → Default
> alle). Diese erzeugen **advisory** Kandidaten (node-config/graph-edit/policy-tighten/alert), die v0.1
> NICHT automatisch promotet werden (`applyCandidate` deckt nur `node-replacement`) — sie sind für den
> menschlichen Operator. Jede Rahmung ist ehrlich: ein **Flag/Vorschlag** aus dem beobachteten Tape, kein
> bewiesener Fix.

| Miner | Signal (im Tape) | Kandidat | Ehrliche Grenze |
|---|---|---|---|
| **loop-bound** | Frames je (run, step) = Iterationen je Run | `node-config` (maxDepth = beob. Max +1) | — (sauber) |
| **elicitation-eliminator** | `Suspended`-Frames + `elicitation.what` | `policy-tighten` (Auto-Resolve) | **Frequenz**-Signal; „Mensch antwortet stets gleich" braucht die aufgelösten Antworten (nicht im Frame) |
| **model-right-sizing** | `cost.model` + `confidence` + `cost.usd` (resolved) | `node-config` (Flag) | **Flag**, kein verifizierter Downgrade — Shadow-Replay nötig |
| **redaction-leak-sniffer** | roher Frame-Inhalt vs. PII-Muster | `alert` | **heuristische** PII-Erkennung (email/Ziffernfolgen) — menschlich prüfen |
| **fail-fast-reorder** | Pro-Run-Abfolge: ablehnendes Gate NACH teurem intelligence-Step | `graph-edit` (+ est. Waste-USD) | flaggt Chance; Reorder nur ohne Datenabhängigkeit |

**Begründet vertagt (NICHT als Schein-Miner gebaut):**
- **over-grant-detector** — bräuchte das Signal *welche Capability eine Node tatsächlich genutzt hat*. Das Tape trägt nur `injected[]` (= *verfügbar*), nicht *genutzt*. Eine ehrliche Umsetzung verlangt Capability-Usage-Tracking (ctx-Service-Wrapping, das Nutzung aufzeichnet + `used[]` tapt) — eine Hot-Path-Observability-Erweiterung, bewusst aufgeschoben.
- **dead-step-pruner** — bräuchte **Graph- + Artefakt-Delta-Analyse** (welche Edge konsumiert den Output, ändert er das Artefakt), nicht reines Tape-Mining. Anderer Mechanismus (statische Graph-Analyse mit dem FeaturePack als Input) — aufgeschoben.

**Helfer:** `groupByRun` (Pro-Run-Sequenzen, für loop-bound/fail-fast). **Tests:** je Miner Positiv- + Negativ-/Schwellwert-Fall (`retro/miners.test.ts`, 25 Tests gesamt). Der Orchestrator-End-to-End-Test bleibt grün — die geseedete Tape löst weiterhin nur determinism + flaky aus (die anderen finden im Test-Tape nichts).

## 9.8 Slices 5–8 — Feature-Scoping, Drift/Demotion, feature-ref, Tier-1

> Vier weitere Slices schließen die verbleibenden Punkte (Tier-2-Codegen bleibt bewusst vertagt — LLM-
> generierter, ausgeführter Code braucht eine eigene Sandbox-sichere Behandlung).

**6b — `traces:<feature>`-Scoping.** Der Runner stempelt jetzt das Feature des Runs an jeden `TapeFrame`
(`feature?`, einmal in `appendTape` via `runContexts`). Daraus folgt: (1) `TraceQuery.feature` + `traceScope`
— `traces:read` liest alle Features, `traces:<feature>` nur das genannte (security by absence, der Injector
reicht den Scope an `RunStoreTracesService`); (2) **Shadow-Eval filtert jetzt `(feature, step, nodeType)`**
— die im Keystone-Review gefundene Feature-Achsen-Lücke ist geschlossen; (3) Miner attribuieren per
`frame.feature` (Default von `groupByCallSite`).

**5 — Drift-Monitor + Demotion.** `mineDrift` mint die `memo-lookup`-Frames promoteter Aufrufstellen und
flaggt eine **hohe Miss-Rate** (Hit/Miss steht im Frame-Output) → die Memo-Domäne ist veraltet (`alert`,
re-mine/demote). TAPE-GETREU. `applyDemotion(pack, step)` ist die Umkehrung von `applyCandidate` (entfernt
das Memo, stellt die LLM-Edges wieder her, bumpt die Version); `demote-apply`-Node + `retro.demote-candidate`-
Feature (approval-gegated, deny-safe) machen es operabel. **Ehrliche Grenze:** der Drift-Signal ist die
*Domänen-Abdeckung* (steigende Miss-Rate); „die memoisierte Antwort ist inzwischen falsch" bräuchte ein
Shadow-Sampling gegen ein frisches LLM (Laufzeit-Pfad). **`retro-of-retros` vertagt** — bräuchte einen
persistierten Candidate-Store mit Promotion-/Demotion-Outcomes (der Handoff ist v0.1 payload-basiert).

**6a — feature-ref `subworkflow`.** `ChildBranchSpec` trägt jetzt optional `graph` + `pack`; der Runner fährt
ein Kind gegen den Sub-Feature-Graphen unter dessen eigener Governance (statt nur linearer Inline-Steps).
Die `feature-ref`-Node fächert über `with.featureIds` und fährt jedes per `FeatureRegistry` aufgelöste
Sub-Feature als Kind-Branch — die **registry-getriebene Fan-out-Form** des Orchestrators (Doc §3): neue Retro
= registrieren, kein Pack-Edit. **Ehrliche Grenze:** Kind gate-los (wie subworkflow); parkt ein Kind und wird
resumed, läuft der Resume unter Parent-Governance (der Sub-Graph reist im Checkpoint, der Sub-Pack nicht) —
für nicht-parkende read-only-Fan-outs irrelevant.

**4 (Tier-1) — Regel-Extraktion.** `detectRule` erkennt über den resolved Frames eine **`constant`-** (jeder
Input → derselbe Output) oder **`passthrough`-Regel** (Output = Input) und annotiert sie am Determinismus-
Kandidaten (`proposal.rule`). **Ehrlich:** das ist eine Tier-1-*Annotation* — sie generalisiert über die
beobachtete Domäne hinaus; die Promotion nutzt weiter die **sichere Tier-0-Lookup + LLM-Fallback**. Eine
echte regelbasierte Generalisierung ohne Fallback bräuchte OOD-Validierung — das ist **Tier-2** (LLM-Codegen
mit gesandboxter Ausführung, Inv. 20). **→ inzwischen gebaut, siehe §9.9.**

**Reviewt (konsolidiert über Slices 4–8):** adversarialer Review (19 Befunde, 14 bestätigt) — alle behoben.
Die wichtigsten: feature-ref-Kind-Frames wurden mit dem **Parent**-Feature gestempelt (jetzt: Stempel aus dem
tatsächlich laufenden Pack → 6b-Korrektheit für Sub-Features); `tape()` umging den Feature-Scope (jetzt
gefiltert wie `collect()`); `mineFailFast`/`mineLoopBound` zählten über Geschwister-Branches hinweg falsch
(jetzt **branch-aware**: pro `(run, branch)` bzw. genau ein teurer Frame je Gate-Ablehnung); `loop-bound`
schlug ein globales `maxDepth` aus einer Call-Site vor (jetzt ehrlich als per-Call-Site **Iterations-Cap**);
`model-right-sizing` meldete bei Mehr-Modell-Call-Sites das zuletzt gesehene Modell (jetzt **pro Modell**);
`feature-ref` dedupliziert `featureIds`; veralteter `ctx.ts`-Kontrakt-Kommentar korrigiert; + Test-Lücken
(feature-Stempel durch den echten Runner, tape-Scope, Drift-Schwellwert-Grenze, applyDemotion non-terminal,
feature-ref parked-child, demote deny-safe).

## 9.9 Slice 9 — Tier-2: LLM-Codegen mit gesandboxter Ausführung (der letzte vertagte Punkt)

> **Das Ziel erreicht:** eine deterministische Aufrufstelle wird jetzt über ein **vom LLM generiertes,
> ÜBER die beobachtete Domäne hinaus generalisierendes Skript** `(input) => output` gelöst — isoliert
> ausgeführt (Worker/VM, Inv. 20), held-out-validiert, hinter dem menschlichen Approval-Gate, mit
> nie gekapptem LLM-Fallback. Damit ist der Sprung von Tier-0 (Lookup gesehener Inputs) und Tier-1
> (Regel-*Annotation*) zur **ausgeführten Generalisierung** vollzogen — der einzige bewusst vertagte
> Punkt der Engine.

**Die Leitidee — eine reine Funktion ist das *einfachste* zu isolierende Ding.** Ein Tier-2-Skript ist
`(input) => output` und braucht **keine** Capability. Statt den `NodeSandbox`-Seam RPC-fähig zu machen
(ctx über eine Prozessgrenze), wird nur der **untrusted Funktions-Body** isoliert: Source rein, Output raus,
**kein ctx**. So bleibt der heiße Pfad/Runner unangetastet und die Isolation sitzt genau dort, wo der
untrusted Code läuft.

**Slice 9a — Sandbox-Primitive (`ctx.scripts`, `sandbox.ts`).** Neue policy-gegatete Capability
`ScriptRunnerService` (gegated via `scripts:execute`, security by absence — Injektion exakt analog
`featureStore`/`traces`/`secrets`). Impl `WorkerScriptRunner` (Owner-Wahl): `node:worker_threads`
(terminierbares Hard-Timeout, eigener Thread, `resourceLimits` gegen Heap-Runaway) + `node:vm`-Context IM
Worker (eingefrorener, capability-freier Scope — kein `require`/`process`/`global`). Der **Input reist als
JSON-String** in den vm und wird DRIN mit dem vm-eigenen `JSON` geparst — ein als lebendes Host-Objekt
übergebener Input wäre ein bekanntes vm-escape (`i.constructor.constructor("return process")()` erreicht den
Host-Realm), ein String-Primitive nicht. Die Ausgabe wird IM vm JSON-serialisiert (plain data, klonbar, kein
Realm-Leak). `ok:false` (Wurf/Timeout/OOD/undefined/thenable/zu-groß) ist KEIN Crash, sondern das
**MISS-Signal → LLM-Fallback**.

**Slice 9b — Ausführung + Graph-Rewrite (`script-eval`, `promotion.ts`).** Neue Proposal-Sorte
`ScriptProposal { tier: 2, source, domain }` (diskriminiert per `tier` von der Tier-0-`DeterminismProposal`).
`applyCandidate` verzweigt nach Tier über einen **gemeinsamen `rewriteReplacement`-Helfer** (der Tier-0
memo-Pfad bleibt byte-identisch) und fügt eine **`script-eval`-Node** ein — gleiche HIT-überspringt-LLM /
MISS-fällt-zurück-Edge-Topologie wie memo-lookup; die Source liegt **base64** (entgeht der Template-Auflösung,
wie memos `lookupB64`). `shadowEvalScript` (async) **führt das Skript gegen held-out Frames aus** (nicht nur
Lookup): ein MISS zählt als OOD (nicht Teil der Behauptung), `agreed/covered` misst die Übereinstimmung mit
dem getapten LLM-Output. `applyDemotion` ist auf beide Tiers verallgemeinert.

**Slice 9c — Synthese (`synthesize-script`, `synthesize.ts`).** Miner sind ctx-lose reine Funktionen, können
also **kein** LLM rufen — Codegen lebt daher in einer Node mit `ctx.model`. `synthesize-script`
(klass `intelligence`, fordert `models` + `traces:read` + `scripts:execute`) liest die **echten**
(input,output)-Beispiele aus dem Tape (die Tier-0-Lookup trägt nur den Input-*Hash*), lässt das LLM eine
reine Funktion generieren, validiert sie isoliert gegen die Beispiele **und** held-out
(`generate→validate→retry`, bounded `maxAttempts`), und emittiert bei bestandenem Gate einen **validierten
Tier-2-Kandidaten**. Es schreibt **kein** Pack — Analyse erzeugt den Vorschlag, die mutierende Promotion
bleibt das separate, approval-gegatete `promote-candidate`-Feature (`promote-apply` re-validiert den
Tier-2-Kandidaten via `shadowEvalScript`, Doc §4). End-to-end lauffähig: mine → synthesize → promote
(Approval) → das promotete Pack führt den generierten Code aus (HIT überspringt das LLM, MISS fällt zurück).

**Ehrliche Grenzen (bewusst):**
- **Isolation ist Thread + capability-freier Scope + terminierbares Timeout + Heap/Output-Cap — KEINE
  OS/seccomp-Isolation** (gemeinsamer Prozess-Heap; `node:vm` ist kein gehärteter Boundary gegen einen
  *determinierten* Angreifer). Für eine generierte reine Transform-Funktion angemessen; ein echter
  Prozess-/Container-Sandbox bleibt vertagt (Roadmap „Echter Worker/VM-Sandbox"). Die zusätzlichen
  Sicherungen: held-out Shadow-Gate, menschliches Approval, der nie gekappte LLM-Fallback.
- **Ein promotetes Tier-2-Pack braucht zur Laufzeit `scripts:execute`** (anders als Tier-0, das gar keinen
  Grant braucht): ohne Grant ist `ctx.scripts` nicht injiziert → `script-eval` failt **closed** (kein
  stilles Erreichen des LLM ohne Grant). Getestet.
- **Reine *synchrone* Funktion ist Vorgabe:** ein zurückgegebenes Promise/thenable (oder eine async-Funktion)
  ist OOD → MISS (nie ein HIT auf `{}`). **Codegen ist nicht-deterministisch** (die Synthese selbst); nur
  *was bestanden hat* wird promotet. **Korrektheit ist durch das held-out-Agreement begrenzt** — daher der
  nie gekappte Fallback + Drift-Monitor (`mineDrift`/Demotion) für die Zeit nach der Promotion.
- **Worker-pro-Call** (saubere Isolation, kein Cross-Call-State); Worker-Pool/Parallelisierung des
  Shadow-Evals sind Perf-Nachzügler, bewusst vertagt.

**Reviewt:** adversarialer Review über 4 Linsen (Sandbox-Escape, Rewrite-Korrektheit, Invarianten-Konformität,
Test-Lücken), jeder Befund unabhängig gegen den echten Code verifiziert (23 Befunde, 11 bestätigt, 12 als
False-Positive widerlegt) — alle bestätigten behoben. Die wichtigsten: **(Blocker)** ein zurückgegebenes
Promise serialisierte zu `"{}"` und wurde als sicherer HIT verbucht (Fallback unterdrückt + Shadow-Eval
vergiftet) → thenable wird jetzt im vm abgewiesen (→ MISS); **(wichtig)** fehlende `resourceLimits` +
Output-Cap (Heap/Payload-DoS) → beide ergänzt; `promote-apply` reichte `timeoutMs` nicht an den
Tier-2-Re-Check durch (asymmetrisch zur Synthese) → behoben; irreführender `decodeSource`-Kommentar/toter
try/catch (malformed base64 degradiert zu MISS, wirft nicht) → korrigiert; `worker.exit`-Listener +
präzisere Backstop-Semantik ergänzt; + Test-Lücken (falsy HIT-Werte `0/false/""/null` vs. `undefined`-MISS,
thenable→MISS, Output-Cap, malformed base64→MISS, promote-apply-Tier-2 ohne `scripts:execute` fail-closed).
