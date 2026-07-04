# ELIO — Documentation

Entry point for the ELIO docs. The project front page is the root [README.md](../README.md); this index maps the maintained documents by purpose.

## How-to / usage

- **[elio-usage.md](elio-usage.md)** — the detailed how-to guide: CLI, SDK, MCP, Studio, feature-pack YAML format, provider profiles & model selection, the `migrate` and `build-skill` verticals, and troubleshooting. Start here to *use* ELIO.

## Architecture (reference)

- **[elio-v0.1-skeleton.md](elio-v0.1-skeleton.md)** — the architecture bible. The 23 numbered invariants (§1), the core TypeScript type contracts (§3), the runner-loop algorithm (§4), and the migrate `feature.yaml` reference (§7) are the authoritative architecture reference. (Its §8 MoSCoW / §9 open-decisions are historical planning, now resolved — see the roadmap for current status.)

## Status (source of truth)

- **[elio-v0.2-roadmap.md](elio-v0.2-roadmap.md)** — the living Open-Topics status catalog: what is **done**, **in progress**, **deferred**, **declined**, or an **idea**. When two docs disagree about whether something is built, this one wins.

## Design docs (feature deep-dives)

Written as design + build logs for specific subsystems:

- **[elio-engine-service-refactor.md](elio-engine-service-refactor.md)** — the central `@elio/engine` layer (`EngineService` / `LocalEngine` / `EngineHost` / `EngineClient`) and `elio serve`, which make CLI/MCP/Studio thin clients over one engine (Inv. 2).
- **[elio-learning-engine.md](elio-learning-engine.md)** — the retro-miner / learning-optimization engine: read-only tape miners → `PromotionCandidate`s → human-gated `promote-candidate` self-update, up to sandboxed Tier-2 script codegen (`ctx.scripts`).
- **[elio-process-mining.md](elio-process-mining.md)** — the process-mining capture/discovery layer: the `pm.event-log` / `pm.session-summary` / `pm.discover` feature packs, event/summary storage, and Claude-Code hook wiring.

## Historical / planning artifacts

Pre-implementation and milestone documents are preserved under [`../_bmad-output/planning-artifacts/`](../_bmad-output/planning-artifacts/) rather than in this maintained set:

- `elio-v0.1-build-plan.md` — the pre-build walking-skeleton sequencing.
- `elio-v0.1-impl-decisions.md` — the pre-build blueprint (file layout, signatures, conventions).
- `elio-v0.1-acceptance.md` — the frozen v0.1 milestone acceptance report.
- `enterprise-ai-runtime-platform-feature-pack-sdk.md` — the original open-ended brainstorm that the skeleton superseded.

These describe past planning states and may contradict current reality; read them as history, not status.
