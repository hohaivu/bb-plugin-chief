import { type ManagedRow, terminal } from "../types";
import { clip } from "../core/text";
import { forgeEnv, markPrReady, prHead } from "../forge/forge";
import { docsCommits } from "../review/impactSlice";
import { BUSY_STATUSES, MAX_RESULT_LENGTH } from "./constants";
import { overrideSchema } from "../tools/shapes";
import type { Ctx } from "./context";
import { isWriter } from "../plan/waveSchedule";

export function createCompletion(ctx: Ctx) {
  const { bb, chainOwner, isDesignWave, isTestWave, latestWorker, ledger, planWavesFor, progress, sideLane, store, taskWriters } = ctx;
  /** Why a worker may not complete yet, or null when its newest review covers what it would ship.
   * With a pull request the verdict must be an approve given for the PR head the forge reports now;
   * without one it must be an approve for the worker's current report. A design-wave worker needs the owner's recorded approval instead.
   * Unreadable forge state refuses: fail closed. */
  async function completionRefusal(row: ManagedRow): Promise<string | null> {
    if (isDesignWave(row)) {
      return row.owner_approval ? null : `${row.thread_id} is design-only work, which only the owner approves: show the user its artboards and record their decision with chief_owner_approval (workerThreadId: ${row.thread_id}), or pass override with a reason to complete anyway.`;
    }
    const next = `Start a fresh review with chief_review (workerThreadId: ${row.thread_id}${row.plan_thread_id ? "; on a plan it covers every branch, once every wave is ready" : ""}), complete it without a review with skipReview (your reason), or pass override with a reason to complete anyway.`;
    const approval = await ledger.headApproval(row, async () => prHead(row.pr_url!, await ctx.projectPath(row.project_id)));
    if (approval.approved) return null;
    switch (approval.reason) {
      case "no-verdict": return `${row.thread_id} has no review verdict. ${next}`;
      case "not-approve": return `The newest review of ${row.thread_id} is ${approval.verdict}, not an approve. ${next}`;
      case "head-unreadable": return `Cannot read the current head of ${row.pr_url} from the forge, so the approve cannot be matched to it. Retry, or pass override with a reason to complete anyway.`;
      case "head-moved": return `The approve covers ${approval.approvedSha ?? "no recorded commit"} but ${row.pr_url} is now at ${approval.headSha}. ${next}`;
      case "report-moved": return `The newest approve does not cover ${row.thread_id}'s current report (report ${row.report_seq}). ${next}`;
    }
  }

  /** The skipReview docs/ check: refuses when the pushed branch has a docs/ commit no Spec Writer of this task is recorded on (Chief-Spec-Writer trailer).
   * Fail open: when the history cannot be read the skip proceeds and the returned note says so. Null when clean. */
  async function docsGate(row: ManagedRow, refuse: (why: string) => never): Promise<string | null> {
    const skipped = (reason: string) => `docs/ check skipped: ${reason}; skipReview proceeded without it.`;
    const path = await ctx.projectPath(row.project_id);
    if (!path) return skipped("no local checkout of the project on the plugin server");
    const hostSkip = await ctx.checkoutHostSkip(row.project_id);
    if (hostSkip) return skipped(hostSkip);
    let head: { branch: string; sha?: string; base?: string };
    if (row.pr_url) {
      const pr = await prHead(row.pr_url, path);
      if (!pr) return skipped("cannot read the pull request head from the forge");
      head = pr;
    } else if (row.branch) head = { branch: row.branch };
    else return skipped("no task branch");
    const found = await docsCommits({ cwd: path, env: forgeEnv(), deadlineMs: 20_000, head });
    if ("skipped" in found) return skipped(found.skipped);
    const allowed = new Set(taskWriters(row, ledger.taskChain(row.thread_id)).map((writer) => writer.thread_id));
    const offending = found.commits.filter((commit) => !commit.writer || !commit.writer.split(",").some((id) => allowed.has(id.trim())));
    if (!offending.length) return null;
    const owner = row.plan_thread_id && row.plan_wave != null ? chainOwner(row.plan_thread_id, planWavesFor(row.plan_thread_id), row.plan_wave) : undefined;
    const route = `chief_delegate (${row.plan_thread_id && owner ? `planThreadId: ${row.plan_thread_id}, wave: ${owner.plan_wave}, ` : ""}replaces: ${owner?.thread_id ?? row.thread_id}, kind: spec-writer)`;
    const shown = offending.slice(0, 10).map((commit) => `${commit.sha.slice(0, 9)} ${clip(commit.subject, 80)} (${commit.paths.slice(0, 5).join(", ")})`).join("; ");
    return refuse(`the branch has docs/ commits no Spec Writer of this task is recorded on: ${shown}${offending.length > 10 ? `; …${offending.length - 10} more` : ""}. A missing Chief-Spec-Writer trailer means unknown ownership (legacy Spec Writer commits have none). History stays as it is. Routes: chief_review (workerThreadId: ${row.thread_id}) — the reviewer attributes legacy writer commits by their reported range and accepts a Spec Writer's adopted correction; to correct the docs first, ${route} naming these commits in its mission, then follow its ready alert; or override with your reason.`);
  }

  /** override is the one bypass of a worker's review requirement; its reason is recorded in the stored result.
   * skipReview completes a worker without a review by Chief's judgment: refused only for invalid state, never cleaned up. */
  async function markComplete(threadId: string, result?: string, override?: string, skipReview?: string, testsSkipped?: string) {
    const row = store.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker or reviewer ${threadId}.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (BUSY_STATUSES.has(live.status)) throw new Error(`Cannot complete ${threadId} while it is ${live.status}.`);
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot complete ${threadId} because it is not a live thread.`);
    let overrideNote: string | null = null;
    let overrideReason: string | null = null;
    let approved = false;
    let reviewSkipped: string | null = null;
    let testsSkippedReason: string | null = null;
    let docsNote: string | null = null;
    // An implementation-lane Spec Writer never counts as done work: its worker (or, on a test wave, the rerun tester) follows. Only a waived test wave ends on one. A side-lane writer completes like a worker.
    if (row.role === "worker" && isWriter(row.kind) && !sideLane(row)) {
      const waves = planWavesFor(row.plan_thread_id);
      const testWave = row.plan_wave != null ? waves[row.plan_wave - 1] : undefined;
      if (!(testWave?.test && testWave.testsSkipped)) {
        throw new Error(`Refusing to complete ${threadId}: a Spec Writer's docs need ${testWave?.test
          ? `a test rerun — chief_delegate (replaces: ${threadId}, kind: tester)`
          : `their worker — chief_delegate (${row.plan_thread_id ? `planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, ` : ""}replaces: ${threadId}, kind: worker)`}.`);
      }
    }
    if (testsSkipped !== undefined) {
      const reason = overrideSchema.safeParse(testsSkipped);
      if (!reason.success || !reason.data) throw new Error(`Refusing to complete ${threadId}: testsSkipped needs a non-empty reason of at most the allowed length.`);
      if (row.role !== "worker") throw new Error(`Refusing to complete ${threadId}: testsSkipped is only for a worker.`);
      if (planWavesFor(row.plan_thread_id).some((wave) => wave.test)) {
        throw new Error(`Refusing to complete ${threadId}: its plan has a test wave; go without it with chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave, reason), not testsSkipped.`);
      }
      testsSkippedReason = reason.data;
    } else if (row.role === "worker" && !row.plan_thread_id && !ledger.taskChain(threadId).some((id) => store.get(id)?.kind === "tester")) {
      throw new Error(`No tester ran on this work: delegate one first — chief_delegate (replaces: ${threadId}, kind: tester) — or pass testsSkipped: your reason.`);
    }
    if (skipReview !== undefined) {
      const refuse = (why: string): never => { throw new Error(`Refusing to skip the review of ${threadId}: ${why}`); };
      const reason = overrideSchema.safeParse(skipReview);
      if (!reason.success || !reason.data) refuse("skipReview needs a non-empty reason of at most the allowed length.");
      if (row.role !== "worker") refuse("only a worker's review can be skipped.");
      if (override !== undefined) refuse("pass skipReview or override, not both.");
      if (isDesignWave(row)) refuse("design-only work is approved by the owner only: record it with chief_owner_approval, or pass override.");
      // A waived test wave is Chief's recorded decision to accept that branch, so its blocked report also counts.
      const waived = row.last_report_state === "blocked" && isTestWave(row) && !!planWavesFor(row.plan_thread_id)[row.plan_wave! - 1]!.testsSkipped
        && latestWorker(row.plan_thread_id!, row.plan_wave!)?.thread_id === row.thread_id;
      if (row.last_report_state !== "ready" && !waived) refuse(`its latest report is ${row.last_report_state ?? "missing"}, not ready.`);
      const busy = ledger.busyReview(threadId);
      if (busy) refuse(`review ${busy.thread_id} is still running; wait for its verdict.`);
      docsNote = await docsGate(row, refuse);
      reviewSkipped = reason.data!;
    } else if (row.role === "worker") {
      const refusal = await completionRefusal(row);
      approved = refusal === null;
      if (refusal) {
        const reason = overrideSchema.safeParse(override);
        if (!reason.success || !reason.data) throw new Error(`Refusing to complete ${threadId}: ${refusal}`);
        overrideReason = reason.data;
        overrideNote = `\n\nCompleted without a matching approve: ${reason.data}`;
        bb.log.warn(`Completing ${threadId} with an override (${refusal}) Reason: ${reason.data}`);
      }
    }
    const replacement = result ? clip(result, MAX_RESULT_LENGTH) : null;
    // A replaced result drops the summary and report file that described the old one.
    const now = Date.now();
    store.markComplete({ status: live.status, result: replacement, note: overrideNote, now, threadId, cleanupApprovedAt: approved && ctx.state.cleanupActive ? now : null, reviewSkipped, testsSkipped: testsSkippedReason });
    const completed = store.get(threadId)!;
    ctx.enqueueCompletionComment(completed, overrideReason);
    const cleanup: "queued" | "override" | "unapproved" | "off" | null = row.role !== "worker" ? null
      : overrideNote !== null ? "override" : !approved ? "unapproved" : ctx.state.cleanupActive ? "queued" : "off";
    return { row: completed, overridden: overrideNote !== null, skipped: reviewSkipped !== null, cleanup, docsNote };
  }

  /** chief_owner_approval: records the owner's approval on a design-wave worker whose latest report was ready.
   * Writes nothing else; the row may have gone ready -> active -> idle while the owner looked, so it is not
   * required to be in state ready, only not working, not finished, and last heard from with a ready report. */
  async function recordOwnerApproval(row: ManagedRow, approval: string) {
    if (!isDesignWave(row)) throw new Error(`${row.thread_id} is not a worker on a design-only plan wave: chief_owner_approval records only the owner's approval of a design wave.`);
    if (terminal(row.state)) throw new Error(`${row.thread_id} is ${row.state}.`);
    const live = await bb.sdk.threads.get({ threadId: row.thread_id });
    if (BUSY_STATUSES.has(live.status)) ctx.busyRejection(row, live.status, "recording the owner's approval");
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`${row.thread_id} is not a live thread.`);
    if (row.last_report_state !== "ready") throw new Error(`${row.thread_id}'s latest report is ${row.last_report_state ?? "missing"}, not ready: wait for its ready report before asking the owner.`);
    store.recordOwnerApproval(row.thread_id, approval);
    const { waves, next } = progress.nextWave(row);
    return next !== null
      ? `Recorded the owner's approval of wave ${row.plan_wave}. Delegate wave ${next}: ${waves[next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${next}, replaces: ${row.thread_id}); name the approved artboards in its mission.${ctx.specFirstLine(row.plan_thread_id, waves, next)}`
      : `Recorded the owner's approval of wave ${row.plan_wave}. Complete it with chief_complete (threadId: ${row.thread_id}). Never chief_review.`;
  }

  /** The line chief_complete and the CLI add for a worker's cleanup outcome; non-workers have none. */
  const cleanupLine = (cleanup: "queued" | "override" | "unapproved" | "off" | null) => cleanup === null ? "" : {
    queued: "\nCleanup queued: a background cleanup worker archives this task's threads (worker, reviewers, advisors, and the planner after its last wave) once nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there; any failure alerts you.",
    override: "\nNo cleanup: completed with override.",
    unapproved: "\nNo cleanup: no approving review.",
    off: "\nNo cleanup: the cleanupApproved setting is off.",
  }[cleanup];

  /** After a worker completes: flips its draft pull request to ready, best-effort. A forge failure
   * never undoes the completion. "skipped" means there was no pull request to flip. */
  async function readyPullRequest(row: ManagedRow): Promise<{ prReady: boolean | "skipped"; error?: string; line: string }> {
    if (row.role !== "worker" || !row.pr_url) return { prReady: "skipped", line: "" };
    const { ready, error } = await markPrReady(row.pr_url, await ctx.projectPath(row.project_id));
    return ready
      ? { prReady: true, line: "\nIts pull request is marked ready for review." }
      : { prReady: false, error, line: `\nCould not mark its pull request ready (${error}); the work is complete either way. Tell the user it is still a draft.` };
  }

  /** Interrupts a running managed thread but keeps its worktree, branch, and history:
   * the row is marked blocked (with a reroute recommendation) rather than complete, so
   * chief_delegate replaces: can hand it to a fresh worker once it is idle. */
  async function stopThread(threadId: string, reason?: string) {
    const row = store.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed thread ${threadId} to stop.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot stop ${threadId} because it is not a live thread.`);
    if (!BUSY_STATUSES.has(live.status)) {
      throw new Error(`${threadId} is ${live.status}; nothing to stop.${row.role === "worker" ? ` Replace it with ${ctx.replacesCall(row)}.` : ""}`);
    }
    await bb.sdk.threads.stop({ threadId });
    store.markStopped(threadId, clip(`Stopped by Chief${reason ? `: ${reason}` : "."}`, 4_000), ctx.rerouteSteps(row));
    return store.get(threadId)!;
  }
  return { cleanupLine, markComplete, readyPullRequest, recordOwnerApproval, stopThread };
}

