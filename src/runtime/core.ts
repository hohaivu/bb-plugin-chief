import { createPlanLifecycle } from "../plan/planLifecycle";
import { createPlanProgress } from "../plan/planProgress";
import { PR_AGENT_DIR } from "../review/prAgent";
import { agentCapSchema, RESEARCH_DEFAULT_TIMEOUT_MINUTES, timeoutSchema } from "../research/research";
import { createReviewLedger } from "../review/reviewLedger";
import { MIGRATIONS } from "../db/migrations";
import { type ManagedRow, terminal } from "../types";
import { createThreadStore } from "../db/threadStore";
import { createWaveSchedule } from "../plan/waveSchedule";
import { BUSY_STATUSES } from "./constants";
import type { Ctx } from "./context";

export const ALERT_RETRY_BASE_MS = 30_000;
export const ALERT_RETRY_MAX_MS = 1_800_000;
export const COORDINATOR_ALERT_MAX_ATTEMPTS = 10;
/** A row with attempts > 0 may be resent: its backoff elapsed and, for a Coordinator-kind row, it is under the cap. */
export function retryDue(row: { dedupe_key: string; attempts: number; last_attempt_at: number | null }, now: number) {
  if (row.attempts >= COORDINATOR_ALERT_MAX_ATTEMPTS && row.dedupe_key.includes(":coordinator-")) return false;
  return (row.last_attempt_at ?? 0) + Math.min(ALERT_RETRY_BASE_MS * 2 ** Math.min(row.attempts - 1, 6), ALERT_RETRY_MAX_MS) <= now;
}

export function createCore(ctx: Ctx) {
  const { bb } = ctx;
  const settings = bb.settings.define({
    chiefProject: { type: "project", label: "Default Chief project" },
    stallMinutes: { type: "string", label: "Stall threshold (minutes)", default: "15" },
    plannerEnabled: {
      type: "boolean",
      label: "Plan before delegating",
      description: "Lets Chief send work to a read-only planner first, read the plan, and delegate it.",
      default: true,
    },
    researchEnabled: {
      type: "boolean",
      label: "Researcher",
      description: "Lets Chief and planners run read-only chief_research surveys and investigations as BB workflows. They share one config.",
      default: true,
    },
    researchMaxAgentCalls: { type: "number", label: "Researcher: agent calls per run (1–100)", default: 24, experimental_schema: agentCapSchema },
    researchSurveyTimeoutMinutes: { type: "number", label: "Researcher: survey timeout (minutes, 1–60)", default: RESEARCH_DEFAULT_TIMEOUT_MINUTES, experimental_schema: timeoutSchema },
    researchInvestigateTimeoutMinutes: { type: "number", label: "Researcher: investigate timeout (minutes, 1–60)", default: RESEARCH_DEFAULT_TIMEOUT_MINUTES, experimental_schema: timeoutSchema },
    autoSpawn: {
      type: "boolean",
      label: "Auto-spawn Chief",
      description: "Automatically start a Chief supervisor when BB opens, the default project changes, or an active project Chief is missing.",
      default: false,
    },
    retroJudge: {
      type: "boolean",
      label: "Grade completed plans (retro judge)",
      description: "When a plan completes, a read-only judge scores its threads and the Chief handoffs (at most 9 model calls per plan) and files lesson proposals that wait for your accept. Off = no retro runs.",
      default: true,
    },
    forgeOwnerHandle: {
      type: "string",
      label: "Forge handle to @-mention on escalations",
      description: "Empty = the forge CLI's logged-in user.",
      default: "",
    },
    cascadeArchive: {
      type: "boolean",
      label: "Archive managed threads with their Chief",
      description: "Planners, workers, reviewers, and advisors started while this is on are archived when their Chief is archived — and deleted when it is deleted, worktrees included. Ownership is fixed at start: threads already running keep their current behavior, and a replacement Chief does not inherit the children of the one it replaced.",
      default: true,
    },
    cleanupApproved: {
      type: "boolean",
      label: "Clean up approved work",
      description: "After Chief completes a worker with an approving review (or a design wave with the owner's approval), a background cleanup worker archives its task's threads when nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there. Override and skipped-review (skipReview) completions are never cleaned up.",
      default: true,
    },
    reviewEngine: {
      type: "select",
      options: ["reviewer", "pr-agent", "both"],
      label: "Review engine",
      description: "reviewer (default): the reviewer reads the code. pr-agent: the reviewer runs pr-agent on each pinned pull request and reports its result; other targets get a direct review. both: pr-agent plus a direct review in a helper thread, combined into one report. Any pr-agent failure falls back to a direct review. pr-agent never posts to the pull request.",
      default: "reviewer",
    },
    prAgentDir: {
      type: "string",
      label: "pr-agent checkout",
      description: "Directory where uv run pr-agent runs; it uses its own .secrets.toml.",
      default: PR_AGENT_DIR,
    },
    tracker: {
      type: "select",
      options: ["none", "bb-tasks"],
      label: "Task tracker",
      description: "none (default) or bb-tasks: mirror Chief work to bb Tasks. Off deletes nothing.",
      default: "none",
    },
    trackerProjects: {
      type: "string",
      label: "Tracker projects",
      experimental_multiline: true,
      description: "One Chief project = tracker project per line, e.g. proj_abc=ABC",
      default: "",
    },
    sentryDsn: { type: "string", label: "Sentry DSN", description: "Empty = nothing is sent. Failures, review outcomes, plugin warnings and failed chief_* calls are mirrored as scrubbed metadata.", secret: true },
    sentryAuthToken: { type: "string", label: "Sentry read token (event:read, project:read)", secret: true },
    sentryOrg: { type: "string", label: "Sentry organization slug", default: "" },
    sentryProject: { type: "string", label: "Sentry project slug", default: "" },
    sentryApiUrl: { type: "string", label: "Sentry API URL", default: "https://sentry.io" },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  // JS, not strftime, so the pinned snapshot clock sets it; OR IGNORE keeps the first startup's value.
  db.prepare(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('failure_events_since', ?)`).run(String(Date.now()));
  // Threads created before this key cannot be proved free of artifact fallbacks, so their storage is kept.
  db.prepare(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('artifact_fallbacks_since', ?)`).run(String(Date.now()));
  // Plans completed before the retro grader existed are never graded (no backfill); set at runtime like failure_events_since.
  db.prepare(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('retros_since', ?)`).run(String(Date.now()));

  const activeChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND chief_thread_id IS NULL AND COALESCE(coordinator,0)=0 AND project_id=? AND state NOT IN ('failed','deleted','archived','complete') ORDER BY created_at DESC LIMIT 1`,
  );
  const latestChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND chief_thread_id IS NULL AND COALESCE(coordinator,0)=0 AND project_id=? ORDER BY created_at DESC LIMIT 1`,
  );
  const chiefCountForProject = db.prepare<[string]>(
    `SELECT COUNT(*) AS count FROM managed_threads WHERE role='chief' AND chief_thread_id IS NULL AND project_id=?`,
  );
  // Every reviewer of a worker, whatever its state: chainFails reads completed reviewers too.
  const reviewerFails = db.prepare<[string]>(
    `SELECT r.fails FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? AND r.fails IS NOT NULL ORDER BY r.created_at DESC, r.rowid DESC`,
  );
  const existingBranchReview = db.prepare<[string, string, string]>(
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id IS NULL AND chief_thread_id=? AND project_id=? AND branch=? AND state NOT IN ('complete','archived','deleted') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  // An alert to a Chief that is complete, archived or deleted can never land (handOver
  // retargets a superseded Chief's alerts), so it must not hold one of the 100 retry slots.
  // A live Chief's worker and report alerts retry without a cap: the worker was told not to report again. Coordinator alerts stop at COORDINATOR_ALERT_MAX_ATTEMPTS.
  // A retried row waits its backoff (see retryDue, the same numbers); rows not due take no slot of the 100.
  // A row never attempted waits 60 s: the report intake writes a fallback row in its transaction and replaces it with the full alert, so a retry must not race that.
  const pendingAlerts = db.prepare<[number, number]>(
    `SELECT * FROM alert_outbox WHERE delivered_at IS NULL
      AND ((attempts = 0 AND created_at <= ?) OR (attempts > 0 AND COALESCE(last_attempt_at, 0) + MIN(${ALERT_RETRY_BASE_MS} << MIN(attempts - 1, 6), ${ALERT_RETRY_MAX_MS}) <= ?))
      AND (attempts < ${COORDINATOR_ALERT_MAX_ATTEMPTS} OR dedupe_key NOT LIKE '%:coordinator-%')
      AND NOT EXISTS (
      SELECT 1 FROM managed_threads WHERE thread_id=alert_outbox.target_thread_id AND state IN ('complete','archived','deleted')
    ) ORDER BY created_at ASC LIMIT 100`,
  );
  const roleModelRow = db.prepare<[string, string]>(
    `SELECT provider_id, model, reasoning_level FROM chief_models WHERE host_id=? AND role=?`,
  );
  const researchModelRow = db.prepare<[string, string]>(
    `SELECT provider_id, model, reasoning_level FROM research_mode_models WHERE host_id=? AND mode=?`,
  );
  // chief_todos.chief_thread_id is the owning Chief (NULL = legacy, from before ownership).
  const todosForProject = db.prepare<[string]>(
    `SELECT * FROM chief_todos WHERE project_id=? AND state='open' ORDER BY id ASC`,
  );
  const closedTodosForProject = db.prepare<[string]>(
    `SELECT * FROM chief_todos WHERE project_id=? AND state<>'open' ORDER BY id ASC`,
  );
  const todoById = db.prepare<[number, string]>(`SELECT * FROM chief_todos WHERE id=? AND project_id=?`);
  const insertTodo = db.prepare<[string, string, string, string | null, number, number]>(
    `INSERT INTO chief_todos (project_id, chief_thread_id, text, after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateTodo = db.prepare<[string, string | null, string, number, number, string]>(
    `UPDATE chief_todos SET text=?, after=?, state=?, updated_at=? WHERE id=? AND project_id=?`,
  );
  // ponytail: global, not per host: usage limits are account-level; key by host if a provider id ever maps to different accounts per machine.
  // ponytail: cooldowns are per provider+model; legacy model='' rows (provider-wide, from before this) are never matched, so they are inert.
  // ponytail: expired rows are ignored, never cleaned; they are bounded by the provider/model pairs.
  const anyCooldown = db.prepare<[number]>(`SELECT 1 FROM provider_cooldowns WHERE until_at > ? LIMIT 1`);
  const cooldownFor = db.prepare<[string, string, number]>(
    `SELECT provider_id, model, until_at, reason FROM provider_cooldowns WHERE provider_id=? AND model=? AND until_at > ? ORDER BY until_at DESC LIMIT 1`,
  );
  const upsertCooldown = db.prepare<[string, string, number, string, number]>(
    `INSERT INTO provider_cooldowns (provider_id, model, until_at, reason, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model) DO UPDATE SET until_at=MAX(until_at, excluded.until_at), reason=excluded.reason, updated_at=excluded.updated_at`,
  ); // set once the state the sweep reads is initialised
  // The sweep follows a reload only once pendingReady, as before the store existed.
  const store = createThreadStore<ManagedRow>(db, {
    onReload: () => {
      if (!ctx.state.pendingReady) return;
      // ponytail: sweeps on every reload, O(planners × rows); index by plan_thread_id if rosters grow large.
      void ctx.sweep();
    },
  });
  const ledger = createReviewLedger<ManagedRow>(db, store.get, store, { busy: (status) => BUSY_STATUSES.has(status) });
  const schedule = createWaveSchedule<ManagedRow>(store.rows);
  const { planWavesFor, isDesignWave, isTestWave, latestWorker, latestSideWriter, specWave, reviewTargetsFor, coexists, sideLane, specWriters, taskWriters, writerPending, chainOwner, chainStarted } = schedule;

  const progress = createPlanProgress<ManagedRow>(store.rows, schedule, ledger, { terminal, busy: (status) => BUSY_STATUSES.has(status) });
  const { onSpecChain } = progress;
  const plans = createPlanLifecycle<ManagedRow>(store, schedule, ledger, (planner: ManagedRow): string | null => ctx.planReviewRefusal(planner));
  return { activeChiefForProject, anyCooldown, chainOwner, chainStarted, chiefCountForProject, closedTodosForProject, coexists, cooldownFor, db, insertTodo, isDesignWave, isTestWave, latestChiefForProject, latestSideWriter, latestWorker, ledger, onSpecChain, pendingAlerts, planWavesFor, plans, progress, researchModelRow, reviewTargetsFor, reviewerFails, roleModelRow, schedule, settings, sideLane, specWave, specWriters, store, taskWriters, todoById, todosForProject, updateTodo, upsertCooldown, writerPending };
}

