// ───────────────────────────── Default Vela module loader (best-effort, impl-decisions §7) ─────────────────────────────
// Lazily dynamic-imports the published `vela-sdk` package and adapts it to the structural VelaModule
// the bridge needs. vela-sdk is NOT a hard dependency (Inv. 2: Vela stays standalone OSS); if it is
// not installed the import rejects and the VelaAgentEngine falls back to the in-process loop. Install
// `vela-sdk` in a consuming app to activate the real path.

import type { VelaModule } from "./vela-contract";

/**
 * Dynamic-import the real `vela-sdk`. Returns a VelaModule, or null if the package is missing /
 * its surface has drifted. Never throws (a throw would be caught by the engine anyway, but we
 * normalise to null so the fallback decision is explicit).
 *
 * The specifier is held in a variable so the bundler/typechecker does not try to statically resolve
 * the (intentionally absent) `vela-sdk` dependency.
 */
export async function defaultVelaModuleLoader(): Promise<VelaModule | null> {
  const specifier = "vela-sdk";
  try {
    const mod: unknown = await import(/* @vite-ignore */ specifier);
    return adaptVelaModule(mod);
  } catch {
    return null;
  }
}

/** Validate that a loaded module exposes the runtime surface the bridge drives. */
export function adaptVelaModule(mod: unknown): VelaModule | null {
  if (mod === null || typeof mod !== "object") return null;
  const m = mod as Record<string, unknown>;
  if (
    typeof m["DefaultWorkflowEngine"] === "function" &&
    typeof m["InMemoryStore"] === "function" &&
    typeof m["registerDelegate"] === "function" &&
    typeof m["resolveDelegate"] === "function"
  ) {
    // Structural match — the real vela-sdk satisfies VelaModule by construction.
    return m as unknown as VelaModule;
  }
  return null;
}
