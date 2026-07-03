// ───────────────────────────── @elio/studio — Static preview sample data ─────────────────────────────
// Realistic, hand-authored sample data shaped EXACTLY like the live API responses, so the static preview
// snapshot (dashboard-preview.html) shows the full dashboard — loop timeline, approval inbox, tape
// scrubber, feature catalog — WITHOUT a running server. Shapes mirror @elio/core:
//   runs    -> RunStatus[]            (GET /api/runs · store.liveStatus())
//   tapes   -> { [run]: TapeFrame[] } (GET /api/runs/:id/tape · store.tape())
//   catalog -> FeatureCatalogEntry[]  (GET /api/features)
// No external requests; inlined into the preview as `window.ELIO_SAMPLE`.

const RUN_A = "9f3c1a77-draft-0001"; // draft-until-good — completed, multi-iteration loop (the showcase)
const RUN_B = "2b8e44d9-migr-0002"; // migrate — suspended at the blocking commit approval (inbox)
const RUN_C = "7d10cc02-retry-0003"; // retry-then-pass — running

/** GET /api/runs — store.liveStatus() */
export const runs = [
  {
    correlation: { run: RUN_A, branch: "main", step: "gate", checkpoint: "cp-final" },
    feature: "demo.draft-until-good",
    phase: "done",
    step: "gate",
    cost: { usd: 0.0123, tokensIn: 920, tokensOut: 410, model: "mock" },
    artifact: { id: "draft-9f3c", version: 3, kind: "text-draft" },
  },
  {
    correlation: { run: RUN_B, branch: "main", step: "commit", checkpoint: "cp-commit" },
    feature: "migrate.csv-to-db",
    phase: "suspended",
    step: "commit",
    waitingOn: {
      what: "Commit 3 mapped rows to users_target?",
      whoCanAnswer: { roles: ["data-owner"], users: [] },
      mode: "blocking",
      schema: {
        type: "object",
        properties: { approved: { type: "boolean" } },
        required: ["approved"],
      },
    },
    cost: { usd: 0.0061, tokensIn: 540, tokensOut: 180, model: "mock" },
    artifact: { id: "migr-2b8e", version: 2, kind: "migration-script" },
  },
  {
    correlation: { run: RUN_C, branch: "main", step: "draft", checkpoint: "cp-2" },
    feature: "demo.retry-then-pass",
    phase: "running",
    step: "draft",
    cost: { usd: 0.0038, tokensIn: 300, tokensOut: 120, model: "mock" },
    artifact: { id: "retry-7d10", version: 1, kind: "text-draft" },
  },
];

/** GET /api/runs/:id/tape — store.tape(run). One frame per Outer-Loop step. */
export const tapes = {
  // The showcase: three iterations of draft→gate. Gate score climbs 0.55 → 0.78 → 0.93 (passes at v3).
  [RUN_A]: [
    {
      correlation: { run: RUN_A, branch: "main", step: "draft", checkpoint: "cp-0" },
      nodeType: "transform",
      input: { payload: {}, hint: "first draft" },
      result: { status: "resolved", output: { text: "Acme onboarding draft" }, confidence: 0.6, cost: { usd: 0.0031, tokensIn: 210, tokensOut: 90 } },
      injected: ["models:mock"],
      ts: "2026-06-27T08:00:01.000Z",
    },
    {
      correlation: { run: RUN_A, branch: "main", step: "gate", checkpoint: "cp-1" },
      nodeType: "validate",
      input: { text: "Acme onboarding draft" },
      result: { status: "resolved", output: { passed: false, score: 0.55, failures: ["too short", "missing call-to-action"] }, confidence: 0.9, cost: { usd: 0.0009 } },
      injected: [],
      ts: "2026-06-27T08:00:02.100Z",
    },
    {
      correlation: { run: RUN_A, branch: "main", step: "draft", checkpoint: "cp-2" },
      nodeType: "transform",
      input: { previous: "Acme onboarding draft", feedback: ["too short", "missing call-to-action"] },
      result: { status: "resolved", output: { text: "Acme onboarding draft — expanded, with CTA" }, confidence: 0.74, cost: { usd: 0.0034, tokensIn: 260, tokensOut: 130 } },
      injected: ["models:mock"],
      ts: "2026-06-27T08:00:03.300Z",
    },
    {
      correlation: { run: RUN_A, branch: "main", step: "gate", checkpoint: "cp-3" },
      nodeType: "validate",
      input: { text: "Acme onboarding draft — expanded, with CTA" },
      result: { status: "resolved", output: { passed: false, score: 0.78, failures: ["tone slightly off"] }, confidence: 0.92, cost: { usd: 0.0009 } },
      injected: [],
      ts: "2026-06-27T08:00:04.400Z",
    },
    {
      correlation: { run: RUN_A, branch: "main", step: "draft", checkpoint: "cp-4" },
      nodeType: "transform",
      input: { previous: "…expanded, with CTA", feedback: ["tone slightly off"] },
      result: { status: "resolved", output: { text: "Acme onboarding — final, warm tone + CTA" }, confidence: 0.88, cost: { usd: 0.0030, tokensIn: 240, tokensOut: 110 } },
      injected: ["models:mock"],
      ts: "2026-06-27T08:00:05.500Z",
    },
    {
      correlation: { run: RUN_A, branch: "main", step: "gate", checkpoint: "cp-final" },
      nodeType: "validate",
      input: { text: "Acme onboarding — final, warm tone + CTA" },
      result: { status: "resolved", output: { passed: true, score: 0.93, failures: [] }, confidence: 0.95, cost: { usd: 0.0009 } },
      injected: [],
      ts: "2026-06-27T08:00:06.600Z",
    },
  ],
  // Migrate: read → propose mapping (intelligence) → dry-run sample → SUSPENDED at the commit approval.
  [RUN_B]: [
    {
      correlation: { run: RUN_B, branch: "main", step: "read_source", checkpoint: "cp-0" },
      nodeType: "migrate.read_source",
      input: { source: "users.csv" },
      result: { status: "resolved", output: { rows: 3, columns: ["id", "full_name", "email_addr"] }, confidence: 1, cost: {} },
      injected: ["fs:read"],
      redaction: { level: "internal", redactedFields: ["email_addr"] },
      ts: "2026-06-27T08:10:00.000Z",
    },
    {
      correlation: { run: RUN_B, branch: "main", step: "propose_mapping", checkpoint: "cp-1" },
      nodeType: "agent",
      input: { columns: ["id", "full_name", "email_addr"], target: "users_target" },
      result: { status: "resolved", output: { mapping: { id: "id", full_name: "name", email_addr: "email" } }, confidence: 0.82, cost: { usd: 0.0042, tokensIn: 410, tokensOut: 150, model: "mock" } },
      injected: ["models:mock"],
      ts: "2026-06-27T08:10:01.200Z",
    },
    {
      correlation: { run: RUN_B, branch: "main", step: "dry_run", checkpoint: "cp-2" },
      nodeType: "validate",
      input: { mapping: { id: "id", full_name: "name", email_addr: "email" } },
      result: { status: "resolved", output: { passed: true, score: 1, failures: [] }, confidence: 0.97, cost: {} },
      injected: ["db:users_target"],
      ts: "2026-06-27T08:10:02.300Z",
    },
    {
      correlation: { run: RUN_B, branch: "main", step: "commit", checkpoint: "cp-commit" },
      nodeType: "approval",
      input: { rows: 3, target: "users_target" },
      result: {
        status: "suspended",
        elicitation: {
          what: "Commit 3 mapped rows to users_target?",
          whoCanAnswer: { roles: ["data-owner"], users: [] },
          mode: "blocking",
          schema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
        },
      },
      injected: [],
      ts: "2026-06-27T08:10:03.400Z",
    },
  ],
  // Retry-then-pass: a failed attempt (retryable) then a running draft — shows the failed marker.
  [RUN_C]: [
    {
      correlation: { run: RUN_C, branch: "main", step: "flaky", checkpoint: "cp-0" },
      nodeType: "transform",
      input: { payload: {} },
      result: { status: "failed", error: { message: "transient backend error", code: "EAGAIN" }, retryable: true, attempts: 1 },
      injected: ["models:mock"],
      ts: "2026-06-27T08:20:00.000Z",
    },
    {
      correlation: { run: RUN_C, branch: "main", step: "draft", checkpoint: "cp-2" },
      nodeType: "transform",
      input: { payload: {}, attempt: 2 },
      result: { status: "resolved", output: { text: "second attempt draft" }, confidence: 0.7, cost: { usd: 0.0038, tokensIn: 300, tokensOut: 120 } },
      injected: ["models:mock"],
      ts: "2026-06-27T08:20:01.100Z",
    },
  ],
};

/** GET /api/features — the catalog (projected FeatureDefinition + per-step klass/requests). */
export const catalog = [
  {
    id: "demo.draft-until-good",
    version: "0.1.0",
    owner: "elio.demos",
    autonomy: "static",
    artifact: { kind: "text-draft", evalGate: "min_length" },
    io: { input: { type: "object" }, output: { type: "object", properties: { text: { type: "string" } } } },
    policies: [],
    graph: {
      steps: [
        { id: "draft", type: "transform", klass: "orchestration" },
        { id: "gate", type: "validate", klass: "orchestration" },
      ],
      edges: [
        { from: "draft", to: "gate" },
        { from: "gate", to: "draft", when: "!passed" },
      ],
    },
  },
  {
    id: "migrate.csv-to-db",
    version: "0.1.0",
    owner: "elio.migrate",
    sourcePath: "packages/migrate/src/feature.yaml",
    autonomy: "guided",
    artifact: { kind: "migration-script", evalGate: "sample_passes" },
    io: {
      input: { type: "object", properties: { source: { type: "string" } } },
      output: { type: "object", properties: { committed: { type: "number" } } },
    },
    policies: ["commit_requires_approval"],
    graph: {
      steps: [
        { id: "read_source", type: "migrate.read_source", klass: "orchestration", requests: { fs: { read: ["*.csv"] } } },
        { id: "propose_mapping", type: "agent", klass: "intelligence", requests: { models: ["mock"] } },
        { id: "dry_run", type: "validate", klass: "orchestration", requests: { db: ["users_target"] } },
        { id: "commit", type: "approval", klass: "orchestration", suspend: "blocking" },
        { id: "commit_write", type: "migrate.commit", klass: "orchestration", requests: { db: ["users_target"] } },
      ],
      edges: [
        { from: "read_source", to: "propose_mapping" },
        { from: "propose_mapping", to: "dry_run" },
        { from: "dry_run", to: "commit" },
        { from: "commit", to: "commit_write", when: "approved" },
      ],
    },
  },
  {
    id: "build-skill",
    version: "0.1.0",
    owner: "elio.meta",
    sourcePath: "packages/skill-builder/src/feature.yaml",
    autonomy: "guided",
    artifact: { kind: "skill", evalGate: "frontmatter_valid" },
    io: { input: { type: "object" }, output: { type: "object", properties: { path: { type: "string" } } } },
    policies: ["skill_write_requires_approval"],
    graph: {
      steps: [
        { id: "interview", type: "agent", klass: "intelligence", requests: { models: ["mock"] } },
        { id: "draft_skill", type: "agent", klass: "intelligence", requests: { models: ["mock"] } },
        { id: "approve_write", type: "approval", klass: "orchestration", suspend: "blocking" },
        { id: "write_skill", type: "skill.write", klass: "orchestration", requests: { fs: { write: ["./out"] } } },
      ],
      edges: [
        { from: "interview", to: "draft_skill" },
        { from: "draft_skill", to: "approve_write" },
        { from: "approve_write", to: "write_skill", when: "approved" },
      ],
    },
  },
];

/** The full sample payload inlined into the preview as window.ELIO_SAMPLE. */
export const sample = {
  title: "ELIO Studio — preview",
  selectedRun: RUN_A,
  runs,
  tapes,
  catalog,
};
