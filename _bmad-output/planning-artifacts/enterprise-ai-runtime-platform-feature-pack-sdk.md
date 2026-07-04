# App Idea: Enterprise AI Runtime Platform / Feature-Pack SDK

## Kurzbeschreibung

Idee für eine enterprise-ready AI Runtime Platform, die lokale Modelle wie Ollama und Cloud-Modelle wie Claude flexibel kombiniert. Der Kern ist eine generische Runtime, in der neue AI-Automationen nicht jedes Mal als Quellcode-Anpassung entstehen, sondern als versionierte, validierbare und auditierbare **Feature Packs**.

Die Plattform soll CLI-first nutzbar sein, gleichzeitig aber als TypeScript-SDK, HTTP-API, Webapp-Backend, n8n-Integration, Cron/Queue-Worker oder Agent-Tool dienen können.

Grundsatz:

```text
Sourcecode erweitert die Plattform.
Konfiguration erweitert die Nutzung.
```

Das bedeutet:

```text
Neues Modell?                 -> Konfiguration
Neuer Prompt?                 -> Konfiguration
Neuer CLI-Befehl?             -> Konfiguration
Neuer Workflow?               -> Konfiguration
Neue Policy?                  -> Konfiguration / Policy-Code
Neues externes System?        -> meist Tool-Adapter in Code
Neue Node-Art?                -> Plattform-Code
Neuer Modellprovider?         -> Adapter-Code
Neue UI-Komponente?           -> Plattform-Code
```

---

## Ausgangspunkt

Die Grundarchitektur besteht aus drei Layern:

```text
1. Model Layer
   - Ollama lokal
   - Claude cloud
   - spaeter: OpenAI, Azure OpenAI, Bedrock, Gemini, Foundry, interne Modelle, LiteLLM-Gateway

2. Router Layer
   - entscheidet: lokal oder Claude
   - loggt Kosten, Modell, Task, Datenklasse, Policy-Entscheidung
   - erzwingt Regeln
   - blockiert unerlaubte Cloud-Nutzung
   - erlaubt Fallbacks nur, wenn Policies es zulassen

3. Workflow Layer
   - manuell in der CLI
   - Cron
   - n8n
   - ein Agent
   - spaeter vielleicht eine UI
   - Webapps ueber SDK/API
```

Zielbild:

```text
CLI / UI / Webapp / n8n / Cron / Agent
        ↓
TypeScript SDK oder HTTP API
        ↓
Feature Registry
        ↓
Workflow Engine
        ↓
Policy Engine + Router Layer
        ↓
Model Adapter + Tool Adapter
        ↓
Run Store + Audit Store + Observability
```

Die Plattform wird dadurch nicht nur ein CLI-Wrapper, sondern eine **AI Operations Runtime**.

---

## Produktidee als Bausteine

```text
AI Runtime Platform
  = Feature Registry
  + Skill Registry
  + Model Registry
  + Tool Registry
  + Policy Engine
  + Workflow Engine
  + Router Layer
  + Run Store
  + Audit Store
  + Eval Runner
  + CLI
  + TypeScript SDK
  + optional API Server
  + optional Web UI
```

### Feature Registry

Versionierte Feature Packs, z. B.:

```text
document.summarize
meeting.extract-actions
email.draft-reply
invoice.extract-fields
research.daily-briefing
```

### Skill Registry

Wiederverwendbare AI-Faehigkeiten, z. B.:

```text
skill.extract-actions
skill.summarize-document
skill.classify-sensitivity
skill.draft-email
skill.critique-output
```

### Model Registry

Katalog aller verfuegbaren Modelle mit Metadaten:

```text
local.fast       -> Ollama, kleines lokales Modell
local.strong     -> Ollama, groesseres lokales Modell
claude.strong    -> Claude Cloud
openai.strong    -> OpenAI Cloud
azure.internal   -> Azure/OpenAI Enterprise Deployment
```

### Tool Registry

Kontrollierte Tools mit Input-/Output-Schemas, Scopes, Side-Effect-Klassen und Approval-Regeln.

### Policy Engine

Regelt Datenklassifikation, Cloud-Nutzung, Kostenlimits, Human Approval, Tool-Permissions und Compliance-Anforderungen.

### Workflow Engine

Fuehrt deklarative Graphen aus, verwaltet State, Checkpoints, Retries, Loops, Human-in-the-Loop-Pausen und Outputs.

### Run Store und Audit Store

Jeder Run wird nachvollziehbar gespeichert: Input-Hash, Feature-Version, Prompt-Version, Modell, Routing-Entscheidung, Tool Calls, Kosten, Outputs, Approvals, Fehler, Trace-ID.

---

## Grundidee: Commands sind deklarierte Features

Ein CLI-Command wie:

```bash
ai meeting extract-actions ./meeting.md
```

soll nicht hart im CLI-Code implementiert sein. Er soll aus einem Feature Pack entstehen:

```text
features/
  meeting.extract-actions/
    feature.yaml
    workflow.yaml
    prompts/
      classify.system.md
      classify.user.md
      extract.system.md
      extract.user.md
      critique.system.md
      critique.user.md
      revise.system.md
      revise.user.md
    schemas/
      input.schema.json
      output.schema.json
      classification.schema.json
      critique.schema.json
    evals/
      basic.yaml
      edge-cases.yaml
      privacy.yaml
    README.md
    CHANGELOG.md
```

Die CLI liest die Registry und erzeugt daraus dynamisch verfuegbare Commands:

```bash
ai list
ai describe meeting.extract-actions
ai run meeting.extract-actions --input ./meeting.md
ai meeting extract-actions ./meeting.md
ai meeting extract-actions ./meeting.md --local-only
ai meeting extract-actions ./meeting.md --output ./outbox/actions.json
```

Der Feature-spezifische Command ist nur syntactic sugar ueber:

```bash
ai run meeting.extract-actions --input ./meeting.md
```

Damit sind Features Daten und nicht hart verdrahtete Programmteile.

---

## Was ist ein Feature?

Ein Feature ist nicht nur ein Prompt.

Ein Feature ist eine versionierte, ausfuehrbare AI-Automation, die:

- Input entgegennimmt,
- Datenklassifikation beruecksichtigt,
- Modelle und Tools kontrolliert nutzt,
- Output validiert,
- Policies erzwingt,
- bei Risiko menschliche Freigabe verlangt,
- Fehler sicher behandelt,
- Kosten und Modellnutzung loggt,
- auditierbar bleibt,
- testbar ist,
- versioniert und publizierbar ist.

Kurz:

```text
Feature = Prompt + Input-Schema + Output-Schema + Workflow + Routing + Policy + Tools + Memory + Evals + Logs + UI-Metadaten
```

### Minimale Funktionsfaehigkeit

Ein Feature braucht mindestens:

1. Identity: Name, ID, Version, Owner, Lifecycle.
2. Command Definition: Wie wird es per CLI oder API angesprochen?
3. Input Contract: Welche Inputs sind erlaubt? Datei, Text, JSON, URL, Event, Webhook, Formular?
4. Output Contract: Was muss am Ende rauskommen? Markdown, JSON, Datei, Draft, Ticket, Report?
5. Prompt oder Skill: Welche AI-Faehigkeit wird benutzt?
6. Workflow: Welche Schritte laufen in welcher Reihenfolge?
7. Model Routing: Welches Modell bevorzugt? Lokal oder Cloud? Fallback erlaubt?
8. Policy-Regeln: Was darf das Feature? Was nicht? Wann muss es stoppen?
9. Validierung: Output muss gegen Schema oder Regeln geprueft werden.
10. Logging: Jeder Run muss nachvollziehbar sein.

### Produktionsreife

Produktionsfaehig wird ein Feature mit:

1. Reflection / Critique Loop
2. Plan & Execute Pattern
3. Layered Memory Policy
4. Striktem Tool Design
5. Human-in-the-Loop Gates
6. Eval Suite
7. Versionierung
8. Approval- und Publish-Prozess
9. Audit Trail
10. Observability
11. Kostenlimit
12. Retry-, Fallback- und Failure-Regeln
13. Security- und Data-Classification-Regeln
14. Lifecycle-Status
15. Owner und Verantwortlichkeit

---

## Reliability Patterns als Feature-Bausteine

Die sechs Pattern fuer produktionsnaehere Agents sollten im Datenmodell als First-Class-Konzepte vorkommen.

### 1. Reflection Loops

Agenten verbessern ihre Antworten, indem sie generieren, kritisieren, ueberarbeiten und wiederholen, bis definierte Kriterien erfuellt sind.

Datenmodell:

```yaml
reflection:
  enabled: true
  maxIterations: 2
  critiquePrompt: ./prompts/critique.md
  revisePrompt: ./prompts/revise.md
  passCriteria:
    - output_valid_json
    - no_missing_required_fields
    - confidence_above: 0.75
```

Nicht jedes Feature braucht Reflection. Es ist besonders sinnvoll bei strukturierten Outputs, externen Texten, komplexen Zusammenfassungen und Aufgaben mit hohem Fehlerrisiko.

### 2. Plan & Execute

Komplexe Ziele werden besser bearbeitet, wenn zuerst ein Plan erstellt und danach kontrolliert ausgefuehrt wird.

Datenmodell:

```yaml
planning:
  enabled: true
  planSchema: ./schemas/plan.schema.json
  requireApprovalBeforeExecution: false
  maxSteps: 5
```

Wichtig ist die Trennung von Plan und Ausfuehrung. Bei riskanten Workflows kann der Plan zuerst menschlich freigegeben werden.

### 3. Layered Memory

Ein Feature muss explizit festlegen, welche Erinnerung genutzt werden darf:

```text
Short-term Context    -> Run-State, aktuelle Live-Fakten
Vector Store          -> Dokumente, Transkripte, Knowledge Base
Episodic Memory       -> Zusammenfassungen vergangener Interaktionen
Long-term Preferences -> Nutzer- oder Team-Praeferenzen
```

Datenmodell:

```yaml
memory:
  shortTerm:
    enabled: true
  vectorStore:
    enabled: true
    collections:
      - project_docs
    topK: 8
  episodic:
    enabled: false
  retention:
    saveRunSummary: true
    ttlDays: 30
```

Enterprise-wichtig: Memory ist Datenschutz- und Compliance-relevant. Jede Memory-Quelle braucht Datenklasse, Retention-Regel, Zugriffskontrolle und Audit.

### 4. Tool Design

Tools muessen single-purpose, strikt typisiert und kontrolliert sein. Kein Feature sollte pauschal beliebige Shell-Kommandos oder Dateisystemzugriff bekommen.

Ein Tool braucht:

```text
Name
Zweck
Input-Schema
Output-Schema
Side-Effect-Klasse
Permissions
Timeout
Fallback
Audit
```

Beispiel:

```yaml
tools:
  allowed:
    - id: file.read
      scope:
        paths:
          - ./inbox
          - ./knowledge
    - id: file.write
      scope:
        paths:
          - ./outbox
    - id: email.createDraft
      requiresApproval: true
  denied:
    - shell.exec
    - email.send
    - file.delete
```

### 5. Human in the Loop

Menschliche Freigabe ist erforderlich bei hohen Risiken, externen Auswirkungen, sensiblen Daten, niedriger Confidence oder Tools mit Side Effects.

Datenmodell:

```yaml
review:
  requiredWhen:
    - output.destination == "external"
    - data.classification in ["confidential", "regulated"]
    - confidence < 0.75
    - tool.sideEffect in ["send_email", "update_crm", "delete_file"]
  reviewers:
    roles:
      - process-owner
      - team-lead
  onReject:
    action: stop
  onTimeout:
    action: fail
    after: 24h
```

### 6. Eval Suite

Jedes Feature braucht Tests und Regression Checks:

```text
Gibt es valides JSON?
Sind Pflichtfelder gesetzt?
Wird der Stil eingehalten?
Werden private Daten nicht geleakt?
Ist die Antwort stabil genug?
Wie verhaelt es sich bei Edge Cases?
```

Datenmodell:

```yaml
evals:
  requiredBeforePublish: true
  cases:
    - ./evals/basic.yaml
    - ./evals/edge-cases.yaml
    - ./evals/privacy.yaml
  metrics:
    - json_validity
    - required_fields
    - factual_consistency
    - pii_leakage
    - tone
  minimumScore: 0.85
```

Ohne Evals entsteht nur eine Sammlung von Prompts, keine belastbare Plattform.

---

## UI oder Markdown?

Empfehlung: Nicht UI oder Markdown, sondern strukturierte Feature Packs als Source of Truth.

```text
Source of Truth: YAML / JSON / Markdown Feature Pack
Authoring: UI + Markdown Editor
Runtime: kompiliertes, validiertes Datenmodell
Governance: Git / Registry / Approval
```

Markdown ist gut fuer:

```text
Prompts
README
Feature-Dokumentation
Beispiele
Changelog
Review-Hinweise
```

YAML/JSON ist gut fuer:

```text
Input-Schema
Output-Schema
Policies
Routing
Tool-Permissions
Audit-relevante Metadaten
Kostenlogik
Workflow-Edges
```

UI ist gut fuer:

```text
Formulare
Graph-Editor
Prompt-Editor
Run-Ansicht
Approval Inbox
Eval Dashboard
Audit- und Kostenansicht
```

Die UI ist nicht die alleinige Quelle der Wahrheit. Sie editiert und visualisiert die versionierten Artefakte.

---

## Feature Pack v0.1

Ein erstes Feature Pack sollte so aussehen:

```text
features/
  meeting.extract-actions/
    feature.yaml
    workflow.yaml
    prompts/
      classify.system.md
      classify.user.md
      extract.system.md
      extract.user.md
      critique.system.md
      critique.user.md
      revise.system.md
      revise.user.md
    schemas/
      input.schema.json
      output.schema.json
      classification.schema.json
      critique.schema.json
    evals/
      basic.yaml
      edge-cases.yaml
      privacy.yaml
    README.md
    CHANGELOG.md
```

### Beispiel `feature.yaml`

```yaml
apiVersion: ai-runtime/v1
kind: Feature

metadata:
  id: meeting.extract-actions
  version: 1.0.0
  title: Meeting Actions extrahieren
  description: Extrahiert Aufgaben, Entscheidungen und offene Fragen aus Meeting-Notizen.
  owner: productivity-team
  lifecycle: draft
  tags:
    - meeting
    - productivity
    - local-first

command:
  namespace: meeting
  name: extract-actions
  aliases:
    - actions
  args:
    - name: input
      type: file
      required: true
      description: Meeting-Notizen als Markdown oder Text
  flags:
    - name: output
      type: path
      required: false
    - name: local-only
      type: boolean
      required: false

input:
  mode: file
  acceptedMimeTypes:
    - text/markdown
    - text/plain
  schema: ./schemas/input.schema.json

output:
  mode: structured
  schema: ./schemas/output.schema.json
  defaultTarget: ./outbox/{{run.id}}.actions.json

data:
  defaultClassification: internal
  allowedClassifications:
    - public
    - internal
    - confidential
    - private

routing:
  strategy: policy
  preferredModel: local.fast
  fallbackModel: claude.strong
  fallbackAllowedWhen:
    - data.classification != "private"
    - run.confidence < 0.75

workflow:
  file: ./workflow.yaml

skills:
  - skill.extract-actions@1.0.0
  - skill.summarize-decisions@1.0.0

policies:
  - no_cloud_for_private_data
  - no_external_side_effects_without_approval
  - max_cost_per_run_0_20

observability:
  logPrompts: true
  logOutputs: true
  redactSensitiveData: true
  traceEnabled: true

evals:
  requiredBeforePublish: true
  path: ./evals

ui:
  icon: list-check
  category: Productivity
  form:
    title: Meeting-Notizen analysieren
    submitLabel: Aufgaben extrahieren
```

### Beispiel `workflow.yaml`

```yaml
apiVersion: ai-runtime/v1
kind: Workflow

metadata:
  id: meeting.extract-actions.workflow
  version: 1.0.0

state:
  inputs:
    - input_file
    - local_only
  outputs:
    - classification
    - selected_model
    - extraction_result
    - confidence
    - review_status

steps:
  - id: read_input
    type: file_read
    with:
      path: "{{input.input_file}}"
    outputs:
      content: state.raw_text

  - id: classify_data
    type: llm
    model: local.fast
    prompt:
      system: ./prompts/classify.system.md
      user: ./prompts/classify.user.md
    structuredOutput:
      schema: ./schemas/classification.schema.json
    outputs:
      classification: state.classification
      complexity: state.complexity

  - id: route_model
    type: router
    policy: model_routing
    with:
      dataClassification: "{{state.classification}}"
      complexity: "{{state.complexity}}"
      localOnly: "{{input.local_only}}"
    outputs:
      selectedModel: state.selected_model
      reason: state.routing_reason

  - id: extract_actions
    type: llm
    model: "{{state.selected_model}}"
    skill: skill.extract-actions@1.0.0
    prompt:
      system: ./prompts/extract.system.md
      user: ./prompts/extract.user.md
    structuredOutput:
      schema: ./schemas/output.schema.json
    outputs:
      result: state.extraction_result
      confidence: state.confidence

  - id: critique
    type: llm
    when: "{{state.confidence < 0.85}}"
    model: local.fast
    prompt:
      system: ./prompts/critique.system.md
      user: ./prompts/critique.user.md
    structuredOutput:
      schema: ./schemas/critique.schema.json
    outputs:
      critique: state.critique

  - id: revise
    type: llm
    when: "{{state.critique.requiresRevision == true}}"
    model: "{{state.selected_model}}"
    prompt:
      system: ./prompts/revise.system.md
      user: ./prompts/revise.user.md
    structuredOutput:
      schema: ./schemas/output.schema.json
    outputs:
      result: state.extraction_result
      confidence: state.confidence

  - id: validate_output
    type: validate_json
    with:
      schema: ./schemas/output.schema.json
      data: "{{state.extraction_result}}"

  - id: require_review
    type: approval
    when: "{{state.confidence < 0.75}}"
    with:
      reason: "Confidence below threshold"
      reviewers:
        roles:
          - process-owner

  - id: write_output
    type: file_write
    with:
      path: "{{input.output || output.defaultTarget}}"
      content: "{{state.extraction_result}}"

edges:
  - from: read_input
    to: classify_data
  - from: classify_data
    to: route_model
  - from: route_model
    to: extract_actions
  - from: extract_actions
    to: critique
  - from: critique
    to: revise
  - from: revise
    to: validate_output
  - from: validate_output
    to: require_review
  - from: require_review
    to: write_output
```

---

## Skill Definition

Ein Skill ist kein Feature. Ein Skill ist eine wiederverwendbare KI-Faehigkeit.

Beispiel:

```text
Feature:
  meeting.extract-actions

nutzt Skill:
  skill.extract-actions

anderes Feature:
  email.extract-actions

nutzt denselben Skill:
  skill.extract-actions
```

Skill Pack:

```yaml
apiVersion: ai-runtime/v1
kind: Skill

metadata:
  id: skill.extract-actions
  version: 1.0.0
  owner: productivity-team

description: Extrahiert Aufgaben, Verantwortliche, Fristen und offene Fragen aus Text.

inputs:
  schema: ./schemas/input.schema.json

outputs:
  schema: ./schemas/output.schema.json

prompts:
  system: ./prompts/system.md
  user: ./prompts/user.md

quality:
  requiresStructuredOutput: true
  preferredModels:
    - local.fast
    - claude.strong

risk:
  level: low
  requiresHumanApproval: false

evals:
  path: ./evals
```

Trennung:

```text
Feature = Produkt-Use-Case
Skill = wiederverwendbare KI-Faehigkeit
Workflow = Ablauf
Tool = externe Aktion
Policy = Regelwerk
Model = Ausfuehrungsbackend
```

---

## TypeScript SDK als Kern

Nicht zuerst eine CLI bauen und spaeter SDK/API drumherum legen. Besser:

```text
@org/ai-runtime        Core Runtime
@org/ai-sdk            TypeScript SDK
@org/ai-cli            CLI Client
@org/ai-server         HTTP/API Server
@org/ai-ui             optionale Web UI
```

Alle Clients nutzen dieselbe Runtime-Logik:

```text
CLI      -> SDK / API -> Runtime
Webapp   -> SDK / API -> Runtime
n8n      -> API       -> Runtime
Agent    -> CLI/API   -> Runtime
cron     -> CLI       -> Runtime
```

Das verhindert, dass Policies, Logging, Routing und Kostenkontrolle in verschiedenen Clients dupliziert oder umgangen werden.

### Grobe TypeScript Interfaces

```ts
export interface FeatureDefinition {
  apiVersion: string;
  kind: "Feature";
  metadata: FeatureMetadata;
  command?: CommandDefinition;
  input: InputDefinition;
  output: OutputDefinition;
  data?: DataDefinition;
  routing?: RoutingDefinition;
  workflow: WorkflowReference;
  skills?: SkillReference[];
  policies?: string[];
  memory?: MemoryDefinition;
  evals?: EvalDefinition;
  ui?: UiDefinition;
}

export interface WorkflowDefinition {
  apiVersion: string;
  kind: "Workflow";
  metadata: WorkflowMetadata;
  state?: StateDefinition;
  steps: StepDefinition[];
  edges: EdgeDefinition[];
}

export type StepDefinition =
  | LlmStep
  | RouterStep
  | ToolStep
  | ConditionStep
  | ApprovalStep
  | FileReadStep
  | FileWriteStep
  | ValidateJsonStep
  | TransformStep
  | MemoryRetrieveStep
  | MemoryWriteStep
  | SubworkflowStep;

export interface LlmStep {
  id: string;
  type: "llm";
  model: string;
  skill?: string;
  prompt?: PromptReference;
  structuredOutput?: {
    schema: string;
    strict?: boolean;
  };
  outputs?: Record<string, string>;
  when?: string;
}

export interface ApprovalStep {
  id: string;
  type: "approval";
  when?: string;
  with: {
    reason: string;
    reviewers?: {
      users?: string[];
      roles?: string[];
    };
    onReject?: "stop" | "revise" | "escalate";
    timeout?: string;
  };
}

export interface ToolStep {
  id: string;
  type: "tool_call";
  tool: string;
  with?: Record<string, unknown>;
  requiresApproval?: boolean;
  outputs?: Record<string, string>;
}
```

Das SDK kompiliert YAML in typisierte Definitionen, validiert sie und fuehrt sie aus.

---

## Model Layer und Router

Der Router sollte mit einem Modellkatalog arbeiten, nicht mit hart codierten if/else-Regeln.

Beispiel:

```yaml
models:
  - id: local.fast
    provider: ollama
    model: llama3.1:8b
    capabilities:
      - summarize
      - classify
      - extract_json
    cost:
      inputPer1k: 0
      outputPer1k: 0
    dataResidency:
      cloud: false
      region: local

  - id: local.strong
    provider: ollama
    model: qwen3-coder:30b
    capabilities:
      - reasoning
      - code
      - extract_json
    cost:
      inputPer1k: 0
      outputPer1k: 0
    dataResidency:
      cloud: false
      region: local

  - id: claude.strong
    provider: anthropic
    model: claude-sonnet
    capabilities:
      - reasoning
      - writing
      - long_context
      - tool_use
    dataResidency:
      cloud: true
      region: vendor_managed
```

Routing-Regeln:

```yaml
routingPolicies:
  - id: model_routing
    rules:
      - if: data.classification == "private"
        use: local.strong

      - if: task.type in ["classify", "summarize", "extract_json"]
        use: local.fast

      - if: task.importance == "high" and data.classification != "private"
        use: claude.strong

      - if: local.confidence < 0.75 and data.classification != "private"
        use: claude.strong

      - default: local.fast
```

Jede Routing-Entscheidung muss auditierbar sein:

```json
{
  "run_id": "run_123",
  "feature_id": "meeting.extract-actions",
  "selected_model": "local.fast",
  "reason": "task=extract_json and data_classification=internal",
  "cloud_allowed": false,
  "policy_decision_id": "pol_789"
}
```

---

## Enterprise Readiness

Enterprise-ready bedeutet, die Plattform von Beginn an fuer Governance, Betrieb und Sicherheit zu entwerfen.

### Identity & RBAC

Fragen:

```text
Wer darf Feature ausfuehren?
Wer darf Feature veroeffentlichen?
Wer darf Cloud-Modelle nutzen?
Wer darf Tools mit Seiteneffekt nutzen?
Wer darf Approvals geben?
```

Beispiel:

```yaml
access:
  execute:
    roles: ["employee"]
  publish:
    roles: ["ai-platform-admin"]
  useCloudModels:
    roles: ["approved-cloud-ai-user"]
  approveExternalActions:
    roles: ["manager", "process-owner"]
```

### Data Classification

Jeder Run braucht eine Datenklasse:

```text
public
internal
confidential
private
regulated
```

Regeln:

```text
private      -> nur lokal
regulated    -> nur freigegebene Modelle
confidential -> Cloud nur nach Policy
public       -> Cloud erlaubt
```

### Human Approval Gates

Freigaben sind Pflicht fuer Side Effects:

```text
E-Mail senden
Ticket schliessen
Datei loeschen
CRM aendern
Zahlung ausloesen
Vertrag aendern
```

### Audit Log

Jeder Run muss rekonstruierbar sein:

```text
Wer?
Wann?
Welches Feature?
Welche Version?
Welcher Prompt?
Welches Modell?
Warum dieses Modell?
Welche Tools?
Welche Outputs?
Welche Approvals?
Welche Kosten?
```

### Observability

Nicht nur Logs, sondern:

```text
Traces
Metrics
Costs
Latency
Tokenverbrauch
Fehlerraten
Policy-Denials
Approval-Zeiten
```

### Evals und Regression Tests

Jedes Feature Pack sollte Testfaelle enthalten:

```bash
ai eval meeting.extract-actions
```

Checks:

```text
Output ist valides JSON
Pflichtfelder sind vorhanden
Keine verbotenen Daten im Cloud-Prompt
Kosten unter Limit
Antwortqualitaet gegen Beispielset
Privacy Checks
Style/Tone Checks
```

### Versionierung und Freigabeprozess

Feature Lifecycle:

```text
draft
validated
reviewed
approved
published
deprecated
blocked
```

---

## Runner als generische State Machine

Der Runner kennt nicht die Fachlichkeit eines Features. Er kennt nur Primitives.

Core Step Types fuer v0.1:

```text
llm
router
condition
approval
file_read
file_write
validate_json
```

Spaeter:

```text
transform
tool_call
subworkflow
memory_retrieve
memory_write
http_call
queue_event
agent_call
```

Runner-Schleife:

```text
1. Feature laden
2. Input validieren
3. Run erzeugen
4. Policies pruefen
5. Workflow-Graph bauen
6. Step ausfuehren
7. State persistieren
8. Logs/Traces schreiben
9. Naechsten Step bestimmen
10. Bei Approval pausieren
11. Bei Fehler retry/fail/escalate
12. Output validieren
13. Run abschliessen
```

Wichtig: Die Workflow-Engine kann sich an LangGraph orientieren, aber das Produktmodell sollte engine-unabhaengig bleiben.

```ts
interface WorkflowEngine {
  compile(workflow: WorkflowDefinition): CompiledWorkflow;
  run(compiled: CompiledWorkflow, input: RunInput): AsyncIterable<RunEvent>;
  resume(runId: string, approval: ApprovalDecision): AsyncIterable<RunEvent>;
}
```

---

## CLI UX

Minimal:

```bash
ai list
ai describe meeting.extract-actions
ai run meeting.extract-actions --input meeting.md
ai runs list
ai runs show run_123
ai runs resume run_123 --approve
ai eval meeting.extract-actions
```

Komfort-Kommandos aus Feature-Metadaten:

```bash
ai meeting extract-actions meeting.md
ai email draft-reply email.txt --tone professional
ai document summarize contract.pdf --local-only
ai invoice extract invoice.pdf --output invoice.json
```

Enterprise-Kommandos:

```bash
ai features validate ./features/meeting.extract-actions
ai features publish ./features/meeting.extract-actions
ai policy test ./features/meeting.extract-actions --data-class private
ai models list
ai costs report --from 2026-06-01
ai audit show run_123
```

CLI-first ist strategisch wertvoll, weil die gleiche CLI spaeter durch Menschen, Cron, n8n, Makefiles, CI oder Agenten orchestriert werden kann.

---

## UI Gedanken

Die UI sollte nicht die Source of Truth sein. Sie soll das Feature-Modell editieren, visualisieren und ausfuehren.

### Builder UI fuer Feature-Ersteller

Tabs:

```text
1. Overview
2. Input
3. Output
4. Prompts
5. Workflow
6. Models & Routing
7. Tools
8. Memory
9. Human Review
10. Evals
11. Publish
```

### Runtime UI fuer Nutzer und Operatoren

Views:

```text
Feature Catalog
Run Form
Live Run View
Approval Inbox
Run History
Cost Dashboard
Audit View
Error Queue
```

Die UI kann aus den Artefakten generiert werden:

```text
input.schema.json  -> Formular
output.schema.json -> Ergebnisansicht
workflow.yaml      -> Graph
policies           -> Warnungen / Publish Gates
approval steps     -> Review UI
evals              -> Qualitaetsdashboard
```

---

## Wo Konfiguration aufhoert und Code beginnt

Deklarativ per YAML/JSON/Markdown:

```text
Features
Commands
Prompts
Workflows
Routing-Regeln
Model-Auswahl
Approval-Regeln
Input-/Output-Schemas
Evals
Kostenlimits
```

Imperativ per Code:

```text
Neue Step-Typen
Neue Tool-Adapter
Neue Modellprovider
Neue Auth-Integrationen
Spezialtransformationen
Komplexe Datenzugriffe
Sandboxing
Policy Engine Integration
```

Richtwert:

```text
70-80 Prozent deklarativ
20-30 Prozent Plattform-Code / Custom Nodes
```

Custom Code sollte als registrierter Node laufen, nicht in Prompts versteckt sein:

```yaml
steps:
  - id: normalize_invoice
    type: custom
    handler: "@org/invoice-normalizer#normalize"
```

---

## Kritische Frage: Vereinfachen oder verkomplizieren wir Loop Engineering?

Nach dem Brainstorming sollte bewusst kritisch geprueft werden, ob diese Architektur Loop Engineering wirklich vereinfacht oder ob sie durch zu viel Metamodell, YAML, Registry und Governance zusaetzliche Komplexitaet schafft.

### Potenzieller Nutzen

Die Architektur kann Loop Engineering vereinfachen, wenn sie:

- wiederkehrende Agenten-Patterns standardisiert,
- Prompts, Schemas, Evals und Policies zusammen versioniert,
- Debugging ueber Run History und Traces erleichtert,
- Modellwechsel und Local/Cloud-Routing vereinheitlicht,
- Human Review und Approval Gates wiederverwendbar macht,
- Feature-Erstellung ohne Quellcode erlaubt,
- Templates fuer haeufige Workflows bereitstellt.

### Potenzielles Risiko

Sie kann Loop Engineering verkomplizieren, wenn:

- jeder kleine Prompt ein vollstaendiges Feature Pack braucht,
- YAML/JSON fuer einfache Aufgaben zu schwergewichtig wird,
- die UI nur Metadaten verwaltet statt Arbeit zu erleichtern,
- Custom Nodes doch wieder ueberall noetig werden,
- Debugging zwischen Runner, Policy Engine, Router und Modelladapter zu indirekt wird,
- Nutzer mehr Plattformwissen als fachliches Wissen brauchen.

### Designprinzip zur Entschaerfung

Die Plattform braucht mehrere Einstiegstiefen:

```text
Level 1: Single Prompt Feature
Level 2: Prompt + Schema + Model Routing
Level 3: Multi-Step Workflow + Evals
Level 4: Tools + Human Review + Memory
Level 5: Enterprise Governance + Approval + Audit
```

Nicht jedes Feature darf gezwungen werden, sofort Level 5 zu sein.

---

## Vorgeschlagener Skill: Feature Pack / Workflow Artifact Generator

Um Erweiterung, Anpassung und Korrektur so einfach wie moeglich zu machen, sollte es einen eigenen Skill geben, der Feature-, Workflow- und Skill-Artefakte erzeugen, validieren und verbessern kann.

Name-Idee:

```text
skill.feature-pack-author
skill.workflow-artifact-generator
skill.ai-runtime-feature-builder
```

Aufgabe dieses Skills:

```text
Aus einer fachlichen Beschreibung ein vollstaendiges Feature Pack erzeugen:
- feature.yaml
- workflow.yaml
- prompts/*.md
- schemas/*.json
- evals/*.yaml
- README.md
- CHANGELOG.md
```

Der Skill sollte auch existierende Artefakte anpassen koennen:

```text
- Feature erweitern
- Prompt verbessern
- Output-Schema schaerfen
- Eval-Cases hinzufuegen
- Policy-Regeln ergaenzen
- Model Routing anpassen
- Workflow vereinfachen
- Feature von Level 1 auf Level 2/3/4 heben
```

Wichtig: Dieser Skill darf nicht nur Dateien erzeugen, sondern muss gegen Plattformregeln validieren:

```text
- YAML syntaktisch valide?
- JSON Schema valide?
- Referenzierte Prompts vorhanden?
- Referenzierte Skills vorhanden?
- Referenzierte Models vorhanden?
- Policies konsistent?
- Output-Schema zum Prompt passend?
- Eval-Cases vorhanden?
- Keine Cloud-Fallbacks bei private data?
```

Damit wird die Plattform selbst wieder einfacher nutzbar: User beschreiben, was sie brauchen; der Skill erzeugt die Artefakte; die Runtime validiert und fuehrt aus.

### Beispiel-Prompt fuer den Skill

```text
Erstelle ein neues Feature Pack fuer:
"Meeting-Notizen analysieren und Aufgaben, Entscheidungen und offene Fragen extrahieren."

Anforderungen:
- CLI Command: ai meeting extract-actions <file>
- Input: Markdown oder Plain Text
- Output: strukturiertes JSON
- Default Modell: local.fast
- Fallback: claude.strong nur fuer nicht-private Daten
- Human Review bei Confidence < 0.75
- Eval Cases fuer leere Meetings, unklare Verantwortliche und Datenschutz
```

### Wichtigster Effekt

Dieser Skill wird zum Multiplikator fuer die ganze Plattform. Er reduziert die Gefahr, dass die Konfiguration selbst zu kompliziert wird.

---

## MVP Vorschlag

Nicht sofort alles bauen. Enterprise-kompatibel starten.

### v0.1 Primitives

Step Types:

```text
llm
router
condition
approval
file_read
file_write
validate_json
```

Model Adapter:

```text
ollama.local
claude.cloud
```

Policies:

```text
no_cloud_for_private_data
max_cost_per_run
approval_for_external_output
```

CLI:

```bash
ai list
ai describe meeting.extract-actions
ai run meeting.extract-actions --input meeting.md
ai runs list
ai runs show <run-id>
ai eval meeting.extract-actions
ai feature validate ./features/meeting.extract-actions
```

Erste Features:

```text
document.summarize
meeting.extract-actions
email.draft-reply
research.briefing
```

### v0.2

```text
Skill Registry
Feature Pack Generator Skill
Eval Runner erweitert
Run Store in Postgres
OpenTelemetry Traces
Approval Inbox minimal
HTTP API
```

### v0.3

```text
Builder UI
Graph View
Policy Dashboard
Model Comparison
Prompt Versioning
Memory Layer
Tool Registry erweitert
```

---

## Offene Architekturfragen

1. Wie leichtgewichtig muss Level-1 Feature-Erstellung sein?
2. Wird YAML fuer Nutzer sichtbar oder primär durch UI/Skill erzeugt?
3. Soll LangGraph echte Runtime-Abhaengigkeit sein oder nur Denkmodell?
4. Wie viel Policy in YAML, wie viel in OPA/Policy-Code?
5. Wie wird Data Classification gesetzt: manuell, automatisch oder hybrid?
6. Wie werden Prompts versioniert und evaluiert?
7. Wie werden lokal generierte Outputs bewertet, bevor Claude-Fallback erlaubt ist?
8. Welche Outputs duerfen automatisch persistiert werden?
9. Welche Tools duerfen Side Effects haben?
10. Wie verhindert man, dass Feature Packs zu schwergewichtig werden?
11. Wie baut man eine gute Dev Experience fuer Feature-Ersteller?
12. Wie wird ein Agent eingeschraenkt, der die CLI orchestriert?
13. Wie werden Secrets, Credentials und Tenant-Kontexte verwaltet?
14. Wie werden Kosten und Modellqualitaet transparent verglichen?
15. Wie sehen Rollback und Deprecation fuer Feature-Versionen aus?

---

## Kurzfazit

Die Architektur ist stark, wenn sie die richtige Balance haelt:

```text
Nicht: alles ist ein Prompt.
Nicht: alles ist harte Softwareentwicklung.
Sondern: Features als versionierte, validierbare AI-Automation-Pakete.
```

Der Kern ist:

```text
Feature = fachlicher Use Case
Skill = wiederverwendbare KI-Faehigkeit
Workflow = ausfuehrbarer Graph
Policy = Sicherheits- und Governance-Regel
Model = lokales oder Cloud-Ausfuehrungsbackend
Tool = kontrollierte externe Aktion
Run = auditierbare Ausfuehrung
```

Die naechste Arbeitsfrage ist nicht nur, wie das Datenmodell aussieht, sondern ob dieses System Loop Engineering wirklich einfacher macht. Der wahrscheinlich wichtigste Hebel dafuer ist ein eigener Feature-Pack-Builder-Skill, der Feature-, Workflow-, Prompt-, Schema- und Eval-Artefakte automatisch anlegt, korrigiert und validiert.

---

> _Quelle: Hippocampus Knowledge Store — Eintrag `6cc025a2-0ba3-4ec4-b068-0a6f99365fbd`, Domain `AI`, Typ `note`._
> _Tags: AI Agents, Enterprise AI, AI Governance, Agent Evaluation, Agent Memory, Platform Strategy, Agent Orchestration, Loop Engineering, Agent Platform._
> _Original: ChatGPT brainstorming, 2026-06-26. Heruntergeladen am 2026-06-26._
