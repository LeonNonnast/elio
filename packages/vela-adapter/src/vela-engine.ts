// ───────────────────────────── VelaAgentEngine (id "vela", governance "transparent", Inv. 17/18/21) ─────────────────────────────
//
// INTEGRATION LEVEL: PARTIAL (impl-decisions §7). This engine implements a REAL integration against
// the inspected `vela-sdk` contract AND a graceful in-process fallback — both are valid v0.1 outcomes.
//
//   REAL Vela path (when the Vela module loads — see VelaModuleLoader):
//     SessionContract -> single-delegate-step WorkflowDefinition -> DefaultWorkflowEngine
//     .startOrResume/.advance. The model call is routed through ctx.model via a registered Vela
//     delegate (INVERSION seam — Vela emits no model calls of its own; ELIO runs them) => full Inv. 18
//     transparency. WHAT GENUINELY WORKS on the real path in v0.1: a single RESOLVED turn whose reply is
//     captured out of run.stateData.text. The model call, transparent cost charge, and per-call audit are
//     real-API-faithful (verified against vela-sdk).
//
//   NOT YET on the real path (honest v0.1 scope — see RESUME/BLOCK CAVEAT in vela-bridge.ts):
//     - Identity-based resume <-> ELIOs correlation-id (Inv. 12, the skeleton §2 aspiration): the
//       single-step run always COMPLETEs, so findByIdentity never re-finds it; cross-turn Vela resume
//       is v0.2. The in-process fallback's bounded loop is the only working v0.1 resume analogue.
//     - blocked/paused AdvanceResult -> ELIO Suspended (Inv. 11): the real engine cannot return
//       blocked:true for a single delegate step (the blocked branch lives inside `if(nextStepId)` after
//       validateDependsOn; there is no next step). The block->Suspended mapping below is therefore
//       exercised ONLY by the deterministic double (a v0.2 multi-step behavioural spec), not real Vela.
//       (Depth-ceiling elicitation in run() IS real + reachable — see Inv. 21 below.)
//
//   FALLBACK path (when Vela is NOT importable, or its contract has drifted, or a turn throws):
//     delegate to the existing InProcessAgentEngine (Slice 3) — itself transparent (routes through
//     ctx.model). The agent node CAN still route to engine id "vela"; it just runs in-process under the
//     hood. This is the honest, documented best-effort outcome; do NOT force a brittle hard integration.
//
// DEFERRED to v0.2 (documented, not forgotten):
//   - Multi-step / multi-turn Vela workflows: findByIdentity only re-finds ACTIVE/PAUSED runs, so a
//     robust v0.1 turn is ONE delegate step (which always COMPLETEs). A real block/pause + resume target
//     needs a 2+ step workflow whose depends_on can go unsatisfied, plus a store that outlives a turn.
//   - Native budget/depth semantics: Vela has no per-call budget or depth ceiling, so Inv. 21 is
//     enforced by THIS engine (depth>=maxDepth -> Elicitation before any Vela call), not by Vela.
//   - Velas sub-workflow / dialog / elicitation MCP surface (McpContext.elicit): richer elicitation
//     bridging — together with the real block->Suspended path above — is v0.2.
//   - vela-sdk is NOT a hard package dependency (Inv. 2: Vela stays standalone OSS). The real module
//     is loaded lazily; install `vela-sdk` and pass the default loader to activate the real path.

import type { AgentEngine, Ctx, Elicitation, Resolved, SessionContract, SessionResult } from "@elio/core";
import { InProcessAgentEngine } from "@elio/sdk";
import type { InProcessAgentEngineOptions } from "@elio/sdk";
import { blockedElicitation, runVelaTurn } from "./vela-bridge";
import { defaultVelaModuleLoader } from "./loader";
import type { VelaModule, VelaModuleLoader, VelaWorkflowStore } from "./vela-contract";

export interface VelaAgentEngineOptions extends InProcessAgentEngineOptions {
  /**
   * Loader for the real `vela-sdk` runtime (best-effort, impl-decisions §7). Default dynamic-imports
   * the published "vela-sdk" package; pass a double in tests. Returning null/undefined or throwing
   * forces the in-process fallback. `false` disables the real path entirely (always fall back).
   */
  velaLoader?: VelaModuleLoader | false;
  /**
   * Hook to observe which path a turn took ("vela" | "fallback") — used by tests + audit. Optional.
   */
  onPath?: (path: "vela" | "fallback", reason?: string) => void;
}

export class VelaAgentEngine implements AgentEngine {
  /** Engine id — an agent node with routing.agentEngine="vela" selects THIS engine. */
  readonly id = "vela";
  /** transparent: every model call flows through ctx.model (Inv. 18), in BOTH the real + fallback path. */
  readonly governance = "transparent" as const;

  private readonly loader: VelaModuleLoader | undefined;
  private readonly fallback: InProcessAgentEngine;
  private readonly onPath: ((path: "vela" | "fallback", reason?: string) => void) | undefined;
  /** Memoised module load (null = tried-and-unavailable). */
  private velaModule: VelaModule | null | undefined;
  private loadAttempted = false;
  /**
   * ONE Vela store for the lifetime of this engine (identity↔correlation, Inv. 12). It OUTLIVES a single
   * turn so a paused run survives until its resume turn re-finds it via findByIdentity. Created lazily
   * from the loaded module. (In-memory: same-process suspend/resume; a durable cross-process store is
   * later work — the FileRunStore-analogue for Vela.)
   */
  private velaStore: VelaWorkflowStore | undefined;

  constructor(opts: VelaAgentEngineOptions = {}) {
    this.loader =
      opts.velaLoader === false
        ? undefined
        : (opts.velaLoader ?? defaultVelaModuleLoader);
    this.onPath = opts.onPath;
    const inProcOpts: InProcessAgentEngineOptions = {};
    if (opts.maxTurns !== undefined) inProcOpts.maxTurns = opts.maxTurns;
    if (opts.stopWhen !== undefined) inProcOpts.stopWhen = opts.stopWhen;
    this.fallback = new InProcessAgentEngine(inProcOpts);
  }

  /** Lazily + memoised load of the Vela module. Any failure -> null (forces fallback). */
  private async loadVela(): Promise<VelaModule | null> {
    if (this.loadAttempted) return this.velaModule ?? null;
    this.loadAttempted = true;
    if (this.loader === undefined) {
      this.velaModule = null;
      return null;
    }
    try {
      const mod = await this.loader();
      this.velaModule = mod ?? null;
    } catch {
      this.velaModule = null;
    }
    return this.velaModule;
  }

  /**
   * Inner-loop run (Inv. 17). Inherits RESTbudget + depth from the contract (never fresh, Inv. 21):
   * the depth ceiling is checked HERE before any Vela call (Velas engine has no depth semantics).
   * depth>=maxDepth -> Elicitation UP (no silent nesting, no hard crash).
   */
  async run(contract: SessionContract, ctx: Ctx): Promise<SessionResult> {
    // Inv. 21 (depth ceiling) — enforced by ELIO, not Vela. Identical guard to InProcessAgentEngine
    // so behaviour is uniform regardless of which path runs.
    if (contract.depth >= contract.maxDepth) {
      const elicitation: Elicitation = {
        what:
          `vela inner loop: Tiefen-Limit erreicht (depth=${contract.depth} >= maxDepth=${contract.maxDepth}) ` +
          `— mehr Tiefe freigeben? (Inv. 21)`,
        whoCanAnswer: { users: ["operator"] },
        mode: "blocking",
      };
      return { elicitation };
    }

    const vela = await this.loadVela();
    if (vela === null) {
      this.onPath?.("fallback", "vela-module-unavailable");
      return this.fallback.run(contract, ctx);
    }

    // Lazily create the ONE persistent store (identity↔correlation, Inv. 12) from the loaded module.
    if (this.velaStore === undefined) this.velaStore = new vela.InMemoryStore();

    try {
      const turn = await runVelaTurn(vela, contract, ctx, this.velaStore);
      if (turn.blocked !== undefined) {
        // Vela paused/blocked -> propagate UP as an ELIO Suspended (Inv. 11). UNREACHABLE on the real
        // v0.1 single-step engine (see header NOT-YET note + vela-bridge RESUME/BLOCK CAVEAT); fires only
        // under the deterministic double's synthetic blockOn — a v0.2 multi-step behavioural spec.
        this.onPath?.("vela", "blocked");
        return { elicitation: blockedElicitation(turn.blocked.by) };
      }
      this.onPath?.("vela");
      // Surface only the captured reply: the agent node consumes the engine output as an opaque value and
      // re-builds a fresh SessionContract each turn, so a velaRunId/resumed flag would be inert (dead
      // output). Re-introduce them only with v0.2 store-backed resume + checkpoint threading.
      const resolved: Resolved<{ text: string }> = {
        status: "resolved",
        output: { text: turn.text },
        confidence: turn.confidence,
        cost: turn.cost,
      };
      return { result: resolved };
    } catch (err) {
      // A brittle real-Vela turn must NEVER break the agent node: fall back in-process (§7).
      const reason = err instanceof Error ? err.message : String(err);
      this.onPath?.("fallback", `vela-turn-threw: ${reason}`);
      return this.fallback.run(contract, ctx);
    }
  }
}
