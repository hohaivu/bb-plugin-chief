import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { forgeInitScript } from "./forge";
import { pingGateway, runEvaluation } from "./jev/gateway";
import { getMetricDefinition } from "./jev/transform";
import { evaluationSchema, type Evaluation, type MetricKey } from "./jev/types";

const SECTION_NAME = "Chief";
const RULES_FILE = "chief.md";
const RECONCILE_INTERVAL_MS = 30_000;
const MAX_ALERT_LENGTH = 3_000;
const MAX_RESULT_LENGTH = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const JEV_DEFAULT_MODEL = "typesafe-ai/jev";
const JEV_PING_TIMEOUT_MS = 30_000;
const JEV_SCORE_TIMEOUT_MS = 180_000;
const JEV_MAX_DIFF_BYTES = 96 * 1024;
/** Scoring a cut diff without saying so reads as missing implementation, and the
 * change is penalised for bytes that were never sent. */
const TRUNCATED_DIFF_NOTE =
  "This diff was cut to fit a size budget: later files and hunks are missing from this state. Judge only what is present, and when a dimension depends on seeing the whole change, answer no to its applicability question instead of penalising the code that was omitted.";
/** Lock files and generated output drown a real diff in noise nobody reviews. */
const GENERATED_OR_LOCK_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|.*\.generated\.[a-z]+|.*\.min\.js)$/;
/** One wording for the reviewer's read-only rule, said when the review starts and
 * again on every continuation — the two places an edit instruction could arrive. */
const REVIEW_ONLY = "Remain review-only: do not modify files. A repair goes back to the worker, which then earns its own review.";
/** Same for a planner: said when the plan starts and again on every continuation. */
const PLAN_ONLY = "Remain read-only in the repository: do not create, modify, or delete any file it tracks. Writing the plan itself to $BB_THREAD_STORAGE/plan.md is not a repository edit and stays allowed. A worker implements the plan in its own worktree.";
/** BB's builtin plan slash command, the trigger a provider maps to its own plan mode. */
const PLAN_COMMAND = "/plan";
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);

const roleSchema = z.enum(["chief", "planner", "worker", "reviewer"]);
/** What a spawn seeds into a thread's pluginMetadata, read back in bb.agents.configure.
 * insertThread runs only after threads.spawn resolves, so the very first configure()
 * call for a brand-new thread can land before that row exists; pluginMetadata is
 * seeded atomically at spawn time and survives that gap. Untrusted input, so parsed
 * defensively like everything else crossing this boundary. */
const spawnMetadataSchema = z.object({
  role: roleSchema,
  chiefThreadId: z.string().nullable().optional(),
});
/** A worker's tier, chosen by Chief at delegation time. Separate from the
 * lifecycle role above: every tier is still a "worker" for role-gated tools,
 * lifecycle alerts, and the managed_threads role CHECK. */
const tierSchema = z.enum(["junior", "senior"]);
/** A reviewer's structured judgement. Chief routes on this field instead of
 * parsing a ship-or-fix opinion out of the report prose. */
const verdictSchema = z.enum(["approve", "request_changes"]);
/** The role key chief_models stores a per-machine model pick under: the
 * lifecycle roles, but with "worker" split into its two tiers. */
const modelRoleSchema = z.enum(["chief", "planner", "junior", "senior", "reviewer"]);
const stateSchema = z.enum([
  "starting",
  "pending",
  "active",
  "stopping",
  "idle",
  "ready",
  "blocked",
  "failed",
  "archived",
  "deleted",
  "complete",
]);
const reasoningSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);
const modelSelectionSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: reasoningSchema,
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

const modelConfigurationSchema = z.object({
  hosts: z.array(z.object({
    hostId: z.string(),
    hostName: z.string(),
    connected: z.boolean(),
    /** A valid starting point for the picker when a role has no selection. */
    fallback: modelSelectionSchema.nullable(),
    error: z.string().nullable(),
    selections: z.object({
      chief: modelSelectionSchema.nullable(),
      planner: modelSelectionSchema.nullable(),
      junior: modelSelectionSchema.nullable(),
      senior: modelSelectionSchema.nullable(),
      reviewer: modelSelectionSchema.nullable(),
    }),
    /** Roles whose stored pick this machine can no longer serve, so spawns use BB's default. */
    unusable: z.array(modelRoleSchema),
  })),
});
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

const managedThreadSchema = z.object({
  threadId: z.string(),
  role: roleSchema,
  projectId: z.string(),
  chiefThreadId: z.string().nullable(),
  workerThreadId: z.string().nullable(),
  title: z.string(),
  state: stateSchema,
  status: z.string().nullable(),
  result: z.string().nullable(),
  blocker: z.string().nullable(),
  recommendation: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ManagedThread = z.infer<typeof managedThreadSchema>;

const delegateParams = z.object({
  title: z.string().trim().min(1).max(160).describe("Exact concise title for the worker thread."),
  mission: z.string().trim().min(1).max(12_000),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  context: z.string().trim().max(12_000).optional(),
  // The policy behind this choice lives in the chief skill, which is loaded into
  // every Chief turn. Here it stays a one-line gloss of the two enum values.
  tier: tierSchema.default("senior").describe(
    "junior for trivial, mechanical, or already-specified bounded work; senior for everything else. When unsure, senior.",
  ),
  branch: z.string().trim().min(1).max(300).optional().describe(
    "The task branch Chief already created and pushed. The worktree is based on it and the worker commits there. Omit to base the worktree on the project default.",
  ),
  issueUrl: z.string().trim().min(1).max(500).optional().describe("URL of the tracking issue Chief opened for this task, when the forge has issues."),
  prUrl: z.string().trim().min(1).max(500).optional().describe("URL of the draft pull request Chief opened from the task branch. The worker never marks it ready."),
});

/** A planner is briefed on the same problem as a worker, minus the criteria and
 * constraints it is being asked to propose. */
const planParams = delegateParams.pick({ title: true, mission: true, context: true });

const optionalReport = z.object({
  state: z.enum(["active", "idle", "failed"]),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional(),
  blocker: z.never().optional(),
  recommendation: z.string().trim().max(4_000).optional(),
});
const readyReport = z.object({
  state: z.literal("ready"),
  result: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
  verdict: verdictSchema.optional().describe(
    "Required in a review thread: approve when the change can ship as it stands, request_changes when the worker must fix something. Workers leave this unset.",
  ),
  blocker: z.never().optional(),
  recommendation: z.string().trim().max(4_000).optional(),
});
const blockedReport = z.object({
  state: z.literal("blocked"),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional(),
  blocker: z.string().trim().min(1).max(4_000),
  recommendation: z.string().trim().min(1).max(4_000),
});
const reportParams = z.discriminatedUnion("state", [optionalReport, readyReport, blockedReport]);

const jevStatusSchema = z.object({
  hasKey: z.boolean(),
  model: z.string(),
  /** The stored check matches the key and model in effect right now. */
  verified: z.boolean(),
  enabled: z.boolean(),
}).strict();

export type JevStatus = z.infer<typeof jevStatusSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ sectionId: z.string().nullable(), threads: z.array(managedThreadSchema) }),
  },
  start: {
    input: z.object({ projectId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }).strict(),
  },
  create: {
    input: z.object({ projectId: z.string().trim().min(1) }).strict(),
    output: z.object({ threadId: z.string(), created: z.literal(true) }).strict(),
  },
  modelConfiguration: {
    input: z.null(),
    output: modelConfigurationSchema,
  },
  setRoleModel: {
    input: z.object({
      hostId: z.string().trim().min(1),
      role: modelRoleSchema,
      selection: modelSelectionSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  jevStatus: {
    input: z.null(),
    output: jevStatusSchema,
  },
  jevCheck: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), message: z.string(), status: jevStatusSchema }).strict(),
  },
});

interface ManagedRow {
  thread_id: string;
  role: z.infer<typeof roleSchema>;
  tier: z.infer<typeof tierSchema> | null;
  branch: string | null;
  issue_url: string | null;
  pr_url: string | null;
  project_id: string;
  chief_thread_id: string | null;
  worker_thread_id: string | null;
  title: string;
  state: z.infer<typeof stateSchema>;
  status: string | null;
  result: string | null;
  blocker: string | null;
  recommendation: string | null;
  verdict: z.infer<typeof verdictSchema> | null;
  brief: string | null;
  active_since: number | null;
  active_cycle: number;
  reject_streak: number;
  stall_alerted_cycle: number | null;
  lifecycle_alert_key: string | null;
  created_at: number;
  updated_at: number;
}

interface AlertRow {
  dedupe_key: string;
  target_thread_id: string;
  source_thread_id: string;
  message: string;
  delivered_at: number | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
}

const BUILT_IN_RULES = `# Chief operating rules

- Own work through completion; do not merely dispatch it.
- Inspect the worker's evidence before choosing the next action.
- Take safe, reversible next steps autonomously: continue a thread, request a focused review, or mark verified work complete.
- Escalate to the user only for genuine product or scope choices, missing permission or credentials, irreversible actions, or conflicting evidence that cannot be resolved safely.
- When escalating, lead with a recommendation, the evidence, and the smallest set of choices.
- A worker report is evidence, not proof. Every worker that reports ready gets an independent review automatically; read that reviewer's verdict before completing its work.
- When the user or a worker corrects a factual claim, verify it against the code before accepting the correction.
- Start extra reviews with chief_review whenever a change is risky enough to deserve a second pass.
- Keep thread titles literal and recognizable. Never invent codenames.
- Do not delete user threads. Mark managed work complete; let the user archive it when desired.`;

const JEV_REVIEWER_INSTRUCTIONS = `
Jev scoring is available to you through chief_score. Use it once per review pass, and only after you have read the change yourself — the score is a second opinion, not your first impression.

You choose the base branch to compare against. Pick the branch this change actually merges into:
1. If the worktree has an open pull request, use its base (\`gh pr view --json baseRefName -q .baseRefName\`).
2. Otherwise use the branch the environment was forked from, if it is a real branch and not the one the work is committed on — a task branch compared against itself yields an empty diff.
3. Otherwise use the repository's default branch (main or master).

Score against the same base on every pass for one worker; only then does the improved/regressed comparison mean anything. If you deliberately change the base, say so in your report and treat that score as a fresh baseline.

In your report to Chief, state the base you used, which findings you confirmed against the code, and which scored points you reject and why.`;

/** Planning is a decision point, not a relay: the plan is worth a thread only because
 * Chief reads it before any worktree is spent on it. */
const PLANNER_CHIEF_INSTRUCTIONS =
  "Planning is on. For work that is not obviously small, use chief_plan first. Its ready report names the plan file it wrote — read that file in full before deciding, correct the plan with chief_continue or escalate a genuine decision to the user, then call chief_delegate with the plan file's path in its context, not the plan body. A plan is never implementation: only a worker changes code.";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    const next = argv[index + 1];
    const value = inline ?? (next && !next.startsWith("--") ? (index++, next) : "true");
    flags.set(name!, [...(flags.get(name!) ?? []), value]);
  }
  return {
    positional,
    one: (name: string) => flags.get(name)?.[0],
    all: (name: string) => flags.get(name) ?? [],
    bool: (name: string) => flags.get(name)?.[0] === "true",
  };
}

/** Keeps as much of the diff as the budget allows, joining separator included, so the
 * result never exceeds maxBytes. A patch that does not fit whole is cut to its byte
 * prefix rather than dropped: one oversized file must still be reviewable, and dropping
 * it would hand Jev an empty diff to score. Exported for tests. */
export function capDiff(patches: readonly { patch: string; truncated: boolean }[], maxBytes: number) {
  const parts: string[] = [];
  let size = 0;
  let truncated = false;
  for (const patch of patches) {
    if (patch.truncated) truncated = true;
    const separator = parts.length === 0 ? 0 : 1;
    const bytes = Buffer.from(patch.patch, "utf8");
    if (size + separator + bytes.byteLength > maxBytes) {
      truncated = true;
      // StringDecoder drops a trailing partial UTF-8 sequence instead of
      // emitting a replacement character mid-identifier.
      // Clamped: a full budget plus the separator makes this negative, and
      // subarray reads a negative end as an offset from the buffer's end —
      // handing back all but the last byte of the patch.
      const room = Math.max(0, maxBytes - size - separator);
      const prefix = new StringDecoder("utf8").write(bytes.subarray(0, room));
      if (prefix) parts.push(prefix);
      break;
    }
    parts.push(patch.patch);
    size += separator + bytes.byteLength;
  }
  return { diff: parts.join("\n"), truncated };
}

function clip(value: string, limit = MAX_ALERT_LENGTH) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function bullets(values?: string[]) {
  return values?.length ? values.map((value) => `- ${value}`).join("\n") : "- None stated.";
}

/** Append-only: the host records each statement's hash by index and rejects a changed
 * or reordered one. Exported so the upgrade path can be tested on a real database. */
export const MIGRATIONS = [
    `CREATE TABLE IF NOT EXISTS plugin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS managed_threads (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','worker','reviewer')),
      project_id TEXT NOT NULL,
      chief_thread_id TEXT,
      worker_thread_id TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      lifecycle_alert_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS alert_outbox (
      dedupe_key TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      message TEXT NOT NULL,
      delivered_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS alert_outbox_pending ON alert_outbox (delivered_at, created_at)`,
    `CREATE TABLE IF NOT EXISTS chief_models (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','worker','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    // One row per (worker, base branch): a delta only means something when both
    // cycles scored the same comparison point.
    `CREATE TABLE IF NOT EXISTS jev_scores (
      worker_thread_id TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      evaluation TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (worker_thread_id, base_branch)
    )`,
    `ALTER TABLE managed_threads ADD COLUMN tier TEXT`,
    // SQLite cannot ALTER a CHECK constraint, so the 'worker'/'chief'/'reviewer'
    // key becomes 'junior'/'senior'/'chief'/'reviewer' via a table rebuild.
    // Existing picks under 'worker' survive as 'senior'.
    `CREATE TABLE chief_models_new (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','junior','senior','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    `INSERT INTO chief_models_new (host_id, role, provider_id, model, reasoning_level, updated_at)
      SELECT host_id, CASE role WHEN 'worker' THEN 'senior' ELSE role END, provider_id, model, reasoning_level, updated_at
      FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_new RENAME TO chief_models`,
    `ALTER TABLE managed_threads ADD COLUMN branch TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN issue_url TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN pr_url TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN verdict TEXT`,
    // The brief a worker was delegated with, so its reviewer can judge the change
    // against the same standard instead of an unanchored one.
    `ALTER TABLE managed_threads ADD COLUMN brief TEXT`,
    // Finding 8 asks whether the applicability gate really abstains on thin diffs
    // instead of guessing. jev_scores only keeps the latest evaluation per worker
    // and base, so the answer has to be counted as the scores are produced.
    // ponytail: aggregate counters, not one row per pass — no slicing by project,
    // diff size, or truncation. Add a column pair if the total hides the answer.
    `CREATE TABLE IF NOT EXISTS jev_metric_stats (
      metric TEXT PRIMARY KEY,
      samples INTEGER NOT NULL,
      abstained INTEGER NOT NULL,
      score_sum REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    // Admitting the planner role means widening two CHECK constraints, and SQLite
    // cannot drop one. Both tables are rebuilt; the statements above keep their old
    // text because migrations are append-only. Column order matches the live table,
    // ALTER-added columns last, which is what SELECT * relies on.
    `CREATE TABLE managed_threads_v2 (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer')),
      project_id TEXT NOT NULL,
      chief_thread_id TEXT,
      worker_thread_id TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      lifecycle_alert_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tier TEXT,
      branch TEXT,
      issue_url TEXT,
      pr_url TEXT,
      verdict TEXT,
      brief TEXT
    )`,
    `INSERT INTO managed_threads_v2 SELECT * FROM managed_threads`,
    `DROP TABLE managed_threads`,
    `ALTER TABLE managed_threads_v2 RENAME TO managed_threads`,
    // Dropping the table dropped its index with it.
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    `CREATE TABLE chief_models_v3 (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','junior','senior','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    `INSERT INTO chief_models_v3 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v3 RENAME TO chief_models`,
    // A reviewer's active_cycle counts every resume, which under a phased plan is the
    // phase count, not rejection rounds. Consecutive request_changes verdicts need
    // their own counter so a phase's first rejection can't misread as a deadlock.
    `ALTER TABLE managed_threads ADD COLUMN reject_streak INTEGER NOT NULL DEFAULT 0`,
];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chiefProject: { type: "project", label: "Default Chief project" },
    stallMinutes: { type: "string", label: "Stall threshold (minutes)", default: "30" },
    plannerEnabled: {
      type: "boolean",
      label: "Plan before delegating",
      description: "Lets Chief send work to a read-only planner first, read the plan, and delegate it.",
      default: false,
    },
    jevApiKey: {
      type: "string",
      label: "AI Gateway API key",
      description: "Needed for Jev scoring. Check the connection below before enabling it.",
      secret: true,
    },
    jevModel: { type: "string", label: "Jev model", default: JEV_DEFAULT_MODEL },
    jevEnabled: {
      type: "boolean",
      label: "Let reviewers score changes with Jev",
      description: "Stays off until a connection check succeeds for the current key and model.",
      default: false,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const allRows = db.prepare(`SELECT * FROM managed_threads ORDER BY created_at ASC`);
  const activeChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND project_id=? AND state NOT IN ('failed','deleted','archived','complete') ORDER BY created_at DESC LIMIT 1`,
  );
  const latestChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND project_id=? ORDER BY created_at DESC LIMIT 1`,
  );
  const chiefCountForProject = db.prepare<[string]>(
    `SELECT COUNT(*) AS count FROM managed_threads WHERE role='chief' AND project_id=?`,
  );
  const existingReview = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id=? AND state NOT IN ('complete','archived','deleted') ORDER BY created_at DESC LIMIT 1`,
  );
  const pendingAlerts = db.prepare(
    `SELECT * FROM alert_outbox WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT 100`,
  );
  const roleModelRow = db.prepare<[string, string]>(
    `SELECT provider_id, model, reasoning_level FROM chief_models WHERE host_id=? AND role=?`,
  );
  const previousScore = db.prepare<[string, string]>(
    `SELECT evaluation FROM jev_scores WHERE worker_thread_id=? AND base_branch=?`,
  );
  const recordMetric = db.prepare<[string, number, number, number]>(
    `INSERT INTO jev_metric_stats (metric, samples, abstained, score_sum, updated_at) VALUES (?, 1, ?, ?, ?)
     ON CONFLICT(metric) DO UPDATE SET samples=samples+1, abstained=abstained+excluded.abstained,
       score_sum=score_sum+excluded.score_sum, updated_at=excluded.updated_at`,
  );
  const metricStats = db.prepare(`SELECT * FROM jev_metric_stats ORDER BY metric ASC`);
  let roles = new Map<string, ManagedRow>();
  // bb.agents.configure is synchronous, so the gate's answer has to be on hand.
  let jevActive = false;
  let plannerActive = false;
  const rulesCache = new Map<string, string>();
  const alertDeliveries = new Map<string, Promise<boolean>>();
  const reviewStarts = new Map<string, Promise<{ threadId: string; title: string; workerThreadId: string; created: boolean }>>();

  function reloadRoles() {
    roles = new Map((allRows.all() as ManagedRow[]).map((row) => [row.thread_id, row]));
  }
  reloadRoles();

  function toManaged(row: ManagedRow): ManagedThread {
    return {
      threadId: row.thread_id,
      role: row.role,
      projectId: row.project_id,
      chiefThreadId: row.chief_thread_id,
      workerThreadId: row.worker_thread_id,
      title: row.title,
      state: row.state,
      status: row.status,
      result: row.result,
      blocker: row.blocker,
      recommendation: row.recommendation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function insertThread(input: {
    threadId: string;
    role: ManagedRow["role"];
    projectId: string;
    chiefThreadId?: string | null;
    workerThreadId?: string | null;
    title: string;
    state?: ManagedRow["state"];
    status?: string | null;
    tier?: ManagedRow["tier"];
    brief?: string | null;
    branch?: string | null;
    issueUrl?: string | null;
    prUrl?: string | null;
  }) {
    const now = Date.now();
    db.prepare(`INSERT INTO managed_threads (
      thread_id, role, project_id, chief_thread_id, worker_thread_id, title,
      state, status, tier, brief, branch, issue_url, pr_url, active_since, active_cycle, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role, project_id=excluded.project_id,
      chief_thread_id=excluded.chief_thread_id, worker_thread_id=excluded.worker_thread_id,
      title=excluded.title, state=excluded.state, status=excluded.status, tier=excluded.tier,
      brief=excluded.brief, branch=excluded.branch, issue_url=excluded.issue_url, pr_url=excluded.pr_url, updated_at=excluded.updated_at`).run(
      input.threadId, input.role, input.projectId, input.chiefThreadId ?? null,
      input.workerThreadId ?? null, input.title, input.state ?? "starting",
      input.status ?? "starting", input.tier ?? null, input.brief ?? null, input.branch ?? null,
      input.issueUrl ?? null, input.prUrl ?? null, input.state === "active" ? now : null,
      input.state === "active" ? 1 : 0, now, now,
    );
    reloadRoles();
  }

  let sectionEnsuring: Promise<string> | null = null;
  async function ensureSection(): Promise<string> {
    if (sectionEnsuring) return sectionEnsuring;
    sectionEnsuring = (async () => {
      const sections = await bb.sdk.threadSections.list();
      let section = sections.find((candidate) => candidate.name === SECTION_NAME);
      if (!section) section = await bb.sdk.threadSections.create({ name: SECTION_NAME });
      db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('section_id', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(section.id);
      return section.id;
    })();
    try {
      return await sectionEnsuring;
    } finally {
      sectionEnsuring = null;
    }
  }

  function storedSectionId() {
    return (db.prepare(`SELECT value FROM plugin_meta WHERE key='section_id'`).get() as { value: string } | undefined)?.value ?? null;
  }

  async function readRules(projectId: string) {
    try {
      const file = await bb.sdk.projects.fileContent({ projectId, path: RULES_FILE });
      const content = file.contentEncoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
      const rules = clip(content.trim() || BUILT_IN_RULES, 32_000);
      rulesCache.set(projectId, rules);
      return rules;
    } catch {
      rulesCache.set(projectId, BUILT_IN_RULES);
      return BUILT_IN_RULES;
    }
  }

  async function projectName(projectId: string) {
    try { return (await bb.sdk.projects.get({ projectId })).name; }
    catch { return projectId; }
  }

  type ModelRole = z.infer<typeof modelRoleSchema>;

  function readRoleModel(hostId: string, role: ModelRole): ModelSelection | null {
    const row = roleModelRow.get(hostId, role) as
      | { provider_id: string; model: string; reasoning_level: string }
      | undefined;
    if (!row) return null;
    const parsed = modelSelectionSchema.safeParse({
      providerId: row.provider_id,
      model: row.model,
      reasoningLevel: row.reasoning_level,
    });
    return parsed.success ? parsed.data : null;
  }

  function writeRoleModel(hostId: string, role: ModelRole, selection: ModelSelection | null) {
    if (!selection) {
      db.prepare(`DELETE FROM chief_models WHERE host_id=? AND role=?`).run(hostId, role);
      return;
    }
    db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, role) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model,
        reasoning_level=excluded.reasoning_level, updated_at=excluded.updated_at`).run(
      hostId, role, selection.providerId, selection.model, selection.reasoningLevel, Date.now(),
    );
  }

  // Discovery must never outlive the plugin or hang a spawn behind an
  // unreachable machine, so every catalog read is aborted on both.
  const discoveryLifetime = new AbortController();
  bb.onDispose(() => discoveryLifetime.abort());

  function discover<T>(run: (signal: AbortSignal) => Promise<T>, label: string) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    discoveryLifetime.signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stop();
          reject(new Error(`${label} timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1_000} seconds.`));
        }, MODEL_DISCOVERY_TIMEOUT_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      discoveryLifetime.signal.removeEventListener("abort", stop);
    });
  }

  function modelCatalog(hostId: string, providerId?: string) {
    return discover(
      (signal) => bb.sdk.providers.models({ hostId, ...(providerId ? { providerId } : {}), signal }),
      "Model discovery",
    );
  }

  type Catalog = (providerId: string) => ReturnType<typeof modelCatalog>;

  /** One scan per provider per request: three roles on one provider must not cost three reads. */
  function catalogReader(hostId: string): Catalog {
    const pending = new Map<string, ReturnType<typeof modelCatalog>>();
    return (providerId) => {
      const started = pending.get(providerId) ?? modelCatalog(hostId, providerId);
      pending.set(providerId, started);
      return started;
    };
  }

  /** The first signed-in provider's default model: what the picker starts from. */
  async function hostFallback(
    hostId: string,
    read: Catalog = catalogReader(hostId),
  ): Promise<{ fallback: ModelSelection | null; error: string | null }> {
    try {
      const providers = await discover(
        (signal) => bb.sdk.providers.list({ hostId, signal }),
        "Provider discovery",
      );
      const provider = providers.find((candidate) => candidate.available);
      if (!provider) return { fallback: null, error: "No signed-in provider on this machine." };
      const catalog = await read(provider.id);
      if (catalog.modelLoadError !== null) {
        return { fallback: null, error: `Model catalog is not available (${catalog.modelLoadError.code}).` };
      }
      const model = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
      if (!model) return { fallback: null, error: "This machine reported no models." };
      return {
        fallback: { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort },
        error: null,
      };
    } catch (error) {
      return { fallback: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The stored pick as the machine can serve it today, or null when it cannot.
   * Settings and the spawn sites share this so what the user sees is what runs.
   */
  async function usableSelection(
    hostId: string,
    selection: ModelSelection,
    read: Catalog = catalogReader(hostId),
  ): Promise<ModelSelection | null> {
    try {
      const catalog = await read(selection.providerId);
      if (catalog.modelLoadError !== null) {
        throw new Error(`model catalog is not available (${catalog.modelLoadError.code})`);
      }
      const model = catalog.models.find((candidate) => candidate.model === selection.model);
      if (!model) throw new Error("the machine no longer offers that model");
      const reasoningLevel = model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === selection.reasoningLevel,
      ) ? selection.reasoningLevel : model.defaultReasoningEffort;
      return { ...selection, reasoningLevel };
    } catch (error) {
      bb.log.warn(
        `Chief model ${selection.providerId}/${selection.model} is unusable on ${hostId}; using the BB default instead: ${String(error)}`,
      );
      return null;
    }
  }

  /**
   * Spawn arguments for a role. No selection, an unknown host, or a selection
   * the machine can no longer serve all fall through to BB's own defaults —
   * a stale pick must not block the work.
   */
  async function execution(role: ModelRole, hostId: string | null) {
    const selection = hostId === null ? null : readRoleModel(hostId, role);
    if (!hostId || !selection) return {};
    return (await usableSelection(hostId, selection)) ?? {};
  }

  async function defaultHostId() {
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No BB host is registered; a host is required for a managed worktree.");
    return host.id;
  }

  /** The machine a role's thread will actually run on, or null when unknown. */
  async function projectHostId(projectId: string) {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source?.hostId ?? await defaultHostId();
    } catch (error) {
      bb.log.warn(`Could not resolve the machine for ${projectId}: ${String(error)}`);
      return null;
    }
  }

  async function environmentHostId(environmentId: string) {
    try {
      return (await bb.sdk.environments.get({ environmentId })).hostId;
    } catch (error) {
      bb.log.warn(`Could not resolve the machine for ${environmentId}: ${String(error)}`);
      return null;
    }
  }

  function chiefForProject(projectId: string) {
    return (activeChiefForProject.get(projectId) as ManagedRow | undefined) ?? null;
  }

  /** The Chief a spawn request belongs to: the calling Chief itself, or the active
   * one for the caller's project. Planning and delegation resolve it the same way. */
  async function owningChief(callerThreadId?: string | null) {
    const caller = callerThreadId ? roles.get(callerThreadId) : undefined;
    const projectId = caller?.project_id ?? (await settings.get()).chiefProject;
    if (!projectId) throw new Error("No Chief project is configured.");
    const chief = caller?.role === "chief" ? caller : chiefForProject(projectId);
    if (!chief || chief.state === "complete") throw new Error("Start Chief for this project first.");
    return { chief, projectId };
  }

  /** bb.agents.configure is synchronous and can only read the cached copy, so every
   * read refreshes it. Spawning a planner gates on this live call, never on the cache. */
  async function plannerEnabled() {
    plannerActive = (await settings.get()).plannerEnabled;
    return plannerActive;
  }

  async function spawnChief(target: string, previous?: ManagedRow) {
    const sectionId = await ensureSection();
    const name = await projectName(target);
    // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
    // the rules into every Chief turn, so the spawn prompt does not repeat them.
    await readRules(target);
    const count = (chiefCountForProject.get(target) as { count: number }).count;
    const title = count === 0 ? `Chief · ${name}` : `Chief · ${name} · ${count + 1}`;
    const prompt = [
      `You are Chief for ${name}. You supervise the ordinary BB threads in the Chief sidebar section.`,
      "",
      "Use chief_delegate for implementation work. Inspect reports and live thread evidence with chief_inspect, continue safe work, and mark work complete only after verification.",
      ...((await plannerEnabled()) ? [PLANNER_CHIEF_INSTRUCTIONS] : []),
      "You own the forge for every delegation: run chief_forge_init, run the script it returns from the project checkout, and pass the branch, issueUrl and prUrl it prints to chief_delegate. Mark the pull request ready only after the work is verified and reviewed. The chief skill's Git workflow section has the rest.",
      "A worker that reports ready is reviewed automatically: a reviewer thread starts in its worktree and reports back here. Wait for that verdict before completing the work, and use chief_review yourself for any further pass you want.",
      "Lifecycle alerts are prompts to decide: continue, review, complete, or escalate. Escalate genuine product, scope, permission, credential, or irreversible decisions here to the user with your recommendation.",
      "", "Acknowledge the operating rules you were given briefly, inspect the roster, and wait for work.",
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: target,
      environment: { type: "project-default" },
      sectionId,
      visibility: "visible",
      title,
      ...(await execution("chief", await projectHostId(target))),
      prompt,
      pluginMetadata: { role: "chief" },
    });
    if (previous && previous.thread_id !== thread.id) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare(`UPDATE managed_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(now, previous.thread_id);
        db.prepare(`UPDATE managed_threads SET chief_thread_id=?, updated_at=?
          WHERE project_id=? AND chief_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(
          thread.id, now, target, previous.thread_id,
        );
        db.prepare(`UPDATE alert_outbox SET target_thread_id=?
          WHERE target_thread_id=? AND delivered_at IS NULL`).run(thread.id, previous.thread_id);
      })();
    }
    insertThread({ threadId: thread.id, role: "chief", projectId: target, title, state: "starting", status: thread.status });
    return { threadId: thread.id, created: true as const };
  }

  async function createChief(projectId: string) {
    return spawnChief(projectId);
  }

  const chiefStarts = new Map<string, Promise<{ threadId: string; created: boolean }>>();
  async function ensureChief(projectId?: string) {
    const values = await settings.get();
    const target = projectId ?? values.chiefProject;
    if (!target) throw new Error("Configure a default Chief project first: bb plugin config chief set chiefProject <proj-id>");
    const inFlight = chiefStarts.get(target);
    if (inFlight) return inFlight;
    const start = (async () => {
      const existing = chiefForProject(target);
      if (existing) {
        await reconcileThread(existing, await ensureSection());
        const reconciled = roles.get(existing.thread_id);
        if (reconciled && !["failed", "deleted", "archived", "complete"].includes(reconciled.state)) {
          return { threadId: existing.thread_id, created: false };
        }
      }
      const previous = latestChiefForProject.get(target) as ManagedRow | undefined;
      return spawnChief(target, previous);
    })();
    chiefStarts.set(target, start);
    try {
      return await start;
    } finally {
      chiefStarts.delete(target);
    }
  }

  /** Open a planner on the provider's own `/plan` action rather than as plain
   * text: the builtin command mention is what makes BB enter plan mode, the way
   * `bb thread spawn --plan` does. */
  function planCommandInput(prompt: string) {
    return [{
      type: "text" as const,
      text: `${PLAN_COMMAND} ${prompt}`,
      mentions: [{
        start: 0,
        end: PLAN_COMMAND.length,
        resource: {
          kind: "command" as const, trigger: "/" as const, name: "plan",
          source: "command" as const, origin: "builtin" as const, label: "plan", argumentHint: null,
        },
      }],
    }];
  }

  /** A plan is read-only work in the project's own checkout: no worktree is spent
   * until Chief has read the plan and chosen to delegate it. */
  async function startPlan(params: z.infer<typeof planParams>, callerThreadId?: string | null) {
    if (!(await plannerEnabled())) {
      throw new Error("Planning is off. Turn on “Plan before delegating” in Chief's settings, or delegate this work directly.");
    }
    const { chief, projectId } = await owningChief(callerThreadId);
    const sectionId = await ensureSection();
    const rules = await readRules(projectId);
    const title = `Plan · ${params.title}`;
    const prompt = [
      `You are the managed planner for “${params.title}”. Report to Chief thread ${chief.thread_id}.`,
      "", "## Problem", params.mission,
      ...(params.context ? ["", "## Context", params.context] : []),
      "", "## Project rules", rules,
      "", "## Working contract",
      "- Read every file this brief names in full before proposing anything: no partial reads, no limit or offset. Then trace the real flow through the code this change would touch — a plan naming the wrong files is worse than no plan.",
      `- ${PLAN_ONLY}`,
      "- Write the full plan as Markdown to $BB_THREAD_STORAGE/plan.md: the files and functions to change, the steps in order, real constraints, and the risks.",
      "- Report with chief_report state ready. Its result is a short summary, not the plan: the goal, the files to touch, the ordered steps as one line each, and the \"What we're NOT doing\" headline — followed by the plan file's absolute path. The detail lives in the file, not the report.",
      "- Split success criteria per-phase into Automated Verification (a command a worker can run, reported with its exit status) and Manual Verification (what only a human can confirm).",
      "- For multi-step work, order it into named phases one worker implements one at a time: each phase ends in its own ready report and review, and only that verdict opens the next phase.",
      "- Add an explicit \"What we're NOT doing\" section naming what this plan leaves out of scope.",
      "- Name a genuine product or scope decision as an open question for Chief instead of deciding it yourself.",
      "- A blocked report must include the blocker and your recommended decision or next action.",
      "- Do not ask the user directly from this thread. Chief decides whether a question needs escalation.",
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      sectionId,
      parentThreadId: chief.thread_id,
      visibility: "visible",
      title,
      ...(await execution("planner", await projectHostId(projectId))),
      input: planCommandInput(prompt),
      pluginMetadata: { role: "planner", chiefThreadId: chief.thread_id },
    });
    insertThread({ threadId: thread.id, role: "planner", projectId, chiefThreadId: chief.thread_id, title, state: "starting", status: thread.status });
    return { threadId: thread.id, title, projectId };
  }

  async function delegate(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await owningChief(callerThreadId);
    // One task branch carries one active worker: a second worktree cannot check out a
    // branch another one already holds, and the spawn would fail with a raw git error.
    const holder = params.branch
      ? [...roles.values()].find((row) => row.role === "worker" && row.state !== "complete"
        && row.project_id === projectId && row.branch === params.branch)
      : undefined;
    if (holder) {
      throw new Error(`Branch ${params.branch} already carries the active worker “${holder.title}” (${holder.thread_id}). Complete that worker, or give this delegation its own branch and pull request.`);
    }
    const sectionId = await ensureSection();
    const rules = await readRules(projectId);
    // One rendering of the brief: the worker reads it now, and its reviewer reads
    // the same text later instead of guessing what the change was asked to do.
    const brief = [
      "## Mission", params.mission,
      "", "## Success criteria", bullets(params.successCriteria),
      "", "## Constraints", bullets(params.constraints),
      ...(params.context ? ["", "## Context", params.context] : []),
    ].join("\n");
    const prompt = [
      `You are the managed worker for “${params.title}”. Report to Chief thread ${chief.thread_id}.`,
      "", brief,
      ...(params.branch || params.issueUrl || params.prUrl ? [
        "", "## Git workflow",
        ...(params.branch ? [`Your worktree is based on ${params.branch}. Check that branch out and commit your work there.`] : []),
        ...(params.issueUrl ? [`Tracking issue: ${params.issueUrl}`] : []),
        ...(params.prUrl ? [`Draft pull request: ${params.prUrl}`] : []),
        "Do not create, merge, or mark ready any pull request — Chief owns the forge. Commit and push your work, then report ready.",
      ] : []),
      "", "## Project rules", rules,
      "", "## Working contract",
      "- Read every file this brief names in full before acting or spawning anything: no partial reads, no limit or offset. When the context above names a plan file, read that file in full too before starting.",
      "- Own the requested outcome in this worktree. Keep scope narrow and verify the user journey or closest executable seam.",
      "- Use chief_report with state ready and a non-empty result when your work is ready for Chief's verification. Only Chief can mark it complete.",
      "- If this brief lays out ordered phases, implement and report only the phase you are currently asked for, then stop; name which phase you finished in your ready result (for example \"Phase 2 of 4\"), so the reviewer and Chief both see it. The next phase arrives as a new instruction once this one is reviewed, not something to start on your own.",
      "- A ready result names changed files by file:line, then splits verification into Automated (the command you ran and its exit status) and Manual (what only a human can confirm).",
      "- A blocked report must include the blocker and your recommended decision or next action.",
      "- Do not ask the user directly from this thread. Chief decides whether a question needs escalation.",
    ].join("\n");
    const hostId = await defaultHostId();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: {
        type: "host",
        hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: params.branch ? { kind: "named" as const, name: params.branch } : { kind: "default" as const },
        },
      },
      sectionId,
      parentThreadId: chief.thread_id,
      visibility: "visible",
      title: params.title,
      ...(await execution(params.tier, hostId)),
      prompt,
      pluginMetadata: { role: "worker", chiefThreadId: chief.thread_id },
    });
    insertThread({
      threadId: thread.id, role: "worker", projectId, chiefThreadId: chief.thread_id, title: params.title,
      state: "starting", status: thread.status, tier: params.tier, brief,
      branch: params.branch, issueUrl: params.issueUrl, prUrl: params.prUrl,
    });
    return { threadId: thread.id, title: params.title, projectId };
  }

  async function continueThread(threadId: string, instruction: string) {
    const row = roles.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker, planner, or reviewer ${threadId}.`);
    // Planners and reviewers both stay out of the files; only a worker edits.
    // The instruction leads so consecutive continuations differ from their first
    // character in the BB queue preview, instead of both starting with the same
    // read-only reminder. Clip the instruction alone, reserving room for the
    // reminder and the blank line between them, then append the reminder to the
    // already-clipped text — otherwise a long instruction could delete or
    // truncate the read-only constraint instead of just itself.
    const reminder = row.role === "reviewer" ? REVIEW_ONLY : row.role === "planner" ? PLAN_ONLY : null;
    const text = reminder
      ? `${clip(instruction, MAX_RESULT_LENGTH - reminder.length - 2)}\n\n${reminder}`
      : clip(instruction, MAX_RESULT_LENGTH);
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
      senderThreadId: row.chief_thread_id ?? undefined,
    });
    db.prepare(`UPDATE managed_threads SET state='active', blocker=NULL, recommendation=NULL, verdict=NULL,
      active_since=?, active_cycle=active_cycle+1, stall_alerted_cycle=NULL, updated_at=? WHERE thread_id=?`).run(
      Date.now(), Date.now(), threadId,
    );
    reloadRoles();
    return roles.get(threadId)!;
  }

  async function startReview(workerThreadId: string, focus?: string) {
    const inFlight = reviewStarts.get(workerThreadId);
    if (inFlight) return inFlight;
    const start = (async () => {
      const worker = roles.get(workerThreadId);
      if (!worker || worker.role !== "worker") throw new Error(`No managed worker ${workerThreadId}.`);
      const duplicate = existingReview.get(workerThreadId) as ManagedRow | undefined;
      if (duplicate) return { threadId: duplicate.thread_id, title: duplicate.title, workerThreadId, created: false };
      const live = await bb.sdk.threads.get({ threadId: workerThreadId });
      if (BUSY_STATUSES.has(live.status)) throw new Error(`Worker ${workerThreadId} is ${live.status}; wait until it is idle before starting a review.`);
      if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Worker ${workerThreadId} is not reviewable.`);
      if (!live.environmentId) throw new Error(`Worker ${workerThreadId} has no reusable environment.`);
      const sectionId = await ensureSection();
      const rules = await readRules(worker.project_id);
      const title = `Review · ${worker.title}`;
      const prompt = [
        `Independently review the work owned by worker thread ${workerThreadId}: “${worker.title}”.`,
        focus ? `Review focus: ${focus}` : "Review for correctness, regressions, validation quality, and unnecessary complexity.",
        REVIEW_ONLY,
        "Inspect the actual worktree and evidence; do not rely only on the worker's claims. When the worker's brief context names a plan file, read that file in full before judging the change against it.",
        "Confirm the automated criteria actually ran with their exit status; list the manual criteria that still need a human to confirm.",
        `Report your findings to Chief thread ${worker.chief_thread_id} with chief_report, state ready, and a verdict: approve when the change can ship as it stands, request_changes when the worker must fix something.`,
        "If the worker's brief lays out ordered phases and this is not the last one, name the next phase in your recommendation (for example \"Continue the worker with phase 3 of 4.\"); leave recommendation unset only when no phases remain, since that is what tells Chief whether to complete this work or continue it.",
        "Do not broaden scope or make product decisions. Recommend escalation when a real decision is required.",
        ...(worker.brief ? [
          "", "## The brief this work was given", clip(worker.brief, 6_000),
          "", "Judge the change against that brief. A trade-off the brief mandates is not a defect — say so rather than filing it as one.",
        ] : []),
        ...(worker.result ? ["", "## What the worker reported", clip(worker.result, 2_000)] : []),
        "", "## Project rules", rules,
      ].join("\n");
      const thread = await bb.sdk.threads.spawn({
        projectId: worker.project_id,
        environment: { type: "reuse", environmentId: live.environmentId },
        sectionId,
        parentThreadId: worker.chief_thread_id ?? undefined,
        visibility: "visible",
        title,
        ...(await execution("reviewer", await environmentHostId(live.environmentId))),
        prompt,
        pluginMetadata: { role: "reviewer", chiefThreadId: worker.chief_thread_id },
      });
      insertThread({ threadId: thread.id, role: "reviewer", projectId: worker.project_id, chiefThreadId: worker.chief_thread_id, workerThreadId, title, state: "starting", status: thread.status });
      return { threadId: thread.id, title, workerThreadId, created: true };
    })();
    reviewStarts.set(workerThreadId, start);
    try {
      return await start;
    } finally {
      reviewStarts.delete(workerThreadId);
    }
  }

  /** A failed auto-review must never swallow the alert Chief is waiting for. */
  async function autoReview(row: ManagedRow) {
    try {
      const review = await startReview(row.thread_id);
      const reviewer = review.created ? null : roles.get(review.threadId);
      // The worker fixed what the review found and reported ready again. Its
      // finished reviewer has to look again, or the fix cycle ships unreviewed.
      if (!reviewer || BUSY_STATUSES.has(reviewer.state)) return { ...review, resumed: false };
      await continueThread(
        review.threadId,
        [
          "The worker reported ready again.",
          // Names whatever phase the worker says it just finished, the same way the
          // reviewer's first pass already sees the worker's brief and last report.
          ...(row.result ? [`What it says it finished: ${clip(row.result, 2_000)}`] : []),
          "Re-check the current worktree, including everything changed since your last report, and send Chief a fresh verdict with chief_report.",
        ].join("\n"),
      );
      return { ...review, resumed: true };
    } catch (error) {
      bb.log.warn(`Could not auto-start a review for ${row.thread_id}: ${String(error)}`);
      return null;
    }
  }

  async function markComplete(threadId: string, result?: string) {
    const row = roles.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker or reviewer ${threadId}.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (BUSY_STATUSES.has(live.status)) throw new Error(`Cannot complete ${threadId} while it is ${live.status}.`);
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot complete ${threadId} because it is not a live thread.`);
    db.prepare(`UPDATE managed_threads SET state='complete', status=?, result=COALESCE(?, result),
      blocker=NULL, recommendation=NULL, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      live.status, result ? clip(result, MAX_RESULT_LENGTH) : null, Date.now(), threadId,
    );
    reloadRoles();
    return roles.get(threadId)!;
  }

  function enqueueAlert(row: ManagedRow, key: string, message: string) {
    if (!row.chief_thread_id) throw new Error(`Managed thread ${row.thread_id} has no Chief to notify.`);
    const dedupeKey = `${row.thread_id}:${key}`;
    // Only an alert of the same kind (the segment before the first ":") is stale
    // once this one lands — a newer report supersedes an older undelivered report,
    // but generic lifecycle noise (idle, active, stall, ...) must never evict a
    // pending report/verdict alert Chief has not received yet.
    const kind = key.slice(0, key.indexOf(":"));
    db.transaction(() => {
      db.prepare(`DELETE FROM alert_outbox WHERE source_thread_id=? AND delivered_at IS NULL AND dedupe_key<>? AND dedupe_key LIKE ?`)
        .run(row.thread_id, dedupeKey, `${row.thread_id}:${kind}:%`);
      db.prepare(`INSERT OR IGNORE INTO alert_outbox
        (dedupe_key, target_thread_id, source_thread_id, message, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(
        dedupeKey, row.chief_thread_id, row.thread_id,
        clip(`[Chief lifecycle alert]\n${message}`), Date.now(),
      );
    })();
    return dedupeKey;
  }

  async function deliverAlert(key: string) {
    const existing = alertDeliveries.get(key);
    if (existing) return existing;
    const delivery = (async () => {
      const alert = db.prepare<[string]>(`SELECT * FROM alert_outbox WHERE dedupe_key=?`).get(key) as AlertRow | undefined;
      if (!alert || alert.delivered_at !== null) return true;
      try {
        await bb.sdk.threads.send({
          threadId: alert.target_thread_id,
          mode: "queue-if-active",
          input: [{ type: "text", text: clip(alert.message), mentions: [] }],
        });
        db.prepare(`UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`UPDATE alert_outbox SET attempts=attempts+1, last_error=? WHERE dedupe_key=?`).run(clip(message, 1_000), key);
        bb.log.warn(`Could not deliver Chief alert ${key}: ${message}`);
        return false;
      }
    })();
    alertDeliveries.set(key, delivery);
    try {
      return await delivery;
    } finally {
      alertDeliveries.delete(key);
    }
  }

  async function alertChief(row: ManagedRow, key: string, message: string) {
    const outboxKey = enqueueAlert(row, key, message);
    return deliverAlert(outboxKey);
  }

  async function retryAlerts() {
    for (const alert of pendingAlerts.all() as AlertRow[]) await deliverAlert(alert.dedupe_key);
  }

  async function report(threadId: string, params: z.infer<typeof reportParams>, callerProjectId: string) {
    let row = roles.get(threadId);
    if (!row) {
      // configure() already falls back to pluginMetadata seeded at spawn time
      // because insertThread only runs after threads.spawn resolves; a report can
      // land in that same gap for a brand-new thread. Recover the same seed here
      // instead of throwing, so exposing the tool and executing it close together.
      // pluginMetadata is writable by any API client, another plugin, or the
      // thread's own agent, so only trust it once originPluginId proves this
      // thread was actually created by our own spawn call.
      const live = await bb.sdk.threads.get({ threadId }).catch(() => null);
      const seeded = live?.originPluginId === bb.pluginId
        ? spawnMetadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null))
        : undefined;
      if (seeded?.success) {
        insertThread({
          threadId,
          role: seeded.data.role,
          projectId: callerProjectId,
          chiefThreadId: seeded.data.chiefThreadId ?? null,
          title: live?.title ?? live?.titleFallback ?? threadId,
          state: "active",
          status: live?.status ?? "active",
        });
        row = roles.get(threadId);
      }
    }
    if (!row || row.role === "chief") throw new Error("chief_report is available only in managed worker, planner, and reviewer threads.");
    if (["complete", "archived", "deleted"].includes(row.state)) {
      throw new Error(`Managed thread ${threadId} is ${row.state} and can no longer report.`);
    }
    const verdict = params.state === "ready" ? params.verdict ?? null : null;
    if (row.role === "reviewer" && params.state === "ready" && !verdict) {
      throw new Error('A reviewer\'s ready report must carry a verdict: "approve" when the change can ship as it stands, or "request_changes" when the worker must fix something.');
    }
    const now = Date.now();
    // A reviewer's active_cycle counts every resume, which under a phased plan is the
    // phase count rather than rejection rounds — a phase's first-ever rejection can
    // land on a high active_cycle and must not read as a deadlock. reject_streak counts
    // only consecutive request_changes verdicts, and resets the moment either side
    // breaks the streak with an approve.
    db.prepare(`UPDATE managed_threads SET state=?, result=?, blocker=?, recommendation=?, verdict=?,
      reject_streak = CASE WHEN ?=1 THEN reject_streak+1 WHEN ?=1 THEN 0 ELSE reject_streak END,
      active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      params.state, params.result ?? null, params.state === "blocked" ? params.blocker : null,
      params.recommendation ?? null, verdict,
      verdict === "request_changes" ? 1 : 0, verdict === "approve" ? 1 : 0,
      now, threadId,
    );
    reloadRoles();
    const current = roles.get(threadId)!;
    const deadlocked = verdict === "request_changes" && current.reject_streak >= 2;
    const summary = [
      `${row.role[0]!.toUpperCase()}${row.role.slice(1)} report from ${row.title} (${threadId})`,
      `State: ${params.state}`,
      ...(verdict ? [`Verdict: ${verdict}`] : []),
      ...(params.result ? [`Result: ${params.result}`] : []),
      ...(params.state === "blocked" ? [`Blocker: ${params.blocker}`] : []),
      ...(params.recommendation ? [`Recommendation: ${params.recommendation}`] : []),
      // The server has no phase column and cannot know from the database whether
      // more phases remain — a reviewer that reads the worker's brief does. Its
      // recommendation naming the next phase is what makes this non-final; its
      // absence is what makes the legacy final wording below reachable verbatim.
      verdict === "approve"
        ? params.recommendation
          ? "The reviewer approves this phase. Continue the worker with the next phase named in the recommendation above."
          : "The reviewer approves. Complete this work, then mark the pull request ready."
        : deadlocked
          ? `The reviewer still requires changes after ${current.reject_streak} consecutive rounds. This pair is not converging: escalate to the user with both positions and your recommendation instead of funding another round.`
          : verdict === "request_changes"
            ? "The reviewer requires changes. Continue the worker with the specific fixes, or escalate if the disagreement is a genuine decision."
            : row.role === "worker" && params.state === "ready"
              ? "An independent review starts by itself once this worker goes idle. Inspect the evidence now, but wait for the reviewer's verdict before completing the work."
              : row.role === "planner" && params.state === "ready"
                ? "The plan detail is in the file named above; read it in full before deciding. Correct it with chief_continue, escalate a genuine decision to the user, or call chief_delegate with the plan file's path in its context, not the plan body. Nothing is implemented until you do."
                : "Inspect live evidence with chief_inspect and choose: continue, review, complete, or escalate to the user.",
    ].join("\n");
    const delivered = await alertChief(current, `report:${now}:${randomUUID()}`, summary);
    if (!delivered) {
      throw new Error("Report was saved but could not be delivered to Chief. It will retry automatically; inspect Chief connectivity before reporting again.");
    }
    return current;
  }

  function stateFromLive(row: ManagedRow, status: string) {
    if (["active", "starting", "pending", "stopping"].includes(status)) return status;
    if (status === "error") return "failed";
    if (["ready", "blocked", "complete"].includes(row.state)) return row.state;
    return "idle";
  }

  async function reconcileThread(row: ManagedRow, sectionId: string) {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: row.thread_id });
    } catch (error) {
      bb.log.warn(`Transient thread read failure for ${row.thread_id}; will retry: ${String(error)}`);
      return false;
    }
    const now = Date.now();
    if (thread.deletedAt !== null) {
      db.prepare(`UPDATE managed_threads SET state='deleted', status=NULL, active_since=NULL, updated_at=? WHERE thread_id=?`).run(now, row.thread_id);
      reloadRoles();
      return true;
    }
    if (thread.archivedAt !== null) {
      db.prepare(`UPDATE managed_threads SET state='archived', status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(thread.status, now, row.thread_id);
      reloadRoles();
      return true;
    }
    if (thread.sectionId !== sectionId || thread.visibility !== "visible") {
      try {
        await bb.sdk.threads.update({ threadId: row.thread_id, sectionId, visibility: "visible" });
      } catch (error) {
        bb.log.warn(`Transient thread filing failure for ${row.thread_id}; will retry: ${String(error)}`);
      }
    }
    const nextState = stateFromLive(row, thread.status) as ManagedRow["state"];
    const enteringActive = nextState === "active" && row.state !== "active";
    db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=?,
      active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
      updated_at=? WHERE thread_id=?`).run(
      nextState, thread.status,
      nextState === "active" ? (row.state === "active" ? row.active_since ?? now : now) : null,
      enteringActive ? 1 : 0, enteringActive ? 1 : 0, now, row.thread_id,
    );
    reloadRoles();
    return true;
  }

  async function reconcile() {
    const sectionId = await ensureSection();
    for (const row of [...roles.values()]) {
      if (row.state !== "deleted") await reconcileThread(row, sectionId);
    }
    const projects = new Set([...roles.values()].map((row) => row.project_id));
    const configured = (await settings.get()).chiefProject;
    if (configured) projects.add(configured);
    for (const projectId of projects) await readRules(projectId);
  }

  async function lifecycle(kind: string, thread: { id: string; status?: string }, detail?: string | null) {
    const row = roles.get(thread.id);
    if (!row) return;
    const now = Date.now();
    if (row.role === "chief") {
      const state = kind === "active" ? "active"
        : kind === "idle" ? "idle"
          : kind === "failed" ? "failed"
            : kind === "archived" ? "archived" : "deleted";
      db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
        state, thread.status ?? state, now, thread.id,
      );
      reloadRoles();
      return;
    }
    if (kind === "active") {
      const enteringActive = row.state !== "active";
      db.prepare(`UPDATE managed_threads SET state='active', status=?, active_since=?,
        active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
        updated_at=? WHERE thread_id=?`).run(
        thread.status ?? "active", enteringActive ? now : row.active_since ?? now,
        enteringActive ? 1 : 0, enteringActive ? 1 : 0, now, thread.id,
      );
      reloadRoles();
      return;
    }
    const observed = kind === "idle" ? "idle" : kind === "failed" ? "failed" : kind === "archived" ? "archived" : "deleted";
    const state = observed === "idle" && ["ready", "blocked", "complete"].includes(row.state) ? row.state : observed;
    db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      state, thread.status ?? observed, now, thread.id,
    );
    reloadRoles();
    const current = roles.get(thread.id)!;
    // Ready work earns its reviewer without Chief having to ask for one; Chief
    // still owns the verdict. Only now is the worker idle enough to review.
    const pending = current.role === "worker" && current.state === "ready";
    const review = pending ? await autoReview(current) : null;
    await alertChief(current, `${kind}:${row.active_cycle}`, [
      `${current.role} “${current.title}” (${current.thread_id}) is ${observed}.`,
      ...(detail ? [`Detail: ${detail}`] : []),
      review
        ? `Independent review “${review.title}” (${review.threadId}) ${review.resumed ? "has been asked to re-check the latest changes" : "is running in this worktree"}. Read its report before completing this work.`
        : pending
          ? "Its review could not be started automatically. Start one with chief_review before completing this work."
          : "Inspect live output and evidence. Choose a safe next step: continue it, start/assess a review, mark it complete, or escalate a genuine decision to the user.",
    ].join("\n"));
  }

  bb.events.on("thread.active", ({ thread }) => lifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => lifecycle("idle", thread, lastAssistantText));
  bb.events.on("thread.failed", ({ thread, error }) => lifecycle("failed", thread, error));
  bb.events.on("thread.archived", ({ thread }) => lifecycle("archived", thread));
  bb.events.on("thread.deleted", ({ thread }) => lifecycle("deleted", thread));

  bb.background.service("supervisor", {
    async start(signal) {
      const wake = () => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, RECONCILE_INTERVAL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      while (!signal.aborted) {
        try {
          await reconcile();
          const values = await settings.get();
          const parsed = Number(values.stallMinutes);
          const threshold = (Number.isFinite(parsed) && parsed > 0 ? parsed : 30) * 60_000;
          const now = Date.now();
          for (const row of [...roles.values()]) {
            if (row.role === "chief" || row.state !== "active" || row.active_since === null) continue;
            if (now - row.active_since < threshold || row.stall_alerted_cycle === row.active_cycle) continue;
            const sent = await alertChief(row, `stall:${row.active_cycle}`, [
              `${row.role} “${row.title}” (${row.thread_id}) has remained active for more than ${Math.round(threshold / 60_000)} minutes.`,
              "Inspect current evidence before intervening. Continue or steer only when a safe next instruction is clear; otherwise escalate the concrete blocker.",
            ].join("\n"));
            if (sent) {
              db.prepare(`UPDATE managed_threads SET stall_alerted_cycle=?, updated_at=? WHERE thread_id=?`).run(row.active_cycle, Date.now(), row.thread_id);
              reloadRoles();
            }
          }
          const chiefProjects = new Set(
            [...roles.values()]
              .filter((row) => row.role === "chief" && ["failed", "archived", "deleted"].includes(row.state))
              .map((row) => row.project_id),
          );
          if (values.chiefProject) chiefProjects.add(values.chiefProject);
          for (const projectId of chiefProjects) await ensureChief(projectId);
          // Replace terminal Chiefs and retarget their queued alerts before any
          // pending delivery is attempted.
          await retryAlerts();
        } catch (error) {
          bb.log.warn(`Supervisor reconciliation failed: ${String(error)}`);
        }
        await wake();
      }
    },
  });

  settings.onChange((next, previous) => {
    if (next.chiefProject && next.chiefProject !== previous.chiefProject) {
      void ensureChief(next.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
    }
    // A new key or model has not been checked yet, whatever the toggle says.
    if (next.jevApiKey !== previous.jevApiKey || next.jevModel !== previous.jevModel) {
      writeJevFingerprint(null);
    }
    void jevStatus().catch((error) => bb.log.warn(`Could not re-check the Jev gate: ${String(error)}`));
    plannerActive = next.plannerEnabled;
  });

  function rosterFor(projectId: string, includeComplete = false) {
    return [...roles.values()].filter((row) => row.project_id === projectId && (includeComplete || row.state !== "complete"));
  }

  function belongsToChief(row: ManagedRow, chiefThreadId: string) {
    return row.thread_id === chiefThreadId || row.chief_thread_id === chiefThreadId;
  }

  function rosterForChief(chiefThreadId: string, includeComplete = false) {
    return [...roles.values()].filter(
      (row) => belongsToChief(row, chiefThreadId) && (includeComplete || row.state !== "complete"),
    );
  }

  async function inspect(threadId: string, projectId: string) {
    const row = roles.get(threadId);
    if (!row || row.project_id !== projectId) throw new Error(`No managed thread ${threadId} for this Chief project.`);
    let liveStatus = row.status;
    try {
      const live = await bb.sdk.threads.get({ threadId });
      liveStatus = live.deletedAt !== null ? "deleted" : live.archivedAt !== null ? "archived" : live.status;
    } catch (error) {
      bb.log.warn(`Could not inspect live status for ${threadId}: ${String(error)}`);
    }
    let output: string | null = null;
    try {
      output = (await bb.sdk.threads.output({ threadId })).output;
    } catch (error) {
      bb.log.warn(`Could not inspect output for ${threadId}: ${String(error)}`);
    }
    return [
      `Thread: ${row.title} (${threadId})`,
      `Role: ${row.role}`,
      ...(row.tier ? [`Tier: ${row.tier}`] : []),
      ...(row.branch ? [`Branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`Issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`Pull request: ${row.pr_url}`] : []),
      `Persisted state: ${row.state}`,
      `Live status: ${liveStatus ?? "unknown"}`,
      ...(row.result ? [`Result: ${clip(row.result, 2_000)}`] : []),
      ...(row.blocker ? [`Blocker: ${clip(row.blocker, 1_000)}`] : []),
      ...(row.recommendation ? [`Recommendation: ${clip(row.recommendation, 1_000)}`] : []),
      ...(row.verdict ? [`Verdict: ${row.verdict}`] : []),
      `Last assistant output:\n${output ? clip(output, 4_000) : "(none available)"}`,
    ].join("\n");
  }

  // --- Jev scoring -------------------------------------------------------
  // The toggle is a claim; the stored fingerprint is the proof. Nothing scores
  // unless a connection check succeeded for the exact key and model in force.

  function jevFingerprint(values: { jevApiKey?: string; jevModel: string }) {
    return createHash("sha256").update(`${values.jevApiKey ?? ""}\n${values.jevModel}`).digest("hex");
  }

  function storedJevFingerprint() {
    return (db.prepare(`SELECT value FROM plugin_meta WHERE key='jev_verified'`).get() as { value: string } | undefined)?.value ?? null;
  }

  function writeJevFingerprint(fingerprint: string | null) {
    if (fingerprint === null) {
      db.prepare(`DELETE FROM plugin_meta WHERE key='jev_verified'`).run();
      return;
    }
    db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('jev_verified', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(fingerprint);
  }

  /** Reads the gate and repairs it: an enabled toggle without a matching check is
   * forced back off, so editing settings through the CLI cannot slip past the UI. */
  async function jevStatus(): Promise<JevStatus> {
    const values = await settings.get();
    const verified = Boolean(values.jevApiKey) && storedJevFingerprint() === jevFingerprint(values);
    if (!verified && values.jevEnabled) {
      jevActive = false;
      await settings.experimental_set({ jevEnabled: false });
      return { hasKey: Boolean(values.jevApiKey), model: values.jevModel, verified: false, enabled: false };
    }
    jevActive = values.jevEnabled;
    return { hasKey: Boolean(values.jevApiKey), model: values.jevModel, verified, enabled: values.jevEnabled };
  }

  async function checkJevConnection() {
    const values = await settings.get();
    if (!values.jevApiKey) {
      writeJevFingerprint(null);
      return { ok: false, message: "Enter an AI Gateway API key first.", status: await jevStatus() };
    }
    try {
      await pingGateway({ apiKey: values.jevApiKey, model: values.jevModel, timeoutMs: JEV_PING_TIMEOUT_MS });
    } catch (error) {
      writeJevFingerprint(null);
      return { ok: false, message: clip(String(error), 500), status: await jevStatus() };
    }
    writeJevFingerprint(jevFingerprint(values));
    return { ok: true, message: `Reached ${values.jevModel}. You can turn scoring on now.`, status: await jevStatus() };
  }

  async function collectDiff(environmentId: string, baseBranch: string) {
    const files = await bb.sdk.environments.diffFiles({ environmentId, target: "all", mergeBaseBranch: baseBranch });
    if (files.outcome !== "available") throw new Error(`Cannot diff against ${baseBranch}: ${diffFailure(files)}`);
    const paths = files.files.map((file) => file.path).filter((path) => !GENERATED_OR_LOCK_PATTERN.test(path));
    if (paths.length === 0) {
      throw new Error(
        files.files.length === 0
          ? `Nothing has changed against ${baseBranch}.`
          : `Only generated or lock files changed against ${baseBranch}.`,
      );
    }
    const patches = await bb.sdk.environments.diffPatch({ environmentId, paths, target: { type: "all", mergeBaseBranch: baseBranch } });
    if (patches.outcome !== "available") throw new Error(`Cannot diff against ${baseBranch}: ${diffFailure(patches)}`);

    const { diff, truncated } = capDiff(patches.patches, JEV_MAX_DIFF_BYTES);
    if (diff.trim() === "") throw new Error(`The diff against ${baseBranch} carries no reviewable text.`);
    return { diff, fileCount: paths.length, truncated };
  }

  function diffFailure(result: { outcome: "not_applicable" | "unavailable"; message?: string; failure?: { message: string } }) {
    return result.outcome === "not_applicable" ? (result.message ?? "not applicable") : (result.failure?.message ?? "unavailable");
  }

  async function scoreChange(reviewer: ManagedRow, baseBranch: string) {
    const status = await jevStatus();
    if (!status.enabled) throw new Error("Jev scoring is off. Turn it on in Chief's settings after a successful connection check.");
    const values = await settings.get();
    if (!values.jevApiKey) throw new Error("Jev scoring has no API key.");
    const workerThreadId = reviewer.worker_thread_id;
    if (!workerThreadId) throw new Error("This reviewer is not attached to a worker.");

    const live = await bb.sdk.threads.get({ threadId: reviewer.thread_id });
    if (!live.environmentId) throw new Error("This review thread has no environment to diff.");
    const { diff, fileCount, truncated } = await collectDiff(live.environmentId, baseBranch);

    const worker = roles.get(workerThreadId);
    const stored = previousScore.get(workerThreadId, baseBranch) as { evaluation: string } | undefined;
    const previous = stored ? evaluationSchema.parse(JSON.parse(stored.evaluation)) : undefined;

    const evaluation = await runEvaluation(
      { apiKey: values.jevApiKey, model: values.jevModel, timeoutMs: JEV_SCORE_TIMEOUT_MS },
      {
        task: worker?.title ?? reviewer.title,
        diff,
        repositoryContext: await readRules(reviewer.project_id),
        ...(truncated ? { diffTruncated: TRUNCATED_DIFF_NOTE } : {}),
      },
      previous,
    );

    db.prepare(`INSERT INTO jev_scores (worker_thread_id, base_branch, evaluation, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(worker_thread_id, base_branch) DO UPDATE SET evaluation=excluded.evaluation, updated_at=excluded.updated_at`).run(
      workerThreadId, baseBranch, JSON.stringify(evaluation), Date.now(),
    );
    recordMetrics(evaluation);
    return formatEvaluation(evaluation, { baseBranch, fileCount, truncated, hadPrevious: previous !== undefined });
  }

  function recordMetrics(evaluation: Evaluation) {
    const now = Date.now();
    db.transaction(() => {
      for (const [metric, value] of Object.entries(evaluation.metrics) as [MetricKey, Evaluation["metrics"][MetricKey]][]) {
        recordMetric.run(metric, value.applicable ? 0 : 1, value.score ?? 0, now);
      }
    })();
  }

  function metricAbstention() {
    return (metricStats.all() as { metric: string; samples: number; abstained: number; score_sum: number }[])
      .map((row) => ({
        metric: row.metric,
        samples: row.samples,
        abstained: row.abstained,
        abstainedPercent: Math.round((row.abstained / row.samples) * 100),
        meanScore: row.samples > row.abstained
          ? Math.round((row.score_sum / (row.samples - row.abstained)) * 10) / 10
          : null,
      }))
      .sort((left, right) => right.abstainedPercent - left.abstainedPercent || left.metric.localeCompare(right.metric));
  }

  function formatEvaluation(
    evaluation: Evaluation,
    context: { baseBranch: string; fileCount: number; truncated: boolean; hadPrevious: boolean },
  ) {
    const scored = (Object.entries(evaluation.metrics) as [MetricKey, Evaluation["metrics"][MetricKey]][])
      .filter((entry): entry is [MetricKey, { applicable: true; score: number }] => entry[1].applicable && entry[1].score !== undefined)
      .sort((left, right) => left[1].score - right[1].score);
    const lines = [
      `Jev score vs ${context.baseBranch} · ${context.fileCount} file(s)${context.truncated ? " · diff truncated, treat low scores as provisional" : ""}`,
      "",
      ...scored.map(([key, metric]) => `${getMetricDefinition(key).label}: ${metric.score}/10`),
    ];
    if (evaluation.priorities.length) {
      lines.push("", "Weakest dimensions:");
      for (const priority of evaluation.priorities) {
        lines.push(`- ${getMetricDefinition(priority.metric).label} (${priority.severity}): ${priority.reason}`);
      }
    }
    if (context.hadPrevious) {
      lines.push("", `Since the last score against this same base — improved: ${evaluation.improvements?.join(", ") || "none"}; regressed: ${evaluation.regressions?.join(", ") || "none"}.`);
    }
    lines.push(
      "",
      "This is one model's opinion on the diff alone. Confirm or reject each point against the code you read, and say so in your report to Chief.",
    );
    return lines.join("\n");
  }

  bb.agents.registerTool({
    name: "chief_forge_init",
    description: "Build the forge pre-flight for one task — tracking issue, task branch, draft pull request — as one script to run before chief_delegate.",
    parameters: z.object({
      title: z.string().trim().min(1).max(160).describe("The exact title this task will be delegated with."),
      base: z.string().trim().min(1).max(300).optional().describe("Branch to cut from and target the pull request at. Omit for the project default; name one only to stack deliberately on an open pull request."),
      body: z.string().trim().min(1).max(4_000).optional().describe("Short summary for the issue and pull request body."),
    }),
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "chief" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("chief_forge_init requires an active registered Chief thread.");
      }
      const { branch, script } = forgeInitScript(params);
      return [
        "Run this from the project checkout, verbatim. Every value is already substituted and quoted, every forge step is best-effort, and your own checkout never moves:",
        "", "```sh", script, "```", "",
        `The last line is CHIEF_FORGE branch=… base=… issue_url=… pr_url=…. Pass those to chief_delegate as branch, issueUrl and prUrl, omitting whatever came back empty — an empty issue_url usually means the repository has issues disabled, and an empty branch means the cut failed, so delegate without one and the worktree uses the project default. Neither is a failure to report as one. The branch will be ${branch}.`,
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "chief_delegate",
    description: "Delegate one clearly titled unit of implementation work to a visible worker in its own managed worktree.",
    parameters: delegateParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "chief" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("chief_delegate requires an active registered Chief thread.");
      }
      const result = await delegate(params, context.threadId);
      return `Started worker “${result.title}” in thread ${result.threadId}. Track it with chief_roster.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_plan",
    description: "Send one unit of work to a read-only planner. It proposes an implementation plan; you read it and decide whether to delegate it.",
    parameters: planParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "chief" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("chief_plan requires an active registered Chief thread.");
      }
      const result = await startPlan(params, context.threadId);
      return `Started planner “${result.title}” in thread ${result.threadId}. Read its plan before delegating the work.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_roster",
    description: "Inspect this project's managed threads and their bounded persisted status, result, blocker, and recommendation.",
    parameters: z.object({ includeComplete: z.boolean().optional() }),
    async execute({ includeComplete }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "chief") throw new Error("chief_roster requires a registered Chief thread.");
      const rows = rosterForChief(caller.thread_id, includeComplete);
      return rows.length ? rows.map((row) => [
        `${row.role}${row.tier ? ` (${row.tier})` : ""} | ${row.state} | live:${row.status ?? "unknown"} | ${row.title} | ${row.thread_id}`,
        ...(row.branch ? [`branch: ${row.branch}`] : []),
        ...(row.issue_url ? [`issue: ${row.issue_url}`] : []),
        ...(row.pr_url ? [`pr: ${row.pr_url}`] : []),
        ...(row.result ? [`result: ${clip(row.result, 1_000)}`] : []),
        ...(row.blocker ? [`blocker: ${clip(row.blocker, 600)}`] : []),
        ...(row.recommendation ? [`recommendation: ${clip(row.recommendation, 600)}`] : []),
        ...(row.verdict ? [`verdict: ${row.verdict}`] : []),
      ].join("\n  ")).join("\n") : "No managed threads for this project.";
    },
  });
  bb.agents.registerTool({
    name: "chief_inspect",
    description: "Inspect one managed thread's live status, persisted report, and bounded last assistant output before deciding what to do.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "chief" || !target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      return inspect(threadId, caller.project_id);
    },
  });
  bb.agents.registerTool({
    name: "chief_continue",
    description: "Send or queue a concrete next instruction to a managed worker or reviewer. Reviewers stay read-only; send a repair to the worker instead.",
    parameters: z.object({
      threadId: z.string(),
      instruction: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
    }),
    async execute({ threadId, instruction }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "chief" || !target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      await continueThread(threadId, instruction);
      return `Continued ${threadId}.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_review",
    description: "Start or return an independent read-only review in an idle worker's existing worktree.",
    parameters: z.object({ workerThreadId: z.string(), focus: z.string().trim().max(4_000).optional() }),
    async execute({ workerThreadId, focus }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const worker = roles.get(workerThreadId);
      if (!caller || caller.role !== "chief" || !worker || !belongsToChief(worker, caller.thread_id)) {
        throw new Error(`No managed worker ${workerThreadId} for this Chief.`);
      }
      const review = await startReview(workerThreadId, focus);
      return `${review.created ? "Started" : "Using existing"} “${review.title}” in thread ${review.threadId}.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_complete",
    description: "Mark an idle managed worker or reviewer complete after Chief has inspected sufficient evidence.",
    parameters: z.object({ threadId: z.string(), result: z.string().trim().max(MAX_RESULT_LENGTH).optional() }),
    async execute({ threadId, result }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      const target = roles.get(threadId);
      if (!caller || caller.role !== "chief" || !target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      const row = await markComplete(threadId, result);
      return `Marked “${row.title}” complete.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_report",
    description: "Report managed work state and evidence to Chief. Use ready, not complete; blocked requires blocker and recommendation; a reviewer's ready report requires a verdict.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_report requires a thread context.");
      await report(context.threadId, params, context.projectId);
      return "Report delivered to Chief.";
    },
  });

  bb.agents.registerTool({
    name: "chief_score",
    description: "Score this review's change on 19 engineering-quality dimensions. You choose the base branch to compare against.",
    parameters: z.object({
      baseBranch: z.string().trim().min(1).describe("The branch this change will merge into — the PR's base, or main/master."),
    }),
    async execute({ baseBranch }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "reviewer" || ["complete", "archived", "deleted"].includes(caller.state)) {
        throw new Error("chief_score is available only in an active managed review thread.");
      }
      return scoreChange(caller, baseBranch);
    },
  });

  bb.agents.configure((context) => {
    const row = roles.get(context.thread.id);
    if (row && ["complete", "archived", "deleted"].includes(row.state)) return { tools: [], skills: [] };
    // insertThread only runs after threads.spawn resolves, so the very first
    // configure() call for a brand-new thread can land before that row exists. The
    // role and chief seeded into pluginMetadata at spawn time cover that gap —
    // without it, a fast environment (a reused reviewer worktree wins this race far
    // more often than a freshly provisioned one) could start a thread with no tools
    // at all, including chief_report. pluginMetadata itself is writable by any API
    // client, another plugin, or the thread's own agent, so only trust it when
    // origin.pluginId proves this thread was actually created by our own spawn call
    // (seeding pluginMetadata always attributes the new thread to this plugin).
    const seeded = context.origin.pluginId === bb.pluginId
      ? spawnMetadataSchema.safeParse(context.pluginMetadata)
      : undefined;
    const role = row?.role ?? (seeded?.success ? seeded.data.role : undefined);
    if (!role) return { tools: [], skills: [] };
    const rules = rulesCache.get(context.project.id) ?? BUILT_IN_RULES;
    if (role === "chief") {
      return {
        tools: [
          ...(plannerActive ? ["chief_plan"] : []),
          "chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_review", "chief_complete",
        ],
        skills: ["chief"],
        instructions: [
          `You are the registered Chief supervisor for ${context.project.name}. Use ordinary visible BB threads and drive managed work through completion.`,
          ...(plannerActive ? ["", PLANNER_CHIEF_INSTRUCTIONS] : []),
          "",
          rules,
        ].join("\n"),
      };
    }
    const scoring = role === "reviewer" && jevActive;
    const chiefThreadId = row?.chief_thread_id ?? (seeded?.success ? seeded.data.chiefThreadId ?? null : null);
    return {
      tools: scoring ? ["chief_report", "chief_score"] : ["chief_report"],
      skills: ["chief-worker"],
      instructions: [
        `You are a managed ${role} reporting to Chief thread ${chiefThreadId}.`,
        ...(scoring ? [JEV_REVIEWER_INSTRUCTIONS] : []),
        "",
        rules,
      ].join("\n"),
    };
  });

  bb.rpc.register(rpcContract, {
    status: () => ({ sectionId: storedSectionId(), threads: [...roles.values()].map(toManaged) }),
    start: ({ projectId }) => ensureChief(projectId ?? undefined),
    create: ({ projectId }) => createChief(projectId),
    modelConfiguration: async () => ({
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          chief: readRoleModel(host.id, "chief"),
          planner: readRoleModel(host.id, "planner"),
          junior: readRoleModel(host.id, "junior"),
          senior: readRoleModel(host.id, "senior"),
          reviewer: readRoleModel(host.id, "reviewer"),
        };
        // A connected machine can answer for its own picks, so say which ones it
        // would refuse instead of showing a model the next spawn will ignore.
        // One reader for the whole host: roles sharing a provider scan it once.
        const read = catalogReader(host.id);
        const [scan, flagged] = await Promise.all([
          connected
            ? hostFallback(host.id, read)
            : { fallback: null, error: "Machine is disconnected; its model catalog is unavailable." },
          Promise.all(modelRoleSchema.options.map(async (role) => {
            const selection = selections[role];
            if (!connected || !selection) return null;
            return (await usableSelection(host.id, selection, read)) ? null : role;
          })),
        ]);
        return {
          hostId: host.id,
          hostName: host.name,
          connected,
          ...scan,
          selections,
          unusable: flagged.filter((role): role is ModelRole => role !== null),
        };
      })),
    }),
    setRoleModel: ({ hostId, role, selection }) => {
      writeRoleModel(hostId, role, selection);
      return { ok: true as const };
    },
    jevStatus: () => jevStatus(),
    jevCheck: () => checkJevConnection(),
  });

  const usage = [
    "Usage:",
    "  bb chief status [--project proj_id] [--json]",
    "  bb chief start [--project proj_id] [--json]",
    "  bb chief create [--project proj_id] [--json]",
    "  bb chief adopt --thread thr_id [--json]",
    "  bb chief plan --title \"…\" --mission \"…\" [--context \"…\"] [--json]",
    "  bb chief delegate --title \"…\" --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--tier junior|senior] [--branch feature/…] [--issue-url …] [--pr-url …] [--json]",
    "  bb chief inspect <thread-id>",
    "  bb chief continue <thread-id> --instruction \"…\" [--json]",
    "  bb chief review <worker-thread-id> [--focus \"…\"] [--json]",
    "  bb chief complete <thread-id> [--result \"…\"] [--json]",
    "  bb chief jev-stats [--json]",
  ].join("\n");

  bb.cli.register({
    name: "chief",
    summary: "Supervise visible BB worker and review threads through completion",
    commands: [
      { name: "status", summary: "Show a project's Chief-managed roster", usage: "bb chief status [--project proj_id] [--json]" },
      { name: "start", summary: "Start or return the latest Chief for a project", usage: "bb chief start [--project proj_id] [--json]" },
      { name: "create", summary: "Create another Chief for a project", usage: "bb chief create [--project proj_id] [--json]" },
      { name: "adopt", summary: "Adopt an existing ordinary thread as its project's Chief", usage: "bb chief adopt --thread thr_id [--json]" },
      { name: "plan", summary: "Start a read-only planner for work Chief has not delegated yet", usage: "bb chief plan --title \"…\" --mission \"…\" [--json]" },
      { name: "delegate", summary: "Start a clearly titled worker in a managed worktree", usage: "bb chief delegate --title \"…\" --mission \"…\" [--tier junior|senior] [--branch feature/…] [--issue-url …] [--pr-url …] [--json]" },
      { name: "inspect", summary: "Inspect a managed thread's live and reported evidence", usage: "bb chief inspect <thread-id>" },
      { name: "continue", summary: "Continue a managed worker or reviewer", usage: "bb chief continue <thread-id> --instruction \"…\" [--json]" },
      { name: "review", summary: "Start or return a read-only review for an idle worker", usage: "bb chief review <worker-thread-id> [--focus \"…\"] [--json]" },
      { name: "complete", summary: "Mark verified, non-running managed work complete", usage: "bb chief complete <thread-id> [--result \"…\"] [--json]" },
      { name: "jev-stats", summary: "Show how often each Jev dimension abstained instead of scoring", usage: "bb chief jev-stats [--json]" },
    ],
    async run(argv: string[], context: PluginCliContext): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      const args = parseArgs(rest);
      const json = args.bool("json");
      const ok = (data: unknown, text: string) => ({ exitCode: 0, stdout: clip(json ? JSON.stringify(data, null, 2) : text, 64_000) + "\n" });
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n\n${usage}\n` });
      try {
        if (!command || command === "help" || command === "--help") return ok({}, usage);
        if (command === "status") {
          const projectId = args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("status requires --project outside a project thread");
          const rows = rosterFor(projectId, true).map(toManaged);
          return ok({ sectionId: storedSectionId(), threads: rows }, rows.length ? rows.map((row) => `${row.role.padEnd(8)} ${row.state.padEnd(9)} ${row.title}  ${row.threadId}`).join("\n") : "Chief has no managed threads for this project.");
        }
        if (command === "start") {
          const result = await ensureChief(args.one("project") ?? context.projectId ?? undefined);
          return ok(result, `${result.created ? "Started" : "Using"} Chief thread ${result.threadId}.`);
        }
        if (command === "create") {
          const projectId = args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("create requires --project outside a project thread");
          const result = await createChief(projectId);
          return ok(result, `Created Chief thread ${result.threadId}.`);
        }
        if (command === "adopt") {
          const threadId = args.one("thread") ?? args.positional[0];
          if (!threadId) return fail("adopt requires --thread <thread-id>");
          // Adoption rewrites the row in place, so re-adopting a worker would
          // discard the branch and forge links its open PR depends on.
          const registered = roles.get(threadId);
          if (registered && registered.role !== "chief") {
            return fail(`Thread ${threadId} is already a managed ${registered.role} (“${registered.title}”). Adopting it would discard its branch, forge links, and report.`);
          }
          const thread = await bb.sdk.threads.get({ threadId });
          const sectionId = await ensureSection();
          const title = `Chief · ${await projectName(thread.projectId)}`;
          await bb.sdk.threads.update({ threadId, sectionId, visibility: "visible", title });
          const previous = chiefForProject(thread.projectId);
          if (previous && previous.thread_id !== threadId) {
            const now = Date.now();
            db.transaction(() => {
              db.prepare(`UPDATE managed_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(now, previous.thread_id);
              db.prepare(`UPDATE managed_threads SET chief_thread_id=?, updated_at=? WHERE project_id=? AND chief_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(threadId, now, thread.projectId, previous.thread_id);
              db.prepare(`UPDATE alert_outbox SET target_thread_id=? WHERE target_thread_id=? AND delivered_at IS NULL`).run(threadId, previous.thread_id);
            })();
          }
          insertThread({ threadId, role: "chief", projectId: thread.projectId, title, state: thread.status === "active" ? "active" : "idle", status: thread.status });
          await readRules(thread.projectId);
          return ok({ threadId, projectId: thread.projectId, title }, `Adopted ${threadId} as “${title}”.`);
        }
        if (command === "plan") {
          const parsed = planParams.safeParse({
            title: args.one("title"), mission: args.one("mission"), context: args.one("context"),
          });
          if (!parsed.success) return fail(`Invalid plan brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await startPlan(parsed.data, context.threadId);
          return ok(result, `Started planner “${result.title}” in ${result.threadId}.`);
        }
        if (command === "delegate") {
          const parsed = delegateParams.safeParse({
            title: args.one("title"), mission: args.one("mission"),
            successCriteria: args.all("criteria"), constraints: args.all("constraint"), context: args.one("context"),
            tier: args.one("tier"),
            branch: args.one("branch"), issueUrl: args.one("issue-url"), prUrl: args.one("pr-url"),
          });
          if (!parsed.success) return fail(`Invalid delegate brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await delegate(parsed.data, context.threadId);
          return ok(result, `Started worker “${result.title}” in ${result.threadId}.`);
        }
        if (command === "inspect") {
          const threadId = args.positional[0];
          if (!threadId) return fail("inspect requires <thread-id>");
          const row = roles.get(threadId);
          if (!row) return fail(`No managed thread ${threadId}.`);
          return ok({ threadId }, await inspect(threadId, row.project_id));
        }
        if (command === "continue") {
          const threadId = args.positional[0];
          const instruction = args.one("instruction");
          if (!threadId || !instruction) return fail("continue requires <thread-id> and --instruction");
          await continueThread(threadId, instruction);
          return ok({ threadId }, `Continued ${threadId}.`);
        }
        if (command === "review") {
          const workerThreadId = args.positional[0];
          if (!workerThreadId) return fail("review requires <worker-thread-id>");
          const result = await startReview(workerThreadId, args.one("focus"));
          return ok(result, `${result.created ? "Started" : "Using existing"} “${result.title}” in ${result.threadId}.`);
        }
        if (command === "jev-stats") {
          const rows = metricAbstention();
          if (!rows.length) return ok([], "No Jev scores recorded yet.");
          const width = Math.max(...rows.map((row) => row.metric.length));
          return ok(rows, [
            "dimension".padEnd(width) + "  samples  abstained  mean score",
            ...rows.map((row) => [
              row.metric.padEnd(width),
              String(row.samples).padStart(7),
              `${row.abstainedPercent}%`.padStart(9),
              (row.meanScore === null ? "—" : row.meanScore.toFixed(1)).padStart(10),
            ].join("  ")),
            "",
            "A dimension that rarely abstains on thin diffs is scoring what it cannot see.",
          ].join("\n"));
        }
        if (command === "complete") {
          const threadId = args.positional[0];
          if (!threadId) return fail("complete requires <thread-id>");
          const row = await markComplete(threadId, args.one("result"));
          return ok(toManaged(row), `Marked “${row.title}” complete.`);
        }
        return fail(`Unknown command “${command}”.`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  try {
    await reconcile();
  } catch (error) {
    bb.log.warn(`Initial reconciliation deferred: ${String(error)}`);
  }
  await jevStatus().catch((error) => bb.log.warn(`Could not read the Jev gate: ${String(error)}`));
  await plannerEnabled().catch((error) => bb.log.warn(`Could not read the planner setting: ${String(error)}`));
  const initial = await settings.get();
  if (initial.chiefProject) {
    void ensureChief(initial.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
  }
  bb.log.info("Chief supervisor loaded");
}
