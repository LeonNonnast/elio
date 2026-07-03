# ELIO

**ELIO — Enterprise Loop Intelligence Orchestrator.** An artifact-centric Loop-Engine: you declare an *artifact* and an *eval gate*, and ELIO runs an Outer Loop until that artifact passes the gate (Inv. 1). The engine lives in the SDK (`@elio/sdk` over `@elio/core`) — everything else (CLI, MCP server, Studio dashboard) is a thin client over the SDK with no engine logic of its own (Inv. 2).

![status: v0.1](https://img.shields.io/badge/status-v0.1-blue) ![tests: 502 passing](https://img.shields.io/badge/tests-502%20passing-brightgreen) ![typecheck: clean](https://img.shields.io/badge/typecheck-clean-brightgreen) ![lint: clean](https://img.shields.io/badge/lint-clean-brightgreen) ![license: MIT](https://img.shields.io/badge/license-MIT-informational) ![surfaces: SDK · CLI · MCP · Studio](https://img.shields.io/badge/surfaces-SDK%20%C2%B7%20CLI%20%C2%B7%20MCP%20%C2%B7%20Studio-informational)

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

Runs `vitest run` — **502 tests** green; typecheck + lint clean.

## 60-second Quickstart

After `pnpm install && pnpm build`:

```bash
# 1. Run a demo feature through the CLI (offline, deterministic — uses MockModel)
node packages/cli/dist/bin.js run demo.draft-until-good

# 2. Open the Studio dashboard (seeds itself with sample runs + an approval)
node packages/studio/dist/bin.js
#    -> open http://localhost:4123 in your browser
```

`elio run demo.draft-until-good` streams `RunEvent`s and exits `0` when the run completes with `gate=passed`. Studio listens on `http://localhost:4123` and shows live run status, the loop tape, an SSE update log, and an approval inbox.

For the full walkthrough see **[docs/elio-usage.md](docs/elio-usage.md)**.

## The four surfaces at a glance

All three client surfaces are thin `@elio/sdk` clients; the demos are offline and deterministic (MockModel). The available features everywhere are `demo.draft-until-good`, `demo.retry-then-pass`, `migrate.csv-to-db`, and `build-skill` — the skill-generator meta-vertical whose artifact is a Claude-Code SKILL.md, with the brief elicited at the prompt or supplied up front (plus, for the CLI, a path to a `feature.yaml`).

One additional **online** demo runs on the CLI/SDK: **`demo.local-agent`** — a local **Ollama** agent drives the Outer Loop. `ctx.agent` is the transparent in-process engine (a bounded multi-turn loop, **no LangGraph**) whose model calls flow through `ctx.model` → an `OllamaModel` on `http://localhost:11434`. Run it with `node packages/cli/dist/bin.js run demo.local-agent` after `ollama pull llama3`; see [docs/elio-usage.md](docs/elio-usage.md#run-a-local-ollama-agent-demolocal-agent).

**Provider layer & model selection.** A feature pins a logical `provider:model` per step; the environment supplies endpoints/credentials, resolved by the shared `resolveProviderProfiles()`. Four provider profiles ship: `mock` (deterministic, offline default), `ollama` (local, auto-detected), `claude` (cloud, `ANTHROPIC_API_KEY`), and **`azure-openai` — now fully wired** (`complete()` + SSE `stream()`, OpenAI-compatible; `AZURE_OPENAI_ENDPOINT`/`_API_KEY`/`_DEPLOYMENT`/`_API_VERSION`). The verticals `migrate.csv-to-db` and `build-skill` route their intelligence step through `ctx.model`, so you can override the model with `--model <spec>` on the CLI or a per-call `model` param via MCP (default stays offline MockModel). For environment-specific setups (two Ollama endpoints, prod/test Azure deployments) you define **named profiles** in `elio.profiles.yaml` (see [`elio.profiles.example.yaml`](elio.profiles.example.yaml)) — credentials referenced via the secrets layer, costs as rough per-profile estimates (no precise price table). See [Provider profiles & model selection](docs/elio-usage.md#provider-profiles--model-selection-providermodel).

| Surface | Package | How to run |
|---|---|---|
| **SDK** (programmatic) | `@elio/sdk` | `import { createRuntime, run, resume, loadFeaturePackFromFile } from "@elio/sdk"` |
| **CLI** | `elio` (`packages/cli`) | `node packages/cli/dist/bin.js run demo.draft-until-good` |
| **MCP server** | `@elio/mcp` (bin `elio-mcp`) | `node packages/mcp/dist/bin.js` (stdio JSON-RPC) |
| **Studio dashboard** | `@elio/studio` (bin `elio-studio`) | `node packages/studio/dist/bin.js` → `http://localhost:4123` |

## Project structure (8 packages)

```text
packages/
  core           @elio/core           Kern-Engine: Runner, Injector, ctx-Contracts, Node-Registry,
                                       Run Store + Checkpoint + correlation-id, Loop Tape, Policy stack.
  sdk            @elio/sdk            Public API over @elio/core: run()/resume(), YAML pack loader,
                                       node registration, model adapters, services. Primary entry point.
  cli            elio                 Thin client: elio run / resume / runs, approval as a CLI prompt.
  mcp            @elio/mcp            MCP server surface: exposes feature packs as MCP tools (stdio).
  studio         @elio/studio         Local HTTP dashboard (read-mostly): run status, loop tape, SSE, approvals.
  migrate        @elio/migrate        Dogfood vertical: CSV→DB migration feature pack + Source/Target adapters.
  skill-builder  @elio/skill-builder  Meta-vertical: a feature whose artifact is a Claude-Code SKILL.md
                                       (build-skill) — interview, draft, validate, approve, governed write.
  vela-adapter   @elio/vela-adapter   Vela integration: binds Vela as a transparent `agent` node-engine.
```

> `@elio/server` appears in the skeleton only as a *(COULD)* / "later" item — it is **not** one of the 8 built packages and does not exist under `packages/`.

## Documentation

- **[docs/elio-usage.md](docs/elio-usage.md)** — detailed how-to-use guide (CLI, SDK, MCP, Studio, feature packs, migrate, troubleshooting).
- **[docs/elio-v0.1-acceptance.md](docs/elio-v0.1-acceptance.md)** — what works in v0.1 and what is deferred.
- **[docs/elio-v0.1-skeleton.md](docs/elio-v0.1-skeleton.md)** — architecture, invariants, and the migrate `feature.yaml` reference.

## v0.1 scope & what's deferred to v0.2

v0.1 is built, runnable, and verified at the execution level. Deferred, and documented honestly rather than silently broken:

- **Cross-process CLI store** → ✅ done (was v0.2). The CLI persists runs to a durable `FileRunStore` (`$ELIO_STATE_DIR`, else `<cwd>/.elio/runs`), so `elio runs` / `elio resume` work **across processes**. Cross-process resume reconstructs the run context from the checkpoint's artifact snapshot + the persisted run input + the `<feature>` argument (which re-supplies the pack). Cross-process *live* `subscribe()`/SSE stays in-process (Studio); a DB-backed store can later dock at the same `RunStore` contract. See [docs/elio-v0.2-roadmap.md](docs/elio-v0.2-roadmap.md).
- **Vela suspend/resume** → v0.2. Only the *resolved* agent path is real in v0.1; suspend/resume + identity↔correlation mapping are deferred. The in-process agent engine is the working fallback.
- **Real Worker/VM sandbox** → seam only. The `NodeSandbox` seam + `InProcessSandbox` ship; *security-by-absence* via the injector is fully enforced (a node has no `ctx.fs/db/model/secrets` it wasn't granted). OS-level isolation is v0.2.
- **`maxCostUsd` and `ctx.http`** → resolved-but-unenforced. The policy stack resolves them but v0.1 does not enforce/inject them. Run-level `budget` (Inv. 21) **is** enforced.

## License

[MIT](LICENSE) © 2026 Leon Nonnast. Each publishable `@elio/*` package declares `"license": "MIT"` and `"publishConfig": { "access": "public" }`.
