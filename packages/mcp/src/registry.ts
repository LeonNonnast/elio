// ───────────────────────────── Feature-Discovery (dünn über @elio/engine, Inv. 2) ─────────────────────────────
// Die MCP-Surface ist ein Client des EngineService: tools/list spiegelt den ZENTRALEN Engine-Katalog
// (defaultCatalog()), tools/call reicht an engine.startRun() durch. KEINE eigene Feature-Auflösung,
// KEINE Runtime-Konstruktion mehr hier (das war die zur CLI gespiegelte Duplikation — entfernt).
//
// MCP-spezifisch bleibt nur: ein VOLLSTÄNDIGER Default-Brief für build-skill, weil ein synchroner
// v0.1-Tool-Call kein Interview (Resume) führen kann — mit komplettem Brief läuft der Pack bis zum
// blocking approve_write-Gate (genau wie migrate am Commit-Approval).

import { defaultCatalog } from "@elio/engine";
import type { FeaturePack } from "@elio/core";
import type { SkillBrief } from "@elio/skill-builder";

/** Ein für tools/list sichtbares Feature: stabile id (= MCP-Tool-Name) + sein Pack (Schema/Beschreibung). */
export interface FeatureInfo {
  id: string;
  pack: FeaturePack;
}

/**
 * Die für die MCP-Surface sichtbaren Features = der zentrale Engine-Katalog. Reihenfolge ist stabil
 * (Katalog-Reihenfolge), damit tools/list deterministisch ist.
 */
export function discoverFeatures(): FeatureInfo[] {
  return defaultCatalog().all().map((p) => ({ id: p.id, pack: p.pack }));
}

/** Indexiert eine FeatureInfo-Liste nach id (für tools/call-Lookup). */
export function indexFeatures(entries: FeatureInfo[]): Map<string, FeatureInfo> {
  const map = new Map<string, FeatureInfo>();
  for (const e of entries) map.set(e.id, e);
  return map;
}

/**
 * Default-Brief für die build-skill-Meta-Vertikale über MCP. Ein VOLLSTÄNDIGER Brief verhindert die
 * collect_brief-Elicitation; der Lauf draftet + validiert deterministisch (MockModel) und suspendiert
 * am blocking approve_write-Gate. Tool-Argumente überschreiben einzelne Felder.
 */
export const SKILL_SAMPLE_BRIEF: SkillBrief = {
  name: "hello-skill",
  description: "A sample generated skill; use it as a starting point for a real skill.",
  purpose: "Demonstrate the build-skill meta-vertical end-to-end (draft, validate, approve, write).",
  whenToUse: "When you want to see how build-skill produces a SKILL.md.",
  instructions: "1. Replace this body with real instructions.\n2. Keep the frontmatter name + description.",
};

/** Baut einen SkillBrief aus den MCP-Tool-Argumenten (Felder überschreiben den Default-Sample-Brief). */
export function briefFromArgs(args: Record<string, unknown>): SkillBrief {
  const brief: SkillBrief = { ...SKILL_SAMPLE_BRIEF };
  for (const field of ["name", "description", "purpose", "whenToUse", "instructions"] as const) {
    if (typeof args[field] === "string") brief[field] = args[field] as string;
  }
  return brief;
}
