import { FORGE_COMMENTS_TABLE } from "../forge/forgeComments";
import { TRACKER_TABLES } from "../tracker/trackerSync";

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
    // Inert legacy column, kept for schema compatibility; nothing reads or writes it.
    `ALTER TABLE managed_threads ADD COLUMN release_pending INTEGER NOT NULL DEFAULT 0`,
    // chief_research's per-machine model pick for each role and stage; no row means inherit the caller's.
    `CREATE TABLE IF NOT EXISTS research_models (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','reviewer')), stage TEXT NOT NULL CHECK(stage IN ('scan','verify','combine')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role, stage))`,
    // One chief_research pick per machine for every stage and role; per-role, per-stage picks are discarded.
    `CREATE TABLE IF NOT EXISTS research_model (host_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    `DROP TABLE IF EXISTS research_models`,
    // chief_research's per-machine pick per mode; the single pick is copied to every mode.
    `CREATE TABLE IF NOT EXISTS research_mode_models (host_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('survey','review','investigate')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, mode))`,
    `INSERT INTO research_mode_models (host_id, mode, provider_id, model, reasoning_level, updated_at) SELECT r.host_id, m.mode, r.provider_id, r.model, r.reasoning_level, r.updated_at FROM research_model r CROSS JOIN (SELECT 'survey' AS mode UNION ALL SELECT 'review' UNION ALL SELECT 'investigate') m`,
    // The single pick now lives on in every mode.
    `DROP TABLE IF EXISTS research_model`,
    // A child Chief's todos are its own: NULL keeps the project-wide scope top-level Chiefs share.
    `ALTER TABLE chief_todos ADD COLUMN chief_thread_id TEXT`,
    // A provider model hit its usage limit; new spawns on it are refused until until_at. model '' rows are legacy and ignored.
    `CREATE TABLE IF NOT EXISTS provider_cooldowns (provider_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', until_at INTEGER NOT NULL, reason TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (provider_id, model))`,
    // One per machine: reviewers and research switch to it while their primary cools down.
    `CREATE TABLE IF NOT EXISTS chief_fallback_model (host_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    // A worker's replaces: predecessor, so a branchless fix chain still groups into one task for bb chief stats.
    `ALTER TABLE managed_threads ADD COLUMN replaces_thread_id TEXT`,
    // bb chief stats counters; neither was recorded before this migration (see stats_since).
    `ALTER TABLE managed_threads ADD COLUMN thread_errors INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE managed_threads ADD COLUMN busy_rejections INTEGER NOT NULL DEFAULT 0`,
    `INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('stats_since', CAST(strftime('%s','now') AS INTEGER) * 1000)`,
    // The per-machine fallback model was removed; a cooling provider is refused outright.
    `DROP TABLE IF EXISTS chief_fallback_model`,
    // A reviewer's full verdict file, handed to the replacement worker, the next reviewer and the advisor.
    `ALTER TABLE managed_threads ADD COLUMN verdict_path TEXT`,
    // A worker's kind ("designer" for design-tool work); NULL reads as a plain worker.
    `ALTER TABLE managed_threads ADD COLUMN kind TEXT`,
    // A Designer model pick; no row inherits the Worker pick.
    `CREATE TABLE chief_models_v6 (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor','designer')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role))`,
    `INSERT INTO chief_models_v6 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v6 RENAME TO chief_models`,
    // Nested Chiefs were removed: existing ones become ordinary top-level Chiefs, and their todos join the project-wide list.
    `UPDATE managed_threads SET chief_thread_id=NULL, state=CASE WHEN state IN ('ready','blocked') THEN 'idle' ELSE state END, blocker=CASE WHEN state='blocked' THEN NULL ELSE blocker END WHERE role='chief' AND chief_thread_id IS NOT NULL`,
    `UPDATE chief_todos SET chief_thread_id=NULL WHERE chief_thread_id IS NOT NULL`,
    // Approaches a worker or reviewer ruled out, carried down a replaces: chain into the successor's brief.
    `ALTER TABLE managed_threads ADD COLUMN fails TEXT`,
    // Shared plan-run log: FACT/FAIL notes workers on one plan read with chief_log, each from its own cursor.
    `CREATE TABLE plan_log (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_thread_id TEXT NOT NULL, author_thread_id TEXT NOT NULL, wave INTEGER, kind TEXT NOT NULL CHECK (kind IN ('FACT','FAIL')), text TEXT NOT NULL, scope TEXT NOT NULL, basis TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX plan_log_plan ON plan_log(plan_thread_id, id)`,
    `ALTER TABLE managed_threads ADD COLUMN log_read_id INTEGER`,
    // legacy: workers delegated on the retired simple tag; read only by bb chief stats
    `ALTER TABLE managed_threads ADD COLUMN simple INTEGER`,
    // chief_continue stall-clock resets since the last report, so repeated nudges cannot postpone the hard stall alert forever.
    `ALTER TABLE managed_threads ADD COLUMN stall_resets INTEGER NOT NULL DEFAULT 0`,
    // bb chief stats usage tracking; nothing is backfilled, so older rows read as unknown (planner_on NULL) or absent.
    // One row per chief_research call. outcome: succeeded | partial | failed | still_running | timed_out | spawned | start_failed | error.
    `CREATE TABLE chief_research_calls (id INTEGER PRIMARY KEY, caller_thread_id TEXT, role TEXT, mode TEXT, run_id TEXT, outcome TEXT, started_at INTEGER, ended_at INTEGER)`,
    // Worker row only: whether planning was on when it was delegated (1/0); NULL for rows from before this column.
    `ALTER TABLE managed_threads ADD COLUMN planner_on INTEGER`,
    // One row per reviewer verdict report; survives chief_continue (which clears the row's verdict) and replacement reviewers.
    `CREATE TABLE reviewer_verdicts (id INTEGER PRIMARY KEY, reviewer_thread_id TEXT, worker_thread_id TEXT, verdict TEXT, report_seq INTEGER, at INTEGER)`,
    // The last chief_report's short summary and the per-report file holding its full text; both follow `result`.
    `ALTER TABLE managed_threads ADD COLUMN summary TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN report_path TEXT`,
    // Bumped each time chief_complete replaces the result, so a pending report-path publication can tell its result was replaced.
    `ALTER TABLE managed_threads ADD COLUMN result_rev INTEGER NOT NULL DEFAULT 0`,
    // Advisor row only: when it first sent a ready or blocked report (its actual advice). Set once; stop, complete, status sync and later reports never clear it. Old rows stay NULL.
    `ALTER TABLE managed_threads ADD COLUMN advised_at INTEGER`,
    // Durable lessons an advisor recorded at a consult; the newest few are injected into every later managed thread in the project.
    `CREATE TABLE chief_lessons (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, source_thread_id TEXT NOT NULL, worker_thread_id TEXT, at INTEGER NOT NULL)`,
    `CREATE INDEX chief_lessons_project ON chief_lessons(project_id, at)`,
    // Admitting the researcher role widens managed_threads' role CHECK, which SQLite cannot alter, so rebuild it once more
    // (same pattern as managed_threads_v3). Column order is the live table's: v3's columns, then every ALTER-added column in
    // migration order, which INSERT ... SELECT * relies on. If another migration that adds a managed_threads column is
    // merged before this one, list its column here too; a mismatch fails the INSERT loudly instead of dropping data.
    `CREATE TABLE managed_threads_v4 (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor','researcher')),
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
      parent_thread_id TEXT,
      stop_alerted_cycle INTEGER,
      plan_waves TEXT,
      plan_thread_id TEXT,
      plan_wave INTEGER,
      regression INTEGER,
      report_seq INTEGER NOT NULL DEFAULT 0,
      reviewed_report_seq INTEGER,
      unplanned_reason TEXT,
      release_pending INTEGER NOT NULL DEFAULT 0,
      replaces_thread_id TEXT,
      thread_errors INTEGER NOT NULL DEFAULT 0,
      busy_rejections INTEGER NOT NULL DEFAULT 0,
      verdict_path TEXT,
      kind TEXT,
      fails TEXT,
      log_read_id INTEGER,
      simple INTEGER,
      stall_resets INTEGER NOT NULL DEFAULT 0,
      planner_on INTEGER,
      summary TEXT,
      report_path TEXT,
      result_rev INTEGER NOT NULL DEFAULT 0,
      advised_at INTEGER
    )`,
    `INSERT INTO managed_threads_v4 SELECT * FROM managed_threads`,
    `DROP TABLE managed_threads`,
    `ALTER TABLE managed_threads_v4 RENAME TO managed_threads`,
    // Dropping the table dropped its index with it.
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    // Backlog board: a todo exported to a task ("pending:<id>" while the file is being created), and the task a worker implements.
    `ALTER TABLE chief_todos ADD COLUMN backlog_task_id TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN backlog_task_id TEXT`,
    // The PR head commit a verdict was given for (copied from the reviewer row by the server, never from a report), and the commit a PR-bound reviewer was pinned to at spawn.
    `ALTER TABLE reviewer_verdicts ADD COLUMN head_sha TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN reviewed_head_sha TEXT`,
    // Design-wave worker only: the owner's approval of its artboards as Chief quoted it (chief_owner_approval), and when. A new report or chief_continue clears both.
    `ALTER TABLE managed_threads ADD COLUMN owner_approval TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN owner_approved_at INTEGER`,
    // The state of the row's latest chief_report (ready, blocked, active, idle, failed): row.state moves on once the thread runs again, this does not.
    `ALTER TABLE managed_threads ADD COLUMN last_report_state TEXT`,
    // Rows from before the column: a ready row that has reported provably last reported ready. Active/blocked/idle rows stay NULL (unknown).
    `UPDATE managed_threads SET last_report_state='ready' WHERE state='ready' AND report_seq > 0 AND last_report_state IS NULL`,
    // One review covers every branch of a plan: one row per worker a reviewer covers, with the report and PR head it was bound to. Reviewers from before are backfilled from their own row.
    `CREATE TABLE IF NOT EXISTS review_targets (reviewer_thread_id TEXT NOT NULL, worker_thread_id TEXT NOT NULL, report_seq INTEGER, head_sha TEXT, pr_url TEXT, branch TEXT, PRIMARY KEY (reviewer_thread_id, worker_thread_id))`,
    `INSERT OR IGNORE INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha, pr_url, branch) SELECT thread_id, worker_thread_id, reviewed_report_seq, reviewed_head_sha, NULL, branch FROM managed_threads WHERE role='reviewer' AND worker_thread_id IS NOT NULL`,
    // The covered worker's report a verdict row was given for (-1: re-pointed before the verdict); NULL on rows from before, which read the reviewer's reviewed_report_seq.
    `ALTER TABLE reviewer_verdicts ADD COLUMN worker_report_seq INTEGER`,
    // A reviewer's latest structured findings (JSON array of {file, line?, severity, message, fix?}); replaced by each report.
    `ALTER TABLE managed_threads ADD COLUMN findings TEXT`,
    // Who recorded a lesson: 'reviewer' lessons go to later reviewers only; NULL (older rows) or 'advisor' go to every managed thread.
    `ALTER TABLE chief_lessons ADD COLUMN role TEXT`,
    // Worker row only: the shell command the worker's brief makes it run; inherited through replaces:. (Legacy: a removed gate once reran it.)
    `ALTER TABLE managed_threads ADD COLUMN verify_command TEXT`,
    // One row per (source thread, active cycle, kind), written when a transient provider failure or a stall is detected, whether or not its alert is delivered. `detail` is classified from the provider error text only; legacy=1 rows were copied from older alerts and are approximate.
    `CREATE TABLE IF NOT EXISTS chief_failure_events (source_thread_id TEXT NOT NULL, active_cycle INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('provider','stall','hard_stall')), detail TEXT CHECK(detail IS NULL OR detail IN ('usage_limit','connection')), legacy INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (source_thread_id, active_cycle, kind))`,
    // One-time copy of the surviving failed:/stall: alerts, classified as bb chief stats classified them ("usage limit" in the message), so totals carry over. error: and report: keys are never copied.
    `INSERT OR IGNORE INTO chief_failure_events (source_thread_id, active_cycle, kind, detail, legacy, at)
     SELECT source_thread_id,
       CAST(CASE WHEN dedupe_key LIKE '%:failed:%' THEN substr(dedupe_key, instr(dedupe_key, ':failed:') + 8) ELSE substr(dedupe_key, instr(dedupe_key, ':stall:') + 7) END AS INTEGER),
       CASE WHEN dedupe_key LIKE '%:failed:%' THEN 'provider' WHEN dedupe_key LIKE '%:hard' THEN 'hard_stall' ELSE 'stall' END,
       CASE WHEN dedupe_key LIKE '%:failed:%' THEN CASE WHEN instr(message, 'usage limit') > 0 THEN 'usage_limit' ELSE 'connection' END END,
       1, created_at
     FROM alert_outbox WHERE dedupe_key LIKE '%:failed:%' OR dedupe_key LIKE '%:stall:%'`,
    // forge comments outbox: text lives in forgeComments.ts; never edit it (hashed by index)
    FORGE_COMMENTS_TABLE,
    // Planner row only: the tracking issue shared by every wave of its plan.
    `ALTER TABLE managed_threads ADD COLUMN plan_issue_url TEXT`,
    // Planner row only: its one advisor review — NULL (none needed), 'required', 'approved' or 'changes'.
    `ALTER TABLE managed_threads ADD COLUMN plan_review TEXT`,
    // Legacy: one row per gate thread of the removed review gate; no longer written or read.
    `CREATE TABLE IF NOT EXISTS gate_threads (thread_id TEXT PRIMARY KEY, environment_id TEXT, chief_thread_id TEXT, worker_thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, thread_deleted INTEGER NOT NULL DEFAULT 0, delete_attempts INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0)`,
    // Worker row only: when chief_complete saw a positive approval with cleanupApproved on. NULL (override, skipReview, legacy: workers delegated on the retired simple tag, setting off, rows from before) is never cleaned up.
    `ALTER TABLE managed_threads ADD COLUMN cleanup_approved_at INTEGER`,
    // One row per thread the post-approval cleanup handles: its current step, the generation (archived_at) it archived, and the bounded-retry state of that step.
    `CREATE TABLE IF NOT EXISTS cleanup_jobs (thread_id TEXT PRIMARY KEY, chief_thread_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT, branch TEXT, step TEXT NOT NULL CHECK(step IN ('archive','teardown','branch','storage','done')), step_at INTEGER NOT NULL, archived_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    // A thread whose Chief artifacts were written to its storage root because the BB data dir was unknown: its storage may hold evidence and is never cleared.
    `CREATE TABLE IF NOT EXISTS artifact_fallbacks (thread_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
    // Worker row only: Chief's reason for completing it with chief_complete skipReview (no review); NULL otherwise.
    `ALTER TABLE managed_threads ADD COLUMN review_skipped TEXT`,
    // Worker row only: Chief's reason for completing unplanned work with no tester (chief_complete testsSkipped); NULL otherwise.
    `ALTER TABLE managed_threads ADD COLUMN tests_skipped TEXT`,
    // A Tester model pick; no row inherits the Worker pick.
    `CREATE TABLE chief_models_v7 (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor','designer','tester')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role))`,
    `INSERT INTO chief_models_v7 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v7 RENAME TO chief_models`,
    // A Spec Writer model pick; no row inherits the Worker pick.
    `CREATE TABLE chief_models_v8 (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor','designer','tester','spec-writer')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role))`,
    `INSERT INTO chief_models_v8 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v8 RENAME TO chief_models`,
    // One owner per shared worktree and cleanup action: the first cleanup job to reach the decisive teardown observation claims it; other jobs on that environment skip it.
    `CREATE TABLE IF NOT EXISTS cleanup_environment_claims (environment_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('branch','trouble','stuck')), thread_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (environment_id, action))`,
    ...TRACKER_TABLES,
    // A Coordinator is a Chief row with coordinator=1; a child Chief names its Coordinator here. chief_thread_id keeps meaning "managed work".
    `ALTER TABLE managed_threads ADD COLUMN coordinator INTEGER`,
    `ALTER TABLE managed_threads ADD COLUMN coordinator_thread_id TEXT`,
    // Worker row only: Chief's reason for reviewing a fix without the tester rerun it owed (chief_review retestSkipped); NULL otherwise.
    `ALTER TABLE managed_threads ADD COLUMN retest_skipped TEXT`,
    // The one event ledger: failures, review outcomes and nudges, one row per dedupe unit. event_id is random, doubles as the Sentry event id and is the commit receipt a send checks.
    `CREATE TABLE chief_events (id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, project_id TEXT, thread_id TEXT, role TEXT, plan_thread_id TEXT, plan_wave INTEGER, kind TEXT NOT NULL, detail TEXT)`,
    `CREATE INDEX chief_events_at ON chief_events (at)`,
    `CREATE INDEX chief_events_plan ON chief_events (plan_thread_id)`,
    `CREATE INDEX chief_events_thread_kind ON chief_events (thread_id, kind)`,
    // One row per completed worker, written before the completion that queues cleanup: the evidence cleanup cannot clear. diff_state says whether completion.diff is whole, clipped or missing (diff_note says why).
    `CREATE TABLE chief_completions (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, plan_thread_id TEXT, pr_url TEXT, base TEXT, head_sha TEXT, diff_state TEXT NOT NULL CHECK(diff_state IN ('ok','truncated','unavailable')), diff_note TEXT, diff_path TEXT, brief_path TEXT, at INTEGER NOT NULL)`,
    // The retro grader: one row per completed plan (PK = exclusive claim). run_id is NULL until a launch succeeds; attempts counts starts.
    `CREATE TABLE chief_retros (plan_thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, chief_thread_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed')), run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, started_at INTEGER, last_error TEXT, path TEXT, rubric_version TEXT NOT NULL, at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    // One score per thread, scorer and rubric version. score is NULL for not_applicable and insufficient_evidence.
    `CREATE TABLE chief_scores (thread_id TEXT NOT NULL, plan_thread_id TEXT NOT NULL, role TEXT NOT NULL, scorer TEXT NOT NULL, rubric_version TEXT NOT NULL, label TEXT NOT NULL, score REAL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(thread_id, scorer, rubric_version))`,
    // The lesson gate: proposed -> accepted -> retired (proposed -> retired is a rejection). Rows that exist now are accepted, which keeps today's injection.
    `ALTER TABLE chief_lessons ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'`,
    `ALTER TABLE chief_lessons ADD COLUMN surface TEXT`,
    `ALTER TABLE chief_lessons ADD COLUMN plan_thread_id TEXT`,
    `ALTER TABLE chief_lessons ADD COLUMN evidence TEXT`,
    `ALTER TABLE chief_lessons ADD COLUMN rubric_version TEXT`,
    `ALTER TABLE chief_lessons ADD COLUMN proposal_key TEXT`,
    `ALTER TABLE chief_lessons ADD COLUMN decided_at INTEGER`,
    `ALTER TABLE chief_lessons ADD COLUMN decided_reason TEXT`,
    `CREATE UNIQUE INDEX chief_lessons_proposal ON chief_lessons(proposal_key)`,
    // communication rows only: the plugin's observed counts and the judge's signals as JSON, so the daily report can total them without reopening retro.md.
    `ALTER TABLE chief_scores ADD COLUMN detail TEXT`,
    // When the last delivery try started (written before the send): the outbox backoff reads it.
    `ALTER TABLE alert_outbox ADD COLUMN last_attempt_at INTEGER`,
];
