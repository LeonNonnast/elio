// ───────────────────────────── Built-in: synthesize-script + synthesize-complete (Tier-2 Codegen) ─────────────────────────────
// Der GENERATIVE Schritt der Tier-2-Engine: nimmt einen Tier-0 node-replacement-Kandidaten (deterministische
// Aufrufstelle), liest die ECHTEN (input,output)-Beispiele aus dem Tape (die Tier-0-Lookup trägt nur den
// input-HASH, nicht den Input — Codegen braucht die realen Inputs), und lässt das LLM eine reine Funktion
// `(input)=>output` GENERIEREN, die über die beobachtete Domäne hinaus generalisiert. Generate→validate→
// retry: jeder Kandidat-Code wird ISOLIERT (ctx.scripts) gegen die Beispiele UND gegen HELD-OUT Frames
// shadow-evaluiert; nur bei bestandenem held-out-Gate (Doc §8) wird ein Tier-2-Kandidat emittiert.
//
// Trennung wie Doc §4: synthesize ist ANALYSE (liest traces, schlägt einen Kandidaten vor) — es schreibt
// KEIN Pack (kein featurestore:write). Die mutierende, menschlich gegatete Promotion bleibt das separate
// promote-candidate-Feature (dessen promote-apply den Tier-2-Kandidaten re-validiert + schreibt).

import type { GateVerdict, Node, NodeDefinition, Resolved } from "../node";
import type { TapeFrame } from "../run";
import {
  hashValue,
  makeCandidate,
  resolvedFrames,
  shadowEvalScript,
  type DeterminismProposal,
  type PromotionCandidate,
  type ScriptProposal,
  type ShadowEvalResult,
  type Tier1Rule,
} from "../retro";

export interface SynthesizeScriptWith {
  /** Der Tier-0 node-replacement-Kandidat, aus dessen Beispielen Code generiert wird (via {{state.input}}). */
  candidate?: PromotionCandidate;
  /** Modell/Profil für die Codegen (fehlt → Worker-Default). */
  model?: string;
  provider?: string;
  /** Max. Codegen-Versuche (generate→validate→retry mit Fehler-Feedback). Default 3. */
  maxAttempts?: number;
  /** Held-out Shadow-Eval-Schwelle für die Annahme. Default 1 (exakt — die sichere Wahl, Doc §8). */
  minAgreement?: number;
  /** Zeitlimit (ms) je Skript-Ausführung bei der Validierung. */
  timeoutMs?: number;
}

interface Example {
  input: unknown;
  output: unknown;
}

interface SynthesizeOutput extends Record<string, unknown> {
  synthesized: boolean;
  attempts: number;
  candidate?: PromotionCandidate;
  verdict?: ShadowEvalResult;
  failures?: string[];
}

function isDeterminismProposal(p: unknown): p is DeterminismProposal {
  return typeof p === "object" && p !== null && Array.isArray((p as { lookup?: unknown }).lookup);
}

/** Zieht den Funktions-Source aus der Modell-Antwort: entfernt ```-Codefences und umliegenden Text/Whitespace. */
export function extractSource(text: string): string {
  const fence = /```(?:js|javascript|ts|typescript)?\s*([\s\S]*?)```/i.exec(text);
  const body = fence?.[1] ?? text;
  return body.trim();
}

const SYNTHESIS_SYSTEM =
  "Du schreibst eine REINE JavaScript-Funktion, die eine deterministische Transformation reproduziert und " +
  "darüber hinaus generalisiert. Strenge Regeln: (1) Gib NUR den Funktions-Ausdruck zurück, z.B. " +
  "`function transform(input) { ... }` oder `(input) => ...` — kein umgebender Text. (2) Reine Funktion: " +
  "KEIN require/import, KEIN process/fs/Netzwerk, KEINE Seiteneffekte, kein Date.now/Math.random. " +
  "(3) Der Rückgabewert muss exakt die Form der Beispiel-Outputs haben (JSON-serialisierbar). (4) Kann die " +
  "Funktion einen Input NICHT sicher behandeln, gib `undefined` zurück (das System fällt dann aufs LLM zurück).";

function buildPrompt(examples: readonly Example[], rule: Tier1Rule | undefined, lastFailure?: string): string {
  const lines = examples.map((e) => `input=${JSON.stringify(e.input)} -> output=${JSON.stringify(e.output)}`);
  let prompt = `Beispiele (input -> output):\n${lines.join("\n")}\n`;
  if (rule !== undefined) {
    prompt +=
      rule.kind === "constant"
        ? `\nHinweis: alle beobachteten Outputs sind identisch (${JSON.stringify(rule.value)}).\n`
        : "\nHinweis: der Output gleicht dem Input (passthrough).\n";
  }
  if (lastFailure !== undefined) {
    prompt += `\nDein vorheriger Versuch war falsch: ${lastFailure}\nKorrigiere die Funktion.\n`;
  }
  prompt += "\nSchreibe `function transform(input) { ... }`.";
  return prompt;
}

export const synthesizeScriptHandler: Node<SynthesizeScriptWith, SynthesizeOutput> = async (input, ctx) => {
  const cfg = (input ?? {}) as SynthesizeScriptWith;
  // security by absence (Inv. 14): Codegen braucht ctx.model, Validierung ctx.scripts, Beispiele ctx.traces.
  if (ctx.model === undefined) {
    throw new Error("synthesize-script: ctx.model nicht injiziert — Codegen braucht ein Modell (Inv. 14).");
  }
  if (ctx.scripts === undefined) {
    throw new Error("synthesize-script: ctx.scripts nicht injiziert — Validierung braucht scripts:execute (Inv. 14).");
  }
  if (ctx.traces === undefined) {
    throw new Error("synthesize-script: ctx.traces nicht injiziert — Beispiele brauchen traces:read (Inv. 14).");
  }
  const candidate = cfg.candidate;
  if (
    candidate === undefined ||
    candidate.kind !== "node-replacement" ||
    !isDeterminismProposal(candidate.proposal)
  ) {
    throw new Error(
      "synthesize-script: erwartet einen Tier-0 node-replacement-Kandidaten (DeterminismProposal) via {{state.input}}.",
    );
  }
  const site = candidate.callSite;
  if (site === undefined || site.feature.length === 0) {
    throw new Error("synthesize-script: candidate ohne callSite.feature — Beispiel-Tape unbestimmbar.");
  }

  // ECHTE (input,output)-Beispiele aus dem Tape (die Lookup trägt nur den Hash). Synthese-Beispiele =
  // Frames der Mining-Runs (candidate.evidence.runs); held-out = der Rest (shadowEvalScript schließt die
  // Mining-Runs ohnehin aus). Auf die Aufrufstelle gescopt (6b).
  const frames = await ctx.traces.collect({ feature: site.feature });
  const miningRuns = new Set(candidate.evidence.runs);
  const atSite = (f: TapeFrame): boolean =>
    f.correlation.step === site.step && f.nodeType === site.nodeType && (site.feature === "" || f.feature === site.feature);
  const examples: Example[] = resolvedFrames(frames)
    .filter((f) => atSite(f) && miningRuns.has(f.correlation.run))
    .map((f) => ({ input: f.input, output: f.result.output }));
  if (examples.length === 0) {
    throw new Error("synthesize-script: keine Synthese-Beispiele im Tape (Mining-Runs an der Aufrufstelle).");
  }
  const sample = examples.slice(0, 30); // Prompt-Größe begrenzen (Beispiel-Cap).

  const maxAttempts = cfg.maxAttempts ?? 3;
  const minAgreement = cfg.minAgreement ?? 1;
  const scripts = ctx.scripts;
  const runOpts = cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {};
  const rule = candidate.proposal.rule;
  const proposalDomain = candidate.proposal.domain;

  const failures: string[] = [];
  let lastFailure: string | undefined;
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    attempts = i + 1;
    const req: { messages: { role: string; content: string }[]; system: string; model?: string } = {
      messages: [{ role: "user", content: buildPrompt(sample, rule, lastFailure) }],
      system: SYNTHESIS_SYSTEM,
    };
    const canonicalModel =
      cfg.provider !== undefined && cfg.provider.length > 0
        ? cfg.model !== undefined && cfg.model.length > 0
          ? `${cfg.provider}:${cfg.model}`
          : cfg.provider
        : cfg.model;
    if (canonicalModel !== undefined && canonicalModel.length > 0) req.model = canonicalModel;

    const completion = await ctx.model.complete(req);
    if (ctx.cost !== undefined) ctx.cost.charge(completion.cost);
    const source = extractSource(completion.text);

    // (a) Sanity-Check gegen die Synthese-Beispiele: das generierte Skript MUSS sie reproduzieren.
    let exMismatch: string | undefined;
    for (const ex of sample) {
      const r = await scripts.run(source, ex.input, runOpts);
      if (!r.ok) {
        exMismatch = `Skript lieferte keinen Output für input=${JSON.stringify(ex.input)} (${r.error}).`;
        break;
      }
      if (hashValue(r.output) !== hashValue(ex.output)) {
        exMismatch = `für input=${JSON.stringify(ex.input)} erwartet ${JSON.stringify(ex.output)}, bekam ${JSON.stringify(r.output)}.`;
        break;
      }
    }
    if (exMismatch !== undefined) {
      lastFailure = exMismatch;
      failures.push(`Versuch ${attempts}: ${exMismatch}`);
      continue;
    }

    // (b) HELD-OUT Shadow-Eval (Doc §8, nicht optional): generalisiert das Skript korrekt? shadowEvalScript
    // schließt die Synthese-Runs aus und führt das Skript isoliert gegen unabhängiges Tape aus.
    const tier2: ScriptProposal = {
      tier: 2,
      source,
      domain: proposalDomain,
      ...(rule !== undefined ? { rule } : {}),
    };
    const probe = makeCandidate({
      source: "synthesize-script",
      kind: "node-replacement",
      callSite: site,
      support: candidate.support,
      evidence: candidate.evidence,
      proposal: tier2,
      summary: `Tier-2 Skript für ${site.nodeType}@${site.step} (aus ${examples.length} Beispielen)`,
    });
    const verdict = await shadowEvalScript(probe, frames, (src, inp) => scripts.run(src, inp, runOpts), minAgreement);
    if (verdict.passed) {
      const accepted = makeCandidate({
        source: "synthesize-script",
        kind: "node-replacement",
        callSite: site,
        support: candidate.support,
        evidence: candidate.evidence,
        ...(candidate.estImpact !== undefined ? { estImpact: candidate.estImpact } : {}),
        verdict,
        proposal: tier2,
        summary:
          `Tier-2 Skript für ${site.nodeType}@${site.step}: held-out-Agreement ` +
          `${Math.round((verdict.score ?? 0) * 100)}% über ${verdict.covered} Frames (Versuch ${attempts})`,
      });
      const output: SynthesizeOutput = { synthesized: true, attempts, candidate: accepted, verdict };
      const result: Resolved<SynthesizeOutput> = {
        status: "resolved",
        output,
        confidence: verdict.score ?? 1,
        cost: completion.cost,
      };
      return result;
    }
    lastFailure = verdict.failures.join("; ");
    failures.push(`Versuch ${attempts}: held-out ${lastFailure}`);
  }

  // Kein Versuch bestand das held-out-Gate → kein Tier-2-Kandidat (ehrlich: lieber kein Skript als ein falsches).
  const output: SynthesizeOutput = { synthesized: false, attempts, failures };
  const result: Resolved<SynthesizeOutput> = { status: "resolved", output, confidence: 0, cost: {} };
  return result;
};

/**
 * synthesize-script: klass "intelligence" (es DENKT — generiert Code via ctx.model). Fordert Modelle +
 * traces:read (Beispiele) + scripts:execute (Validierung). Schreibt KEIN Pack — die mutierende Promotion
 * bleibt das separate, approval-gegatete promote-candidate-Feature (Doc §4).
 */
export const synthesizeScriptNode: NodeDefinition<SynthesizeScriptWith, SynthesizeOutput> = {
  type: "synthesize-script",
  klass: "intelligence",
  handler: synthesizeScriptHandler,
  requests: { models: ["*"], tools: ["traces:read", "scripts:execute"] },
};

// ───────────────────────────── synthesize-complete: Eval-Gate ─────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Eval-Gate des synthesize-script-Features: passt, sobald `content.synthesized === true` (ein validierter
 * Tier-2-Kandidat liegt im Artefakt). synthesized===false (kein Versuch bestand das held-out-Gate) → stopped.
 */
export const synthesizeCompleteHandler: Node<unknown, GateVerdict> = (_input, ctx) => {
  const content = ctx.artifact.content;
  const ok = isRecord(content) && content["synthesized"] === true;
  const verdict: GateVerdict = ok
    ? { passed: true, score: 1, failures: [] }
    : { passed: false, score: 0, failures: ["synthesize-complete: kein Tier-2-Kandidat (held-out-Gate nicht bestanden)"] };
  return Promise.resolve({ status: "resolved", output: verdict, confidence: 1, cost: {} });
};

export const synthesizeCompleteNode: NodeDefinition<unknown, GateVerdict> = {
  type: "synthesize-complete",
  klass: "orchestration",
  handler: synthesizeCompleteHandler,
};
