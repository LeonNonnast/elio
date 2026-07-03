// ───────────────────────────── tighten-only Property-Tests (Inv. 13, §11/#15, Blueprint §4) ─────────────────────────────
// Exerziert die Halbordnungen aus Blueprint §4 generativ, aber DETERMINISTISCH: jede Variation wird aus
// einem Index abgeleitet (kein Math.random), sodass Fehlschläge reproduzierbar sind. Geprüfte
// Eigenschaften:
//  - monoton restriktiv: das Ergebnis ist auf KEINER Achse permissiver als der Parent.
//  - idempotent: tighten(tighten(p,r),r) == tighten(p,r).
//  - keine Hinzunahme: eine nicht-angeforderte / nicht-Parent-Capability kann NIE auftauchen
//    (models/tools/dbScopes = Teilmenge; allowCloud nur AND; dataClassification nur RAISE;
//    suspendMode nur RAISE; maxCostUsd nur min; fsPaths nur Schnitt).

import { describe, expect, it } from "vitest";
import {
  dataClassRank,
  DATA_CLASSIFICATION_ORDER,
  rootPolicy,
  SUSPEND_MODE_ORDER,
  suspendModeRank,
  tighten,
} from "./policy-impl";
import type { DataClassification } from "./policy-impl";
import type { CapabilityRequest, ResolvedPolicy } from "./policy";
import type { SuspendMode } from "./elicitation";

// ───────────────────────────── deterministische Achsen-Generatoren ─────────────────────────────

const MODEL_UNIVERSE = ["ollama", "claude", "gpt", "azure", "mistral"] as const;
const TOOL_UNIVERSE = ["read", "write", "exec", "net", "secret:DB"] as const;
const DB_UNIVERSE = ["sales", "hr", "finance", "ops"] as const;
const FS_PREFIX_UNIVERSE = ["/data", "/data/out", "/tmp", "/etc"] as const;
const FS_PATH_UNIVERSE = [
  "/data/sub/file.csv",
  "/data/out/x",
  "/tmp/y",
  "/etc/passwd",
  "/data",
] as const;

/** Wählt eine Teilmenge eines Universums anhand der Bits von `mask` (deterministisch). */
function subsetFromMask<T>(universe: readonly T[], mask: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < universe.length; i += 1) {
    if ((mask >> i) & 1) out.push(universe[i] as T);
  }
  return out;
}

/** Baut eine deterministische ResolvedPolicy (Parent) aus einem Index. */
function parentFromIndex(idx: number): ResolvedPolicy {
  const models = subsetFromMask(MODEL_UNIVERSE, idx & 0b11111);
  const tools = subsetFromMask(TOOL_UNIVERSE, (idx >> 5) & 0b11111);
  const db = subsetFromMask(DB_UNIVERSE, (idx >> 10) & 0b1111);
  const fsRead = subsetFromMask(FS_PREFIX_UNIVERSE, (idx >> 14) & 0b1111);
  const fsWrite = subsetFromMask(FS_PREFIX_UNIVERSE, (idx >> 18) & 0b1111);
  const dc = DATA_CLASSIFICATION_ORDER[(idx >> 22) % DATA_CLASSIFICATION_ORDER.length] as DataClassification;
  const sm = SUSPEND_MODE_ORDER[(idx >> 24) % SUSPEND_MODE_ORDER.length] as SuspendMode;
  const overrides: Partial<ResolvedPolicy> = {
    allowedModels: models,
    toolPermissions: tools,
    allowCloud: ((idx >> 26) & 1) === 1,
    dataClassification: dc,
    suspendMode: sm,
    dbScopes: db,
    fsPaths: { read: fsRead, write: fsWrite },
  };
  if (((idx >> 27) & 1) === 1) overrides.maxCostUsd = (idx % 7) + 1;
  return rootPolicy(overrides);
}

/** Baut einen deterministischen CapabilityRequest aus einem Index (kann über Parent hinausfragen). */
function requestFromIndex(idx: number): CapabilityRequest {
  const req: CapabilityRequest = {};
  if ((idx & 1) === 1) req.models = subsetFromMask(MODEL_UNIVERSE, (idx >> 1) & 0b11111);
  if (((idx >> 6) & 1) === 1) req.tools = subsetFromMask(TOOL_UNIVERSE, (idx >> 7) & 0b11111);
  if (((idx >> 12) & 1) === 1) req.db = subsetFromMask(DB_UNIVERSE, (idx >> 13) & 0b1111);
  if (((idx >> 17) & 1) === 1) {
    req.fs = {
      read: subsetFromMask(FS_PATH_UNIVERSE, (idx >> 18) & 0b11111),
      write: subsetFromMask(FS_PATH_UNIVERSE, (idx >> 23) & 0b11111),
    };
  }
  req.cloud = ((idx >> 28) & 1) === 1;
  return req;
}

/** Erzeugt N deterministische (parent, req)-Paare via gestreutem Index (kein Math.random). */
function* cases(n: number): Generator<{ idx: number; parent: ResolvedPolicy; req: CapabilityRequest }> {
  // Zwei teilerfremde Schrittweiten streuen die Bits beider Achsen breit über den Raum.
  for (let i = 0; i < n; i += 1) {
    const pIdx = (i * 2654435761) >>> 0;
    const rIdx = (i * 40503 + 12345) >>> 0;
    yield { idx: i, parent: parentFromIndex(pIdx), req: requestFromIndex(rIdx) };
  }
}

const N = 400;

// ───────────────────────────── Eigenschaft: keine Hinzunahme (Teilmenge / AND / RAISE / min) ─────────────────────────────

describe("tighten — never adds an unrequested or non-parent capability (Inv. 13)", () => {
  it("allowedModels ⊆ (parent ∩ request); never a model the parent lacks", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      const parentSet = new Set(parent.allowedModels);
      const reqSet = new Set(req.models ?? []);
      for (const m of r.allowedModels) {
        expect(parentSet.has(m), `case ${idx}: ${m} not in parent`).toBe(true);
        expect(reqSet.has(m), `case ${idx}: ${m} not requested`).toBe(true);
      }
    }
  });

  it("toolPermissions ⊆ (parent ∩ request)", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      const parentSet = new Set(parent.toolPermissions);
      const reqSet = new Set(req.tools ?? []);
      for (const t of r.toolPermissions) {
        expect(parentSet.has(t), `case ${idx}: tool ${t} not in parent`).toBe(true);
        expect(reqSet.has(t), `case ${idx}: tool ${t} not requested`).toBe(true);
      }
    }
  });

  it("dbScopes ⊆ (parent ∩ request) when requested; absent when not requested", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      if (req.db === undefined) {
        expect(r.dbScopes, `case ${idx}: db not requested -> absent`).toBeUndefined();
        continue;
      }
      const parentSet = new Set(parent.dbScopes ?? []);
      const reqSet = new Set(req.db);
      for (const d of r.dbScopes ?? []) {
        expect(parentSet.has(d), `case ${idx}: db ${d} not in parent`).toBe(true);
        expect(reqSet.has(d), `case ${idx}: db ${d} not requested`).toBe(true);
      }
    }
  });

  it("allowCloud is only ever parent.allowCloud AND request.cloud (never turns on against parent)", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      expect(r.allowCloud, `case ${idx}`).toBe(parent.allowCloud && !!req.cloud);
      if (!parent.allowCloud) expect(r.allowCloud, `case ${idx}: parent denies`).toBe(false);
    }
  });

  it("dataClassification only RAISES (>= parent), never lowers", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      expect(
        dataClassRank(r.dataClassification) >= dataClassRank(parent.dataClassification),
        `case ${idx}`,
      ).toBe(true);
      // a request cannot lower it: in tighten() req has no data-class axis, so it stays == parent.
      expect(r.dataClassification, `case ${idx}`).toBe(parent.dataClassification);
    }
  });

  it("suspendMode only RAISES (>= parent), never loosens", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      expect(
        suspendModeRank(r.suspendMode) >= suspendModeRank(parent.suspendMode),
        `case ${idx}`,
      ).toBe(true);
    }
  });

  it("maxCostUsd is only ever min(parent, ...) — never raised above the parent cap", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      if (parent.maxCostUsd === undefined) {
        expect(r.maxCostUsd, `case ${idx}`).toBeUndefined();
      } else {
        expect(r.maxCostUsd, `case ${idx}`).toBeLessThanOrEqual(parent.maxCostUsd);
      }
    }
  });

  it("fsPaths read/write only ever land under an allowed parent prefix (intersection)", () => {
    const underAny = (p: string, prefixes: readonly string[]): boolean =>
      prefixes.some((prefix) => p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      if (req.fs === undefined) {
        expect(r.fsPaths, `case ${idx}: fs not requested -> absent`).toBeUndefined();
        continue;
      }
      const allowedRead = parent.fsPaths?.read ?? [];
      const allowedWrite = parent.fsPaths?.write ?? [];
      for (const p of r.fsPaths?.read ?? []) {
        expect(underAny(p, allowedRead), `case ${idx}: read ${p} not under parent`).toBe(true);
        expect((req.fs.read ?? []).includes(p), `case ${idx}: read ${p} not requested`).toBe(true);
      }
      for (const p of r.fsPaths?.write ?? []) {
        expect(underAny(p, allowedWrite), `case ${idx}: write ${p} not under parent`).toBe(true);
        expect((req.fs.write ?? []).includes(p), `case ${idx}: write ${p} not requested`).toBe(true);
      }
    }
  });
});

// ───────────────────────────── Eigenschaft: monoton restriktiv ─────────────────────────────

describe("tighten — monotone restrictive: result is never MORE permissive than parent", () => {
  it("on every axis, the tightened policy is <= the parent in permissiveness", () => {
    for (const { idx, parent, req } of cases(N)) {
      const r = tighten(parent, req);
      // set axes: result is a subset of parent
      const pModels = new Set(parent.allowedModels);
      expect(r.allowedModels.every((m) => pModels.has(m)), `case ${idx}: models`).toBe(true);
      const pTools = new Set(parent.toolPermissions);
      expect(r.toolPermissions.every((t) => pTools.has(t)), `case ${idx}: tools`).toBe(true);
      const pDb = new Set(parent.dbScopes ?? []);
      expect((r.dbScopes ?? []).every((d) => pDb.has(d)), `case ${idx}: db`).toBe(true);
      // scalar axes: not looser than parent
      expect(r.allowCloud === false || parent.allowCloud === true, `case ${idx}: cloud`).toBe(true);
      expect(dataClassRank(r.dataClassification) >= dataClassRank(parent.dataClassification)).toBe(true);
      expect(suspendModeRank(r.suspendMode) >= suspendModeRank(parent.suspendMode)).toBe(true);
    }
  });
});

// ───────────────────────────── Eigenschaft: idempotent ─────────────────────────────

describe("tighten — idempotent: tighten(tighten(p,r),r) == tighten(p,r)", () => {
  it("re-tightening an already-tightened policy with the same request changes nothing", () => {
    for (const { idx, parent, req } of cases(N)) {
      const once = tighten(parent, req);
      const twice = tighten(once, req);
      // Compare structurally; normalize undefined-vs-absent by JSON round-trip on the comparable shape.
      expect(twice.allowedModels, `case ${idx}: models`).toEqual(once.allowedModels);
      expect(twice.toolPermissions, `case ${idx}: tools`).toEqual(once.toolPermissions);
      expect(twice.dbScopes, `case ${idx}: db`).toEqual(once.dbScopes);
      expect(twice.fsPaths, `case ${idx}: fs`).toEqual(once.fsPaths);
      expect(twice.allowCloud, `case ${idx}: cloud`).toBe(once.allowCloud);
      expect(twice.dataClassification, `case ${idx}: dc`).toBe(once.dataClassification);
      expect(twice.suspendMode, `case ${idx}: sm`).toBe(once.suspendMode);
      expect(twice.maxCostUsd, `case ${idx}: cost`).toBe(once.maxCostUsd);
    }
  });
});
