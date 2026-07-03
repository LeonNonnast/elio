// ───────────────────────────── Skill-Builder-FeatureProvider ─────────────────────────────
// Wrappt die setupSkillBuilder()-Fassade. Die outDir-Policy (frisches temp-Verzeichnis, fs-Write CONFINED
// darauf, Inv. 14) lebt jetzt hier statt in jeder Surface. outDir/brief via ctx.params überschreibbar;
// ohne brief werden die Pflichtfelder per Interview (Elicitation) erhoben.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillPack, setupSkillBuilder } from "@elio/skill-builder";
import type { SkillBrief } from "@elio/skill-builder";
import type { FeatureProvider } from "../provider";
import { modelOptsFrom, storeOptFrom } from "../provider";

const SKILL_CAPS = { model: true, db: false, fs: "write", traces: false, ephemeralStore: false } as const;

/** build-skill — Meta-Vertikale: baut ein Claude-Skill-Verzeichnis hinter einem approve_write-Gate. */
export function skillBuilderProvider(): FeatureProvider {
  const pack = buildSkillPack();
  return {
    id: pack.metadata.id,
    pack,
    capabilities: { ...SKILL_CAPS },
    setup: (ctx) => {
      const outDir =
        typeof ctx.params?.["outDir"] === "string"
          ? (ctx.params["outDir"] as string)
          : mkdtempSync(join(tmpdir(), "elio-skill-"));
      const brief = ctx.params?.["brief"] as SkillBrief | undefined;
      const setup = setupSkillBuilder({
        outDir,
        ...(brief !== undefined ? { brief } : {}),
        ...storeOptFrom(ctx, SKILL_CAPS),
        ...modelOptsFrom(ctx),
        ...(ctx.rootPolicy !== undefined ? { rootPolicy: ctx.rootPolicy } : {}),
      });
      return { runtime: setup.runtime, pack: setup.pack, handles: { outDir: setup.outDir } };
    },
  };
}
