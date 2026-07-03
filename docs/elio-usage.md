# ELIO v0.1 — Usage Guide

How to use ELIO across its four surfaces: the **SDK** (the core), the **CLI**, the **MCP server**, and the **Studio dashboard**. Plus how to write a feature pack, run the migrate dogfood, and the known v0.1 limits.

> All demos are **offline and deterministic** — they use the built-in `MockModel`, so nothing here needs an API key or network.

---

## Install & build

```bash
pnpm install
pnpm build
```

> **Use the ROOT `pnpm build`.** It runs `tsc -b && node scripts/fix-esm-extensions.mjs`. The second step rewrites the emitted ESM import extensions so the package bins run under Node. `pnpm -r build` skips it and the bins fail with `ERR_MODULE_NOT_FOUND`.

Verify:

```bash
pnpm typecheck   # tsc -b
pnpm test        # vitest run — 361 tests
pnpm lint        # eslint .
```

The three runnable bins after a build:

| Bin | Path | Purpose |
|---|---|---|
| `elio` | `packages/cli/dist/bin.js` | CLI |
| `elio-mcp` | `packages/mcp/dist/bin.js` | MCP server (stdio) |
| `elio-studio` | `packages/studio/dist/bin.js` | Studio dashboard (HTTP) |

The four features available on every surface:

- `demo.draft-until-good` — Outer-Loop convergence demo (draft until a min-length gate passes).
- `demo.retry-then-pass` — Failed → retry → Resolved, then a passing gate.
- `migrate.csv-to-db` — the CSV→DB migration dogfood vertical.
- `build-skill` — the skill-generator meta-vertical (the artifact it builds is a Claude-Code SKILL.md).

Plus one **online** demo on the CLI/SDK (the others are offline/MockModel):

- `demo.local-agent` — a local **Ollama** agent drives the Outer Loop. `ctx.agent` is the transparent
  `InProcessAgentEngine` (a bounded multi-turn loop — **no LangGraph**, no external agent library); its
  model calls flow through `ctx.model`, which is an `OllamaModel` hitting `http://localhost:11434`. Requires
  a running Ollama with the model pulled (`ollama pull llama3`). See [Run a local Ollama agent](#run-a-local-ollama-agent-demolocal-agent).

The CLI additionally accepts a filesystem path to a `feature.yaml`.

---

## CLI

Package `elio`, bin `packages/cli/dist/bin.js`. A thin client over `@elio/sdk` with a hand-rolled arg parser. Exit codes: **0** = gate `passed`; **1** = stopped / error / suspended-and-unanswered; **2** = usage error.

### `elio --help`

```bash
node packages/cli/dist/bin.js --help
```

Aliases: `-h`, `help`, and no args all print usage and exit `0`. Output (verbatim):

```text
elio — ELIO CLI (dünner Client über @elio/sdk)

Usage:
  elio run <feature>                       Feature laden + ausführen, RunEvents streamen,
                                           an einem Approval (node-suspended) interaktiv prompten.
  elio resume <feature> <correlation-id> [answer]
                                           Einen suspendierten Run über die correlation-id resumen.
  elio runs <feature>                      Runs im Store auflisten (id, feature, phase, waitingOn).
  elio --help | -h                         Diese Hilfe.

<feature> ist eine built-in id oder ein Pfad zu einer feature.yaml:
  demo.draft-until-good
  demo.retry-then-pass
  migrate.csv-to-db
  build-skill
  ./path/to/feature.yaml
```

(The verbatim `--help` also documents the `run` flags — `--csv`, `--out`, `--no-prompt` — and a short `build-skill` blurb; see the [`build-skill` subsection](#build-skill-skill-generator) below.)

### `elio run <feature>`

Loads the feature (built-in id **or** path to a `feature.yaml`), runs it through the SDK runtime with `{ payload: {}, budget: 1000, maxDepth: 200 }`, and streams each `RunEvent` as a human-readable line. At a `node-suspended` elicitation it prompts on stdin (the Approval Inbox) and resumes **in-process** with your answer — works both at an interactive TTY and with piped/scripted stdin — looping until completion or until no answer is given.

```bash
node packages/cli/dist/bin.js run demo.draft-until-good
```

This run converges and exits `0` on `run-completed{gate:"passed"}`. `demo.retry-then-pass` behaves the same way:

```bash
node packages/cli/dist/bin.js run demo.retry-then-pass
```

**Flags:**

- `--csv <content>` — sets the CSV sample for the `migrate.csv-to-db` vertical (mapped to `migrateCsv`).
- `--out <dir>` — sets the output directory for the `build-skill` vertical (mapped to `skillOutDir`; default: a fresh temp dir). `write_skill` is fs-write **confined** to exactly this directory (Inv. 14).
- `--no-prompt` — do **not** prompt at an approval; leave the run suspended instead.

```bash
# Run the migrate vertical and stop at the commit approval instead of prompting:
node packages/cli/dist/bin.js run migrate.csv-to-db --no-prompt
```

### The approval-inbox flow (run → suspend → resume, in one invocation)

The migrate feature suspends at a `commit` approval (`suspend: blocking`). Without `--no-prompt`, `elio run` prompts you on stdin. Answers are parsed by `parseAnswer` (shared with the Studio dashboard):

| You type | Becomes |
|---|---|
| `y` `yes` `approve` `ok` `true` | `{ "approved": true }` |
| `n` `no` `deny` `reject` `false` | `{ "approved": false }` |
| valid JSON | the parsed value |
| any other text | the raw string |

```bash
node packages/cli/dist/bin.js run migrate.csv-to-db
# ... streams events, then at the commit approval prompts on stdin.
# At an interactive terminal, type:  y  <Enter>  -> { "approved": true }
# -> the run resumes in-process and continues to run-completed{gate:"passed"}.
```

The complete `run → suspend → resume` cycle works **end-to-end within this single `elio run`**, for both an interactive TTY and piped/scripted stdin.

> **Works non-interactively too.** The in-process cycle handles **piped or scripted stdin** as well as an interactive terminal — `printf 'y\n' | node packages/cli/dist/bin.js run migrate.csv-to-db` resumes through the commit approval to `gate=passed`. (For cross-process or programmatic resume — answering a run from a *different* process — use the engine-level resume: the SDK `runtime.resume(correlation, answer)` or Studio's `POST /api/resume`.)

### `elio resume <feature> <correlation-id> [answer]`

```bash
node packages/cli/dist/bin.js resume migrate.csv-to-db "run/branch/step#checkpoint"
node packages/cli/dist/bin.js resume migrate.csv-to-db "run/branch/step#checkpoint" '{"approved":true}'
```

`<feature>` is positional (or `--feature <f>`), then the `correlation-id` (form `run/branch/step#checkpoint`, codec `encode/decodeCorrelation`), then an optional `[answer]`. When `[answer]` is omitted it defaults to `{ approved: true }`.

> **v0.1 limit:** the store is in-memory and process-local. A `resume` in a *new* process cannot find a checkpoint created by an earlier `elio run` process — the command reports this explicitly. Cross-process resume is v0.2. Use the in-process flow above for the working approval cycle.

### `elio runs <feature>`

```bash
node packages/cli/dist/bin.js runs demo.draft-until-good
```

Lists runs from the store via `runtime.store.liveStatus()` (id, feature, phase, waitingOn). In a fresh process the store is empty, so it prints an explanatory v0.1 note — that is expected, not a bug.

### Copy-pasteable CLI reference

```bash
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js run demo.draft-until-good
node packages/cli/dist/bin.js run demo.retry-then-pass
node packages/cli/dist/bin.js run migrate.csv-to-db
node packages/cli/dist/bin.js run ./path/to/feature.yaml
node packages/cli/dist/bin.js run migrate.csv-to-db --no-prompt
# Online demo — needs a running Ollama (ollama pull llama3):
node packages/cli/dist/bin.js run demo.local-agent
```

---

## SDK

Package `@elio/sdk` (`main: ./dist/index.js`, `types: ./dist/index.d.ts`). The barrel `export * from "@elio/core"` so all core contracts are re-exported through the SDK, plus the runtime facade, the YAML loader, the demo packs, the model adapters, and the fs/db/secrets services. It also exports `ELIO_SDK_VERSION`.

### Run a demo feature & consume `RunEvent`s

`createDemoRuntime()` builds a runtime with both demo node-sets and their artifact types registered — the simplest one-call entry point.

```ts
import { createDemoRuntime, draftUntilGoodPack, type RunEvent } from "@elio/sdk";

const rt = createDemoRuntime();
const input = { payload: {}, budget: 10, maxDepth: 4 };

for await (const ev of rt.run(draftUntilGoodPack, input)) {
  if (ev.type === "cost-delta") console.log("cost", ev.total);
  if (ev.type === "run-completed") console.log("done, gate:", ev.gate);
}
```

`retryThenPassPack` runs the same way against the same `rt`. `RunInput` is `{ artifact?, payload, budget, maxDepth }`. A `RunEvent`'s `type` is one of `run-started | step-started | node-resolved | node-suspended | elicitation-resolved | artifact-updated | cost-delta | run-completed`; the terminal event is `{ type: "run-completed", correlation, artifact, gate: "passed" | "stopped" }`.

### Load & run a YAML feature

```ts
import { createRuntime, loadFeaturePackFromFile, collectEvents } from "@elio/sdk";

const rt = createRuntime();
// Register any custom node types your YAML's steps reference, e.g.:
// rt.registry.register(myCustomNodeDef);

const pack = loadFeaturePackFromFile("/abs/path/to/feature.yaml");
const events = await collectEvents(rt.run(pack, { payload: {}, budget: 10, maxDepth: 4 }));
console.log(events.at(-1)); // run-completed
```

For an inline YAML string use `loadFeaturePack({ yaml, baseDir })`. The loader **compiles only** — it executes nothing; step types resolve at run time via the registry. Loader API: `loadFeaturePack({ path | yaml, baseDir? })`, `loadFeaturePackFromFile(path)`, `computeContentHash(pack, baseDir?)`; throws `FeaturePackError` on malformed packs.

### Top-level `run` / `resume`

`run(pack, input)` and `resume(id, answer, opts?)` delegate to a lazy default runtime (`getDefaultRuntime()`); `setDefaultRuntime(rt)` replaces it. `collectEvents(stream)` drains a stream into an array.

```ts
import { run, collectEvents, draftUntilGoodPack } from "@elio/sdk";
const events = await collectEvents(run(draftUntilGoodPack, { payload: {}, budget: 10, maxDepth: 4 }));
```

> Note: `run`/`resume` against the default runtime won't have the demo node-sets registered unless you set a runtime that does (e.g. `setDefaultRuntime(createDemoRuntime())`). For demos, calling `createDemoRuntime()` and using `rt.run(...)` is the straightforward path.

### Wire models (mock default; Claude / Ollama)

With no `model`/`models`, `createRuntime()` builds an `LlmWorker` over `{ mock: new MockModel() }` (default model `"mock"`, concurrency `4`). For real providers, pass a `ProviderMap`:

```ts
import { createRuntime, MockModel, ClaudeModel, OllamaModel } from "@elio/sdk";

// Default — offline, deterministic:
const mockRt = createRuntime();

// Real providers; createRuntime builds the concurrency-gated LlmWorker for you.
// Keys are exact model ids OR prefixes; req.model is routed by exact match then longest prefix.
const rt = createRuntime({
  models: {
    mock: new MockModel(),
    claude: new ClaudeModel({ apiKey: process.env.ANTHROPIC_API_KEY }), // default "claude-opus-4-8"
    llama3: new OllamaModel({ baseUrl: "http://localhost:11434" }),
  },
  defaultModel: "claude-opus-4-8",
  concurrency: 4,
});
// rt.model is the LlmWorker that sits behind ctx.model.
```

You can also pass a fully built `model: new LlmWorker({ providers, defaultModel })`; `model` takes priority over `models`.

Adapter facts:

- **`MockModel`** — deterministic, no network; `usd: 0`. Options: `model` (default `"mock"`), `confidence` (default `1`), `transform` (default prefixes `"echo: "`), `charsPerToken` (default `4`).
- **`OllamaModel`** — POSTs `/api/chat`; `usd: 0` (local). Options: `baseUrl` (default `http://localhost:11434`), `defaultModel` (default `"llama3"`), `fetchImpl`, `confidence` (default `0.8`).
- **`ClaudeModel`** — raw `fetch` to `https://api.anthropic.com/v1/messages`, header `anthropic-version: 2023-06-01`; supports `complete` + SSE `stream`. Options: `apiKey` (default `process.env.ANTHROPIC_API_KEY`), `defaultModel`, `maxTokens` (default `1024`), `fetchImpl`, `confidence` (default `0.9`), `endpoint`. Exports const `DEFAULT_CLAUDE_MODEL = "claude-opus-4-8"`; pricing for `claude-opus-4-8` = $5 in / $25 out per 1M tokens.

### Run a local Ollama agent (`demo.local-agent`)

A worked example of a **local agent driving the Outer Loop — no cloud, no LangGraph**. The `agent` node
delegates to the transparent `InProcessAgentEngine` (`ctx.agent`), an elio-owned bounded multi-turn inner
loop. Every model call in that loop goes through `ctx.model`, which here is an `OllamaModel` talking to
`http://localhost:11434`. So you get a real agent loop on a local model, with full per-call governance and
`usd: 0` cost — and the orchestration is elio's own engine, not an external agent library.

**Prerequisite:** a running Ollama with the model pulled:

```bash
ollama pull llama3          # the model demo.local-agent uses by default
# Ollama serves on http://localhost:11434 automatically.
```

CLI:

```bash
node packages/cli/dist/bin.js run demo.local-agent
# Streams RunEvents; exits 0 on run-completed{gate:"passed"}.
# If Ollama isn't running you get a clear connection error (exit 1) — that's expected, not a bug.
```

SDK — `createLocalAgentRuntime()` wires `OllamaModel` behind the engine for you; the `ollama` option
forwards to the adapter (e.g. a `fetchImpl` for offline/deterministic tests, or a custom `baseUrl`):

```ts
import { createLocalAgentRuntime, localAgentPack, collectEvents } from "@elio/sdk";

const rt = createLocalAgentRuntime();                 // OllamaModel on localhost:11434 + InProcessAgentEngine
// const rt = createLocalAgentRuntime({ ollama: { baseUrl: "http://my-host:11434" } });

const events = await collectEvents(rt.run(localAgentPack, { payload: {}, budget: 1000, maxDepth: 200 }));
const completed = events.find((e) => e.type === "run-completed");
console.log(completed?.gate); // "passed"
```

Want an agent on a cloud model instead? Same shape — pass `models: { llama3: new OllamaModel() }` →
`models: { claude: new ClaudeModel(...) }` and keep the default `agentEngine`; the engine is provider-neutral.

### Provider profiles & model selection (`provider:model`)

A feature pins **which** model each step uses; the environment supplies **how** to reach it. That split keeps
features reproducible (the model choice lives in the versioned `feature.yaml`) while endpoints/credentials
stay out of the YAML.

**In a step** (authoring uses two fields; internally canonicalised to `provider:model`):

```yaml
steps:
  - id: draft
    type: agent           # or: llm
    with:
      provider: ollama    # the provider profile
      model: llama3       # the model within that profile
      prompt: "…"
```

This routes through `ctx.model` → `LlmWorker` → the `ollama` profile, and the adapter receives the bare
model (`llama3`). The canonical spec `ollama:llama3` shows up in the loop tape / `cost.model` for audit.
Ollama tags work too (`model: llama3:8b` → only the first colon splits the profile). Other profiles:
`claude:claude-opus-4-8`, `azure-openai:<deployment>` (e.g. `azure-openai:gpt-4o`). **Azure OpenAI is now
fully wired** (`complete()` + SSE `stream()`); see the [Azure OpenAI provider](#azure-openai-provider)
subsection below.

**Provider matrix:**

| Profile | Reach | Network | Cost (`cost.usd`) | Notes |
|---|---|---|---|---|
| `mock` | always present | none | `0` | deterministic; the offline default. |
| `ollama` | local daemon | `localhost:11434` | `0` | auto-detected; tag syntax `model:tag` preserved. |
| `claude` | cloud | `api.anthropic.com` | from profile | needs `ANTHROPIC_API_KEY`. |
| `azure-openai` | cloud | your Azure resource | from profile | fully wired (`complete`/`stream`); needs endpoint + key + deployment. |

> **Cost is a per-profile estimate, not a built-in price table.** There is no precise `PRICE_PER_MTOK` table
> any more. A profile carries a rough `cost` (`tier` + optional `usdPerMTok`); when `usdPerMTok` is set, the
> `LlmWorker` stamps `cost.usd` from the returned token counts. Without it, `cost.usd` is `0` (tokens are still
> reported). Adapters themselves report `usd: 0` — money is a profile concern (see named profiles below).

#### Named profiles (`elio.profiles.yaml`)

The profile keys above (`ollama`, `claude`, …) are the built-in defaults (provider type = profile name). For
real reproducibility — two Ollama endpoints, prod vs. test Azure deployments, environment-specific creds — you
define **named** profiles. A profile is a named, environment-specific provider config; the feature pins the
**name**, the environment supplies endpoint/creds. Discovery: `$ELIO_PROFILES`, else `elio.profiles.yaml`
(`.yml`/`.json`) in the cwd. Secrets are **referenced**, never inlined.

```yaml
# elio.profiles.yaml
profiles:
  fast-local:                         # -> step: { provider: fast-local, model: llama3 }
    kind: ollama
    baseUrl: http://localhost:11434
    cost: { tier: free }
  prod-azure:                         # -> step: { provider: prod-azure, model: gpt-4o }
    kind: azure-openai
    endpoint: https://my-res.openai.azure.com
    deployment: gpt-4o
    apiKeySecret: AZURE_PROD_KEY      # resolved via the SecretsProvider (env/vault), NOT inlined
    cost: { tier: high, usdPerMTok: { in: 2.5, out: 10 } }
  review:
    kind: claude
    apiKeySecret: ANTHROPIC_API_KEY
    cost: { tier: high, usdPerMTok: { in: 5, out: 25 } }
```

- **Credentials** resolve through the existing `SecretsProvider` (`apiKeySecret: <name>`) — a profile's key is
  a granted capability, governance-consistent (Inv. 14). No secrets in the YAML.
- **Governance**: a runtime allows a profile via a `<name>:*` wildcard in `allowedModels`; a feature still pins an
  exact `name:model`. So you can allow `review:*` but not `prod-azure:*`.
- **Programmatic**: `registerProfile({ name, kind, … })` from the SDK (merged with the file; explicit wins).
- **Preflight** resolves each pinned profile name → kind → reachability/credential check before the loop.

**Resolving profiles** — `resolveProviderProfiles(opts?)` (async) builds the `ProviderMap` from env + opts:

```ts
import { resolveProviderProfiles, createRuntime } from "@elio/sdk";

const { providers, defaultModel, allowedModels } = await resolveProviderProfiles();
// mock is always present; ollama if reachable (auto-detect) or $OLLAMA_HOST; claude if $ANTHROPIC_API_KEY;
// azure-openai if BOTH $AZURE_OPENAI_ENDPOINT and $AZURE_OPENAI_API_KEY are set.
const rt = createRuntime({ models: providers, defaultModel, rootPolicy: { allowedModels, /* … */ } });
```

`resolveProviderProfiles()` auto-registers `azure-openai` only when **both** `AZURE_OPENAI_ENDPOINT` and
`AZURE_OPENAI_API_KEY` are present (it also forwards `AZURE_OPENAI_DEPLOYMENT` / `AZURE_OPENAI_API_VERSION`
if set). The resulting `allowedModels` is built from the profiles that are actually configured (e.g.
`["mock", "azure-openai:*"]`) — not from all known providers — so policy gating stays security-by-absence
(Inv. 13/14).

- **Auto-detect default**: with no explicit choice it probes Ollama at `http://localhost:11434/api/tags`;
  reachable → default `ollama:<model>`, else `mock`. Disable with `ELIO_DISABLE_AUTODETECT=1`, or force a
  choice with `ELIO_MODEL=mock` (also `--model` on the CLI).
- **Policy wildcards**: `allowedModels` accepts `"*"` and `"<provider>:*"` (e.g. `"ollama:*"`) so a runtime
  can broadly allow a profile while a feature still pins an exact model (security by absence, Inv. 13/14).

**Preflight (fail fast)** — before the loop starts, ELIO validates every profile a feature's steps pin:
defined in the runtime **and** reachable (Ollama is probed at `/api/tags`; Azure checks `isConfigured()` —
endpoint + api-key + deployment all present; mock/claude are ready once defined). One aggregated, clear error
if anything is missing — no mid-run surprise. `elio run <feature>` does this automatically; programmatically:

```ts
import { preflightFeature, assertPreflight } from "@elio/sdk";
assertPreflight(await preflightFeature(pack, { providers: rt.providers ?? {} }));
```

**On the CLI**, the normal path is just `elio run <feature.yaml>` — the feature self-describes its models and
auto-detect fills in the profiles. The `--model <spec>` flag accepts any canonical `provider:model` spec
(`ollama:llama3`, `claude:claude-opus-4-8`, `azure-openai:gpt-4o`, or `mock`) and applies to **every**
feature — the built-in verticals `migrate.csv-to-db` and `build-skill` as well as a `feature.yaml`. Other
overrides: `--ollama-url http://host:11434` (independent of `--model`; both can be combined). Precedence for
the default model: explicit `--model` (→ `resolveProviderProfiles({ model })`) wins over `ELIO_MODEL`, which
wins over Ollama auto-detect, which falls back to `mock`.

```bash
# Drive the migrate vertical's propose_mapping agent with a local Ollama model instead of MockModel:
node packages/cli/dist/bin.js run migrate.csv-to-db --model ollama:llama3

# Draft a skill body with Azure OpenAI (needs the AZURE_OPENAI_* env, see below):
node packages/cli/dist/bin.js run build-skill --model azure-openai:gpt-4o --out ./skills
```

### Azure OpenAI provider

`AzureOpenAiModel` (`@elio/sdk`) is a **fully implemented** adapter — `complete()` and SSE `stream()` over raw
`fetch` (no SDK, no new runtime dependency), OpenAI-compatible wire format. It POSTs to
`{endpoint}/openai/deployments/{deployment}/chat/completions?api-version={apiVersion}` with an `api-key`
header (not `authorization`); the system prompt is sent as the **first** `role: "system"` message (there is no
top-level `system` field like Claude), and the deployment is routed via the URL, not the `model` body field.
`cost.usd` is computed from the `usage` tokens against the price table (`gpt-4o` = $2.5 in / $10 out,
`gpt-4o-mini` = $0.15 / $0.6 per 1M; unknown model → `0`).

Environment (read by `resolveProviderProfiles()`):

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | yes | — | resource endpoint, e.g. `https://my-res.openai.azure.com`. |
| `AZURE_OPENAI_API_KEY` | yes | — | the resource API key (sent as the `api-key` header). |
| `AZURE_OPENAI_DEPLOYMENT` | for use | — | the deployed model name; routes the request URL. |
| `AZURE_OPENAI_API_VERSION` | no | `2024-10-21` | the chat-completions API version. |

A profile is `isConfigured()` (and so passes preflight) only when **endpoint + api-key + deployment** are all
present. In a step, pin it as `provider: azure-openai` / `model: <deployment>`:

```yaml
steps:
  - id: draft
    type: agent              # or: llm
    with:
      provider: azure-openai # the Azure profile
      model: gpt-4o          # the deployment name (Azure routes by deployment, the model is for audit)
      prompt: "…"
```

```bash
export AZURE_OPENAI_ENDPOINT="https://my-res.openai.azure.com"
export AZURE_OPENAI_API_KEY="…"
export AZURE_OPENAI_DEPLOYMENT="gpt-4o"          # optional if your step pins model:
# export AZURE_OPENAI_API_VERSION="2024-10-21"   # optional; this is the default
node packages/cli/dist/bin.js run ./path/to/feature.yaml
```

### Feature packs with cloud models

A YAML feature can pin any profile per step via `with.provider` + `with.model`; preflight then enforces that
the pinned profile is configured + reachable before the loop starts. The two shipped verticals both route
their intelligence step through `ctx.model`, so they take a model override with no YAML change:

- **`migrate.csv-to-db`** — the `propose_mapping` step is `type: agent` and calls `ctx.model` (MockModel by
  default). Override it with `--model` on the CLI or the `model` param via MCP — e.g. drive the mapping with
  `claude:claude-opus-4-8` or `azure-openai:gpt-4o`.
- **`build-skill`** — the `draft_skill` step enriches the SKILL.md body via a one-shot `ctx.model` call
  (MockModel offline by default). Same overrides apply (`--model` / MCP `model` param).

Without `--model`/`--ollama-url` (CLI) or a `model` arg (MCP), the verticals stay **offline and deterministic**
on MockModel. The Root-Policy `allowedModels` (built from the resolved profiles) still gates which providers a
run may use, so an override only takes effect for a profile the runtime actually configured (Inv. 13/14).

### `createRuntime` options (selected real fields)

`store?`, `registry?`, `model?: ModelService`, `models?: ProviderMap`, `agentEngine?`, `defaultModel?` (default `"mock"`), `concurrency?` (default `4`), `rootPolicy?`, `policyRegistry?`, `artifactTypes?`, `secretsProvider?`, `fs?: FsService`, `db?: DbService`, `redactor?`, `injector?`, `registerBuiltins?` (default `true`).

The `Runtime` interface: `run(pack, input)` and `resume(id, answer, opts?)` (both `AsyncIterable<RunEvent>`); readonly props `registry`, `policyRegistry`, `store`, `runner`, `model`. The `expectedPackVersion` resume-pinning option is real.

---

## Persistent run store (`.elio/runs`) — cross-process `runs` / `resume`

The CLI persists runs to a durable **`FileRunStore`** so `elio runs` / `elio resume` work **across processes**
(the in-memory store is process-local). Location: `$ELIO_STATE_DIR`, else `<cwd>/.elio/runs` (git-ignored).

```bash
# Process A: run, suspend at the commit approval, leave it suspended.
node packages/cli/dist/bin.js run migrate.csv-to-db --no-prompt

# Process B (later, new process): the run is listed…
node packages/cli/dist/bin.js runs migrate.csv-to-db
#   Runs (1):  … migrate.csv-to-db  suspended  step=commit …

# …and resumable. The <feature> arg supplies the pack; the run comes from the store.
node packages/cli/dist/bin.js resume migrate.csv-to-db <run/branch/step#checkpoint> '{"approved":true}'
```

How cross-process resume reconstructs the run context: the checkpoint persists a full **artifact snapshot**;
the store persists the **run input** (budget/depth); the **`<feature>` argument** re-supplies the pack. With all
three, a fresh process rebuilds the context and continues. Missing any → a clear error (no silent run).

- **SDK**: `new FileRunStore(dir)` implements the same `RunStore` contract as `InMemoryRunStore` (it extends it:
  in-memory hot state for the runner + live SSE, plus disk persistence + hydration). `createRuntime({ store })`,
  `setupMigrate({ store })`, `setupSkillBuilder({ store })`, `createDemoRuntime({ store })` all accept it.
- **Out of scope (by design)**: cross-process *live* `subscribe()`/SSE — Studio stays in-process. Durability for
  `runs`/`resume` is the goal. A future DB-backed store can dock at the same contract.

## MCP server

Package `@elio/mcp`, bin `packages/mcp/dist/bin.js`. Built on `@modelcontextprotocol/sdk`. **stdio transport only** — stdout is the JSON-RPC channel, the "connected" notice goes to **stderr**.

### Start it

```bash
node packages/mcp/dist/bin.js
```

Server identity at initialize: name `elio-mcp`, version `0.0.0`, capabilities `{ tools: {} }`, plus `instructions` describing the ELIO surface. Handlers: `ListToolsRequestSchema` and `CallToolRequestSchema` only — no resources, no prompts.

### Connect a client (stdio)

Register the server command `node packages/mcp/dist/bin.js` (no args). Example Claude Code MCP config:

```json
{
  "mcpServers": {
    "elio": { "command": "node", "args": ["/home/leon/workspaces/elio/packages/mcp/dist/bin.js"] }
  }
}
```

### List & call feature-tools

There is **one tool per feature**, named by feature id (stable order): `demo.draft-until-good`, `demo.retry-then-pass`, `migrate.csv-to-db`, `build-skill`. Each tool's `inputSchema` is the feature's input schema, always augmented with optional run params: `csv` (string, for the migrate vertical), the `build-skill` brief fields (`name`/`description`/`purpose`/`whenToUse`/`instructions`, all optional strings), `budget` (number, overrides server default), `maxDepth` (number, overrides server default), `model` (string, an optional per-call canonical `provider:model` spec), and `ollamaUrl` (string, an optional Ollama endpoint override).

**Per-call model override.** The optional `model` param is a canonical spec like `ollama:llama3`,
`claude:claude-opus-4-8`, `azure-openai:gpt-4o`, or `mock`. It is consumed by the per-call runtime façade
(via `resolveProviderProfiles({ model, ollamaUrl })`) — **not** forwarded into the run `payload`. On the
**demo** packs it is a documented no-op (they are mock-only). On the **verticals** (`migrate.csv-to-db`,
`build-skill`) it selects a real provider for that call, as far as the Root-Policy `allowedModels` permits
(Inv. 13/14). Omitting it keeps the verticals offline on MockModel.

A client does `tools/list` (4 tools), then `tools/call`:

```json
{
  "name": "migrate.csv-to-db",
  "arguments": { "csv": "id,full_name,email_addr\nu1,Ann,ann@example.com\n" }
}
```

With a per-call model override (drives `propose_mapping` with Claude instead of MockModel):

```json
{
  "name": "migrate.csv-to-db",
  "arguments": {
    "csv": "id,full_name,email_addr\nu1,Ann,ann@example.com\n",
    "model": "claude:claude-opus-4-8"
  }
}
```

`tools/call` builds a fresh runtime per call, runs with `budget = args.budget ?? 1000` and `maxDepth = args.maxDepth ?? 200`, with `payload` = the args minus `csv`/`budget`/`maxDepth`, then consumes the stream until:

- **`run-completed`** → a `CallToolResult` with `structuredContent { feature, run, gate, artifact:{ref,content,evalState}|null }` + a text headline. `isError: true` only when `gate === "stopped"`.
- **`node-suspended`** → a `CallToolResult` with `structuredContent { feature, run, status:"suspended", mode, elicitation, correlation }`, `isError: true`. The client sees what the loop waits on; there is **no auto-resolve** — v0.1 tool-calls are synchronous.
- Stream ends with neither / throws → `isError: true` text result.

---

## Studio dashboard

Package `@elio/studio`, bin `packages/studio/dist/bin.js`. Pure `node:http` — no frontend framework, no build step; the dashboard is a single self-contained HTML string (inline CSS + vanilla JS, CSP-safe).

### Start it

```bash
node packages/studio/dist/bin.js                 # http://localhost:4123
PORT=8080 node packages/studio/dist/bin.js       # http://localhost:8080
```

Default port `4123` (override via `$PORT`, or `main({ port })`; `0` = ephemeral). On startup it builds one shared runtime (migrate- **and** skill-builder-wired base + both demo packs, **one shared store**) and by default **seeds** the store so the dashboard shows something immediately: two completed demo runs + one migrate run suspended at the commit approval + one `build-skill` run suspended at the `approve_write` approval (both feeding the Approval Inbox). Logs:

```text
elio-studio: dashboard listening on http://<host>:<port>
elio-studio: open <url> in your browser (Run status · Loop tape · Live updates · Approval inbox).
```

Graceful shutdown on `SIGINT`/`SIGTERM`.

### HTTP endpoints

| Method & path | Returns |
|---|---|
| `GET /` | the dashboard HTML (`200`, `text/html`; `<title>ELIO Studio</title>`; body marker `elio-studio-dashboard`). |
| `GET /api/runs` | JSON array from `store.liveStatus()` (`RunStatus[]`, `200`). |
| `GET /api/runs/:id/tape` | JSON array of the run's `TapeFrame`s from `store.tape(id)` (`200`; `:id` URL-decoded). |
| `GET /api/stream` | Server-Sent Events (`text/event-stream`); each `RunEvent` as `data: <json>\n\n`. Read-only. |
| `POST /api/resume` | **The only write path.** Resume a suspended run (see below). |
| any other route | `404 { error: "Not found: <METHOD> <path>" }`. |

```bash
curl http://localhost:4123/api/runs
curl http://localhost:4123/api/runs/<run-id>/tape
curl -N http://localhost:4123/api/stream
```

### The elicitation-resume write path

`POST /api/resume` is the only write path (Inv. 2). Body `{ correlation:{run,branch,step,checkpoint}, answer }`. It validates the correlation (`400` if invalid, `400` on bad JSON; ~1 MiB body cap), calls `runtime.resume(correlation, answer)`, consumes to the next rest point, and returns `200 { ok:true, correlation, outcome:"completed"|"suspended"|"ended", gate?, waitingOn? }`; on failure `409 { ok:false, error }`.

```bash
curl -X POST http://localhost:4123/api/resume \
  -H 'content-type: application/json' \
  -d '{"correlation":{"run":"r","branch":"b","step":"s","checkpoint":"c"},"answer":{"approved":true}}'
```

### What the dashboard shows

Four panels:

- **Live Run Status** — table of Run / Feature / Phase pill (running · suspended · done) / Step / Cost (`$usd / tokensIn in / tokensOut out`); click a row to select.
- **Approval Inbox** — pending suspended runs with `waitingOn` (`what`, `mode`, who-can-answer); an answer input defaulting to `y` + Resume/Deny buttons that POST `/api/resume`.
- **Loop Tape** — per selected run, each `TapeFrame` (nodeType, status pill, step, ts, injected list, JSON `result`).
- **Live Updates (SSE)** — a rolling log of incoming `RunEvent`s (capped at 200 lines).

It boots by polling `GET /api/runs`, auto-selecting the first run, opening the SSE stream, plus a 3-second safety-net poll. The answer input uses the same `parseAnswer` rules as the CLI (`y`/`yes`/… → `{approved:true}`, etc.).

---

## Writing a feature pack

A `feature.yaml` is compiled by the SDK loader into a typed `FeaturePack`. The loader validates and compiles only — the runtime/registry resolves step `type`s at run time (built-in nodes are registered exactly like custom ones — there is no privileged step class).

### The format

Top level:

- `apiVersion` — must be exactly `"elio/v1"`.
- `kind` — must be exactly `"Feature"`.
- `metadata` — required `id` (non-empty string), `version` (non-empty string); optional `owner`, `lifecycle`.
- `feature`:
  - `autonomy` — required: `"static" | "guided" | "dynamic"`.
  - `artifact` — required: `kind` (non-empty), `evalGate` (non-empty — the exit condition, Inv. 1).
  - `io` — required: `input` (object = JSON Schema), `output` (object = JSON Schema). `$ref` string values are treated as file references.
  - `graph` — optional, **required for static/guided**: `state` (optional initial branch state object), `steps` (required non-empty array of StepRef; ids unique), `edges` (array, default `[]`).
  - `planner` — optional `{ node: string }`; **required when `autonomy: dynamic`**.
  - `policies` — optional array of strings.
  - Invariant: a feature MUST have either `graph` (static/guided) or `planner` (dynamic).

**StepRef** (`graph.steps[]` and nested `with.steps[]`):

- `id` — non-empty, unique.
- `type` — non-empty (resolved at run time; built-in or custom).
- `with` — optional step params. Compiled recursively: a nested `with.steps` array is compiled as nested StepRefs (subworkflow pattern). Ref-bearing string keys (`system`, `user`, `prompt`, `schema`, `adapter`, `$ref`) that look like file paths are resolved to **file content** relative to `baseDir`.
- `outputs` — optional `string → string` map (output-key → state path, e.g. `rows: state.sampleRows`).
- `suspend` — optional: `"blocking" | "parked" | "timeout" | "optional"`.
- `when` — optional guard expression.

**Edge** (`graph.edges[]`): `{ from, to, when? }`; `from`/`to` must reference known step ids.

`contentHash` (set on load) is `sha256:<hex>` over the pack's canonical JSON (keys sorted, `contentHash` excluded) **plus** the raw contents of every referenced prompt/schema file. A changed prompt changes the hash → reproducible evals + resume pinning.

### A small annotated example

```yaml
apiVersion: elio/v1            # must be exactly this
kind: Feature                  # must be exactly this
metadata:
  id: hello.echo               # required, non-empty
  version: 0.1.0               # required, non-empty
  owner: you                   # optional
feature:
  autonomy: static             # static -> needs a graph
  artifact:
    kind: text-doc             # what we're building
    evalGate: min-length       # the exit condition (Inv. 1)
  io:
    input:  { type: object }   # JSON Schema
    output: { type: object }
  graph:
    state:
      draft: ""
    steps:
      - id: write              # unique id
        type: transform        # built-in node type
        with:
          mode: append
        outputs:
          value: state.draft   # output-key -> state path
      - id: check
        type: validate         # validation gate
    edges:
      - { from: write, to: check }
```

### Built-in node types

`registerBuiltins(registry)` registers exactly these 11:

| type | klass | what it does |
|---|---|---|
| `transform` | orchestration | pure/deterministic data shaping (take/from/mode…); re-runnable. |
| `validate` | orchestration | schema/gate check, returns a `GateVerdict`. |
| `approval` | orchestration | human side-effect gate; used with `suspend: blocking` to hold for sign-off. |
| `router` | orchestration | branch routing / chooses the next path. |
| `condition` | orchestration | conditional/guard evaluation gate. |
| `file` | orchestration | file read/write via the injected fs service (requests `fs.read`/`fs.write`). |
| `db` | orchestration | database access via the injected db service (requests `db`). |
| `batch` | orchestration | idempotent bulk write to fs/db (requests `fs.write` + `db`). |
| `subworkflow` | orchestration | per-record / nested Outer Loop (`forEach`, recursion); each record = own child branch + correlation-id. |
| `llm` | intelligence | single-shot model call, returns `{ text }` via `ctx.model` (requests `models`). |
| `agent` | intelligence | delegated intelligence node (Vela optional), returns `{ output }`; can resolve or suspend with an elicitation. Routes model calls through `ctx.model` (MockModel by default). |

### Run your pack

Via the CLI:

```bash
node packages/cli/dist/bin.js run ./path/to/feature.yaml
```

Via the SDK (register any custom node types your steps reference first):

```ts
import { createRuntime, loadFeaturePackFromFile, collectEvents } from "@elio/sdk";

const rt = createRuntime();
// rt.registry.register(myCustomNodeDef);  // for non-built-in step types
const pack = loadFeaturePackFromFile("/abs/path/to/feature.yaml");
console.log((await collectEvents(rt.run(pack, { payload: {}, budget: 10, maxDepth: 4 }))).at(-1));
```

---

## The migrate dogfood

`@elio/migrate` is the real dogfood vertical: a CSV→DB migration feature pack with injected Source/Target adapters. The shipped pack is `packages/migrate/features/migrate.csv-to-db/feature.yaml` (id `migrate.csv-to-db`, version `0.1.0`, owner `solo-dev`, lifecycle `draft`).

It is `autonomy: guided` — the mapping agent is guided while the runtime stays deterministic. `artifact: { kind: migration-script, evalGate: sample_passes }` (the migration script *is* the artifact; the gate is "sample runs clean, committed in the target"). `policies: [ commit_requires_approval ]`.

The 9-step linear graph (plus 2 nested per-record steps): `read_source` (custom `migrate.read_source`) → `sample` (`transform`, first 20 rows) → `propose_mapping` (`agent`, prompts resolved to content, `maxTurns: 1`) → `parse_mapping` (custom) → `stage` (custom) → `run_on_sample` (`subworkflow`, per-record `transform_record` + `validate_record`, `itemKey: record`) → `dry_run` (`transform`, `mode: dry-run`) → `commit` (`approval`, `suspend: blocking`) → `commit_write` (custom `migrate.commit`, idempotent batch write, runs **after** approval).

### Run it

```bash
# CLI — prompts at the commit approval (type y to commit); works interactively or piped:
#   printf 'y\n' | node packages/cli/dist/bin.js run migrate.csv-to-db   -> gate=passed
node packages/cli/dist/bin.js run migrate.csv-to-db

# CLI — stop at the approval instead of committing:
node packages/cli/dist/bin.js run migrate.csv-to-db --no-prompt

# CLI — feed your own CSV sample:
node packages/cli/dist/bin.js run migrate.csv-to-db --csv $'id,full_name,email_addr\nu1,Ann,ann@example.com\n'
```

Via MCP, call the `migrate.csv-to-db` tool with `{ "csv": "id,full_name,email_addr\nu1,Ann,ann@example.com\n" }`. In Studio, the seeded migrate run appears in the Approval Inbox suspended at the commit step — resume it from there.

### Programmatic wiring

`registerMigrate` is **not** exported by `@elio/sdk` — it lives in `@elio/migrate`:

```ts
import { registerMigrate, SourceCsvAdapter, TargetDbAdapter } from "@elio/migrate";
import { createRuntime } from "@elio/sdk";

const rt = createRuntime();
registerMigrate(rt, { source: new SourceCsvAdapter(/* … */), target: new TargetDbAdapter(/* … */) });
// registers migrate.read_source / parse_mapping / stage / transform_record /
// validate_record / commit, and the sample_passes gate (idempotent).
```

`@elio/migrate` also exports `setupMigrate`, `loadMigrateFeature`, `migrateFeaturePath`, `migrateRootPolicy`, `registerMigratePolicies`, `parseCsv`, `parseMappingProposal`, `applyMapping`, `validateTargetRecord`, `DEFAULT_MAPPING`, `TARGET_REQUIRED_FIELDS`, `MIGRATION_SCRIPT_TYPE`, `MIGRATE_MODEL`, `COMMIT_REQUIRES_APPROVAL`.

---

## build-skill (skill generator)

`@elio/skill-builder` is the **meta-vertical**: a feature whose *artifact* is a Claude-Code **SKILL.md** (id `build-skill`, version `0.1.0`, `autonomy: guided`, gate `skill_well_formed`). A Claude-Code skill is a directory containing a `SKILL.md` — YAML frontmatter (`name`: kebab-case = the directory name; `description`: one line) plus a markdown instruction body — and that file *is* the artifact (Inv. 1).

Its 5-step linear graph: `collect_brief` (interviews any missing required brief field — `name`/`description`/`purpose` — via an **elicitation**) → `draft_skill` (`intelligence`; builds a structurally valid SKILL.md skeleton deterministically, enriching the body via a one-shot `ctx.model` call when a model is present — MockModel offline by default) → `validate_skill` (a `GateVerdict`: frontmatter parseable, name kebab-case, one-line non-empty description, non-empty body) → `approve_write` (built-in `approval`, `suspend: blocking`) → `write_skill` (writes `<outDir>/<skill-name>/SKILL.md` via `ctx.fs`, **confined** to `outDir` — a path escaping it is rejected, Inv. 14). The `skill_write_requires_approval` policy tightens the suspend mode to `blocking` (tighten-only, Inv. 13), so the disk write always waits for sign-off. The gate stays open until the file is both valid **and** written.

### Run it via the CLI (with a piped interview)

The brief can come from a supplied brief (SDK) or be **elicited** field-by-field at the CLI prompt — interactively **or** piped/scripted on stdin. With no brief, `collect_brief` interviews `name`, `description`, then `purpose`, and the final answer approves the disk write:

```bash
# Piped interview: name, description, purpose, then 'y' to approve the write -> gate=passed.
printf 'code-reviewer\nReviews a diff for correctness bugs; use before merging a PR.\nHelp the author catch correctness bugs before merge.\ny\n' \
  | node packages/cli/dist/bin.js run build-skill --out ./skills
#  -> writes ./skills/code-reviewer/SKILL.md and exits 0 (run-completed{gate:"passed"}).

# Without --out, the skill is written under a fresh temp dir (still runnable with no config).
node packages/cli/dist/bin.js run build-skill            # interactive interview at a TTY

# Stop at the write approval instead of approving:
node packages/cli/dist/bin.js run build-skill --no-prompt
```

### Run it via the SDK

```ts
import { collectEvents } from "@elio/sdk";
import { setupSkillBuilder } from "@elio/skill-builder";

const { runtime, pack, outDir } = setupSkillBuilder({
  outDir: "/abs/out/dir",
  brief: {
    name: "Code Reviewer",                 // normalized to kebab-case for the dir + frontmatter
    description: "Reviews a diff for correctness bugs; use before merging a PR.",
    purpose: "Catch correctness bugs before merge.",
    // whenToUse / instructions are optional; a missing REQUIRED field would trigger an interview.
  },
});

// Run 1 drafts + validates, then suspends at the blocking approve_write approval (nothing written yet).
const ev1 = await collectEvents(runtime.run(pack, { payload: {}, budget: 1000, maxDepth: 200 }));
const corr = ev1.find((e) => e.type === "node-suspended")?.correlation;

// Approve -> write_skill writes <outDir>/<name>/SKILL.md -> gate "skill_well_formed" passes.
await collectEvents(runtime.resume(corr!, { approved: true }));
// -> <outDir>/code-reviewer/SKILL.md now exists.
```

`@elio/skill-builder` also exports `registerSkillBuilder`, `registerSkillBuilderPolicies`, `loadSkillBuilderFeature`, `buildSkillPack`, `skillBuilderFeaturePath`, `skillBuilderRootPolicy`, `SKILL_TYPE`, `SKILL_WRITE_REQUIRES_APPROVAL`, and the pure skill helpers (`buildSkillMd`, `validateSkillMd`, `parseSkillMd`, `isKebabCase`, …).

Via **MCP**, call the `build-skill` tool — pass the brief fields as arguments (`{ "name": "...", "description": "...", "purpose": "..." }`); a complete brief runs through to the blocking `approve_write` and is returned as a suspended result (v0.1 tool-calls are synchronous, no auto-resolve). In **Studio**, the seeded `build-skill` run appears in the Approval Inbox suspended at `approve_write` — resume it from there.

---

## Troubleshooting / known v0.1 limits

**Bins crash with `ERR_MODULE_NOT_FOUND`.** You built with `pnpm -r build`. Use the **root** `pnpm build` — it runs `scripts/fix-esm-extensions.mjs` to make the emitted ESM runnable under Node. Rebuild from the repo root.

**`elio runs` shows nothing / `elio resume` (new process) can't find a run.** The run store is in-memory and **process-local** in v0.1. A new process gets a freshly-wired runtime with an empty store, so it can't see runs from a prior `elio run`. The commands print a clear hint, not an empty-looking bug. The full `run → suspend → resume` approval cycle works **within one `elio run`** (which prompts on stdin). Cross-process / persistent runs are v0.2.

**MCP `tools/call` returns an error on a suspended run.** A `node-suspended` is returned as an `isError` result with `structuredContent { status:"suspended", … }` — there is no auto-resolve. v0.1 tool-calls are synchronous; resuming from MCP is not wired in v0.1.

**Vela suspend/resume.** Only the *resolved* agent path is real in v0.1. Suspend/resume + identity↔correlation mapping are v0.2; the in-process agent engine is the working fallback. By default the `agent` node uses MockModel.

**Real Worker/VM sandbox.** Seam only (`NodeSandbox` + `InProcessSandbox`). Security-by-absence via the injector *is* enforced — a node has no `ctx.fs/db/model/secrets` it wasn't granted — but OS-level isolation is v0.2.

**Azure OpenAI preflight fails / step says the profile is missing config.** `AzureOpenAiModel` is fully wired
(`complete()` + `stream()`), but a feature pinning `provider: azure-openai` only passes preflight when the
profile is `isConfigured()` — **endpoint + api-key + deployment** all present. Set `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_API_KEY`, and `AZURE_OPENAI_DEPLOYMENT` (and optionally `AZURE_OPENAI_API_VERSION`, default
`2024-10-21`). `resolveProviderProfiles()` registers the profile only when endpoint **and** api-key are both
set, so a half-configured environment surfaces as one clear aggregated preflight error, not a mid-run failure.

**`maxCostUsd` / `ctx.http` seem to do nothing.** They are resolved by the policy stack but **not enforced/injected** in v0.1. Run-level `budget` (Inv. 21) **is** enforced — pass it via `RunInput.budget`.

---

## See also

- [README.md](../README.md) — project front page.
- [docs/elio-v0.1-acceptance.md](elio-v0.1-acceptance.md) — what works + deferred items.
- [docs/elio-v0.1-skeleton.md](elio-v0.1-skeleton.md) — architecture, invariants, migrate `feature.yaml` reference (§7).
