import { cliAdapters, createForgeComments, sanitizeForge } from "../forge/forgeComments";
import { findingLines } from "../report/reportIntake";
import { type ManagedRow, type ReportFinding } from "../types";
import { clip } from "../core/text";
import { trackerProjects } from "../tracker/tracker";
import { trackerSelector } from "../tracker/trackerBbTasks";
import { createTrackerSync } from "../tracker/trackerSync";
import { chainOf } from "../plan/waveSchedule";
import { forgeEnv, prMerged, serverPath } from "../forge/forge";
import { execFileAsync } from "./exec";
import type { Ctx } from "./context";

export function createForgeWiring(ctx: Ctx) {
  const { bb, db, ledger, planWavesFor, progress, settings, store } = ctx;
  const forgeComments = createForgeComments({
    db, adapters: cliAdapters(forgeEnv), log: bb.log,
    ownerHandle: async () => (await settings.get()).forgeOwnerHandle ?? "",
    escalate: async (threadId, alertKey, message) => {
      const row = store.get(threadId);
      if (!row?.chief_thread_id) { bb.log.error(message); return; }
      await ctx.alertChief(row, alertKey, message);
    },
  });

  const selectTracker = trackerSelector({ execFileAsync, serverPath });
  const trackerSync = createTrackerSync({
    db, log: bb.log,
    config: () => settings.get().then((value) => {
      const tracker = selectTracker(value.tracker);
      return tracker ? { tracker, projects: trackerProjects(value.trackerProjects) } : null;
    }).catch((error) => { bb.log.warn(`Tracker setting not read; the tracker is off: ${String(error)}`); return null; }),
    get: store.get, all: store.all, taskChain: ledger.taskChain,
    reviewTargets: (reviewerId) => ledger.targets(reviewerId).map((target) => target.worker_thread_id),
    planDone: (planner) => !!planner.plan_waves && progress.plannerAbsorbed(planner),
    prMerged: async (url, projectId) => prMerged(url, await ctx.projectPath(projectId)),
    // The live Chief of the thread: its own, else the project's active one.
    answerAlert: (threadId, key, message) => {
      const source = store.get(threadId);
      const own = source?.chief_thread_id ? store.get(source.chief_thread_id) : undefined;
      const chiefId = ctx.isActiveChief(own) ? own.thread_id : source ? ctx.chiefForProject(source.project_id)?.thread_id : undefined;
      return source && chiefId ? ctx.writeAlert({ ...source, chief_thread_id: chiefId }, key, message) : null;
    },
    deliver: ctx.deliverAlert,
  });

  /** Which attempt at a task this is: the worker's position in its replaces: chain. */
  const taskRound = (workerThreadId: string) => ledger.taskChain(workerThreadId).length;
  /** Agent- or tool-originated text, made safe for the forge and bounded. */
  const forgeText = (text: string, limit: number) => sanitizeForge(clip(text.trim(), limit));

  /** One comment per pull request a verdict covers (a branch review: its own pull request, when it was given as a full URL). Runs inside the report intake's store.batch. */
  function enqueueVerdictComments(row: ManagedRow, seq: number, verdict: string, findingList: ReportFinding[] | undefined, result: string | undefined, recommendation: string | undefined) {
    const targets = ledger.targets(row.thread_id);
    const covered = targets.length
      ? targets.map((target) => ({ worker: target.worker_thread_id, url: target.pr_url ?? store.get(target.worker_thread_id)?.pr_url, sha: target.head_sha, id: `verdict:${row.thread_id}:${seq}:${target.worker_thread_id}` }))
      : [{ worker: null, url: row.pr_url, sha: row.reviewed_head_sha, id: `verdict:${row.thread_id}:${seq}` }];
    const blocking = findingList?.filter((finding) => finding.severity === "blocking") ?? [];
    const nits = findingList?.filter((finding) => finding.severity === "nit") ?? [];
    const details = sanitizeForge([
      ...(blocking.length ? ["### Blocking findings", "", ...findingLines(blocking, "blocking"), ""] : []),
      ...(nits.length ? ["### Nits", "", ...findingLines(nits, "nit"), ""] : []),
      ...(result ? ["### Findings", "", result, ""] : []),
      ...(recommendation ? ["### Recommendation", "", recommendation] : []),
    ].join("\n"));
    for (const entry of covered) {
      forgeComments.enqueue({
        key: entry.id, row, target: entry.url,
        comment: {
          title: "Review verdict", round: entry.worker ? taskRound(entry.worker) : undefined,
          lines: [
            verdict === "approve" ? "**Approved**" : "**Changes requested**",
            ...(entry.sha ? [`Reviewed head: \`${entry.sha.slice(0, 12)}\``] : []),
            `${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}, ${nits.length} nit${nits.length === 1 ? "" : "s"}`,
          ],
          details: { summary: "Findings and recommendation", body: details },
        },
      });
    }
  }

  /** A worker's blocked report, on its pull request (its issue when it has none). Runs inside the report intake's store.batch. */
  function enqueueBlockedComment(row: ManagedRow, seq: number, blocker: string | undefined, recommendation: string | undefined) {
    const id = `blocked:${row.thread_id}:${seq}`;
    forgeComments.enqueue({
      key: id, row, target: row.pr_url ?? row.issue_url,
      comment: { title: "Blocked", round: taskRound(row.thread_id), lines: [
        `**Blocker:** ${forgeText(blocker ?? "", 1_500)}`, ...(recommendation ? [`**Recommendation:** ${forgeText(recommendation, 1_500)}`] : []),
      ] },
    });
  }

  /** A worker task's outcome, on its tracking issue (its pull request when the repository has no issue). Called once markComplete has committed. */
  function enqueueCompletionComment(row: ManagedRow, overrideReason: string | null) {
    if (row.role !== "worker") return;
    const id = `complete:${row.thread_id}`;
    const waves = row.plan_thread_id ? planWavesFor(row.plan_thread_id).length : 0;
    const details = [
      ...(row.result ? [forgeText(row.result, 4_000)] : []),
      ...(row.owner_approval ? ["", `Owner's approval: “${forgeText(row.owner_approval, 1_000)}”`] : []),
    ].join("\n");
    forgeComments.enqueue({
      key: id, row, target: row.issue_url ?? row.pr_url,
      comment: {
        title: "Completed", round: taskRound(row.thread_id),
        lines: [
          `**${forgeText(row.title, 160)}**${row.plan_wave && waves ? ` · wave ${row.plan_wave} of ${waves}` : ""}`,
          ...(row.pr_url ? [`Pull request: ${row.pr_url}`] : []),
          ...(overrideReason ? [`**Completed without a matching approve:** ${forgeText(overrideReason, 1_000)}`] : []),
          ...(row.unplanned_reason ? [`**Planning skipped:** ${forgeText(row.unplanned_reason, 500)}`] : []),
          ...(row.review_skipped ? [`**Review skipped:** ${forgeText(row.review_skipped, 500)}`] : []),
          ...(row.tests_skipped ? [`**Tests skipped:** ${forgeText(row.tests_skipped, 500)}`] : []),
          ...(row.retest_skipped ? [`**Retest skipped:** ${forgeText(row.retest_skipped, 500)}`] : []),
          // The waived test waves of this worker's chain (an absent one is off the chain, so compare chain heads).
          ...(row.plan_thread_id && row.plan_wave != null ? ((plan) => plan.flatMap((wave, index) => wave.testsSkipped && chainOf(plan, index + 1)[0] === chainOf(plan, row.plan_wave!)[0]
            ? [`**Tests skipped (wave ${index + 1}):** ${forgeText(wave.testsSkipped, 500)}`] : []))(planWavesFor(row.plan_thread_id)) : []),
          ...(row.plan_thread_id && row.plan_wave != null ? ((plan) => plan.flatMap((wave, index) => wave.specsSkipped && chainOf(plan, index + 1)[0] === chainOf(plan, row.plan_wave!)[0]
            ? [`**Specs skipped (wave ${index + 1}):** ${forgeText(wave.specsSkipped, 500)}`] : []))(planWavesFor(row.plan_thread_id)) : []),
        ],
        details: { summary: "Result", body: details },
      },
    });
  }
  return { enqueueBlockedComment, enqueueCompletionComment, enqueueVerdictComments, forgeComments, forgeText, trackerSync };
}

