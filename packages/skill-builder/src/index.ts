// @elio/skill-builder — Meta-Vertikale: ein Feature, dessen ARTEFAKT ein Claude-Code-Skill ist (SKILL.md).
// Es interviewt den Nutzer (Elicitation), draftet eine SKILL.md, validiert sie und schreibt sie governed
// auf die Platte (fs-Write CONFINED auf outDir, Inv. 14). Brief/outDir sind injizierte Werte, keine Steps
// (analog @elio/migrate, §7). Built-in == custom (Inv. 6): die Fach-Nodes hängen an derselben Registry.

// ───────────────────────────── Skill-Logik (reine, deterministische Bausteine) ─────────────────────────────
export {
  buildSkillMd,
  buildSkillBody,
  validateSkillMd,
  parseSkillMd,
  isKebabCase,
  toKebabCase,
  toSingleLine,
  skillNameFrom,
  firstMissingField,
  briefIsComplete,
  questionFor,
  extractBodyFromModel,
  REQUIRED_BRIEF_FIELDS,
  SKILL_ARTIFACT_KIND,
  SKILL_BUILDER_MODEL,
  PLACEHOLDER_NAME,
  PLACEHOLDER_DESCRIPTION,
  PLACEHOLDER_PURPOSE,
} from "./skill";
export type {
  SkillBrief,
  RequiredBriefField,
  ParsedFrontmatter,
  SkillValidation,
} from "./skill";

// ───────────────────────────── Nodes + registerSkillBuilder ─────────────────────────────
export { registerSkillBuilder } from "./nodes";
export type { RegisterSkillBuilderOptions } from "./nodes";

// ───────────────────────────── Policies ─────────────────────────────
export {
  registerSkillBuilderPolicies,
  skillWriteRequiresApprovalPolicy,
  SKILL_WRITE_REQUIRES_APPROVAL,
} from "./policies";

// ───────────────────────────── Setup-Fassade + Feature-Pack ─────────────────────────────
export {
  setupSkillBuilder,
  loadSkillBuilderFeature,
  skillBuilderFeaturePath,
  skillBuilderRootPolicy,
  SKILL_TYPE,
} from "./setup";
export type { SetupSkillBuilderOptions, SkillBuilderSetup } from "./setup";

import { loadSkillBuilderFeature } from "./setup";
import type { FeaturePack } from "@elio/core";

/**
 * Programmatischer Zugriff auf den kanonischen build-skill-FeaturePack (geladen + compiliert aus der
 * feature.yaml). Gegenstück zu setupSkillBuilder() für Aufrufer, die nur den Pack brauchen (z.B. um ihn
 * an eine eigene, schon verdrahtete Runtime zu reichen).
 */
export function buildSkillPack(): FeaturePack {
  return loadSkillBuilderFeature();
}
