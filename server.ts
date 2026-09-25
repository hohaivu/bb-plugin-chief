import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { forgeInitScript } from "./forge";

const SECTION_NAME = "Chief";
const RULES_FILE = "chief.md";
const RECONCILE_INTERVAL_MS = 30_000;
const MAX_ALERT_LENGTH = 3_000;
const MAX_RESULT_LENGTH = 8_000;
const MAX_PLAN_LENGTH = 64_000;
// ponytail: a nudge is 1–3 sentences; anything longer is new work for a fresh thread.
const MAX_NUDGE_LENGTH = 500;
// ponytail: arbitrary cap so a runaway plan can't schedule an unbounded worker chain.
const MAX_WAVES = 8;
// ponytail: done capped at 50, newest first
const MAX_DONE_ITEMS = 50;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const FORGE_CLI_TIMEOUT_MS = 10_000;
/** One wording for the reviewer's read-only rule, said when the review starts and
 * again on every continuation — the two places an edit instruction could arrive. */
const REVIEW_ONLY = "Remain review-only: do not modify files. A repair goes back to the worker, which then earns its own review.";
/** Same for a planner: said when the plan starts and again on every continuation. */
const PLAN_ONLY = "Remain read-only in the repository: do not create, modify, or delete any file it tracks. Submit the plan itself through chief_report's plan field, not as a file write. A worker implements the plan in its own worktree.";
/** Same for an advisor: said when the consult starts and again on every continuation. */
const ADVISE_ONLY = "Remain advisory: read code and run commands to reproduce the problem, but do not create, modify, or delete any file, commit, or push. Report your advice to Chief; a worker makes the change.";
/** Consecutive request_changes verdicts on one task before Chief must consult the advisor. */
const CONSULT_AFTER_REJECTIONS = 2;
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);

const execFileAsync = promisify(execFile);
const FORGE_SCRIPT_TIMEOUT_MS = 120_000;

type Forge = "github" | "gitlab";

/** Pulls the forge target (and, when the reference names its own repo, the repo
 * to pass alongside it) out of a PR number, an owner/repo#123 reference, or a
 * PR/MR URL. An explicit URL also names its forge, so callers don't need to
 * re-derive it from a repo checkout that may not even be the right one. */
function parsePullRequestRef(input: string): { target: string; repo: string | null; forge: Forge | null } {
  const githubUrl = input.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (githubUrl) return { target: githubUrl[3], repo: `${githubUrl[1]}/${githubUrl[2]}`, forge: "github" };
  const gitlabUrl = input.match(/\/([^/\s]+)\/([^/\s]+)\/-\/merge_requests\/(\d+)/);
  if (gitlabUrl) return { target: gitlabUrl[3], repo: `${gitlabUrl[1]}/${gitlabUrl[2]}`, forge: "gitlab" };
  const shortRef = input.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (shortRef) return { target: shortRef[2], repo: shortRef[1], forge: null };
  return { target: input.replace(/^#/, ""), repo: null, forge: null };
}

/** Best-effort: resolves a pull request reference to its head branch with
 * whichever forge CLI the repo uses, mirroring the detection in forgeInitScript.
 * An explicit URL's own forge wins; a bare number or owner/repo#123 reference
 * falls back to `git remote get-url origin` in the target project's own
 * checkout (cwd), never this process's own. Every subprocess is time-bounded,
 * and any failure — no remote, no CLI, no auth, an unrecognised reference, a
 * hung subprocess — returns null so the caller falls back to treating the
 * input as a plain branch name. */
async function resolvePullRequestBranch(pullRequest: string, cwd: string | null): Promise<string | null> {
  try {
    const { target, repo, forge } = parsePullRequestRef(pullRequest);
    let resolvedForge = forge;
    if (!resolvedForge) {
      const remote = cwd
        ? await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: FORGE_CLI_TIMEOUT_MS })
            .then((result) => result.stdout.trim())
            .catch(() => "")
        : "";
      resolvedForge = remote.includes("github.com") ? "github" : "gitlab";
    }
    if (resolvedForge === "github") {
      const args = ["pr", "view", target, "--json", "headRefName", "--jq", ".headRefName", ...(repo ? ["--repo", repo] : [])];
      const { stdout } = await execFileAsync("gh", args, { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS });
      return stdout.trim() || null;
    }
    const args = ["mr", "view", target, "-F", "json", ...(repo ? ["--repo", repo] : [])];
    const { stdout } = await execFileAsync("glab", args, { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS });
    const parsed = JSON.parse(stdout) as { source_branch?: string };
    return parsed.source_branch?.trim() || null;
  } catch {
    return null;
  }
}

const roleSchema = z.enum(["chief", "planner", "worker", "reviewer", "advisor"]);
/** What a spawn seeds into a thread's pluginMetadata, read back in bb.agents.configure.
 * insertThread runs only after threads.spawn resolves, so the very first configure()
 * call for a brand-new thread can land before that row exists; pluginMetadata is
 * seeded atomically at spawn time and survives that gap. Untrusted input, so parsed
 * defensively like everything else crossing this boundary. */
const spawnMetadataSchema = z.object({
  role: roleSchema,
  chiefThreadId: z.string().nullable().optional(),
});
/** A reviewer's structured judgement. Chief routes on this field instead of
 * parsing a ship-or-fix opinion out of the report prose. */
const verdictSchema = z.enum(["approve", "request_changes"]);
/** The role key chief_models stores a per-machine model pick under: the lifecycle roles. */
const modelRoleSchema = roleSchema;
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
      worker: modelSelectionSchema.nullable(),
      reviewer: modelSelectionSchema.nullable(),
      advisor: modelSelectionSchema.nullable(),
    }),
    /** Roles whose stored pick this machine can no longer serve, so spawns use BB's default. */
    unusable: z.array(modelRoleSchema),
  })),
});
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

const todoItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  action: z.string().nullable(),
  done: z.boolean(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

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

const delegateShape = z.object({
  title: z.string().trim().min(1).max(160).describe("Exact concise title for the worker thread."),
  mission: z.string().trim().min(1).max(12_000),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
  context: z.string().trim().max(12_000).optional(),
  branch: z.string().trim().min(1).max(300).optional().describe(
    "The task branch Chief already created and pushed. The worktree is based on it and the worker commits there. Omit to base the worktree on the project default.",
  ),
  issueUrl: z.string().trim().min(1).max(500).optional().describe("URL of the tracking issue Chief opened for this task, when the forge has issues."),
  prUrl: z.string().trim().min(1).max(500).optional().describe("URL of the draft pull request Chief opened from the task branch. The worker never marks it ready."),
  replaces: z.string().trim().min(1).optional().describe("A finished worker's thread id to hand off from: the new worker starts in that worker's worktree and branch, gets its latest review findings, and the old worker is marked complete."),
  planThreadId: z.string().trim().min(1).optional().describe("A planner thread that reported a wave schedule. Combined with wave, the plugin takes the plan file from that schedule."),
  wave: z.number().int().min(1).max(MAX_WAVES).optional().describe("1-based index into planThreadId's wave schedule."),
  unplannedReason: z.string().trim().min(1).max(300).optional().describe("Planning is on and this work skips chief_plan: a short reason why. Only for bounded work whose shape and cause are already known. Not needed with planThreadId/wave or replaces."),
});

const delegateParams = delegateShape.superRefine((value, ctx) => {
  if (value.unplannedReason && value.planThreadId) {
    ctx.addIssue({ code: "custom", path: ["unplannedReason"], message: "unplannedReason cannot be combined with planThreadId." });
  }
});

/** A planner is briefed on the same problem as a worker, minus the criteria and
 * constraints it is being asked to propose. */
const planParams = delegateShape.pick({ title: true, mission: true, context: true });

const consultParams = planParams.extend({
  workerThreadId: z.string().trim().min(1).optional().describe("The managed worker whose change keeps failing review: the advisor runs in its worktree and gets its brief, reviewer verdicts, and branch."),
});

const reviewParams = z.object({
  workerThreadId: z.string().trim().min(1).optional().describe("An existing managed worker's thread id."),
  pullRequest: z.string().trim().min(1).max(500).optional().describe(
    "A pull request to review when no managed worker owns it: a number, an owner/repo#123 reference, or a PR URL. Resolved to its head branch with gh or glab, falling back to the raw value as a branch name.",
  ),
  branch: z.string().trim().min(1).max(300).optional().describe("A branch to review when no managed worker owns it."),
  focus: z.string().trim().max(4_000).optional(),
}).refine((value) => [value.workerThreadId, value.pullRequest, value.branch].filter((v) => v !== undefined).length === 1, {
  message: "Give exactly one of workerThreadId, pullRequest, or branch.",
});

const stopParams = z.object({
  threadId: z.string().trim().min(1),
  reason: z.string().trim().max(1_000).optional().describe("Why it is being stopped: what the evidence shows it stuck on."),
});

const optionalReport = z.object({
  state: z.enum(["active", "idle", "failed"]),
  result: z.string().trim().max(MAX_RESULT_LENGTH).optional(),
  blocker: z.never().optional(),
  recommendation: z.string().trim().max(4_000).optional(),
});
const planWavesSchema = z.array(z.object({
  body: z.string().trim().min(1).max(MAX_PLAN_LENGTH),
})).min(1).max(MAX_WAVES);
const readyReport = z.object({
  state: z.literal("ready"),
  result: z.string().trim().min(1).max(MAX_RESULT_LENGTH),
  verdict: verdictSchema.optional().describe(
    "Required in a review thread: approve when the change can ship as it stands, request_changes when the worker must fix something. Workers leave this unset.",
  ),
  regression: z.boolean().optional().describe(
    "Reviewer only, with request_changes: true when the change introduced a new problem or regression that was not there before. Workers leave this unset.",
  ),
  plan: z.union([
    z.string().trim().min(1).max(MAX_PLAN_LENGTH),
    planWavesSchema,
  ]).optional().describe(
    "A planner's ready report requires this: either the full plan body as Markdown (one wave), or an array of up to 8 {body} waves. Chief receives each wave as its own file, not inline. No other role sets this.",
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
  pending: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ chief: z.boolean(), items: z.array(todoItemSchema), doneOmitted: z.number() }).strict(),
  },
});

interface TodoRow {
  id: number;
  project_id: string;
  text: string;
  after: string | null;
  state: "open" | "done" | "dropped";
  updated_at: number;
}

interface ManagedRow {
  thread_id: string;
  role: z.infer<typeof roleSchema>;
  branch: string | null;
  issue_url: string | null;
  pr_url: string | null;
  project_id: string;
  chief_thread_id: string | null;
  worker_thread_id: string | null;
  parent_thread_id?: string | null;
  title: string;
  state: z.infer<typeof stateSchema>;
  status: string | null;
  result: string | null;
  blocker: string | null;
  recommendation: string | null;
  verdict: z.infer<typeof verdictSchema> | null;
  /** Reviewer row only: the last request_changes verdict's regression flag, persisted so
   * nextAction (a pure function of ManagedRow) can see it on a later call, not just the
   * report() turn that set it. */
  regression: number | null;
  brief: string | null;
  active_since: number | null;
  active_cycle: number;
  reject_streak: number;
  stall_alerted_cycle: number | null;
  stop_alerted_cycle: number | null;
  lifecycle_alert_key: string | null;
  /** Planner row only: JSON `[{path}]`, the schedule a planner-ready report persisted. */
  plan_waves: string | null;
  /** Worker row only: the planner it was delegated from, with plan_wave, when planThreadId/wave was given. */
  plan_thread_id: string | null;
  plan_wave: number | null;
  /** Worker row only: the reason it was delegated without a plan while planning was on. */
  unplanned_reason: string | null;
  /** Incremented on every chief_report call from this row, regardless of role. */
  report_seq: number;
  /** Reviewer row only: the worker's report_seq this reviewer was started for —
   * the tie nextAction uses to know whether it already covers the worker's latest
   * report, instead of comparing updated_at timestamps. */
  reviewed_report_seq: number | null;
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
- Never reuse a worker for more work. Finishing skipped acceptance criteria, rebasing or restacking, or any new task goes to a fresh worker with chief_delegate replaces: — same worktree, branch, and pull request. chief_continue is only a short nudge to a thread that is still working.
- Escalate to the user only for genuine product or scope choices, missing permission or credentials, irreversible actions, or conflicting evidence that cannot be resolved safely.
- When escalating, lead with a recommendation, the evidence, and the smallest set of choices.
- A worker report is evidence, not proof. Start one independent review per run with chief_review when a worker's ready alert says to — after the final wave, or for a worker with no plan link — and read that reviewer's verdict before completing the work.
- When the user or a worker corrects a factual claim, verify it against the code before accepting the correction.
- Start extra reviews with chief_review — a worker's worktree, or a fresh one for a pull request or branch with no worker — whenever a change deserves a second pass.
- Keep thread titles literal and recognizable. Never invent codenames.
- Do not delete user threads. Mark managed work complete; let the user archive it when desired.`;

/** Planning is on by default: the plugin persists the planner's wave schedule and
 * names the exact next call, so Chief relays it without reading the plan itself. */
const PLANNER_CHIEF_INSTRUCTIONS =
  "Planning is on. Use chief_plan first for every new feature, multi-file change, or task whose design or cause is not already settled — a well-specified issue included. Order: chief_plan → chief_forge_init → chief_delegate. chief_delegate rejects a call without planThreadId and wave; only bounded work whose shape and cause are already known may skip the plan, with unplannedReason saying why. Its ready alert lists the wave schedule and the exact next call — delegate wave 1 right away without waiting for user sign-off, and without reading the plan file yourself. Escalate to the user only for a genuine product or scope open question that cannot be resolved from the code. A plan is never implementation: only a worker changes code.";

/** chief_roster's Pending block is the canonical work list; keep Chief calling it
 * at each turn start and after compaction instead of relying on memory. */
const ROSTER_CHIEF_INSTRUCTIONS =
  "Call chief_roster at the start of every turn, and again after any compaction, before acting: its Pending block is the current work list. Track every todo — including work the user queued that nobody has delegated yet — with chief_roster's `todo` field; never use Memory files, TodoWrite, or Task tools for Chief work. When work a todo tracks is finished, close that todo in the same turn with chief_roster todo { id, state: \"done\" }.";

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

function clip(value: string, limit = MAX_ALERT_LENGTH) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Like clip(), but elides the middle instead of the tail: a long brief's opening
 * (the mission) and its trailing sections (Context, where a plan file path now
 * lives) both survive the cut, instead of the tail-only clip() dropping whichever
 * section comes last. */
function clipMiddle(value: string, limit: number) {
  const marker = "\n…\n";
  if (value.length <= limit || limit <= marker.length) return clip(value, limit);
  const room = limit - marker.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
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
    // A reviewer's active_cycle counts every resume, not rejection rounds.
    // Consecutive request_changes verdicts need their own counter so an
    // unrelated resume can't misread as a deadlock.
    `ALTER TABLE managed_threads ADD COLUMN reject_streak INTEGER NOT NULL DEFAULT 0`,
    // Jev scoring is removed for cost reasons; its tables and settled state go with it.
    `DROP TABLE IF EXISTS jev_scores`,
    `DROP TABLE IF EXISTS jev_metric_stats`,
    `DELETE FROM plugin_meta WHERE key='jev_verified'`,
    // Child threads spawned by Chief or filed under Chief track their parent thread.
    `ALTER TABLE managed_threads ADD COLUMN parent_thread_id TEXT`,
    // Admitting the advisor role means widening two CHECK constraints again, and
    // SQLite still cannot drop one. Same rebuild pattern as managed_threads_v2 /
    // chief_models_v3 above: column order matches the live table, ALTER-added
    // columns last, which is what SELECT * relies on.
    `CREATE TABLE managed_threads_v3 (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor')),
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
      brief TEXT,
      reject_streak INTEGER NOT NULL DEFAULT 0,
      parent_thread_id TEXT
    )`,
    `INSERT INTO managed_threads_v3 SELECT * FROM managed_threads`,
    `DROP TABLE managed_threads`,
    `ALTER TABLE managed_threads_v3 RENAME TO managed_threads`,
    // Dropping the table dropped its index with it.
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    `CREATE TABLE chief_models_v4 (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','junior','senior','reviewer','advisor')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    `INSERT INTO chief_models_v4 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v4 RENAME TO chief_models`,
    // The hard stall alert (2x stallMinutes) fires once per active cycle, like the soft one.
    `ALTER TABLE managed_threads ADD COLUMN stop_alerted_cycle INTEGER`,
    // Persisted wave schedule (planner row) and the link a worker delegated from it carries.
    `ALTER TABLE managed_threads ADD COLUMN plan_waves TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN plan_thread_id TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN plan_wave INTEGER`,
    // A reviewer's regression flag, so nextAction can see it on a later call too.
    `ALTER TABLE managed_threads ADD COLUMN regression INTEGER`,
    // A monotonic per-row report counter and a reviewer's snapshot of the worker's
    // count at spawn time — a robust (not timestamp-based) tie between a reviewer
    // and the exact report it covers, immune to same-millisecond collisions and to
    // the reviewer later completing.
    `ALTER TABLE managed_threads ADD COLUMN report_seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE managed_threads ADD COLUMN reviewed_report_seq INTEGER`,
    // Worker row only: the reason a delegation skipped chief_plan while planning was on.
    `ALTER TABLE managed_threads ADD COLUMN unplanned_reason TEXT`,
    // Chief's own todos, per project so they survive replacement Chiefs.
    `CREATE TABLE IF NOT EXISTS chief_todos (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, text TEXT NOT NULL, after TEXT, state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','dropped')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS chief_todos_project ON chief_todos (project_id, state, id)`,
    // One worker type: senior picks carry over as worker; junior picks are dropped.
    `CREATE TABLE chief_models_v5 (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role))`,
    `INSERT INTO chief_models_v5 (host_id, role, provider_id, model, reasoning_level, updated_at) SELECT host_id, CASE role WHEN 'senior' THEN 'worker' ELSE role END, provider_id, model, reasoning_level, updated_at FROM chief_models WHERE role <> 'junior'`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v5 RENAME TO chief_models`,
];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chiefProject: { type: "project", label: "Default Chief project" },
    stallMinutes: { type: "string", label: "Stall threshold (minutes)", default: "15" },
    plannerEnabled: {
      type: "boolean",
      label: "Plan before delegating",
      description: "Lets Chief send work to a read-only planner first, read the plan, and delegate it.",
      default: true,
    },
    autoSpawn: {
      type: "boolean",
      label: "Auto-spawn Chief",
      description: "Automatically start a Chief supervisor when BB opens, the default project changes, or an active project Chief is missing.",
      default: false,
    },
    cascadeArchive: {
      type: "boolean",
      label: "Archive managed threads with their Chief",
      description: "Planners, workers, reviewers, and advisors started while this is on are archived when their Chief is archived — and deleted when it is deleted, worktrees included. Ownership is fixed at start: threads already running keep their current behavior, and a replacement Chief does not inherit the children of the one it replaced.",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const allRows = db.prepare(`SELECT * FROM managed_threads ORDER BY created_at ASC, rowid ASC`);
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
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id=? AND state NOT IN ('complete','archived','deleted') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  // Unlike existingReview, this is not filtered by state: nextAction's dedup must
  // still find a reviewer that has since completed, so a completed reviewer that
  // already covered the worker's latest report does not bring back a spurious
  // chief_review recommendation.
  const latestReviewForWorker = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const existingBranchReview = db.prepare<[string, string]>(
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id IS NULL AND project_id=? AND branch=? AND state NOT IN ('complete','archived','deleted') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const pendingAlerts = db.prepare(
    `SELECT * FROM alert_outbox WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT 100`,
  );
  const roleModelRow = db.prepare<[string, string]>(
    `SELECT provider_id, model, reasoning_level FROM chief_models WHERE host_id=? AND role=?`,
  );
  const todosForProject = db.prepare<[string]>(
    `SELECT * FROM chief_todos WHERE project_id=? AND state='open' ORDER BY id ASC`,
  );
  const closedTodosForProject = db.prepare<[string]>(
    `SELECT * FROM chief_todos WHERE project_id=? AND state<>'open' ORDER BY id ASC`,
  );
  const todoById = db.prepare<[number, string]>(`SELECT * FROM chief_todos WHERE id=? AND project_id=?`);
  const insertTodo = db.prepare<[string, string, string | null, number, number]>(
    `INSERT INTO chief_todos (project_id, text, after, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const updateTodo = db.prepare<[string, string | null, string, number, number, string]>(
    `UPDATE chief_todos SET text=?, after=?, state=?, updated_at=? WHERE id=? AND project_id=?`,
  );
  let roles = new Map<string, ManagedRow>();
  let plannerActive = false;
  const rulesCache = new Map<string, string>();
  const alertDeliveries = new Map<string, Promise<boolean>>();
  const reviewStarts = new Map<string, Promise<{ threadId: string; title: string; workerThreadId: string | null; created: boolean }>>();

  let pendingReady = false; // set once everything pendingSnapshot() touches is initialised
  let publishedPending: string | null = null; // ponytail: in-memory dedupe; lost on reload → one extra signal
  const liveSeen = new Set<string>(); // threads whose live BB status this process has observed
  const load = () => new Map((allRows.all() as ManagedRow[]).map((row) => [row.thread_id, row]));
  /** Completes supporting rows whose work was absorbed: reviewers and advisors of a complete
   * worker, and a planner once its final wave is complete and every linked worker is terminal.
   * Idempotent; rows whose live status is busy or not yet observed this process are left alone
   * and swept on the reload after they are seen idle. */
  function completeAbsorbed() {
    const terminal = (state: string) => ["complete", "archived", "deleted"].includes(state);
    const rows = [...roles.values()];
    const ids = rows.filter((row) => {
      if (terminal(row.state) || BUSY_STATUSES.has(row.state)) return false;
      if (!liveSeen.has(row.thread_id) || !row.status || BUSY_STATUSES.has(row.status)) return false;
      if (row.role === "reviewer" || row.role === "advisor") {
        return !!row.worker_thread_id && roles.get(row.worker_thread_id)?.state === "complete";
      }
      if (row.role !== "planner" || !row.plan_waves) return false;
      const waves = planWavesFor(row.thread_id).length;
      const linked = rows.filter((other) => other.role === "worker" && other.plan_thread_id === row.thread_id);
      return linked.some((w) => w.plan_wave === waves && w.state === "complete") && linked.every((w) => terminal(w.state));
    }).map((row) => row.thread_id);
    if (!ids.length) return 0;
    const now = Date.now();
    const complete = db.prepare<[number, string]>(`UPDATE managed_threads SET state='complete', active_since=NULL, updated_at=? WHERE thread_id=?`);
    db.transaction(() => { for (const id of ids) complete.run(now, id); })();
    return ids.length;
  }
  function reloadRoles() {
    roles = load();
    if (!pendingReady) return;
    // ponytail: sweeps on every reload, O(planners × rows); index by plan_thread_id if rosters grow large.
    if (completeAbsorbed()) roles = load();
    // ponytail: recomputes every Chief's Pending block per reload; debounce if rosters grow large.
    const next = JSON.stringify(pendingSnapshot());
    if (next !== publishedPending) {
      publishedPending = next;
      bb.realtime.publish("pending", null);
    }
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
    parentThreadId?: string | null;
    title: string;
    state?: ManagedRow["state"];
    status?: string | null;
    brief?: string | null;
    branch?: string | null;
    issueUrl?: string | null;
    prUrl?: string | null;
    planThreadId?: string | null;
    planWave?: number | null;
    reviewedReportSeq?: number | null;
    unplannedReason?: string | null;
  }) {
    const now = Date.now();
    if (input.status) liveSeen.add(input.threadId);
    db.prepare(`INSERT INTO managed_threads (
      thread_id, role, project_id, chief_thread_id, worker_thread_id, parent_thread_id, title,
      state, status, brief, branch, issue_url, pr_url, plan_thread_id, plan_wave, reviewed_report_seq, unplanned_reason, active_since, active_cycle, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role, project_id=excluded.project_id,
      chief_thread_id=excluded.chief_thread_id, worker_thread_id=excluded.worker_thread_id,
      parent_thread_id=COALESCE(excluded.parent_thread_id, managed_threads.parent_thread_id),
      title=excluded.title, state=excluded.state, status=excluded.status,
      brief=excluded.brief, branch=excluded.branch, issue_url=excluded.issue_url, pr_url=excluded.pr_url,
      plan_thread_id=excluded.plan_thread_id, plan_wave=excluded.plan_wave,
      reviewed_report_seq=excluded.reviewed_report_seq, unplanned_reason=excluded.unplanned_reason,
      updated_at=excluded.updated_at`).run(
      input.threadId, input.role, input.projectId, input.chiefThreadId ?? null,
      input.workerThreadId ?? null, input.parentThreadId ?? null, input.title, input.state ?? "starting",
      input.status ?? "starting", input.brief ?? null, input.branch ?? null,
      input.issueUrl ?? null, input.prUrl ?? null, input.planThreadId ?? null, input.planWave ?? null,
      input.reviewedReportSeq ?? null, input.unplannedReason ?? null,
      input.state === "active" ? now : null,
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
  // Spread into child spawns only; BB cascades archive/delete from the owner.
  async function lifecycleOwner(chiefThreadId: string | null) {
    return chiefThreadId && (await settings.get()).cascadeArchive ? { lifecycleOwnerThreadId: chiefThreadId } : {};
  }

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

  /** The target project's own local checkout path, or null when unknown. */
  async function projectPath(projectId: string) {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source?.path ?? null;
    } catch (error) {
      bb.log.warn(`Could not resolve the checkout path for ${projectId}: ${String(error)}`);
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
      "When chief_plan is available, implementation work goes plan → forge → delegate: chief_plan, then chief_forge_init, then chief_delegate with the planThreadId and wave its ready alert names; chief_delegate refuses anything else unless it is bounded work of known shape and cause that you pass unplannedReason for. Without chief_plan, use chief_delegate directly. Inspect reports and live thread evidence with chief_inspect, continue safe work, and mark work complete only after verification.",
      "You own the forge for every delegation: run chief_forge_init, and pass the branch, issueUrl and prUrl it returns to chief_delegate — if it returns a script instead, run it from the project checkout and use the CHIEF_FORGE line it prints. Mark the pull request ready only after the work is verified and reviewed. The chief skill's Git workflow section has the rest.",
      "A worker's ready alert names the next call: an intermediate wave hands off to the next wave with no review in between; the final wave, or a worker with no plan link, tells you to start the one review of the whole run with chief_review, whose reviewer reports back here. Wait for that verdict before completing the work, and use chief_review yourself for any further pass you want — including a pull request or branch with no managed worker.",
      "Lifecycle alerts are prompts to decide: continue, review, complete, or escalate. Escalate genuine product, scope, permission, credential, or irreversible decisions here to the user with your recommendation.",
      "", "Acknowledge the operating rules you were given briefly, call chief_roster for the current work list, and wait for work.",
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
    void pinPendingTab(thread.id);
    return { threadId: thread.id, created: true as const };
  }

  /** Best-effort: appends the pending panel tab to a Chief thread once. Never throws. */
  async function pinPendingTab(threadId: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { revision, tabs } = await bb.sdk.threads.tabs.get({ threadId });
        if (tabs.some((tab) => tab.kind === "plugin-panel" && tab.pluginId === bb.pluginId && tab.actionId === "pending")) return;
        await bb.sdk.threads.tabs.update({
          threadId, expectedRevision: revision,
          tabs: [...tabs, {
            // Must match the host's id so opening the action finds this tab: get-bb/bb
            // packages/client-core/src/panel/fixed-panel-tabs-state.ts buildFixedPanelTabId.
            kind: "plugin-panel", id: `plugin-panel:${encodeURIComponent(`${bb.pluginId}:pending:`)}:none`, pluginId: bb.pluginId,
            actionId: "pending", title: "Chief to-do", paramsJson: null,
          }],
        });
        return;
      } catch (error) {
        // ponytail: retries any error once, not only revision conflicts
        if (attempt === 1) bb.log.warn(`Could not pin the pending tab on ${threadId}: ${String(error)}`);
      }
    }
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

  /** A plan is read-only work in the project's own checkout: no worktree is spent
   * until Chief has read the plan and chosen to delegate it. */
  async function startPlan(params: z.infer<typeof planParams>, callerThreadId?: string | null) {
    if (!(await plannerEnabled())) {
      throw new Error("Planning is off. Turn on “Plan before delegating” in Chief's settings, or delegate this work directly.");
    }
    const { chief, projectId } = await owningChief(callerThreadId);
    const sectionId = await ensureSection();
    // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
    // the rules into every planner turn, so the spawn prompt does not repeat them.
    await readRules(projectId);
    const title = `Plan · ${params.title.replace(/^Plan · /, "")}`;
    const prompt = [
      `You are the managed planner for “${params.title}”. Report to Chief thread ${chief.thread_id}.`,
      "", "## Problem", params.mission,
      ...(params.context ? ["", "## Context", params.context] : []),
      "", "## Working contract",
      "- Read every file this brief names in full before proposing anything: no partial reads, no limit or offset. Then trace the real flow through the code this change would touch — a plan naming the wrong files is worse than no plan.",
      `- ${PLAN_ONLY}`,
      "- Write the full plan as Markdown: the files and functions to change, the steps in order, real constraints, and the risks.",
      "- Report with chief_report state ready, passing the plan through chief_report's `plan` field: an array of `{body}` per wave, or a single string for one wave. Its result is a short summary, not the plan: the goal, the files to touch, the ordered steps as one line each, and the \"What we're NOT doing\" headline. Chief receives each wave as its own file.",
      "- Split success criteria per wave into Automated Verification (a command a worker can run, reported with its exit status) and Manual Verification (what only a human can confirm).",
      "- Split the work into at most 8 sequential waves, each a self-contained plan one worker finishes on the same branch; one wave by default, more only when one worker cannot finish it. Submit `plan` as an array of `{body}`. Waves contain no phases.",
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
      ...(await lifecycleOwner(chief.thread_id)),
      prompt,
      pluginMetadata: { role: "planner", chiefThreadId: chief.thread_id },
    });
    insertThread({ threadId: thread.id, role: "planner", projectId, chiefThreadId: chief.thread_id, parentThreadId: chief.thread_id, title, state: "starting", status: thread.status });
    return { threadId: thread.id, title, projectId };
  }

  /** A consult is read-only, like a review: with a worker it reuses that
   * worker's worktree so the advisor can reproduce the failing change; without
   * one it runs in the project's own checkout, like a plan. */
  async function startConsult(params: z.infer<typeof consultParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await owningChief(callerThreadId);
    const worker = params.workerThreadId ? roles.get(params.workerThreadId) : undefined;
    if (params.workerThreadId && (!worker || worker.role !== "worker" || !belongsToChief(worker, chief.thread_id))) {
      throw new Error(`No managed worker ${params.workerThreadId} for this Chief.`);
    }
    let workerLive: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
    if (worker) {
      workerLive = await bb.sdk.threads.get({ threadId: worker.thread_id });
      if (BUSY_STATUSES.has(workerLive.status)) throw new Error(`Worker ${worker.thread_id} is ${workerLive.status}; wait until it is idle before starting a consult.`);
      if (workerLive.deletedAt !== null || workerLive.archivedAt !== null) throw new Error(`Worker ${worker.thread_id} is not consultable.`);
      if (!workerLive.environmentId) throw new Error(`Worker ${worker.thread_id} has no reusable environment.`);
    }
    const sectionId = await ensureSection();
    // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
    // the rules into every advisor turn, so the spawn prompt does not repeat them.
    await readRules(projectId);
    const title = `Consult · ${params.title.replace(/^Consult · /, "")}`;
    const reviews = worker ? taskReviews(worker) : [];
    const prompt = [
      `You are the managed advisor for “${params.title}”. Report to Chief thread ${chief.thread_id}.`,
      "You are a strategic advisor and debugger of last resort: find the root cause and the smallest credible way forward.",
      "", "## Question", params.mission,
      ...(params.context ? ["", "## Context", params.context] : []),
      ...(worker ? [
        ...(worker.brief ? [
          "", "## The brief this work was given", clipMiddle(worker.brief, 4_000),
        ] : []),
        ...(reviews.length ? [
          "", "## Reviewer verdicts",
          ...reviews.flatMap((review) => [
            `Verdict: ${review.verdict} (${review.thread_id})`, clip(review.result ?? "", 300),
            `Full report and last output: bb chief inspect ${review.thread_id}`,
          ]),
        ] : []),
        "", "## Branch and diff",
        `Branch: ${worker.branch ?? "the project default base"}`,
        ...(worker.pr_url ? [`Pull request: ${worker.pr_url}`] : []),
        "This worktree holds the change: read it with git diff against its base.",
        ...(worker.result ? [clip(worker.result, 300), `Full report and last output: bb chief inspect ${worker.thread_id}`] : []),
      ] : []),
      "", "## Working contract",
      `- ${ADVISE_ONLY}`,
      "- Read every file this brief names in full before concluding anything: no partial reads, no limit or offset.",
      "- Reproduce before concluding: run the failing test or command, and quote the command and its exit status.",
      "- A ready report gives the root cause, the evidence, what earlier rounds missed, and the recommended next step for a fresh worker.",
      "- A blocked report must include the blocker and your recommended decision or next action.",
      "- Do not ask the user directly from this thread. Chief decides whether a question needs escalation.",
    ].join("\n");
    const hostId = worker ? await environmentHostId(workerLive!.environmentId!) : await projectHostId(projectId);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: worker
        ? { type: "reuse", environmentId: workerLive!.environmentId! }
        : { type: "project-default" },
      sectionId,
      parentThreadId: chief.thread_id,
      visibility: "visible",
      title,
      ...(await execution("advisor", hostId)),
      ...(await lifecycleOwner(chief.thread_id)),
      prompt,
      pluginMetadata: { role: "advisor", chiefThreadId: chief.thread_id },
    });
    insertThread({
      threadId: thread.id, role: "advisor", projectId, chiefThreadId: chief.thread_id,
      workerThreadId: worker?.thread_id ?? null, parentThreadId: chief.thread_id, title,
      state: "starting", status: thread.status,
    });
    return { threadId: thread.id, title, projectId };
  }

  async function delegate(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await owningChief(callerThreadId);
    const prior = params.replaces ? roles.get(params.replaces) : undefined;
    if (params.replaces && (!prior || prior.role !== "worker" || !belongsToChief(prior, chief.thread_id) || prior.project_id !== projectId)) {
      throw new Error(`No managed worker ${params.replaces} for this Chief.`);
    }
    let priorLive: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
    if (prior) {
      priorLive = await bb.sdk.threads.get({ threadId: prior.thread_id });
      if (BUSY_STATUSES.has(priorLive.status)) throw new Error(`Worker ${prior.thread_id} is ${priorLive.status}; wait until it is idle before replacing it.`);
      if (priorLive.deletedAt !== null || priorLive.archivedAt !== null) throw new Error(`Worker ${prior.thread_id} is not replaceable.`);
      if (!priorLive.environmentId) throw new Error(`Worker ${prior.thread_id} has no reusable environment.`);
      if (params.branch && params.branch !== prior.branch) throw new Error(`replaces: ${prior.thread_id} carries branch ${prior.branch}; pass no --branch or the same one.`);
    }
    const branch = prior ? prior.branch ?? undefined : params.branch;
    const issueUrl = params.issueUrl ?? (prior ? prior.issue_url ?? undefined : undefined);
    const prUrl = params.prUrl ?? (prior ? prior.pr_url ?? undefined : undefined);
    // With replaces: and no explicit wave, the new worker inherits the prior worker's
    // plan link — a fix worker after the final review still reads as "final wave".
    let planThreadId = params.planThreadId;
    let wave = params.wave;
    if (planThreadId === undefined && wave === undefined && prior?.plan_thread_id && prior.plan_wave != null) {
      planThreadId = prior.plan_thread_id;
      wave = prior.plan_wave;
    }
    // The schema only sees params.planThreadId; a replaces: inherited one must be checked here too.
    if (planThreadId !== undefined && params.unplannedReason) {
      throw new Error("unplannedReason cannot be combined with planThreadId.");
    }
    // Planning on means every new delegation starts from a plan wave. replaces: hands off
    // an already-gated delegation, so it passes; the escape hatch must say why.
    if (planThreadId === undefined && !prior && !params.unplannedReason && await plannerEnabled()) {
      throw new Error("Planning is on: call chief_plan first, then delegate its waves with planThreadId and wave. Only bounded work whose shape and cause are already known may skip the plan — pass unplannedReason (CLI: --unplanned-reason) with a short reason why.");
    }
    const unplannedReason = params.unplannedReason ?? (planThreadId === undefined ? prior?.unplanned_reason ?? undefined : undefined);
    let planPath: string | undefined;
    let waveTotal: number | undefined;
    if (planThreadId !== undefined) {
      const planner = roles.get(planThreadId);
      if (!planner || planner.role !== "planner" || !belongsToChief(planner, chief.thread_id)) {
        throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      }
      const waves = planWavesFor(planThreadId);
      if (wave === undefined || wave < 1 || wave > waves.length) {
        throw new Error(`Wave ${wave ?? "?"} is out of range: planner ${planThreadId} scheduled ${waves.length} wave(s).`);
      }
      const scheduled = waves[wave - 1]!;
      planPath = scheduled.path;
      waveTotal = waves.length;
    }
    // One task branch carries one active worker: a second worktree cannot check out a
    // branch another one already holds, and the spawn would fail with a raw git error.
    const holder = branch
      ? [...roles.values()].find((row) => row.role === "worker" && row.state !== "complete"
        && row.project_id === projectId && row.branch === branch && row.thread_id !== params.replaces)
      : undefined;
    if (holder) {
      throw new Error(`Branch ${branch} already carries the active worker “${holder.title}” (${holder.thread_id}). Complete that worker, or give this delegation its own branch and pull request.`);
    }
    const sectionId = await ensureSection();
    // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
    // the rules into every worker turn, so the spawn prompt does not repeat them.
    await readRules(projectId);
    const planContextLine = planPath !== undefined ? `Plan file (wave ${wave} of ${waveTotal}): ${planPath}` : undefined;
    const context = [params.context, planContextLine].filter((value): value is string => Boolean(value)).join("\n\n") || undefined;
    const render = (mission: string, contextText?: string) => [
      "## Mission", mission,
      "", "## Success criteria", bullets(params.successCriteria),
      "", "## Constraints", bullets(params.constraints),
      ...(contextText ? ["", "## Context", contextText] : []),
    ].join("\n");
    const brief = render(params.mission, context);
    // The reviewer gets the same sections, with a long mission or context clipped —
    // it judges against the criteria and constraints, which stay in full.
    const reviewerBrief = render(clip(params.mission, 1_500), context && clipMiddle(context, 1_500));
    // Read before the reviewer row is re-pointed below, so a `replaces` chain always
    // hands the fresh worker the review that prompted the handoff.
    const findings = prior ? existingReview.get(prior.thread_id) as ManagedRow | undefined : undefined;
    const prompt = [
      `You are the managed worker for “${params.title}”. Report to Chief thread ${chief.thread_id}.`,
      "", brief,
      ...(findings?.result ? [
        "", `## Review findings to fix (${findings.thread_id})`,
        `Verdict: ${findings.verdict ?? "none"}`, clip(findings.result, 300),
        `Full report and last output: bb chief inspect ${findings.thread_id}`,
        ...(findings.recommendation ? [`Recommendation: ${clip(findings.recommendation, 600)}`] : []),
      ] : []),
      ...(wave !== undefined && waveTotal !== undefined ? [
        "", "## Wave",
        `Wave ${wave} of ${waveTotal}. Implement only this wave's plan file. Name "Wave ${wave} of ${waveTotal}" in your ready result.`,
        wave < waveTotal ? "No review runs after this wave." : "Your ready report leads to the one review of the whole run.",
      ] : []),
      ...(branch || issueUrl || prUrl ? [
        "", "## Git workflow",
        ...(branch ? [`Your worktree is based on ${branch}. Check that branch out and commit your work there.`] : []),
        ...(prior ? [`This worktree already holds the previous worker's changes (${prior.thread_id}); continue from them. Its last report: bb chief inspect ${prior.thread_id}`] : []),
        ...(issueUrl ? [`Tracking issue: ${issueUrl}`] : []),
        ...(prUrl ? [`Draft pull request: ${prUrl}`] : []),
        "Do not create, merge, or mark ready any pull request — Chief owns the forge. Commit and push your work, then report ready.",
      ] : []),
      "", "## Working contract",
      "- Read every file this brief names in full before acting or spawning anything: no partial reads, no limit or offset. When the context above names a plan file, read that file in full too before starting.",
      "- Own the requested outcome in this worktree. Keep scope narrow and verify the user journey or closest executable seam.",
      "- Use chief_report with state ready and a non-empty result when your work is ready for Chief's verification. Only Chief can mark it complete.",
      "- A ready result names changed files by file:line, then splits verification into Automated (the command you ran and its exit status) and Manual (what only a human can confirm).",
      "- A blocked report must include the blocker and your recommended decision or next action.",
      "- Do not ask the user directly from this thread. Chief decides whether a question needs escalation.",
    ].join("\n");
    const hostId = prior ? await environmentHostId(priorLive!.environmentId!) : await defaultHostId();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: prior
        ? { type: "reuse", environmentId: priorLive!.environmentId! }
        : {
          type: "host",
          hostId: hostId as string,
          workspace: {
            type: "managed-worktree",
            baseBranch: branch ? { kind: "named" as const, name: branch } : { kind: "default" as const },
          },
        },
      sectionId,
      parentThreadId: chief.thread_id,
      visibility: "visible",
      title: params.title,
      ...(await execution("worker", hostId)),
      ...(await lifecycleOwner(chief.thread_id)),
      prompt,
      pluginMetadata: { role: "worker", chiefThreadId: chief.thread_id },
    });
    insertThread({
      threadId: thread.id, role: "worker", projectId, chiefThreadId: chief.thread_id, parentThreadId: chief.thread_id, title: params.title,
      state: "starting", status: thread.status, brief: reviewerBrief,
      branch, issueUrl, prUrl, planThreadId, planWave: wave, unplannedReason,
    });
    if (prior) {
      const now = Date.now();
      db.transaction(() => {
        db.prepare(`UPDATE managed_threads SET state='complete', active_since=NULL, updated_at=? WHERE thread_id=?`).run(now, prior.thread_id);
        // Reset the snapshot too: it was tied to the prior worker's report_seq, and the
        // fresh worker restarts its own count from 0, so a stale value here could
        // coincidentally match a future report and wrongly suppress its review.
        db.prepare(`UPDATE managed_threads SET worker_thread_id=?, reviewed_report_seq=NULL, updated_at=? WHERE role='reviewer' AND worker_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(thread.id, now, prior.thread_id);
      })();
      reloadRoles();
    }
    return { threadId: thread.id, title: params.title, projectId };
  }

  async function continueThread(threadId: string, instruction: string, callerChiefThreadId?: string | null) {
    const row = roles.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker, planner, reviewer, or advisor ${threadId}.`);
    const callerChief = callerChiefThreadId ? roles.get(callerChiefThreadId) : undefined;
    const effectiveChiefId = (callerChief && callerChief.role === "chief")
      ? callerChief.thread_id
      : (row.chief_thread_id ?? undefined);
    const handoff = `Hand it to a fresh worker instead: chief_delegate (replaces: ${threadId}) keeps the same worktree, branch, and pull request.`;
    if (row.role === "worker" && (row.state === "ready" || row.state === "complete")) {
      throw new Error(`Worker ${threadId} already reported ${row.state}. chief_continue never reuses a finished worker for more work — deferred acceptance criteria, a rebase or restack, or a new task. ${handoff}`);
    }
    if (instruction.trim().length > MAX_NUDGE_LENGTH) {
      throw new Error(`chief_continue is a short nudge of at most ${MAX_NUDGE_LENGTH} characters to a thread that is still working. ${row.role === "worker" ? handoff : rerouteSteps(row)}`);
    }
    // Planners, reviewers, and advisors all stay out of the files; only a worker
    // edits. The instruction leads so consecutive continuations differ from their
    // first character in the BB queue preview, instead of both starting with the
    // same read-only reminder.
    const reminder = ({ reviewer: REVIEW_ONLY, planner: PLAN_ONLY, advisor: ADVISE_ONLY } as Partial<Record<ManagedRow["role"], string>>)[row.role] ?? null;
    const text = reminder ? `${instruction}\n\n${reminder}` : instruction;
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
      senderThreadId: effectiveChiefId,
    });
    const now = Date.now();
    db.prepare(`UPDATE managed_threads SET state='active', chief_thread_id=?, blocker=NULL, recommendation=NULL, verdict=NULL,
      active_since=?, active_cycle=active_cycle+1, stall_alerted_cycle=NULL, updated_at=? WHERE thread_id=?`).run(
      effectiveChiefId ?? null, now, now, threadId,
    );
    reloadRoles();
    return roles.get(threadId)!;
  }

  /** A worker's linked planner's persisted wave schedule, or [] when unlinked. */
  function planWavesFor(planThreadId: string | null): { path: string }[] {
    if (!planThreadId) return [];
    const planner = roles.get(planThreadId);
    return planner?.plan_waves ? (JSON.parse(planner.plan_waves) as { path: string }[]) : [];
  }

  /** A ready worker's exact next call: the next wave (no review runs between waves), or
   * the one review of the whole run once the schedule's last wave is ready — or, with no
   * plan link at all, the same review call. */
  function workerReadyNextStep(row: ManagedRow): string {
    const waves = planWavesFor(row.plan_thread_id);
    if (row.plan_thread_id && row.plan_wave != null && row.plan_wave < waves.length) {
      const next = waves[row.plan_wave]!;
      return `Wave ${row.plan_wave} of ${waves.length} is ready. Once it is idle, delegate wave ${row.plan_wave + 1}: ${next.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave + 1}, replaces: ${row.thread_id}). Do not review between waves.`;
    }
    return `Start its review now: chief_review (workerThreadId: ${row.thread_id}). Complete the work only on the reviewer's approve.`;
  }

  /** A row's single pending call, reused identically in report()'s alert and
   * chief_roster's Pending block so the two surfaces never disagree. Purely a
   * function of already-persisted row state — no new columns, no new tracking. */
  function nextAction(row: ManagedRow): string | null {
    if (row.state === "blocked") return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user.`;
    if (row.state !== "ready") return null;
    if (row.role === "planner") {
      if (!row.plan_waves) return null;
      const delegated = [...roles.values()].some((other) => other.role === "worker" && other.plan_thread_id === row.thread_id);
      return delegated ? null : `Delegate wave 1 now: chief_delegate (planThreadId: ${row.thread_id}, wave: 1). The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.`;
    }
    if (row.role === "worker") {
      // A reviewer that still covers this worker's latest report — either busy
      // (a review is actually in flight) or already reported on it — means its own
      // recommendation (below) covers this work now, so the worker itself must not
      // also ask for a review. The tie is report_seq equality, not updated_at: two
      // reports in the same millisecond are indistinguishable by timestamp, and a
      // reviewer that later completes (state moves to complete) must still count.
      // A re-pointed stale reviewer (delegate's `replaces:`) has its snapshot reset
      // to null, so it no longer matches and this still recommends chief_review.
      const reviewer = latestReviewForWorker.get(row.thread_id) as ManagedRow | undefined;
      if (reviewer && reviewer.reviewed_report_seq === row.report_seq) return null;
      return workerReadyNextStep(row);
    }
    if (row.role === "advisor") {
      return `The advisor changed nothing. Decide the next step yourself: hand its advice to a fresh worker with chief_delegate${row.worker_thread_id ? ` (replaces: ${row.worker_thread_id})` : " (through chief_plan first when planning is on)"} with the advice in its context, or escalate to the user if it names a genuine decision.`;
    }
    if (row.role !== "reviewer" || !row.verdict) return null;
    // replaces: re-pointed this reviewer to a fresh worker (snapshot reset to null): its findings were handed off.
    if (row.worker_thread_id && row.reviewed_report_seq === null) return null;
    // A worker independently marked complete already absorbed this reviewer's verdict.
    if (row.worker_thread_id && roles.get(row.worker_thread_id)?.state === "complete") return null;
    if (row.verdict === "approve") return "The reviewer approves. Complete this work, then mark the pull request ready.";
    if (row.reject_streak >= CONSULT_AFTER_REJECTIONS) {
      return `The reviewer still requires changes after ${row.reject_streak} consecutive rounds. This pair is not converging. Before starting another worker round, call chief_consult${row.worker_thread_id ? ` (workerThreadId: ${row.worker_thread_id})` : " with this branch and review in its context"} — it attaches the brief, the reviewer verdicts, and the branch — and act on its advice. If an earlier consult's advice already failed, or the disagreement is a genuine decision, escalate to the user with both positions and your recommendation instead of funding another round.`;
    }
    if (row.regression) {
      return `The reviewer reports this change introduced a new problem. Before starting another worker round, call chief_consult${row.worker_thread_id ? ` (workerThreadId: ${row.worker_thread_id})` : " with this branch and review in its context"} — it attaches the brief, the reviewer verdicts, and the branch — and act on its advice. If an earlier consult's advice already failed, or the disagreement is a genuine decision, escalate to the user with both positions and your recommendation instead of funding another round.`;
    }
    return row.worker_thread_id
      ? `The reviewer requires changes. Hand the fix to a fresh worker with chief_delegate (replaces: ${row.worker_thread_id}); its findings are attached automatically. Escalate if the disagreement is a genuine decision.`
      : "The reviewer requires changes. Continue the worker with the specific fixes, or escalate if the disagreement is a genuine decision.";
  }

  /** The one open/done test: the panel's unchecked items are exactly Pending's actions plus work
   * still in progress. A worker is open until complete; a planner, reviewer, or advisor only while
   * it runs or names a next action. */
  function isOpenItem(row: ManagedRow) {
    if (["complete", "archived", "deleted"].includes(row.state)) return false;
    return row.role === "worker" || BUSY_STATUSES.has(row.state) || nextAction(row) !== null;
  }

  /** Shared reviewer prompt: REVIEW_ONLY and the chief_report/verdict contract are
   * identical for a worker's reviewer and a branch/PR reviewer. Only the subject
   * line and provenance section (worker brief/result, or nothing for a branch/PR
   * with no worker) differ. */
  function reviewerPrompt(opts: {
    subject: string;
    chiefThreadId: string | null;
    focus?: string;
    provenance: string[];
  }) {
    return [
      opts.subject,
      opts.focus ? `Review focus: ${opts.focus}` : "Review for correctness, regressions, validation quality, and unnecessary complexity.",
      REVIEW_ONLY,
      "Inspect the actual worktree and evidence; do not rely only on the worker's claims. When the worker's brief context names a plan file, read that file in full before judging the change against it.",
      "Confirm the automated criteria actually ran with their exit status; list the manual criteria that still need a human to confirm.",
      `Report your findings to Chief thread ${opts.chiefThreadId} with chief_report, state ready, and a verdict: approve when the change can ship as it stands, request_changes when the worker must fix something.`,
      "If the change introduced a new problem or regression that was not there before, say so with request_changes and regression: true.",
      "Do not broaden scope or make product decisions. Recommend escalation when a real decision is required.",
      ...opts.provenance,
    ].join("\n");
  }

  /** A reviewer that already finished (idle, ready, blocked, or failed) is superseded
   * by a fresh one rather than resumed; its verdict and reject_streak carry over onto
   * the new row, so deadlock detection still sees consecutive rejections across the
   * fresh reviewers. Only a reviewer still busy (BUSY_STATUSES) is returned as-is. */
  async function startReview(workerThreadId: string, focus?: string) {
    const inFlight = reviewStarts.get(workerThreadId);
    if (inFlight) return inFlight;
    const start = (async () => {
      const worker = roles.get(workerThreadId);
      if (!worker || worker.role !== "worker") throw new Error(`No managed worker ${workerThreadId}.`);
      const previous = existingReview.get(workerThreadId) as ManagedRow | undefined;
      if (previous && BUSY_STATUSES.has(previous.state)) {
        return { threadId: previous.thread_id, title: previous.title, workerThreadId, created: false };
      }
      const live = await bb.sdk.threads.get({ threadId: workerThreadId });
      if (BUSY_STATUSES.has(live.status)) throw new Error(`Worker ${workerThreadId} is ${live.status}; wait until it is idle before starting a review.`);
      if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Worker ${workerThreadId} is not reviewable.`);
      if (!live.environmentId) throw new Error(`Worker ${workerThreadId} has no reusable environment.`);
      const sectionId = await ensureSection();
      // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
      // the rules into every reviewer turn, so the spawn prompt does not repeat them.
      await readRules(worker.project_id);
      const title = `Review · ${worker.title}`;
      const waves = planWavesFor(worker.plan_thread_id);
      const prompt = reviewerPrompt({
        subject: `Independently review the work owned by worker thread ${workerThreadId}: “${worker.title}”.`,
        chiefThreadId: worker.chief_thread_id,
        focus,
        provenance: [
          ...(worker.brief ? [
            "", "## The brief this work was given", clipMiddle(worker.brief, 4_000),
            "", "Judge the change against that brief. A trade-off the brief mandates is not a defect — say so rather than filing it as one.",
          ] : []),
          ...(worker.result ? [
            "", "## What the worker reported", clip(worker.result, 300),
            `Full report and last output: bb chief inspect ${workerThreadId}`,
          ] : []),
          ...(previous?.result ? [
            "", `## The previous review (${previous.thread_id})`,
            `Verdict: ${previous.verdict ?? "none"}`, clip(previous.result, 300),
            `Full report and last output: bb chief inspect ${previous.thread_id}`,
            ...(previous.recommendation ? [`Recommendation: ${clip(previous.recommendation, 600)}`] : []),
            "", "Check each finding above against the current worktree: say which were fixed and which remain. Do not re-open points it approved.",
          ] : []),
          ...(waves.length > 1 ? [
            "", `This is the final wave (${waves.length} of ${waves.length}). Review the whole branch against its base — every wave's changes — against every wave's plan:`,
            ...waves.map((wave, index) => `Wave ${index + 1} of ${waves.length}: ${wave.path}`),
          ] : []),
        ],
      });
      const thread = await bb.sdk.threads.spawn({
        projectId: worker.project_id,
        environment: { type: "reuse", environmentId: live.environmentId },
        sectionId,
        parentThreadId: worker.chief_thread_id ?? undefined,
        visibility: "visible",
        title,
        ...(await execution("reviewer", await environmentHostId(live.environmentId))),
        ...(await lifecycleOwner(worker.chief_thread_id)),
        prompt,
        pluginMetadata: { role: "reviewer", chiefThreadId: worker.chief_thread_id },
      });
      insertThread({ threadId: thread.id, role: "reviewer", projectId: worker.project_id, chiefThreadId: worker.chief_thread_id, parentThreadId: worker.chief_thread_id, workerThreadId, title, state: "starting", status: thread.status, reviewedReportSeq: worker.report_seq });
      if (previous) {
        const now = Date.now();
        db.transaction(() => {
          db.prepare(`UPDATE managed_threads SET reject_streak=?, updated_at=? WHERE thread_id=?`).run(previous.reject_streak, now, thread.id);
          db.prepare(`UPDATE managed_threads SET state='complete', active_since=NULL, updated_at=? WHERE thread_id=?`).run(now, previous.thread_id);
        })();
        reloadRoles();
      }
      return { threadId: thread.id, title, workerThreadId, created: true };
    })();
    reviewStarts.set(workerThreadId, start);
    try {
      return await start;
    } finally {
      reviewStarts.delete(workerThreadId);
    }
  }

  /** The chief_review counterpart to startReview for a pull request or branch no
   * managed worker owns: same reviewer contract, but spawned on a fresh managed
   * worktree (delegate()'s exact shape) instead of the worker's reused environment. */
  async function startBranchReview(
    chiefThreadId: string,
    projectId: string,
    branch: string,
    pullRequestRef: string | null,
    focus?: string,
  ) {
    const key = `branch:${projectId}:${branch}`;
    const inFlight = reviewStarts.get(key);
    if (inFlight) return inFlight;
    const start = (async () => {
      const duplicate = existingBranchReview.get(projectId, branch) as ManagedRow | undefined;
      if (duplicate) return { threadId: duplicate.thread_id, title: duplicate.title, workerThreadId: null, created: false };
      const sectionId = await ensureSection();
      // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
      // the rules into every reviewer turn, so the spawn prompt does not repeat them.
      await readRules(projectId);
      const title = `Review · ${branch}`;
      const prompt = reviewerPrompt({
        subject: pullRequestRef
          ? `Independently review pull request ${pullRequestRef} (branch ${branch}). No managed worker owns this change: read it in this worktree against its base branch.`
          : `Independently review branch ${branch}. No managed worker owns this change: read it in this worktree against its base branch.`,
        chiefThreadId,
        focus,
        provenance: [],
      });
      const hostId = await defaultHostId();
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: {
          type: "host",
          hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "named" as const, name: branch } },
        },
        sectionId,
        parentThreadId: chiefThreadId,
        visibility: "visible",
        title,
        ...(await execution("reviewer", hostId)),
        ...(await lifecycleOwner(chiefThreadId)),
        prompt,
        pluginMetadata: { role: "reviewer", chiefThreadId },
      });
      insertThread({
        threadId: thread.id, role: "reviewer", projectId, chiefThreadId, parentThreadId: chiefThreadId, title,
        state: "starting", status: thread.status, branch, prUrl: pullRequestRef,
      });
      return { threadId: thread.id, title, workerThreadId: null, created: true };
    })();
    reviewStarts.set(key, start);
    try {
      return await start;
    } finally {
      reviewStarts.delete(key);
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

  /** Interrupts a running managed thread but keeps its worktree, branch, and history:
   * the row is marked blocked (with a reroute recommendation) rather than complete, so
   * chief_delegate replaces: can hand it to a fresh worker once it is idle. */
  async function stopThread(threadId: string, reason?: string) {
    const row = roles.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed thread ${threadId} to stop.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot stop ${threadId} because it is not a live thread.`);
    if (!BUSY_STATUSES.has(live.status)) {
      throw new Error(`${threadId} is ${live.status}; nothing to stop.${row.role === "worker" ? ` Replace it with chief_delegate (replaces: ${threadId}).` : ""}`);
    }
    await bb.sdk.threads.stop({ threadId });
    db.prepare(`UPDATE managed_threads SET state='blocked', blocker=?, recommendation=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      clip(`Stopped by Chief${reason ? `: ${reason}` : "."}`, 4_000), rerouteSteps(row), Date.now(), threadId,
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
      // ponytail: only catches sends BB left queued; a send that reached an
      // idle Chief and then threw has no idempotency key to detect it by.
      if (alert.attempts > 0) {
        try {
          const queued = await bb.sdk.threads.queuedMessages.list({ threadId: alert.target_thread_id });
          const alreadyQueued = queued.some((message) =>
            message.content.some((part) => part.type === "text" && part.text === clip(alert.message)));
          if (alreadyQueued) {
            db.prepare(`UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
            return true;
          }
        } catch {
          // Fall through to the send below.
        }
      }
      try {
        await bb.sdk.threads.send({
          threadId: alert.target_thread_id,
          senderThreadId: alert.source_thread_id,
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

  /** The server, not the planner, owns writing the plan: the planner submits it
   * through chief_report and this lands it at the thread's own storage location. */
  async function writePlan(threadId: string, plan: string | { body: string }[], mirrorRoot?: string) {
    const { storageRootPath } = await bb.sdk.threads.storageLocation({ threadId });
    const bodies = typeof plan === "string" ? [{ name: "plan.md", body: plan }]
      : plan.map((wave, index) => ({ name: `plan-${index + 1}.md`, body: wave.body }));
    // mirrorRoot writes a copy elsewhere; the returned paths stay the canonical planner ones.
    for (const root of [mirrorRoot ?? storageRootPath]) {
      await mkdir(root, { recursive: true });
      for (const wave of bodies) await writeFile(join(root, wave.name), `${wave.body}\n`);
    }
    return bodies.map((wave) => ({ path: join(storageRootPath, wave.name) }));
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
    if (!row || row.role === "chief") throw new Error("chief_report is available only in managed worker, planner, reviewer, and advisor threads.");
    if (["complete", "archived", "deleted"].includes(row.state)) {
      throw new Error(`Managed thread ${threadId} is ${row.state} and can no longer report.`);
    }
    const verdict = params.state === "ready" ? params.verdict ?? null : null;
    if (row.role === "reviewer" && params.state === "ready" && !verdict) {
      throw new Error('A reviewer\'s ready report must carry a verdict: "approve" when the change can ship as it stands, or "request_changes" when the worker must fix something.');
    }
    // Some planners send the wave array JSON-encoded; the string branch would take it as one flat wave.
    let plan: z.infer<typeof readyReport>["plan"] = params.state === "ready" ? params.plan : undefined;
    if (typeof plan === "string" && plan.startsWith("[")) {
      let decoded: unknown;
      try { decoded = JSON.parse(plan); } catch { decoded = undefined; }
      if (Array.isArray(decoded)) {
        const waves = planWavesSchema.safeParse(decoded);
        if (!waves.success) {
          throw new Error(`plan is a JSON-encoded wave array that is not valid (${waves.error.issues[0]?.message ?? "check the waves"}). Pass plan as an array of {body}, not a string.`);
        }
        plan = waves.data;
      }
    }
    if (row.role === "planner" && params.state === "ready" && !plan) {
      throw new Error("A planner's ready report requires plan: the full plan body.");
    }
    if (params.state === "ready" && plan && row.role !== "planner") {
      throw new Error("Only a planner's ready report carries plan.");
    }
    if (row.role === "planner" && params.state === "ready" && plan) {
      const bodies = typeof plan === "string" ? [plan] : plan.map((wave) => wave.body);
      // ponytail: headings inside code blocks are deliberately out of scope (user decision).
      if (!bodies.some((body) => /^[ \t]*#{1,6}[ \t]+what we(?:'re|’re| are) not doing/im.test(body))) {
        const hint = typeof plan === "string" && plan.startsWith("[")
          ? " If you meant to send several waves, pass plan as an actual array of {body}, not a JSON string."
          : "";
        throw new Error(`A planner's ready report requires a "What we're NOT doing" section in some wave.${hint}`);
      }
    }
    const plannerReady = row.role === "planner" && params.state === "ready";
    const planWaves = plannerReady && plan ? await writePlan(threadId, plan) : null;
    // Best-effort mirror into Chief's storage: inline-vis resolves paths against the rendering thread.
    let inlinePlans: string[] = [];
    if (planWaves && plan && row.chief_thread_id) {
      try {
        const { storageRootPath } = await bb.sdk.threads.storageLocation({ threadId: row.chief_thread_id });
        await writePlan(threadId, plan, join(storageRootPath, "plans", threadId));
        inlinePlans = planWaves.map((wave) => `::inline-vis{source="thread-storage" file="plans/${threadId}/${basename(wave.path)}"}`);
      } catch (error) {
        bb.log.warn(`Could not mirror ${threadId}'s plan into Chief's storage: ${String(error)}`);
      }
    }
    const now = Date.now();
    // A reviewer's active_cycle counts every resume, not rejection rounds — a
    // reviewer resumed for an unrelated reason must not read as a deadlock.
    // reject_streak counts only consecutive request_changes verdicts, and
    // resets the moment either side breaks the streak with an approve.
    const regressionFlag = params.state === "ready" && params.regression === true && verdict === "request_changes";
    db.prepare(`UPDATE managed_threads SET state=?, result=?, blocker=?, recommendation=?, verdict=?,
      reject_streak = CASE WHEN ?=1 THEN reject_streak+1 WHEN ?=1 THEN 0 ELSE reject_streak END,
      plan_waves = COALESCE(?, plan_waves), regression=?, report_seq = report_seq + 1,
      active_since=NULL, updated_at=? WHERE thread_id=?`).run(
      params.state, params.result ?? null, params.state === "blocked" ? params.blocker : null,
      params.recommendation ?? null, verdict,
      verdict === "request_changes" ? 1 : 0, verdict === "approve" ? 1 : 0,
      planWaves ? JSON.stringify(planWaves) : null, regressionFlag ? 1 : 0,
      now, threadId,
    );
    reloadRoles();
    const current = roles.get(threadId)!;
    const action = nextAction(current) ?? "Inspect live evidence with chief_inspect and choose: continue, review, complete, or escalate to the user.";
    const summary = [
      `${row.role[0]!.toUpperCase()}${row.role.slice(1)} report from ${row.title} (${threadId})`,
      `State: ${params.state}`,
      ...(plannerReady && planWaves
        ? [
            `Plan: ${planWaves.length} wave(s)`,
            ...planWaves.map((wave, index) => `Wave ${index + 1} of ${planWaves.length}: ${wave.path}`),
            ...(inlinePlans.length
              ? ["To show the plan to the user, put each line below alone on its own line in your reply (not in a code block):", ...inlinePlans]
              : []),
            action,
          ]
        : []),
      ...(verdict ? [`Verdict: ${verdict}`] : []),
      ...(params.result ? [`Result: ${params.result}`] : []),
      ...(params.state === "blocked" ? [`Blocker: ${params.blocker}`] : []),
      ...(params.recommendation ? [`Recommendation: ${params.recommendation}`] : []),
      ...(plannerReady ? [] : [action]),
    ].join("\n");
    const contentKey = createHash("sha1").update(summary).digest("hex").slice(0, 16);
    return alertChief(current, `report:${current.active_cycle}:${contentKey}`, summary);
  }

  function stateFromLive(row: ManagedRow, status: string) {
    if (status === "error") return "failed";
    if (["ready", "blocked", "complete"].includes(row.state)) return row.state;
    if (["active", "starting", "pending", "stopping"].includes(status)) return status;
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
    liveSeen.add(row.thread_id);
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
    if (thread.parentThreadId && row.parent_thread_id !== thread.parentThreadId) {
      db.prepare(`UPDATE managed_threads SET parent_thread_id=?, updated_at=? WHERE thread_id=?`).run(thread.parentThreadId, now, row.thread_id);
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

  async function lifecycle(kind: string, thread: { id: string; status?: string }) {
    const row = roles.get(thread.id);
    if (!row) return;
    liveSeen.add(thread.id);
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
  }

  bb.events.on("thread.active", ({ thread }) => lifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread }) => lifecycle("idle", thread));
  bb.events.on("thread.failed", ({ thread }) => lifecycle("failed", thread));
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
          const threshold = (Number.isFinite(parsed) && parsed > 0 ? parsed : 15) * 60_000;
          const now = Date.now();
          for (const row of [...roles.values()]) {
            if (row.role === "chief" || row.state !== "active" || row.active_since === null) continue;
            const elapsed = now - row.active_since;
            if (elapsed < threshold) continue;
            const hard = elapsed >= 2 * threshold;
            if ((hard ? row.stop_alerted_cycle : row.stall_alerted_cycle) === row.active_cycle) continue;
            const output = await lastOutput(row.thread_id);
            const minutes = Math.round(threshold / 60_000);
            const sent = await alertChief(row, `stall:${row.active_cycle}${hard ? ":hard" : ""}`, [
              `${row.role} “${row.title}” (${row.thread_id}) has been active for ${Math.round(elapsed / 60_000)} minutes${hard ? `, twice the ${minutes}-minute stall threshold` : ` (stall threshold ${minutes})`}.`,
              `Last output: ${output ? clip(output, 400) : "(none available)"}`,
              hard
                ? "Stop it now with chief_stop unless that output shows it finishing. Its worktree and branch are kept."
                : `Inspect it with chief_inspect. If it is progressing, leave it. If it is stuck or looping, chief_stop it: its worktree and branch are kept. At ${2 * minutes} minutes you will be told to stop it.`,
              rerouteSteps(row),
            ].join("\n"));
            if (sent) {
              db.prepare(`UPDATE managed_threads SET stall_alerted_cycle=?, stop_alerted_cycle=?, updated_at=? WHERE thread_id=?`)
                .run(row.active_cycle, hard ? row.active_cycle : row.stop_alerted_cycle, Date.now(), row.thread_id);
              reloadRoles();
            }
          }
          // Replace terminal Chiefs only if they left active orphaned workers or undelivered alerts that need a supervisor.
          const terminalChiefsWithOrphanWork = [...roles.values()].filter((row) => {
            if (row.role !== "chief" || !["failed", "archived", "deleted"].includes(row.state)) return false;
            const hasActiveChildren = [...roles.values()].some(
              (child) => child.chief_thread_id === row.thread_id && !["failed", "deleted", "archived", "complete"].includes(child.state),
            );
            const hasPendingAlerts = (pendingAlerts.all() as AlertRow[]).some(
              (alert) => alert.target_thread_id === row.thread_id,
            );
            return hasActiveChildren || hasPendingAlerts;
          });
          const chiefProjects = new Set(terminalChiefsWithOrphanWork.map((row) => row.project_id));
          if (values.autoSpawn && values.chiefProject) chiefProjects.add(values.chiefProject);
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
    if (next.autoSpawn && next.chiefProject && next.chiefProject !== previous.chiefProject) {
      void ensureChief(next.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
    }
    plannerActive = next.plannerEnabled;
  });

  function rosterFor(projectId: string, includeComplete = false) {
    return [...roles.values()].filter((row) => row.project_id === projectId && (includeComplete || row.state !== "complete"));
  }

  /** Said the same way in chief_stop's reply and both stall alerts. */
  function rerouteSteps(row: ManagedRow): string {
    if (row.role === "worker") {
      return `Once it is idle, call chief_consult (workerThreadId: ${row.thread_id}) if the cause is unclear, then hand the work to a fresh worker with chief_delegate (replaces: ${row.thread_id}) and the advice in its context. Use chief_plan instead if the brief itself is wrong or too big.`;
    }
    if (row.role === "reviewer") {
      return row.worker_thread_id
        ? `Once it is idle, start a fresh review with chief_review (workerThreadId: ${row.worker_thread_id}).`
        : `Once it is idle, chief_complete it, then start a fresh chief_review for branch ${row.branch}.`;
    }
    if (row.role === "planner") return "Once it is idle, start a fresh chief_plan with a narrower brief.";
    return "Once it is idle, decide without it or start a fresh chief_consult with a narrower question.";
  }

  function belongsToChief(row: ManagedRow, chiefThreadId: string) {
    if (row.thread_id === chiefThreadId || row.chief_thread_id === chiefThreadId) return true;
    if (row.parent_thread_id && row.parent_thread_id === chiefThreadId) return true;
    return false;
  }

  /** The last 3 reviewer rows with a verdict for this worker's task, so the
   * advisor sees the review history that led to the consult, across a `replaces`
   * handoff. ponytail: chains by matching branch across the whole project, so a
   * branch reused by a later task can surface an earlier task's reviews, and
   * with no branch only the current worker's own reviews are found. Upgrade to
   * a `replaces` link column if that ever needs to be precise. */
  function taskReviews(worker: ManagedRow): ManagedRow[] {
    const chain = worker.branch
      ? [...roles.values()].filter((row) => row.role === "worker" && row.project_id === worker.project_id && row.branch === worker.branch)
      : [worker];
    const workerIds = new Set(chain.map((row) => row.thread_id));
    return [...roles.values()]
      .filter((row) => row.role === "reviewer" && row.verdict && row.worker_thread_id && workerIds.has(row.worker_thread_id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 3);
  }

  const INACTIVE_CHIEF_STATES = ["complete", "archived", "deleted"];
  /** A superseded Chief (spawnChief already marked it complete/archived/deleted and
   * handed its workers to the replacement) must not still be able to act as Chief. */
  function isActiveChief(caller: ManagedRow | undefined): caller is ManagedRow {
    return !!caller && caller.role === "chief" && !INACTIVE_CHIEF_STATES.includes(caller.state);
  }

  async function resolveTarget(threadId: string, chiefThreadId: string): Promise<ManagedRow | undefined> {
    let target = roles.get(threadId);
    if (!target) {
      try {
        const live = await bb.sdk.threads.get({ threadId });
        const chief = roles.get(chiefThreadId);
        if (
          live.deletedAt === null && live.archivedAt === null &&
          live.parentThreadId === chiefThreadId && chief && live.projectId === chief.project_id
        ) {
          // Only adopt threads this plugin itself spawned (pluginMetadata seeded at
          // spawn time, trusted only once originPluginId proves it — see report()'s
          // identical check) — otherwise a sub-thread the user created under Chief in
          // the BB UI gets silently relocated into the Chief section as a "worker".
          const seeded = live.originPluginId === bb.pluginId
            ? spawnMetadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null))
            : undefined;
          if (seeded?.success) {
            insertThread({
              threadId: live.id,
              role: "worker",
              projectId: live.projectId,
              chiefThreadId,
              parentThreadId: chiefThreadId,
              title: live.title || "Managed thread",
              state: live.status === "active" ? "active" : "idle",
              status: live.status,
            });
            target = roles.get(threadId);
          }
        }
      } catch {
        // not found
      }
    }
    return target;
  }

  function rosterForChief(chiefThreadId: string, includeComplete = false) {
    return [...roles.values()].filter(
      (row) => belongsToChief(row, chiefThreadId) && (includeComplete || row.state !== "complete"),
    );
  }

  /** A planner's wave schedule and how far it has been delegated, or a worker's own
   * wave — shared by chief_roster and bb chief status so the two never disagree either. */
  function waveLines(row: ManagedRow): string[] {
    if (row.role === "planner" && row.plan_waves) {
      const waves = planWavesFor(row.thread_id);
      // The current wave's worker: the highest plan_wave linked to this planner,
      // breaking ties (a same-wave fix worker) by the newest.
      const current = [...roles.values()]
        .filter((other) => other.role === "worker" && other.plan_thread_id === row.thread_id)
        .reduce<ManagedRow | undefined>((best, other) => (
          !best || (other.plan_wave ?? 0) > (best.plan_wave ?? 0)
            || ((other.plan_wave ?? 0) === (best.plan_wave ?? 0) && other.created_at >= best.created_at)
        ) ? other : best, undefined);
      const currentWave = current?.plan_wave ?? 1;
      const isFinalWave = currentWave === waves.length;
      const reviewer = current ? latestReviewForWorker.get(current.thread_id) as ManagedRow | undefined : undefined;
      // Only trust the reviewer's verdict/busy-ness for the wave's state when it
      // still covers the current worker's latest report — the same report_seq tie
      // nextAction uses, so a stale (re-pointed but not-yet-reported) reviewer
      // does not show an approval or rejection that predates the current attempt.
      const reviewerCovers = reviewer != null && reviewer.reviewed_report_seq === current?.report_seq;
      const approved = isFinalWave && reviewerCovers && reviewer!.verdict === "approve";
      const state = !current ? "not delegated"
        : approved ? "approved"
        : reviewerCovers && reviewer!.verdict === "request_changes" ? "changes requested"
        : reviewerCovers && BUSY_STATUSES.has(reviewer!.state) ? "in review"
        : current.state;
      const done = Math.max(0, currentWave - 1) + (approved ? 1 : 0);
      return [
        `waves: ${done}/${waves.length} done, wave ${currentWave} ${state}`,
        ...waves.map((wave, index) => `  wave ${index + 1} of ${waves.length}: ${wave.path}`),
      ];
    }
    if (row.role === "worker" && row.plan_thread_id && row.plan_wave != null) {
      return [`wave: ${row.plan_wave} of ${planWavesFor(row.plan_thread_id).length} (plan ${row.plan_thread_id})`];
    }
    return [];
  }

  /** One row's full detail block, reused by chief_roster and bb chief status. */
  function rosterRowLines(row: ManagedRow): string[] {
    return [
      `${row.role} | ${row.state} | live:${row.status ?? "unknown"} | ${row.title} | ${row.thread_id}`,
      ...(row.branch ? [`branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`pr: ${row.pr_url}`] : []),
      ...waveLines(row),
      ...(row.unplanned_reason ? [`unplanned: ${clip(row.unplanned_reason, 200)}`] : []),
      ...(row.result ? [`result: ${clip(row.result, 300)}`] : []),
      ...(row.blocker ? [`blocker: ${clip(row.blocker, 200)}`] : []),
      ...(row.recommendation ? [`recommendation: ${clip(row.recommendation, 200)}`] : []),
      ...(row.verdict ? [`verdict: ${row.verdict}`] : []),
    ];
  }

  /** The Pending block, in the same wording as the lifecycle alert — "Pending: none."
   * when nothing is, so the block is never silently missing (an empty roster included). */
  function pendingLines(rows: ManagedRow[], todos: string[] = []): string[] {
    const pending = rows
      .map((row) => [row, nextAction(row)] as const)
      .filter((entry): entry is [ManagedRow, string] => entry[1] !== null)
      .map(([row, action]) => `- ${row.role} “${row.title}” (${row.thread_id}): ${action}`);
    return pending.length || todos.length ? ["Pending:", ...pending, ...todos] : ["Pending: none."];
  }

  function todoLine(todo: TodoRow) {
    const state = todo.state === "open" ? "" : ` [${todo.state}]`;
    return `- todo #${todo.id}${state}: ${todo.text}${todo.after ? ` (after: ${todo.after})` : ""}`;
  }

  /** A project's open todos as Pending lines — after thread lines, so clipping drops them first. */
  function todoLines(projectId: string | undefined) {
    return projectId ? (todosForProject.all(projectId) as TodoRow[]).map(todoLine) : [];
  }

  /** Clips a rendered Pending block to `limit` by whole lines — never mid-action —
   * naming how many were dropped. Clipped on its own, separately from the rest of
   * the roster, so an overflowing roster still cuts detail rows first. */
  function clipPendingBlock(lines: string[], limit: number): string {
    const joined = lines.join("\n");
    if (joined.length <= limit) return joined;
    const [header, ...items] = lines;
    const kept: string[] = [];
    let used = header!.length;
    for (const item of items) {
      const next = used + 1 + item.length;
      if (next > limit) break;
      used = next;
      kept.push(item);
    }
    let suffix = `…and ${items.length - kept.length} more pending`;
    while (kept.length > 0 && used + 1 + suffix.length > limit) {
      used -= 1 + kept.pop()!.length;
      suffix = `…and ${items.length - kept.length} more pending`;
    }
    return [header, ...kept, suffix].join("\n");
  }

  /** The Pending block exactly as chief_roster prints it. */
  function pendingBlock(chiefThreadId: string) {
    return clipPendingBlock(pendingLines([...rosterForChief(chiefThreadId)].reverse(), todoLines(roles.get(chiefThreadId)?.project_id)), 6_000);
  }

  /** The panel's checklist: action threads, in-progress threads (newest first), open
   * todos, then done threads and closed todos by recency, capped at MAX_DONE_ITEMS. */
  function todoItems(chiefThreadId: string): { items: TodoItem[]; doneOmitted: number } {
    const rows = rosterForChief(chiefThreadId, true).filter((row) => row.thread_id !== chiefThreadId).reverse();
    const threadItem = (row: ManagedRow, done: boolean) => ({
      id: row.thread_id, label: `${row.role} “${row.title}”`, status: row.state, action: done ? null : nextAction(row), done,
    });
    const todoItem = (todo: TodoRow) => ({
      id: `todo #${todo.id}`, label: `${todo.text}${todo.after ? ` (after: ${todo.after})` : ""}`,
      status: todo.state, action: null, done: todo.state !== "open",
    });
    const open = rows.filter(isOpenItem).map((row) => threadItem(row, false));
    const projectId = roles.get(chiefThreadId)?.project_id;
    const doneRows = [
      ...rows.filter((row) => !isOpenItem(row)).map((row) => [row.updated_at, threadItem(row, true)] as const),
      ...(projectId ? closedTodosForProject.all(projectId) as TodoRow[] : []).map((todo) => [todo.updated_at, todoItem(todo)] as const),
    ].sort((a, b) => b[0] - a[0]);
    return {
      items: [
        ...open.filter((item) => item.action),
        ...open.filter((item) => !item.action),
        ...(projectId ? todosForProject.all(projectId) as TodoRow[] : []).map(todoItem),
        ...doneRows.slice(0, MAX_DONE_ITEMS).map(([, item]) => item),
      ],
      doneOmitted: Math.max(0, doneRows.length - MAX_DONE_ITEMS),
    };
  }

  /** Every active Chief's checklist, only to detect a change worth a realtime signal. */
  function pendingSnapshot() {
    return [...roles.values()].filter(isActiveChief).map((chief) => [chief.thread_id, todoItems(chief.thread_id)]);
  }

  async function lastOutput(threadId: string) {
    try {
      return (await bb.sdk.threads.output({ threadId })).output;
    } catch (error) {
      bb.log.warn(`Could not inspect output for ${threadId}: ${String(error)}`);
      return null;
    }
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
    const output = await lastOutput(threadId);
    return [
      `Thread: ${row.title} (${threadId})`,
      `Role: ${row.role}`,
      ...(row.branch ? [`Branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`Issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`Pull request: ${row.pr_url}`] : []),
      ...(row.unplanned_reason ? [`Unplanned: ${clip(row.unplanned_reason, 300)}`] : []),
      `Persisted state: ${row.state}`,
      `Live status: ${liveStatus ?? "unknown"}`,
      ...(row.result ? [`Result: ${clip(row.result, 1_500)}`] : []),
      ...(row.blocker ? [`Blocker: ${clip(row.blocker, 600)}`] : []),
      ...(row.recommendation ? [`Recommendation: ${clip(row.recommendation, 600)}`] : []),
      ...(row.verdict ? [`Verdict: ${row.verdict}`] : []),
      `Last assistant output:\n${output ? clip(output, 2_000) : "(none available)"}`,
    ].join("\n");
  }

  bb.agents.registerTool({
    name: "chief_forge_init",
    presentation: { label: { pending: "Running forge pre-flight…", completed: "Ran forge pre-flight" } },
    description: "Run the forge pre-flight for one task — tracking issue, task branch, draft pull request — before chief_delegate. Returns the values, or a script to run yourself when the server could not.",
    parameters: z.object({
      title: z.string().trim().min(1).max(160).describe("The exact title this task will be delegated with."),
      base: z.string().trim().min(1).max(300).optional().describe("Branch to cut from and target the pull request at. Omit for the project default; name one only to stack deliberately on an open pull request."),
      body: z.string().trim().min(1).max(4_000).optional().describe("Short summary for the issue and pull request body."),
    }),
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_forge_init requires an active registered Chief thread.");
      }
      const { branch, script } = forgeInitScript(params);
      const cwd = await projectPath(caller.project_id);
      let failure: string | null = null;
      if (cwd) {
        // ponytail: a remote-host project whose path also exists on the server would run against the wrong checkout; unlikely.
        try {
          const { stdout } = await execFileAsync("sh", ["-c", script], {
            cwd, timeout: FORGE_SCRIPT_TIMEOUT_MS,
            // ponytail: heuristic for GUI-launched servers whose PATH lacks Homebrew; upgrade path is a configured forge PATH.
            env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` },
          });
          const line = String(stdout).match(/^CHIEF_FORGE (.*)$/gm)?.at(-1)?.slice("CHIEF_FORGE ".length);
          const values = Object.fromEntries((line ?? "").split(" ").map((pair) => {
            const at = pair.indexOf("=");
            return [pair.slice(0, at), pair.slice(at + 1)];
          }));
          if (line && values.branch && values.forge) {
            return `The forge pre-flight already ran in the project checkout: branch=${values.branch} base=${values.base ?? ""} issue_url=${values.issue_url ?? ""} pr_url=${values.pr_url ?? ""}. Pass branch, issueUrl and prUrl to chief_delegate, omitting whatever came back empty — an empty issue_url usually means the repository has issues disabled, not a failure. Do not run anything yourself.`;
          }
          failure = !line ? "no CHIEF_FORGE line" : !values.branch ? "the branch was not cut" : "no gh or glab found on the server";
        } catch (error) {
          failure = String(error);
        }
        failure = clip(failure, 200);
        bb.log.warn(`Server-side forge pre-flight fell back to Chief: ${failure}`);
      }
      return [
        ...(failure ? [`Running it on the server did not finish (${failure}), so run it yourself.`] : []),
        "Run this from the project checkout, verbatim. Every value is already substituted and quoted, every forge step is best-effort, and your own checkout never moves:",
        "", "```sh", script, "```", "",
        `The last line is CHIEF_FORGE branch=… base=… issue_url=… pr_url=…. Pass those to chief_delegate as branch, issueUrl and prUrl, omitting whatever came back empty — an empty issue_url usually means the repository has issues disabled, and an empty branch means the cut failed, so delegate without one and the worktree uses the project default. Neither is a failure to report as one. The branch will be ${branch}.`,
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "chief_delegate",
    presentation: { label: { pending: "Delegating work…", completed: "Delegated work" } },
    description: "Delegate one clearly titled unit of implementation work to a visible worker in its own managed worktree.",
    parameters: delegateParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_delegate requires an active registered Chief thread.");
      }
      const result = await delegate(params, context.threadId);
      return `Started worker “${result.title}” in thread ${result.threadId}. Track it with chief_roster.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_plan",
    presentation: { label: { pending: "Starting planner…", completed: "Started planner" } },
    description: "Send one unit of work to a read-only planner. It proposes an implementation plan, split into waves; its ready alert names the exact next call.",
    parameters: planParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_plan requires an active registered Chief thread.");
      }
      const result = await startPlan(params, context.threadId);
      return `Started planner “${result.title}” in thread ${result.threadId}. Its ready alert lists the wave schedule and the exact next call.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_consult",
    presentation: { label: { pending: "Starting advisor…", completed: "Started advisor" } },
    description: "Start a read-only advisor on a hard problem or a change that keeps failing review. It may read code and run commands to reproduce it, never edits, and reports its advice back to you.",
    parameters: consultParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_consult requires an active registered Chief thread.");
      }
      if (params.workerThreadId) {
        const worker = await resolveTarget(params.workerThreadId, caller.thread_id);
        if (!worker || !belongsToChief(worker, caller.thread_id)) {
          throw new Error(`No managed worker ${params.workerThreadId} for this Chief.`);
        }
      }
      touchCallerChief(caller);
      const result = await startConsult(params, context.threadId);
      return `Started advisor “${result.title}” in thread ${result.threadId}. Wait for its advice before starting another worker round.`;
    },
  });
  function touchCallerChief(caller?: ManagedRow) {
    if (caller && caller.role === "chief" && caller.state === "failed") {
      db.prepare(`UPDATE managed_threads SET state='active', updated_at=? WHERE thread_id=?`).run(Date.now(), caller.thread_id);
      reloadRoles();
    }
  }

  bb.agents.registerTool({
    name: "chief_roster",
    presentation: { label: { pending: "Reading roster…", completed: "Read roster" } },
    description: "Inspect this project's managed threads and their bounded persisted status, result, blocker, and recommendation. Opens with a Pending block naming each item's next action, in the same wording as its lifecycle alert. Add a todo with `todo.text` (and optional `after`, e.g. 'PR #42 merges'); change one by `todo.id`; close it with `state: done|dropped`. Track all Chief work here — including queued work nobody has delegated yet.",
    parameters: z.object({
      includeComplete: z.boolean().optional(),
      todo: z.object({
        id: z.number().int().optional(),
        text: z.string().trim().min(1).max(500).optional(),
        after: z.string().trim().max(200).optional().describe("Empty string clears it."),
        state: z.enum(["open", "done", "dropped"]).optional(),
      }).optional(),
    }),
    async execute({ includeComplete, todo }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!caller || caller.role !== "chief") throw new Error("chief_roster requires a registered Chief thread.");
      touchCallerChief(caller);
      if (todo) {
        const now = Date.now();
        if (todo.id === undefined) {
          if (!todo.text) throw new Error("chief_roster todo needs text to add, or an id to change.");
          insertTodo.run(caller.project_id, todo.text, todo.after || null, now, now);
        } else {
          const existing = todoById.get(todo.id, caller.project_id) as TodoRow | undefined;
          if (!existing) throw new Error(`No todo #${todo.id} in this project.`);
          const after = todo.after === undefined ? existing.after : todo.after || null;
          updateTodo.run(todo.text ?? existing.text, after, todo.state ?? existing.state, now, todo.id, caller.project_id);
        }
        reloadRoles();
      }
      const rows = rosterForChief(caller.thread_id, includeComplete);
      const reversed = [...rows].reverse();
      // The Pending block is clipped on its own so it always survives whole (or
      // ends with "…and N more pending"), then the rest gets whatever budget is
      // left — otherwise one clip() across both could cut a pending action off mid-line.
      const pending = pendingBlock(caller.thread_id);
      const rest = clip([
        ...reversed.map((row) => rosterRowLines(row).join("\n  ")),
        ...(includeComplete ? (closedTodosForProject.all(caller.project_id) as TodoRow[]).map(todoLine) : []),
      ].join("\n"), Math.max(0, 6_000 - pending.length - 1));
      return `${pending}\n${rest}`;
    },
  });
  bb.agents.registerTool({
    name: "chief_inspect",
    presentation: { label: { pending: "Inspecting thread…", completed: "Inspected thread" } },
    description: "Inspect one managed thread's live status, persisted report, and bounded last assistant output before deciding what to do.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      const target = await resolveTarget(threadId, caller.thread_id);
      if (!target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      touchCallerChief(caller);
      return inspect(threadId, caller.project_id);
    },
  });
  bb.agents.registerTool({
    name: "chief_continue",
    presentation: { label: { pending: "Nudging thread…", completed: "Nudged thread" } },
    description: "Send a short nudge (at most 500 characters) to a managed thread that is still working. Never reuse a worker for more work: once it has reported ready, finishing skipped acceptance criteria, a rebase or restack, or any new task goes to a fresh worker with chief_delegate replaces: (same worktree, branch, and PR). Reviewers stay read-only; a repair goes to a fresh worker.",
    parameters: z.object({
      threadId: z.string(),
      instruction: z.string().trim().min(1).max(MAX_RESULT_LENGTH).describe(`A short nudge, at most ${MAX_NUDGE_LENGTH} characters.`),
    }),
    async execute({ threadId, instruction }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      const target = await resolveTarget(threadId, caller.thread_id);
      if (!target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      touchCallerChief(caller);
      await continueThread(threadId, instruction, caller.thread_id);
      return `Continued ${threadId}.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_stop",
    presentation: { label: { pending: "Stopping thread…", completed: "Stopped thread" } },
    description: "Interrupt a running managed thread that is stuck or looping. Keeps its worktree and branch so a fresh worker can replace it with chief_delegate replaces.",
    parameters: stopParams,
    async execute({ threadId, reason }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error("chief_stop requires an active registered Chief thread.");
      const target = await resolveTarget(threadId, caller.thread_id);
      if (!target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      touchCallerChief(caller);
      const row = await stopThread(threadId, reason);
      return `Stopped “${row.title}” (${threadId}). Its worktree, branch, and history are kept. ${rerouteSteps(row)}`;
    },
  });
  bb.agents.registerTool({
    name: "chief_review",
    presentation: { label: { pending: "Starting review…", completed: "Started review" } },
    description: "Start or return an independent read-only review: in an idle worker's existing worktree, or in a fresh worktree for a pull request or branch no managed worker owns.",
    parameters: reviewParams,
    async execute(params, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (params.workerThreadId) {
        if (!isActiveChief(caller)) throw new Error(`No managed worker ${params.workerThreadId} for this Chief.`);
        const worker = await resolveTarget(params.workerThreadId, caller.thread_id);
        if (!worker || !belongsToChief(worker, caller.thread_id)) {
          throw new Error(`No managed worker ${params.workerThreadId} for this Chief.`);
        }
        touchCallerChief(caller);
        const review = await startReview(params.workerThreadId, params.focus);
        return `${review.created ? "Started" : "Using existing"} “${review.title}” in thread ${review.threadId}.`;
      }
      if (!isActiveChief(caller)) {
        throw new Error("chief_review requires a registered Chief thread.");
      }
      touchCallerChief(caller);
      const branch = params.branch
        ?? (await resolvePullRequestBranch(params.pullRequest!, await projectPath(caller.project_id)))
        ?? params.pullRequest!;
      const review = await startBranchReview(caller.thread_id, caller.project_id, branch, params.pullRequest ?? null, params.focus);
      return `${review.created ? "Started" : "Using existing"} “${review.title}” in thread ${review.threadId}.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_complete",
    presentation: { label: { pending: "Completing work…", completed: "Completed work" } },
    description: "Mark an idle managed worker or reviewer complete after Chief has inspected sufficient evidence. Completing a worker also completes its reviewers and the advisors consulted on it, and — after the plan's final wave — its planner.",
    parameters: z.object({ threadId: z.string(), result: z.string().trim().max(MAX_RESULT_LENGTH).optional() }),
    async execute({ threadId, result }, context) {
      const caller = context.threadId ? roles.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      const target = await resolveTarget(threadId, caller.thread_id);
      if (!target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      touchCallerChief(caller);
      const row = await markComplete(threadId, result);
      const todos = row.role === "worker" ? todosForProject.all(caller.project_id) as TodoRow[] : [];
      const todoLine = todos.length
        ? `\n${clip(`Open todos: ${todos.map((todo) => `#${todo.id} ${clip(todo.text, 80)}`).join(", ")} — close any this work finished with chief_roster todo { id, state: "done" }.`, 1_000)}`
        : "";
      return `Marked “${row.title}” complete.${todoLine}`;
    },
  });
  bb.agents.registerTool({
    name: "chief_report",
    presentation: { label: { pending: "Reporting to Chief…", completed: "Reported to Chief" } },
    description: "Report managed work state and evidence to Chief. Use ready, not complete; blocked requires blocker and recommendation; a reviewer's ready report requires a verdict; a planner's ready report requires plan (the full plan body), which Chief receives as a file.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_report requires a thread context.");
      const delivered = await report(context.threadId, params, context.projectId);
      return delivered ? "Report delivered to Chief." : "Report queued for Chief; it will be delivered automatically. Do not report again.";
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
          "chief_consult",
          "chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete",
        ],
        skills: ["chief"],
        instructions: [
          `You are the registered Chief supervisor for ${context.project.name}. Use ordinary visible BB threads and drive managed work through completion.`,
          "",
          ROSTER_CHIEF_INSTRUCTIONS,
          ...(plannerActive ? ["", PLANNER_CHIEF_INSTRUCTIONS] : []),
          "",
          rules,
        ].join("\n"),
      };
    }
    const chiefThreadId = row?.chief_thread_id ?? (seeded?.success ? seeded.data.chiefThreadId ?? null : null);
    return {
      tools: ["chief_report"],
      skills: ["chief-worker"],
      instructions: [
        `You are a managed ${role} reporting to Chief thread ${chiefThreadId}.`,
        "",
        rules,
      ].join("\n"),
    };
  });

  bb.rpc.register(rpcContract, {
    status: () => ({ sectionId: storedSectionId(), threads: [...roles.values()].map(toManaged) }),
    start: ({ projectId }) => ensureChief(projectId ?? undefined),
    create: ({ projectId }) => createChief(projectId),
    pending: ({ threadId }) =>
      isActiveChief(roles.get(threadId)) ? { chief: true, ...todoItems(threadId) } : { chief: false, items: [], doneOmitted: 0 },
    modelConfiguration: async () => ({
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          chief: readRoleModel(host.id, "chief"),
          planner: readRoleModel(host.id, "planner"),
          worker: readRoleModel(host.id, "worker"),
          reviewer: readRoleModel(host.id, "reviewer"),
          advisor: readRoleModel(host.id, "advisor"),
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
  });

  const usage = [
    "Usage:",
    "  bb chief status [--project proj_id] [--json]",
    "  bb chief start [--project proj_id] [--json]",
    "  bb chief create [--project proj_id] [--json]",
    "  bb chief adopt --thread thr_id [--json]",
    "  bb chief plan --title \"…\" --mission \"…\" [--context \"…\"] [--json]",
    "  bb chief consult --title \"…\" --mission \"…\" [--context \"…\"] [--worker thr_id] [--json]",
    "  bb chief delegate --title \"…\" --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--branch feature/…] [--issue-url …] [--pr-url …] [--replaces thr_id] [--plan-thread thr_id --wave N] [--unplanned-reason \"…\"] [--json]",
    "  bb chief inspect <thread-id>",
    "  bb chief continue <thread-id> --instruction \"…\" [--json]",
    "  bb chief stop <thread-id> [--reason \"…\"] [--json]",
    "  bb chief review [<worker-thread-id>] [--branch feature/… | --pull-request 123] [--focus \"…\"] [--json]",
    "  bb chief complete <thread-id> [--result \"…\"] [--json]",
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
      { name: "consult", summary: "Start a read-only advisor on a hard problem or a change that keeps failing review", usage: "bb chief consult --title \"…\" --mission \"…\" [--worker thr_id] [--json]" },
      { name: "delegate", summary: "Start a clearly titled worker in a managed worktree", usage: "bb chief delegate --title \"…\" --mission \"…\" [--branch feature/…] [--issue-url …] [--pr-url …] [--replaces thr_id] [--plan-thread thr_id --wave N] [--unplanned-reason \"…\"] [--json]" },
      { name: "inspect", summary: "Inspect a managed thread's live and reported evidence", usage: "bb chief inspect <thread-id>" },
      { name: "continue", summary: "Continue a managed worker or reviewer", usage: "bb chief continue <thread-id> --instruction \"…\" [--json]" },
      { name: "stop", summary: "Interrupt a stuck managed thread, keeping its worktree for a replacement", usage: "bb chief stop <thread-id> [--reason \"…\"] [--json]" },
      { name: "review", summary: "Start or return a read-only review for a worker, pull request, or branch", usage: "bb chief review [<worker-thread-id>] [--branch feature/… | --pull-request 123] [--focus \"…\"] [--json]" },
      { name: "complete", summary: "Mark verified, non-running managed work complete", usage: "bb chief complete <thread-id> [--result \"…\"] [--json]" },
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
          const managedRows = rosterFor(projectId, true);
          const text = [
            ...pendingLines(managedRows, todoLines(projectId)),
            ...managedRows.map((row) => rosterRowLines(row).join("\n  ")),
          ].join("\n");
          return ok({ sectionId: storedSectionId(), threads: managedRows.map(toManaged) }, text);
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
        if (command === "consult") {
          const parsed = consultParams.safeParse({
            title: args.one("title"), mission: args.one("mission"), context: args.one("context"),
            workerThreadId: args.one("worker"),
          });
          if (!parsed.success) return fail(`Invalid consult brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await startConsult(parsed.data, context.threadId);
          return ok(result, `Started advisor “${result.title}” in ${result.threadId}.`);
        }
        if (command === "delegate") {
          const parsed = delegateParams.safeParse({
            title: args.one("title"), mission: args.one("mission"),
            successCriteria: args.all("criteria"), constraints: args.all("constraint"), context: args.one("context"),
            branch: args.one("branch"), issueUrl: args.one("issue-url"), prUrl: args.one("pr-url"),
            replaces: args.one("replaces"),
            planThreadId: args.one("plan-thread"),
            wave: args.one("wave") !== undefined ? Number(args.one("wave")) : undefined,
            unplannedReason: args.one("unplanned-reason"),
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
        if (command === "stop") {
          const parsed = stopParams.safeParse({ threadId: args.positional[0], reason: args.one("reason") });
          if (!parsed.success) return fail(`Invalid stop target: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const row = await stopThread(parsed.data.threadId, parsed.data.reason);
          return ok(toManaged(row), `Stopped “${row.title}”. ${row.recommendation}`);
        }
        if (command === "review") {
          const parsed = reviewParams.safeParse({
            workerThreadId: args.positional[0],
            pullRequest: args.one("pull-request"),
            branch: args.one("branch"),
            focus: args.one("focus"),
          });
          if (!parsed.success) return fail(`Invalid review target: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          if (parsed.data.workerThreadId) {
            const result = await startReview(parsed.data.workerThreadId, parsed.data.focus);
            return ok(result, `${result.created ? "Started" : "Using existing"} “${result.title}” in ${result.threadId}.`);
          }
          const { chief, projectId } = await owningChief(context.threadId);
          const branch = parsed.data.branch
            ?? (await resolvePullRequestBranch(parsed.data.pullRequest!, await projectPath(projectId)))
            ?? parsed.data.pullRequest!;
          const result = await startBranchReview(chief.thread_id, projectId, branch, parsed.data.pullRequest ?? null, parsed.data.focus);
          return ok(result, `${result.created ? "Started" : "Using existing"} “${result.title}” in ${result.threadId}.`);
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

  pendingReady = true;
  try {
    await reconcile(); // each reconciled row's reloadRoles() sweeps rows absorbed before this version
  } catch (error) {
    bb.log.warn(`Initial reconciliation deferred: ${String(error)}`);
  }
  await plannerEnabled().catch((error) => bb.log.warn(`Could not read the planner setting: ${String(error)}`));
  const initial = await settings.get();
  if (initial.autoSpawn && initial.chiefProject) {
    void ensureChief(initial.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
  }
  bb.log.info("Chief supervisor loaded");
}
