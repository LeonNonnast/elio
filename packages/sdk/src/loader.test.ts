// ───────────────────────────── @elio/sdk — Feature-Pack-YAML-Loader Tests ─────────────────────────────
//
// Deckt die fünf geforderten Eigenschaften ab:
//  (a) Inline-YAML lädt in das korrekte typisierte FeaturePack (graph steps/edges/io/policies present).
//  (b) contentHash ist deterministisch + stabil über Reloads UND ändert sich, wenn die YAML ODER eine
//      referenzierte Prompt-/Schema-Datei sich ändert.
//  (c) Malformed YAML / fehlendes Pflichtfeld wirft einen klaren FeaturePackError.
//  (d) Ein geladener Pack läuft end-to-end durch createRuntime().run() bis gate:"passed" — nur mit
//      Built-in-Nodes (transform + validate als Gate). Beweist: Loader-Output ist execution-ready.
//  (e) Resume gegen einen Pack mit ABWEICHENDEM contentHash wird über den packVersion-Check des Runners
//      abgelehnt.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ArtifactType, NodeDefinition, RunEvent } from "@elio/core";
import {
  collectEvents,
  computeContentHash,
  createRuntime,
  FeaturePackError,
  loadFeaturePack,
  loadFeaturePackFromFile,
} from "./index";

// ───────────────────────────── Test-YAML-Fixtures ─────────────────────────────

/**
 * Vollständiger guided Pack: file-ref auf einen Prompt (für den Hash) + io.output via $ref + policies +
 * graph mit steps/edges/state/outputs. Kein agent-Step, damit (a)/(b) ohne ein Modell laufen.
 */
const SAMPLE_YAML = `
apiVersion: elio/v1
kind: Feature
metadata:
  id: sample.loader
  version: 0.1.0
  owner: tester
  lifecycle: draft
feature:
  autonomy: guided
  artifact:
    kind: text-doc
    evalGate: artifact-ready
  policies:
    - no_cloud_for_private_data
    - commit_requires_approval
  io:
    input:
      type: object
      properties:
        source: {}
    output:
      $ref: ./schemas/target.schema.json
  graph:
    state:
      progress: ""
    steps:
      - id: propose
        type: agent
        with:
          prompt:
            system: ./prompts/mapping.system.md
          take: 5
      - id: finalize
        type: transform
        with:
          set: done
          as: status
        outputs:
          status: state.progress
    edges:
      - { from: propose, to: finalize }
`;

/**
 * End-to-end runnable Pack — NUR Built-in-Nodes. Ein transform-Step setzt content.ready=true; das
 * Eval-Gate ist die Built-in validate-Node mit einem Schema gegen das Artefakt (der Runner ruft das
 * Gate mit { artifact, value: artifact } auf — validate prüft `value`, also das ganze Artefakt).
 */
const RUNNABLE_YAML = `
apiVersion: elio/v1
kind: Feature
metadata:
  id: sample.runnable
  version: 0.1.0
feature:
  autonomy: static
  artifact:
    kind: text-doc
    evalGate: validate
  io:
    input: { type: object }
    output: { type: object }
  graph:
    state:
      ready: false
    steps:
      - id: mark_ready
        type: transform
        with:
          set: true
          as: ready
        outputs:
          ready: state.ready
    edges: []
`;

const TEXT_DOC_TYPE: ArtifactType = { kind: "text-doc", holders: ["progress.md", "memory"] };

// ───────────────────────────── (a) typisiertes Laden ─────────────────────────────

describe("loadFeaturePack — typed compile", () => {
  it("compiliert Inline-YAML in das korrekte FeaturePack-Shape", () => {
    const pack = loadFeaturePack({ yaml: SAMPLE_YAML });

    expect(pack.apiVersion).toBe("elio/v1");
    expect(pack.kind).toBe("Feature");
    expect(pack.metadata).toEqual({
      id: "sample.loader",
      version: "0.1.0",
      owner: "tester",
      lifecycle: "draft",
    });

    expect(pack.feature.autonomy).toBe("guided");
    expect(pack.feature.artifact).toEqual({ kind: "text-doc", evalGate: "artifact-ready" });
    expect(pack.feature.policies).toEqual([
      "no_cloud_for_private_data",
      "commit_requires_approval",
    ]);

    // io: input + output (output via $ref) sind beides Objekte.
    expect(pack.feature.io.input).toMatchObject({ type: "object" });
    expect(pack.feature.io.output).toMatchObject({ $ref: "./schemas/target.schema.json" });

    // graph: steps + edges + state korrekt typisiert.
    const graph = pack.feature.graph;
    expect(graph).toBeDefined();
    expect(graph?.state).toEqual({ progress: "" });
    expect(graph?.steps).toHaveLength(2);

    const propose = graph?.steps[0];
    expect(propose?.id).toBe("propose");
    expect(propose?.type).toBe("agent");
    expect(propose?.with).toMatchObject({ take: 5 });

    const finalize = graph?.steps[1];
    expect(finalize?.id).toBe("finalize");
    expect(finalize?.type).toBe("transform");
    expect(finalize?.outputs).toEqual({ status: "state.progress" });

    expect(graph?.edges).toEqual([{ from: "propose", to: "finalize" }]);
  });

  it("computeContentHash matcht den vom Loader gesetzten contentHash", () => {
    const pack = loadFeaturePack({ yaml: SAMPLE_YAML });
    expect(pack.contentHash).toBeDefined();
    expect(pack.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Re-Hash über denselben Pack (ohne baseDir -> file-refs unreadable, aber pfad-stabil).
    expect(computeContentHash(pack)).toBe(pack.contentHash);
  });
});

// ───────────────────────────── (b) contentHash-Determinismus + Sensitivität ─────────────────────────────

describe("loadFeaturePack — contentHash", () => {
  it("ist deterministisch + stabil über Reloads derselben YAML", () => {
    const a = loadFeaturePack({ yaml: SAMPLE_YAML });
    const b = loadFeaturePack({ yaml: SAMPLE_YAML });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("ändert sich, wenn die YAML sich ändert", () => {
    const base = loadFeaturePack({ yaml: SAMPLE_YAML });
    const edited = loadFeaturePack({ yaml: SAMPLE_YAML.replace("0.1.0", "0.2.0") });
    expect(edited.contentHash).not.toBe(base.contentHash);
  });

  describe("mit referenzierten Dateien auf der Platte", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "elio-pack-"));
      writeFileSync(join(dir, "feature.yaml"), SAMPLE_YAML, "utf8");
      // Referenzierte Dateien anlegen, damit ihr INHALT in den Hash fließt.
      writeFileSync(join(dir, "prompts.system.placeholder"), "x", "utf8"); // no-op, hält dir nicht leer
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("ändert sich, wenn ein referenzierter Prompt sich ändert (§11/#14)", () => {
      const promptDir = join(dir, "prompts");
      const schemaDir = join(dir, "schemas");
      writeFileSync(join(dir, "feature.yaml"), SAMPLE_YAML, "utf8");
      // Verzeichnisse + referenzierte Dateien anlegen.
      mkdirpSync(promptDir);
      mkdirpSync(schemaDir);
      writeFileSync(join(promptDir, "mapping.system.md"), "You are a mapping agent.\n", "utf8");
      writeFileSync(
        join(schemaDir, "target.schema.json"),
        JSON.stringify({ type: "object", properties: { id: { type: "string" } } }),
        "utf8",
      );

      const before = loadFeaturePackFromFile(join(dir, "feature.yaml"));
      expect(before.contentHash).toMatch(/^sha256:/);

      // Prompt-Inhalt ändern -> Hash MUSS sich ändern (selbe YAML, anderer Prompt).
      writeFileSync(join(promptDir, "mapping.system.md"), "You are a DIFFERENT mapping agent.\n", "utf8");
      const after = loadFeaturePackFromFile(join(dir, "feature.yaml"));

      expect(after.contentHash).not.toBe(before.contentHash);
    });

    it("ist stabil, solange YAML + referenzierte Dateien unverändert sind", () => {
      const a = loadFeaturePackFromFile(join(dir, "feature.yaml"));
      const b = loadFeaturePackFromFile(join(dir, "feature.yaml"));
      expect(a.contentHash).toBe(b.contentHash);
    });
  });
});

// ───────────────────────────── (c) Fehlerfälle ─────────────────────────────

describe("loadFeaturePack — malformed", () => {
  it("wirft bei kaputtem YAML einen klaren FeaturePackError", () => {
    expect(() => loadFeaturePack({ yaml: "apiVersion: elio/v1\n  : : :\nkind: [unterminated" })).toThrow(
      FeaturePackError,
    );
  });

  it("wirft bei falscher apiVersion", () => {
    const yaml = SAMPLE_YAML.replace("apiVersion: elio/v1", "apiVersion: elio/v2");
    expect(() => loadFeaturePack({ yaml })).toThrow(/apiVersion muss "elio\/v1"/);
  });

  it("wirft bei falschem kind", () => {
    const yaml = SAMPLE_YAML.replace("kind: Feature", "kind: Workflow");
    expect(() => loadFeaturePack({ yaml })).toThrow(/kind muss "Feature"/);
  });

  it("wirft bei fehlendem metadata.id", () => {
    const yaml = `
apiVersion: elio/v1
kind: Feature
metadata:
  version: 0.1.0
feature:
  autonomy: static
  artifact: { kind: x, evalGate: g }
  io: { input: {}, output: {} }
  graph: { steps: [ { id: s, type: transform } ], edges: [] }
`;
    expect(() => loadFeaturePack({ yaml })).toThrow(/metadata.id/);
  });

  it("wirft bei fehlendem feature.artifact.evalGate (Inv. 1)", () => {
    const yaml = `
apiVersion: elio/v1
kind: Feature
metadata: { id: x, version: 0.1.0 }
feature:
  autonomy: static
  artifact: { kind: text-doc }
  io: { input: {}, output: {} }
  graph: { steps: [ { id: s, type: transform } ], edges: [] }
`;
    expect(() => loadFeaturePack({ yaml })).toThrow(/evalGate/);
  });

  it("wirft, wenn weder graph noch planner gesetzt ist", () => {
    const yaml = `
apiVersion: elio/v1
kind: Feature
metadata: { id: x, version: 0.1.0 }
feature:
  autonomy: static
  artifact: { kind: text-doc, evalGate: validate }
  io: { input: {}, output: {} }
`;
    expect(() => loadFeaturePack({ yaml })).toThrow(/graph .* oder planner/);
  });

  it("wirft bei Edge, die einen unbekannten Step referenziert", () => {
    const yaml = `
apiVersion: elio/v1
kind: Feature
metadata: { id: x, version: 0.1.0 }
feature:
  autonomy: static
  artifact: { kind: text-doc, evalGate: validate }
  io: { input: {}, output: {} }
  graph:
    steps: [ { id: s, type: transform } ]
    edges: [ { from: s, to: nonexistent } ]
`;
    expect(() => loadFeaturePack({ yaml })).toThrow(/nonexistent/);
  });

  it("wirft, wenn weder path noch yaml übergeben wird", () => {
    expect(() => loadFeaturePack({})).toThrow(/`path` oder `yaml`/);
  });
});

// ───────────────────────────── (d) end-to-end durch createRuntime().run() ─────────────────────────────

describe("loadFeaturePack — execution-ready", () => {
  it("ein geladener Pack läuft mit nur Built-in-Nodes bis gate:'passed'", async () => {
    const pack = loadFeaturePack({ yaml: RUNNABLE_YAML });

    const runtime = createRuntime({ artifactTypes: { "text-doc": TEXT_DOC_TYPE } });
    // Eval-Gate "validate" (Built-in) gegen das Artefakt: artifact.content.ready muss truthy sein.
    // Das Gate liest `value` (= das ganze Artefakt) — daher Schema auf content.ready. Wir hängen die
    // Gate-Konfiguration NICHT an die YAML (das Gate ist eine registrierte Node, built-in==custom):
    // hier registrieren wir eine validate-Variante, die das Artefakt-content prüft.
    runtime.registry.register({
      type: "validate",
      klass: "orchestration",
      handler: (input: unknown) => {
        const artifact = (input as { artifact?: { content?: Record<string, unknown> } }).artifact;
        const ready = artifact?.content?.["ready"] === true;
        return Promise.resolve({
          status: "resolved" as const,
          output: { passed: ready, score: ready ? 1 : 0, failures: ready ? [] : ["not ready"] },
          confidence: 1,
          cost: { usd: 0 },
        });
      },
    } as unknown as NodeDefinition);

    const events: RunEvent[] = await collectEvents(
      runtime.run(pack, { payload: {}, budget: 10, maxDepth: 20 }),
    );

    const completed = events.find((e) => e.type === "run-completed");
    expect(completed).toBeDefined();
    expect(completed && completed.type === "run-completed" && completed.gate).toBe("passed");
  });
});

// ───────────────────────────── (e) Resume gegen geänderten Pack -> reject (§11/#14) ─────────────────────────────

/**
 * Pack mit einem blocking approval-Step, der suspendet — so entsteht ein Checkpoint, gegen den ein
 * Resume mit ABWEICHENDER Pack-Version geprüft werden kann.
 */
const SUSPENDING_YAML = `
apiVersion: elio/v1
kind: Feature
metadata: { id: sample.suspend, version: 0.1.0 }
feature:
  autonomy: static
  artifact: { kind: text-doc, evalGate: never-passes }
  io: { input: { type: object }, output: { type: object } }
  graph:
    state: {}
    steps:
      - id: gate
        type: approval
        suspend: blocking
        with: { reason: "approve to continue" }
    edges: []
`;

describe("loadFeaturePack — resume packVersion-Pinning (§11/#14)", () => {
  it("lehnt Resume ab, wenn der erwartete contentHash vom gepinnten abweicht", async () => {
    const pack = loadFeaturePack({ yaml: SUSPENDING_YAML });

    const runtime = createRuntime({ artifactTypes: { "text-doc": TEXT_DOC_TYPE } });
    // Gate, das nie besteht, damit der Run nicht vor dem approval-Suspend completed.
    runtime.registry.register({
      type: "never-passes",
      klass: "orchestration",
      handler: () =>
        Promise.resolve({
          status: "resolved" as const,
          output: { passed: false, failures: ["pending approval"] },
          confidence: 1,
          cost: { usd: 0 },
        }),
    } as unknown as NodeDefinition);

    const events = await collectEvents(runtime.run(pack, { payload: {}, budget: 10, maxDepth: 20 }));
    const suspended = events.find((e) => e.type === "node-suspended");
    expect(suspended).toBeDefined();
    if (!suspended || suspended.type !== "node-suspended") throw new Error("kein Suspend");

    const corrId = suspended.correlation;

    // Ein Resume mit einer ABWEICHENDEN erwarteten Pack-Version (simuliert eine editierte YAML, die zu
    // einem anderen contentHash kompiliert) wird vom Runner-packVersion-Check abgelehnt (§11/#14).
    const editedPack = loadFeaturePack({ yaml: SUSPENDING_YAML.replace("0.1.0", "0.9.9") });
    expect(editedPack.contentHash).not.toBe(pack.contentHash);
    const editedHash = editedPack.contentHash;
    if (editedHash === undefined) throw new Error("editedPack.contentHash undefined");

    await expect(
      collectEvents(
        runtime.resume(corrId, { approved: true }, { expectedPackVersion: editedHash }),
      ),
    ).rejects.toThrow(/Pack-Version geändert/);
  });
});

// ───────────────────────────── (f) nested subworkflow-Steps werden compiliert/validiert ─────────────────────────────

/** Pack mit einem subworkflow-Step, dessen with.steps eine per-record Kind-Step-Liste trägt (§7). */
const SUBWORKFLOW_YAML = `
apiVersion: elio/v1
kind: Feature
metadata: { id: sample.subworkflow, version: 0.1.0 }
feature:
  autonomy: guided
  artifact: { kind: text-doc, evalGate: g }
  io: { input: { type: object }, output: { type: object } }
  graph:
    state: { items: [] }
    steps:
      - id: fan
        type: subworkflow
        with:
          forEach: "{{state.items}}"
          itemKey: record
          steps:
            - id: transform_record
              type: transform
            - id: validate_record
              type: validate
              when: state.record
    edges: []
`;

describe("loadFeaturePack — nested subworkflow steps are compiled + validated (§3, Inv. 6)", () => {
  it("compiliert with.steps zu typisierten StepRefs (nicht verbatim) und ehrt nested when/suspend", () => {
    const pack = loadFeaturePack({ yaml: SUBWORKFLOW_YAML });
    const fan = pack.feature.graph?.steps[0];
    const nested = (fan?.with as { steps?: unknown[] } | undefined)?.steps;
    expect(Array.isArray(nested)).toBe(true);
    const list = nested as { id: string; type: string; when?: string }[];
    expect(list.map((s) => s.id)).toEqual(["transform_record", "validate_record"]);
    expect(list[0]?.type).toBe("transform");
    expect(list[1]?.when).toBe("state.record");
  });

  it("wirft, wenn ein nested Step type kein String ist (kein half-built pack)", () => {
    const bad = SUBWORKFLOW_YAML.replace("type: transform\n            - id: validate_record", "type: 12345\n            - id: validate_record");
    expect(() => loadFeaturePack({ yaml: bad })).toThrow(/with\.steps.*type muss ein nichtleerer String/s);
  });

  it("wirft, wenn ein nested Step keine id hat", () => {
    const bad = SUBWORKFLOW_YAML.replace("            - id: transform_record\n              type: transform\n", "            - type: transform\n");
    expect(() => loadFeaturePack({ yaml: bad })).toThrow(/with\.steps.*id muss ein nichtleerer String/s);
  });

  it("wirft bei doppelter nested Step-id", () => {
    const bad = SUBWORKFLOW_YAML.replace("- id: validate_record", "- id: transform_record");
    expect(() => loadFeaturePack({ yaml: bad })).toThrow(/doppelte nested Step-id/);
  });

  it("wirft bei ungültigem nested suspend-Modus", () => {
    const bad = SUBWORKFLOW_YAML.replace(
      "            - id: validate_record\n              type: validate",
      "            - id: validate_record\n              type: validate\n              suspend: nonsense",
    );
    expect(() => loadFeaturePack({ yaml: bad })).toThrow(/suspend muss eines von/);
  });
});

// ───────────────────────────── (g) Prompt-/Schema-file-refs werden zu Inhalt aufgelöst (execution-ready) ─────────────────────────────

const AGENT_PROMPT_YAML = `
apiVersion: elio/v1
kind: Feature
metadata: { id: sample.prompt, version: 0.1.0 }
feature:
  autonomy: guided
  artifact: { kind: text-doc, evalGate: g }
  io: { input: { type: object }, output: { type: object } }
  graph:
    state: {}
    steps:
      - id: propose
        type: agent
        with:
          system: ./prompts/sys.md
          prompt: ./prompts/user.md
    edges: []
`;

describe("loadFeaturePack — prompt/schema file refs resolve to content (execution-ready, §7/§11/#14)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "elio-prompt-"));
    mkdirpSync(join(dir, "prompts"));
    writeFileSync(join(dir, "feature.yaml"), AGENT_PROMPT_YAML, "utf8");
    writeFileSync(join(dir, "prompts", "sys.md"), "SYSTEM PROMPT CONTENT\n", "utf8");
    writeFileSync(join(dir, "prompts", "user.md"), "USER PROMPT CONTENT\n", "utf8");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inlined den DATEI-INHALT in with.system/with.prompt (nicht den Pfad)", () => {
    const pack = loadFeaturePackFromFile(join(dir, "feature.yaml"));
    const propose = pack.feature.graph?.steps[0];
    const w = propose?.with as { system?: string; prompt?: string };
    expect(w.system).toBe("SYSTEM PROMPT CONTENT\n");
    expect(w.prompt).toBe("USER PROMPT CONTENT\n");
  });

  it("der Hash ändert sich, wenn der referenzierte Prompt-Inhalt sich ändert (§11/#14)", () => {
    const before = loadFeaturePackFromFile(join(dir, "feature.yaml"));
    writeFileSync(join(dir, "prompts", "sys.md"), "DIFFERENT SYSTEM PROMPT\n", "utf8");
    const after = loadFeaturePackFromFile(join(dir, "feature.yaml"));
    expect(after.contentHash).not.toBe(before.contentHash);
    // ...und der neue Inhalt ist inlined.
    expect((after.feature.graph?.steps[0]?.with as { system?: string }).system).toBe(
      "DIFFERENT SYSTEM PROMPT\n",
    );
  });

  it("wirft fail-loud, wenn ein file-basierter Pack einen nicht-lesbaren Prompt-ref hat", () => {
    const yaml = AGENT_PROMPT_YAML.replace("./prompts/sys.md", "./prompts/missing.md");
    writeFileSync(join(dir, "feature2.yaml"), yaml, "utf8");
    expect(() => loadFeaturePackFromFile(join(dir, "feature2.yaml"))).toThrow(
      /referenziert die Datei "\.\/prompts\/missing\.md".*nicht gelesen werden/s,
    );
  });

  it("ein reiner Inline-Pack (ohne baseDir) lässt nicht-lesbare refs als Pfad stehen (kein throw)", () => {
    const pack = loadFeaturePack({ yaml: AGENT_PROMPT_YAML });
    const w = pack.feature.graph?.steps[0]?.with as { system?: string };
    expect(w.system).toBe("./prompts/sys.md");
  });
});

// ───────────────────────────── Test-Helfer ─────────────────────────────

function mkdirpSync(p: string): void {
  mkdirSync(p, { recursive: true });
}
