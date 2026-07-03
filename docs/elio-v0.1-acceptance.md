# ELIO v0.1 — Acceptance Report

> Status: **V0.1 GOAL MET.** Built autonomously across 8 dependency-ordered slices, each adversarially
> verified (build → 3-lens audit → fix) and confirmed at the real-execution level (bins actually run),
> not just gate-green. Full gate from a clean rebuild: `pnpm -r typecheck && pnpm test && pnpm lint` —
> **343 tests / 48 files, typecheck + lint clean.**

## Goal

> „nutzbar über Clients, CLI und MCP-Server, Dashboard einsehbar."

Four real surfaces, all verified runnable from a clean `pnpm build`:

| Surface | Package | How to run | Verified |
|---|---|---|---|
| **SDK client** | `@elio/sdk` | `import { createRuntime, run, resume, loadFeaturePackFromFile }` | 343 unit/integration tests (run/resume, all invariants) |
| **CLI** | `elio` (`packages/cli`) | `node packages/cli/dist/bin.js run demo.draft-until-good` | exit 0, `run-completed gate=passed`; `runs`/`--help`/migrate pipeline run via bin |
| **MCP server** | `@elio/mcp` (`elio-mcp`) | `node packages/mcp/dist/bin.js` (stdio) | server connects; in-memory protocol test (tools/list + tools/call) green |
| **Studio dashboard** | `@elio/studio` (`elio-studio`) | `node packages/studio/dist/bin.js` → http://localhost:4123 | `GET /` 200 (`<title>ELIO Studio</title>`), `/api/runs` JSON with live runs + approval inbox (`waitingOn`), clean shutdown |

Plus the real dogfood vertical `@elio/migrate` (CSV→DB, sample-first, per-record idempotency) and the YAML feature-pack loader.

## Packages

`@elio/core` (engine: runner, injector+sandbox-seam, registry, in-mem run store + tape, all built-in nodes,
policy/tighten, cost/budget, artifact+holders) · `@elio/sdk` (run/resume facade, YAML loader, model adapters
+ LLM worker, demo features) · `elio` CLI · `@elio/mcp` · `@elio/studio` · `@elio/migrate` · `@elio/vela-adapter`.

## Slice ledger (each verified at the execution level, not just gate-green)

| # | Slice | Proven | Notable adversarial catches (fixed) |
|---|---|---|---|
| 1 | Core engine spine | Inv. 1/5/6/10 | missing 2-node→DONE e2e test; gate ran only after orchestration nodes |
| 2 | Suspend/Resume/Elicitation/Approval | Inv. 11/12 | **governance bypass**: resume answer leaked into later approvals; per-run executor deleted under concurrent resumes |
| 3 | Models + LLM worker + llm/agent nodes | Inv. 7/9/17 | **Inv. 21**: agent inner loop got `Infinity` budget; depth never checked vs maxDepth |
| 4 | Governance + remaining nodes + lint | Inv. 13/14/15/16/20(seam)/21/23 | **2 security leaks**: ctx.model injected unscoped (cloud reachable); dead-letter bypassed the tape redactor |
| 5 | YAML loader + @elio/migrate | Inv. 1(full)/4/22 | **re-derive not identity-preserving** (Inv. 22); prompt file-refs sent as path strings to the model; nested subworkflow steps unvalidated |
| 6 | Surfaces (CLI/MCP/Studio) | the v0.1 goal | **blocker the 320 green tests masked**: bins crashed with ERR_MODULE_NOT_FOUND (vitest aliases src, never dist); studio `close()` hung on open SSE |
| 7 | Vela adapter (best-effort) | Inv. 3/8/17/18 | suspend/resume misrepresented as live; relabeled `[DOUBLE-ONLY, v0.2 spec]`, real resolved path kept |
| 8 | Acceptance | — | clean rebuild + 4-surface run + completeness critic |

## Consciously deferred to v0.2 (honestly documented, not silently broken)

- **Full Worker/VM sandbox (Inv. 20):** v0.1 ships the `NodeSandbox` seam + `InProcessSandbox`; *security by absence* via the injector is fully enforced (a node literally has no `ctx.fs/db/model/secrets` it wasn't granted). OS-level isolation is v0.2.
- **Vela suspend/resume/block:** the **resolved** path is built against Vela's real API shape (transparent — model calls flow through `ctx.model`); suspend/resume + identity↔correlation mapping need a multi-step workflow + persistent store and are deferred to v0.2 (tests for them are labeled `[DOUBLE-ONLY, v0.2 spec]`). `vela-sdk` is not a workspace dependency, so the "real path" tests run against a structurally faithful double; the in-process agent engine is the working fallback.
- **Cross-process CLI store:** `elio run/runs/resume` share state only within one process (in-memory store); cross-process listing/resume (file-backed store) is v0.2 — `elio runs` prints a clear hint, not an empty-looking bug.
- **`ResolvedPolicy.maxCostUsd` and `CapabilityRequest.http`:** resolved by the policy stack but not yet enforced/injected in v0.1 (commented as such); run-level budget (Inv. 21) IS enforced.

## Notes

- Working tree is **not committed** — left for review (branch `003-chess-bot-webapp`). Review in your editor, then commit when ready.
- Canonical build is the **root** `pnpm build` (it runs `scripts/fix-esm-extensions.mjs` to make the emitted ESM runnable under Node); `pnpm -r build` skips that step.
- Cosmetic follow-up: rename the vela-adapter `REAL Vela path` test to reflect it runs against a structural double (vela-sdk not installed).
