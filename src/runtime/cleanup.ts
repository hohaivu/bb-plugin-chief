import { cleanupEligible, deleteSafeBranch, ownedBranch } from "../forge/cleanup";
import { clip } from "../core/text";
import { z } from "zod";
import { bounded } from "./exec";
import { BUSY_STATUSES } from "./constants";
import { forgeEnv, prMerged } from "../forge/forge";
import type { Ctx } from "./context";

export function createCleanup(ctx: Ctx) {
  const { bb, db, ledger, store } = ctx;
  /** bb waits 5 min, then retries a failed teardown after 1, 2, 4 and 8 min with hooks of up to 15 min each. */
  const TEARDOWN_LIMIT_MS = 60 * 60_000;
  const MISSING = /not found|404/i;
  const CLEANUP_ATTEMPTS = 3;
  /** How long a job waits on a busy root or live descendants before it gives up on that thread. */
  const CLEANUP_WAIT_MS = 60 * 60_000;
  /** bb's undo window after an archive: its worktree and storage are untouched until it passes. */
  const CLEANUP_GRACE_MS = 5 * 60_000;
  const CLEANUP_READ_MS = 15_000;
  const CLEANUP_CALL_MS = 30_000;
  type CleanupStep = "archive" | "teardown" | "branch" | "storage" | "done";
  interface CleanupJob {
    thread_id: string; chief_thread_id: string; project_id: string; environment_id: string | null; branch: string | null; step: CleanupStep;
    step_at: number; archived_at: number | null; attempts: number; last_error: string | null; outcome: string | null; created_at: number; updated_at: number;
  }
  /** Where a step's third failure lands: the safe outcome (nothing destructive follows a failed archive) and what the alert tells Chief. */
  const CLEANUP_FAILURE: Record<Exclude<CleanupStep, "done">, { next: "storage" | "done"; outcome: string; left: string }> = {
    archive: { next: "done", outcome: "kept: archive failed", left: "the thread, its branch and its storage are untouched" },
    teardown: { next: "storage", outcome: "branch kept: environment unreadable", left: "the bb/ branch (bb's worktree state is unknown)" },
    branch: { next: "storage", outcome: "branch kept: lookup or git failed", left: "the local bb/ branch" },
    storage: { next: "done", outcome: "storage kept", left: "the thread storage" },
  };

  /** Moves a job to its next step in one UPDATE, with the alert that goes with the move in the same transaction. Delivery is
   * not awaited: the outbox row is durable and retryAlerts re-sends it. */
  function cleanupMove(job: CleanupJob, step: CleanupStep, change: { outcome?: string; archivedAt?: number; environmentId?: string | null; branch?: string | null } = {}, alert?: { key: string; message: string }) {
    const key = db.transaction(() => {
      const now = Date.now();
      db.prepare(`UPDATE cleanup_jobs SET step=?, step_at=?, attempts=0, last_error=NULL, outcome=COALESCE(?, outcome), archived_at=COALESCE(?, archived_at),
        environment_id=COALESCE(?, environment_id), branch=COALESCE(?, branch), updated_at=? WHERE thread_id=?`).run(
        step, now, change.outcome ?? null, change.archivedAt ?? null, change.environmentId ?? null, change.branch ?? null, now, job.thread_id,
      );
      return alert ? ctx.writeAlert(store.get(job.thread_id)!, alert.key, alert.message) : null;
    })();
    if (key) void ctx.deliverAlert(key).catch((error) => bb.log.warn(`Cleanup alert ${key} will be retried: ${String(error)}`));
  }

  /** Counts a failed attempt; the third moves the job to the step's safe outcome and tells Chief, in one transaction. */
  function cleanupFail(job: CleanupJob, error: unknown) {
    const detail = clip(error instanceof Error ? error.message : String(error), 500);
    if (job.step === "done") return;
    if (job.attempts + 1 < CLEANUP_ATTEMPTS) {
      db.prepare(`UPDATE cleanup_jobs SET attempts=attempts+1, last_error=?, updated_at=? WHERE thread_id=?`).run(detail, Date.now(), job.thread_id);
      return;
    }
    const failure = CLEANUP_FAILURE[job.step];
    const recover = job.step === "archive" ? `bb thread archive ${job.thread_id}`
      : job.step === "teardown" ? `bb environment show ${job.environment_id ?? "<environment id>"}`
      : job.step === "branch" ? `git branch -D ${job.branch ?? "<branch>"} (only after confirming origin holds its commits)`
      : `bb storage clear-thread --thread ${job.thread_id} --yes${/plugin|method/i.test(detail) && /not found|unknown|not installed|disabled/i.test(detail) ? " (enable the storage-retention plugin first)" : ""}`;
    cleanupMove(job, failure.next, { outcome: failure.outcome }, {
      key: `cleanup-${job.step}-failed:alert`,
      message: `Cleanup of ${job.thread_id} failed at the ${job.step} step after ${CLEANUP_ATTEMPTS} attempts: ${clip(detail, 200)}. Left in place: ${failure.left}. Recover by hand: ${recover}.`,
    });
  }

  /** The thread as bb has it now, or null when it is gone or deleted. Any other read error throws. */
  async function cleanupRead(threadId: string) {
    try {
      const thread = await bounded(() => bb.sdk.threads.get({ threadId }), CLEANUP_READ_MS);
      return thread.deletedAt === null ? thread : null;
    } catch (error) {
      if (MISSING.test(String(error))) return null;
      throw error;
    }
  }

  /** One supervisor-tick pass over the post-approval cleanup: enqueue the threads of positively approved, completed tasks, then
   * move each open job one step. Archive comes first and only when bb's recursive archive cannot reach any other live thread; the
   * branch and the storage follow bb's own teardown and grace. Every failure is bounded: three attempts, then one alert and a
   * safe outcome. One job's error never skips another. With the setting off nothing runs and jobs are kept as they are. */
  async function observeCleanup() {
    if (!ctx.state.cleanupActive) return;
    let eligible = new Set<string>();
    try {
      eligible = cleanupEligible(store.all(), (id) => ledger.targets(id).map((target) => target.worker_thread_id));
      const insert = db.prepare(`INSERT OR IGNORE INTO cleanup_jobs (thread_id, chief_thread_id, project_id, step, step_at, created_at, updated_at) VALUES (?, ?, ?, 'archive', ?, ?, ?)`);
      const now = Date.now();
      for (const id of eligible) {
        const row = store.get(id)!;
        insert.run(id, row.chief_thread_id, row.project_id, now, now, now);
      }
    } catch (error) {
      bb.log.error(`Cleanup could not enqueue approved threads this tick: ${String(error)}`);
    }
    try {
      const jobs = db.prepare(`SELECT * FROM cleanup_jobs WHERE step <> 'done' ORDER BY created_at ASC, rowid ASC`).all() as CleanupJob[];
      for (const job of jobs) {
        try {
          await cleanupStep(job, eligible);
        } catch (error) {
          try { cleanupFail(job, error); }
          catch (inner) { bb.log.error(`Cleanup of ${job.thread_id} could not record a failure at the ${job.step} step (${String(error)}): ${String(inner)}`); }
        }
      }
    } catch (error) {
      bb.log.error(`Cleanup could not read its jobs this tick: ${String(error)}`);
    }
  }

  async function cleanupStep(job: CleanupJob, eligible: Set<string>) {
    const id = job.thread_id;
    const row = store.get(id);
    if (!row) return cleanupMove(job, "done", { outcome: "kept: no managed row" });
    const label = `${row.role} “${row.title}” (${id})`;
    const waited = Date.now() - job.step_at;
    const finish = (outcome: string, alert?: { key: string; message: string }) => cleanupMove(job, "done", { outcome }, alert);

    if (job.step === "archive") {
      const live = await cleanupRead(id);
      if (!live) return finish("deleted");
      if (live.pinnedAt !== null) return finish("kept: pinned");
      let archivedAt = live.archivedAt;
      let environmentId = live.environmentId ?? null;
      if (archivedAt === null) {
        if (BUSY_STATUSES.has(live.status)) return waited > CLEANUP_WAIT_MS ? finish("kept: in use") : undefined;
        // bb's archive is recursive over children, hidden forks and lifecycle dependents with no check of their own: archive only a thread whose closure is itself.
        const [summary, children, forks] = await Promise.all([
          bounded(() => bb.sdk.threads.childSummary({ threadId: id }), CLEANUP_READ_MS),
          bounded(() => bb.sdk.threads.list({ parentThreadId: id, includeHidden: true, limit: 100 }), CLEANUP_READ_MS),
          bounded(() => bb.sdk.threads.list({ sourceThreadId: id, includeHidden: true, limit: 100 }), CLEANUP_READ_MS),
        ]);
        const liveOthers = (page: typeof children) => page.length >= 100 || page.some((other) => other.id !== id && other.archivedAt === null && other.deletedAt === null);
        if (summary.unarchivedDescendantCount > 0 || liveOthers(children) || liveOthers(forks)) {
          if (waited <= CLEANUP_WAIT_MS) return;
          return finish("kept: live descendants", {
            key: "cleanup-scope-kept:alert",
            message: `Cleanup of ${label} did not archive it: other live threads would be archived with it (children, forks or dependents) and they stayed live for 60 minutes. Left in place: the thread, its branch and its storage. Archive it yourself when they are done: bb thread archive ${id}.`,
          });
        }
        const archived = await bounded(() => bb.sdk.threads.archive({ threadId: id }), CLEANUP_CALL_MS);
        const extra = archived.archivedThreadIds.filter((other) => other !== id);
        if (extra.length) {
          const key = ctx.enqueueAlert(row, "cleanup-scope-extra:alert", `Cleaning up ${label} archived ${extra.length} other thread(s) with it: ${extra.join(", ")}. Restore each with: ${extra.map((other) => `bb thread unarchive ${other}`).join("; ")}.`);
          void ctx.deliverAlert(key).catch((error) => bb.log.warn(`Cleanup alert ${key} will be retried: ${String(error)}`));
        }
        const after = await bounded(() => bb.sdk.threads.get({ threadId: id }), CLEANUP_READ_MS);
        if (after.archivedAt === null) throw new Error("the archive call returned but the thread is not archived");
        archivedAt = after.archivedAt;
        environmentId = after.environmentId ?? environmentId;
      }
      // Step-out: the thread's own bb/ branch, only when its worktree environment is read and its name is owned by this job's Chief and project.
      let branch: string | null = null;
      let unreadable: string | null = null;
      if (environmentId) {
        try {
          const environment = await bounded(() => bb.sdk.environments.get({ environmentId: environmentId! }), CLEANUP_READ_MS);
          const owns = (threadId: string) => { const owner = store.get(threadId); return eligible.has(threadId) && owner?.chief_thread_id === job.chief_thread_id && owner?.project_id === job.project_id; };
          branch = environment.isWorktree ? ownedBranch(environment.branchName, owns) : null;
        } catch (error) { unreadable = clip(String(error), 200); }
      }
      return cleanupMove(job, branch ? "teardown" : "storage", { archivedAt, environmentId, branch, outcome: unreadable ? "branch kept: environment unreadable" : undefined }, unreadable ? {
        key: "cleanup-branch-kept:alert",
        message: `Cleanup of ${label} archived it but could not read its environment ${environmentId} (${unreadable}), so its bb/ branch was not touched. Left in place: the branch. Inspect: bb environment show ${environmentId}.`,
      } : undefined);
    }

    // Every later step belongs to the archive generation it recorded: an unarchive, or an unarchive and a re-archive, ends the job.
    const generation = job.archived_at;
    if (generation === null) throw new Error("no archive time recorded for this job");
    if (job.step === "storage" && Date.now() < generation + CLEANUP_GRACE_MS) return;
    const live = await cleanupRead(id);
    if (!live) return finish("kept: thread deleted");
    if (live.archivedAt !== generation) return finish("kept: unarchived");

    if (job.step === "teardown") {
      let environment: Awaited<ReturnType<typeof bb.sdk.environments.get>> | null = null;
      try {
        environment = await bounded(() => bb.sdk.environments.get({ environmentId: job.environment_id! }), CLEANUP_READ_MS);
      } catch (error) {
        if (!MISSING.test(String(error))) throw error; // a read error is never proof that the environment is gone
      }
      // One job per shared worktree owns each action: the first to reach it claims it, the others end at storage with no alert. "In use" claims nothing.
      const shared = (action: "branch" | "trouble" | "stuck") => {
        const claim = db.transaction(() => {
          db.prepare(`INSERT OR IGNORE INTO cleanup_environment_claims (environment_id, action, thread_id, at) VALUES (?, ?, ?, ?)`).run(job.environment_id, action, id, Date.now());
          return db.prepare(`SELECT thread_id FROM cleanup_environment_claims WHERE environment_id=? AND action=?`).get(job.environment_id, action) as { thread_id: string };
        })();
        if (claim.thread_id === id) return false;
        cleanupMove(job, "storage", { outcome: `worktree shared: ${action} handled by ${claim.thread_id}` });
        return true;
      };
      if (!environment || environment.status === "destroyed" || environment.lifecycle.phase === "destroyed" || environment.hostLifecycle === "removed") return shared("branch") ? undefined : cleanupMove(job, "branch");
      const teardown = environment.lifecycle.teardown;
      const trouble = teardown?.message?.startsWith("Needs recovery:") ? teardown.message
        : environment.hostLifecycle === "cleanup-failed" && teardown?.status !== "running" ? `bb reports cleanup-failed${teardown?.message ? `: ${teardown.message}` : ""}` : null;
      const left = `Left in place: the bb/ branch ${job.branch} and the worktree. Inspect: bb environment show ${job.environment_id}.`;
      if (trouble) return shared("trouble") ? undefined : cleanupMove(job, "storage", { outcome: "branch kept: teardown trouble" }, { key: "cleanup-teardown-trouble:alert", message: `Cleanup of ${label}: bb could not remove its worktree environment: ${clip(trouble, 300)}. ${left}` });
      if (Date.now() - generation <= TEARDOWN_LIMIT_MS) return;
      if (environment.lifecycle.phase === "active") return cleanupMove(job, "storage", { outcome: "branch kept: environment in use" });
      if (shared("stuck")) return;
      return cleanupMove(job, "storage", { outcome: "branch kept: teardown stuck" }, { key: "cleanup-teardown-stuck:alert", message: `Cleanup of ${label}: bb has not removed its worktree environment 60 minutes after the archive (${environment.lifecycle.phase}/${environment.hostLifecycle}). ${left}` });
    }

    if (job.step === "branch") {
      const [project, config] = await Promise.all([
        bounded(() => bb.sdk.projects.get({ projectId: job.project_id }), CLEANUP_READ_MS),
        bounded(() => bb.sdk.system.config(), CLEANUP_READ_MS),
      ]);
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      const kept = (reason: string, alert = false) => cleanupMove(job, "storage", { outcome: `branch kept: ${reason}` }, alert ? {
        key: "cleanup-branch-kept:alert",
        message: `Cleanup of ${label} kept its bb/ branch ${job.branch}: ${reason}. Left in place: the local branch. Delete it yourself with git branch -D ${job.branch} once you have confirmed origin holds its commits.`,
      } : undefined);
      if (!source?.hostId) return kept("no source host recorded for the project", true);
      if (!source.path) return kept("the project has no checkout path");
      if (source.hostId !== config.primaryHostId) return kept("the project checkout is on a remote host, not the plugin server");
      // A worker or spec-writer row carries its chain's pr_url; a reviewer's PRs come from the workers it covered.
      const urls = [...new Set([row.pr_url, ...ledger.targets(id).map((target) => store.get(target.worker_thread_id)?.pr_url)].filter((url): url is string => !!url))];
      const mergedHeads = urls.length
        ? () => bounded(async () => (await Promise.all(urls.map((url) => prMerged(url, source.path!)))).flatMap((merged) => merged?.merged && merged.head ? [merged.head] : []), CLEANUP_CALL_MS)
        : undefined;
      const result = await bounded(() => deleteSafeBranch({ cwd: source.path!, env: forgeEnv(), branch: job.branch!, deadlineMs: CLEANUP_CALL_MS, mergedHeads }), 2 * CLEANUP_CALL_MS + 5_000);
      if ("error" in result) throw new Error(result.error);
      if ("kept" in result) return kept(result.kept, true);
      return cleanupMove(job, "storage", { outcome: "deleted" in result ? `branch deleted${result.note ? ` (${result.note})` : ""}` : "branch already gone" });
    }

    // storage
    const since = Number((db.prepare(`SELECT value FROM plugin_meta WHERE key='artifact_fallbacks_since'`).get() as { value: string } | undefined)?.value);
    const fallback = db.prepare(`SELECT 1 FROM artifact_fallbacks WHERE thread_id=?`).get(id);
    // A fallback leaves Chief's artifacts in this storage; before tracking began the history is unknown, so that fails closed too.
    if (fallback || !(row.created_at >= since)) {
      return finish("storage kept: evidence", {
        key: "cleanup-evidence-kept:alert",
        message: `Cleanup of ${label} kept its thread storage: ${fallback ? "Chief's artifacts for it were written there (the BB data dir was unknown)" : "it was created before Chief tracked that, so its artifacts may be there"}. Left in place: the storage. Clear it yourself once nothing there is needed: bb storage clear-thread --thread ${id} --yes.`,
      });
    }
    await bounded(() => bb.sdk.plugins.callRpc({ pluginId: "bb--storage-retention", method: "clearThread", input: { threadId: id }, outputSchema: z.object({ ok: z.literal(true) }) }), CLEANUP_CALL_MS);
    return finish("cleaned");
  }
  return { CLEANUP_READ_MS, observeCleanup };
}

