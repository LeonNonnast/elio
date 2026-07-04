# ELIO

**ELIO — Enterprise Loop Intelligence Orchestrator.** An artifact-centric Loop-Engine: you declare an *artifact* and an *eval gate*, and ELIO runs an Outer Loop until that artifact passes the gate (Inv. 1). The engine logic lives in one place — `@elio/engine` (an `EngineService` over `@elio/sdk`/`@elio/core`) — and every surface (CLI, MCP server, Studio dashboard) is a thin client over it, in-process or over HTTP, with no engine logic of its own (Inv. 2).

![status: v0.2](https://img.shields.io/badge/status-v0.2-blue) ![tests: 722 passing](https://img.shields.io/badge/tests-722%20passing-brightgreen) ![typecheck: clean](https://img.shields.io/badge/typecheck-clean-brightgreen) ![lint: clean](https://img.shields.io/badge/lint-clean-brightgreen) ![license: MIT](https://img.shields.io/badge/license-MIT-informational) ![surfaces: SDK · CLI · MCP · Studio](https://img.shields.io/badge/surfaces-SDK%20%C2%B7%20CLI%20%C2%B7%20MCP%20%C2%B7%20Studio-informational)

## Requirements

- **Node.js** — a modern Node with ESM support (developed/verified on Node 22+; the published bins carry `#!/usr/bin/env node`).
- **pnpm** `10.24.0` (declared via `packageManager` in `package.json`).

## Install

```bash
pnpm install
```

## Build

```bash
pnpm build
```

> **Use the ROOT `pnpm build`, not `pnpm -r build`.** The root build runs `tsc -b && node scripts/fix-esm-extensions.mjs`. That second step rewrites the emitted ESM import extensions so the package bins are actually runnable under Node. `pnpm -r build` skips it, and the bins will fail with `ERR_MODULE_NOT_FOUND`.

Other root scripts: `pnpm typecheck` (`tsc -b`), `pnpm clean` (`tsc -b --clean`), `pnpm lint` (`eslint .`).

## Test

```bash
pnpm test
```

Runs `vitest run` — **722 tests** green (3 skipped: real-provider e2e that need live credentials); typecheck + lint clean.

## 60-second Quickstart

After `pnpm install && pnpm build`:

```bash
# 1. Run the hello-world feature through the CLI (offline, deterministic)
#    -> the Outer Loop polishes a greeting until a quality checklist passes ("Hello world!")
node packages/cli/dist/bin.js run demo.hello

# 2. Open the Studio dashboard (seeds itself with sample runs + an approval)
node packages/studio/dist/bin.js
#    -> open http://localhost:4123 in your browser
```

`elio run demo.hello` streams `RunEvent`s and exits `0` when the run completes with `gate=passed`. Studio listens on `http://localhost:4123` and shows live run status, the loop tape, an SSE update log, and an approval inbox.

For the full walkthrough see **[docs/elio-usage.md](docs/elio-usage.md)** (index: **[docs/README.md](docs/README.md)**).

## The surfaces at a glance

The engine (`@elio/engine`) is the single source of engine behaviour. CLI, MCP, and Studio are thin clients over the same `EngineService` — either **in-process** (`LocalEngine`) or over **HTTP/SSE** against a long-running host (`elio serve` → `EngineHost`, reachable via `--engine-url` / `$ELIO_ENGINE_URL`). Policy, cost, and routing are never duplicated or bypassed by a client.

| Surface | Package | How to run |
|---|---|---|
| **SDK** (programmatic) | `@elio/sdk` | `import { createRuntime, run, resume, loadFeaturePackFromFile } from "@elio/sdk"` |
| **Engine** (shared core / host) | `@elio/engine` | `import { LocalEngine, createEngineHost, EngineClient } from "@elio/engine"` |
| **CLI** | `elio` (`packages/cli`) | `node packages/cli/dist/bin.js run demo.draft-until-good` · `elio serve [--port <n>]` |
| **MCP server** | `@elio/mcp` (bin `elio-mcp`) | `node packages/mcp/dist/bin.js` (stdio JSON-RPC) |
| **Studio dashboard** | `@elio/studio` (bin `elio-studio`) | `node packages/studio/dist/bin.js` → `http://localhost:4123` |

## Features

The demos are offline and deterministic (MockModel) unless a real model is selected. Available feature packs:

- **Demos** — `demo.hello` (the offline "aha" case: the Outer Loop polishing a greeting until a quality gate passes), `demo.draft-until-good`, `demo.retry-then-pass`, and the online `demo.local-agent` (a local **Ollama** agent drives the loop via `ctx.model` on `http://localhost:11434`; run after `ollama pull llama3`).
- **Verticals** — `migrate.csv-to-db` (CSV→DB migration, sample-first, dry-run then approval-gated commit) and `build-skill` (a meta-vertical whose artifact is a Claude-Code `SKILL.md` — interview, draft, validate, human approval, governed write).
- **Process-mining** (`pm.*`) — `pm.event-log` (AI-free hook logger), `pm.session-summary` (LLM 1×/session), `pm.discover` (read-only mining over the captured events). See [docs/elio-process-mining.md](docs/elio-process-mining.md).
- **Learning / optimization** — read-only retro-miners over the loop tape produce `PromotionCandidate`s; a human-gated `promote-candidate` step hardens them into a new, versioned pack variant (the hot path is never touched). See [docs/elio-learning-engine.md](docs/elio-learning-engine.md).

**Provider layer & model selection.** A feature pins a logical `provider:model` per step; the environment supplies endpoints/credentials, resolved by the shared `resolveProviderProfiles()`. Four provider profiles ship: `mock` (deterministic, offline default), `ollama` (local, auto-detected), `claude` (cloud, `ANTHROPIC_API_KEY`), and `azure-openai` (`complete()` + SSE `stream()`, OpenAI-compatible; `AZURE_OPENAI_ENDPOINT`/`_API_KEY`/`_DEPLOYMENT`/`_API_VERSION`). Verticals route their intelligence step through `ctx.model`, so you override the model with `--model <spec>` on the CLI or a per-call `model` param via MCP (default stays offline MockModel). For environment-specific setups you define **named profiles** in `elio.profiles.yaml` (see [`elio.profiles.example.yaml`](elio.profiles.example.yaml)) — credentials referenced via the secrets layer, costs as rough per-profile estimates. See [Provider profiles & model selection](docs/elio-usage.md#provider-profiles--model-selection-providermodel).

In addition, `@elio/vela-adapter` and `@elio/claude-adapter` bind Vela and Claude as **agent node-engines** — a `type: agent` step can delegate to a transparent (Vela, model calls flow through `ctx.model`) or opaque (Claude, hull-governed) engine.

## Project structure (10 packages)

```text
packages/
  core           @elio/core           Kern-Engine: Runner, Injector, ctx-Contracts, Node-Registry,
                                       Run Store + Checkpoint + correlation-id, Loop Tape, Policy stack.
  sdk            @elio/sdk            Public API over @elio/core: run()/resume(), YAML pack loader,
                                       node registration, model adapters, services.
  engine         @elio/engine         Central EngineService: LocalEngine (in-process) + EngineHost/EngineClient
                                       (HTTP/SSE). The one place engine behaviour lives (Inv. 2).
  cli            elio                 Thin client: elio run / resume / runs / serve, approval as a CLI prompt.
  mcp            @elio/mcp            MCP server surface: exposes feature packs as MCP tools (stdio).
  studio         @elio/studio         Local HTTP dashboard (read-mostly): run status, loop tape, SSE, approvals.
  migrate        @elio/migrate        Dogfood vertical: CSV→DB migration feature pack + Source/Target adapters.
  skill-builder  @elio/skill-builder  Meta-vertical: a feature whose artifact is a Claude-Code SKILL.md
                                       (build-skill) — interview, draft, validate, approve, governed write.
  vela-adapter   @elio/vela-adapter   Binds Vela as a transparent `agent` node-engine (model via ctx.model).
  claude-adapter @elio/claude-adapter Binds Claude as an opaque `agent` node-engine (hull-governed).
```

> `@elio/server` appears in the original skeleton only as a *(COULD)* / "later" item — it was never built and does not exist under `packages/`. The shared-core role it hinted at is filled by `@elio/engine`.

## Documentation

Start at the docs index: **[docs/README.md](docs/README.md)**. Highlights:

- **[docs/elio-usage.md](docs/elio-usage.md)** — detailed how-to (CLI, SDK, MCP, Studio, feature packs, providers, verticals, troubleshooting).
- **[docs/elio-v0.1-skeleton.md](docs/elio-v0.1-skeleton.md)** — architecture bible: the 23 invariants, core type contracts, the runner loop, and the migrate `feature.yaml` reference.
- **[docs/elio-v0.2-roadmap.md](docs/elio-v0.2-roadmap.md)** — the living Open-Topics status catalog (the source of truth for "what's done / deferred / declined").
- **[docs/elio-engine-service-refactor.md](docs/elio-engine-service-refactor.md)**, **[docs/elio-learning-engine.md](docs/elio-learning-engine.md)**, **[docs/elio-process-mining.md](docs/elio-process-mining.md)** — design docs for the engine layer, learning engine, and process-mining.

Historical planning artifacts (v0.1 build plan, impl-decisions, acceptance, the original brainstorm) live under `_bmad-output/` and are not part of the maintained docs.

## Status & honest limits

Built, runnable, and verified at the execution level. The **[roadmap](docs/elio-v0.2-roadmap.md)** is the source of truth for status; in short:

- **Shipped (v0.2):** cross-process `FileRunStore` (`runs`/`resume` across processes), `maxCostUsd` hard cap, `ctx.http` enforcement, `@elio/claude-adapter`, and Vela suspend/resume — the latter **real-verified against the actual `vela-sdk` dist** (guarded test).
- **Partial:** OS-level sandboxing. A real `worker_threads` + `node:vm` sandbox ships for Tier-2 generated scripts (`ctx.scripts`); the `NodeSandbox` seam for *all* nodes is still `InProcessSandbox`. Security-by-absence via the injector is fully enforced regardless (a node has no capability it wasn't granted).
- **Deferred:** DB-backed run store (SQLite/Postgres — docks at the same `RunStore` contract), cross-process live `subscribe()`/SSE, platform-wide approval-deny safe-by-default, and dynamic-feature/meta-orchestration.

This is a coherent, tested reference implementation of *governed* loop orchestration — its value today is the architecture and proven feasibility, not a deployed production workload.

## License

[MIT](LICENSE) © 2026 Leon Nonnast. Each publishable `@elio/*` package declares `"license": "MIT"` and `"publishConfig": { "access": "public" }`.
