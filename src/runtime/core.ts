import { createPlanLifecycle } from "../../planLifecycle";
import { createPlanProgress } from "../../planProgress";
import { PR_AGENT_DIR } from "../review/prAgent";
import { agentCapSchema, RESEARCH_DEFAULT_TIMEOUT_MINUTES, timeoutSchema } from "../research/research";
import { createReviewLedger } from "../../reviewLedger";
import { MIGRATIONS } from "../db/migrations";
import { type ManagedRow, terminal } from "../types";
import { createThreadStore } from "../../threadStore";
import { createWaveSchedule } from "../../waveSchedule";
import { BUSY_STATUSES } from "./constants";
import type { Ctx } from "./context";

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
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  // JS, not strftime, so the pinned snapshot clock sets it; OR IGNORE keeps the first startup's value.
  db.prepare(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('failure_events_since', ?)`).run(String(Date.now()));
  // Threads created before this key cannot be proved free of artifact fallbacks, so their storage is kept.
  db.prepare(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('artifact_fallbacks_since', ?)`).run(String(Date.now()));

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
  // A live Chief's alerts retry until they land: the worker was told not to report again.
  // A row never attempted waits 60 s: the report intake writes a fallback row in its transaction and replaces it with the full alert, so a retry must not race that.
  const pendingAlerts = db.prepare<[number]>(
    `SELECT * FROM alert_outbox WHERE delivered_at IS NULL AND (attempts > 0 OR created_at <= ?) AND NOT EXISTS (
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
  const { planWavesFor, isDesignWave, isTestWave, waveWorkers, specWave, reviewTargetsFor } = schedule;

  const progress = createPlanProgress<ManagedRow>(store.rows, schedule, ledger, { terminal, busy: (status) => BUSY_STATUSES.has(status) });
  const { onSpecChain } = progress;
  const plans = createPlanLifecycle<ManagedRow>(store, schedule, ledger, (planner: ManagedRow): string | null => ctx.planReviewRefusal(planner));
  return { activeChiefForProject, anyCooldown, chiefCountForProject, closedTodosForProject, cooldownFor, db, insertTodo, isDesignWave, isTestWave, latestChiefForProject, ledger, onSpecChain, pendingAlerts, planWavesFor, plans, progress, researchModelRow, reviewTargetsFor, reviewerFails, roleModelRow, schedule, settings, specWave, store, todoById, todosForProject, updateTodo, upsertCooldown, waveWorkers };
}

