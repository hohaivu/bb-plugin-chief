import { type ManagedRow, terminal } from "../types";
import { clip } from "../core/text";
import { forgeEnv, markBranchReady, markPrReady, prHead } from "../forge/forge";
import { docsCommits } from "../review/impactSlice";
import { BUSY_STATUSES, MAX_RESULT_LENGTH } from "./constants";
import { overrideSchema } from "../tools/shapes";
import type { Ctx } from "./context";
import { isWriter } from "../plan/waveSchedule";

export function createCompletion(ctx: Ctx) {
  const { bb, chainOwner, isDesignWave, ledger, planBaseOf, planWavesFor, sideLane, store, taskWriters } = ctx;
  /** Why a worker, or a gate's reviewer, may not complete yet, or null when its review gate passed.
   * A design-wave worker needs the owner's recorded approval instead. Completion never needs a re-review or an approve on the latest head. */
  async function completionRefusal(row: ManagedRow): Promise<string | null> {
    if (isDesignWave(row)) {
      return row.owner_approval ? null : `${row.thread_id} is design-only work, which only the owner approves: show the user its artboards and record their decision with chief_owner_approval (workerThreadId: ${row.thread_id}), or pass override with a reason to complete anyway.`;
    }
    // A chat fix run has no gate and no review: its own ready report and a clean docs/ history complete it.
    if (row.fix_run === "chat") {
      if (row.last_report_state !== "ready") return `chat fix run ${row.thread_id} has no ready report yet: wait for it, or pass override with a reason.`;
      let docs: string | null = null;
      await docsGate(row, (why) => { docs = why; throw new Error(why); }).catch(() => undefined);
      return docs;
    }
    const gated = ctx.gateOf(row);
    if (!gated) return `${row.thread_id} has no review gate. Start the review gate: chief_review (workerThreadId: ${row.thread_id}${row.plan_thread_id ? "; on a plan it covers every branch, once every wave is ready" : ""}), complete it without one with skipReview (your reason), or pass override with a reason to complete anyway.`;
    if (gated.decision.kind === "pass") return null;
    return `the review gate ${gated.gate.gate_key} has not passed (${gated.decision.kind}). ${ctx.gateLine(gated.gate, gated.decision)}`;
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
    } else if (row.branch) {
      // A stacked or branch-based plan wave is checked against its plan base, never origin/HEAD.
      const pb = planBaseOf(row);
      if (pb && "skipped" in pb) return skipped(pb.skipped);
      head = { branch: row.branch, ...pb };
    } else return skipped("no task branch");
    const found = await docsCommits({ cwd: path, env: forgeEnv(), deadlineMs: 20_000, head });
    if ("skipped" in found) return skipped(found.skipped);
    const chain = ledger.taskChain(row.thread_id);
    // A chat fix is unplanned: its provenance is the newest non-chat row it replaces (the original plan's target), whose writers stay authorized.
    const origin = row.fix_run === "chat" ? chain.map((id) => store.get(id)).find((other) => !!other && other.fix_run !== "chat") : undefined;
    // A gate fixer (or legacy tester) origin has no wave: use the gate's pinned target on this chat fix's PR or branch, never the whole plan.
    const gate = origin && store.isGateActor(origin.thread_id) ? store.gateFor(origin.thread_id) : undefined;
    const pinned = gate?.targets.find((target) => (row.pr_url && target.prUrl === row.pr_url) || (!!row.branch && target.branch === row.branch));
    const source = (pinned && store.get(pinned.threadId)) || (gate ? undefined : origin);
    const allowed = new Set([...taskWriters(row, chain), ...(source ? taskWriters(source, ledger.taskChain(source.thread_id)) : [])].map((writer) => writer.thread_id));
    const offending = found.commits.filter((commit) => !commit.writer || !commit.writer.split(",").some((id) => allowed.has(id.trim())));
    if (!offending.length) return null;
    const owner = row.plan_thread_id && row.plan_wave != null ? chainOwner(row.plan_thread_id, planWavesFor(row.plan_thread_id), row.plan_wave) : undefined;
    const route = `chief_delegate (${row.plan_thread_id && owner ? `planThreadId: ${row.plan_thread_id}, wave: ${owner.plan_wave}, ` : ""}replaces: ${owner?.thread_id ?? row.thread_id}, kind: spec-writer)`;
    const shown = offending.slice(0, 10).map((commit) => `${commit.sha.slice(0, 9)} ${clip(commit.subject, 80)} (${commit.paths.slice(0, 5).join(", ")})`).join("; ");
    return refuse(`the branch has docs/ commits no Spec Writer of this task is recorded on: ${shown}${offending.length > 10 ? `; …${offending.length - 10} more` : ""}. A missing Chief-Spec-Writer trailer means unknown ownership (legacy Spec Writer commits have none). History stays as it is. Routes: chief_review (workerThreadId: ${row.thread_id}) — the reviewer attributes legacy writer commits by their reported range and accepts a Spec Writer's adopted correction; to correct the docs first, ${route} naming these commits in its mission, then follow its ready alert; or override with your reason.`);
  }

  /** override is the one bypass of a worker's review requirement; its reason is recorded in the stored result.
   * skipReview completes a worker without a review by Chief's judgment: refused only for invalid state, never cleaned up. */
  async function markComplete(threadId: string, result?: string, override?: string, skipReview?: string) {
    const row = store.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker or reviewer ${threadId}.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (BUSY_STATUSES.has(live.status)) throw new Error(`Cannot complete ${threadId} while it is ${live.status}.`);
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot complete ${threadId} because it is not a live thread.`);
    let overrideNote: string | null = null;
    let overrideReason: string | null = null;
    let approved = false;
    let reviewSkipped: string | null = null;
    let docsNote: string | null = null;
    // An implementation-lane Spec Writer never counts as done work: its worker follows, unless its replaces: chain reaches a gate target
    // whose gate passed (a hand-off worker would have no gate). A side-lane writer completes like a worker.
    const implWriter = row.role === "worker" && isWriter(row.kind) && !sideLane(row);
    const writerPassed = implWriter && ledger.taskChain(threadId).some((id) => {
      const target = store.get(id);
      const gated = target && ctx.gateOf(target);
      return gated?.decision.kind === "pass" && gated.gate.targets.some((t) => t.threadId === id);
    });
    if (implWriter && !writerPassed) {
      throw new Error(`Refusing to complete ${threadId}: a Spec Writer's docs need their worker — chief_delegate (${row.plan_thread_id ? `planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, ` : ""}replaces: ${threadId}, kind: worker).`);
    }
    if (writerPassed) {
      approved = true;
    } else if (skipReview !== undefined) {
      const refuse = (why: string): never => { throw new Error(`Refusing to skip the review of ${threadId}: ${why}`); };
      const reason = overrideSchema.safeParse(skipReview);
      if (!reason.success || !reason.data) refuse("skipReview needs a non-empty reason of at most the allowed length.");
      if (row.role !== "worker") refuse("only a worker's review can be skipped.");
      if (override !== undefined) refuse("pass skipReview or override, not both.");
      if (isDesignWave(row)) refuse("design-only work is approved by the owner only: record it with chief_owner_approval, or pass override.");
      if (row.last_report_state !== "ready") refuse(`its latest report is ${row.last_report_state ?? "missing"}, not ready.`);
      const busy = ledger.busyReview(threadId);
      if (busy) refuse(`review ${busy.thread_id} is still running; wait for its verdict.`);
      const gate = store.gateFor(threadId);
      // tester_thread_id and corrector_thread_id are legacy columns, read only for old gates.
      const busyActor = gate && [gate.reviewer_thread_id, gate.tester_thread_id, gate.fixer_thread_id, gate.corrector_thread_id]
        .map((id) => (id ? store.get(id) : undefined)).find((actor) => actor && BUSY_STATUSES.has(actor.state));
      if (busyActor) refuse(`review gate ${gate!.gate_key} is still running ${busyActor.thread_id}; wait for its report.`);
      docsNote = await docsGate(row, refuse);
      reviewSkipped = reason.data!;
    } else if (row.role === "worker" || (row.role === "reviewer" && store.gateFor(threadId))) {
      const refusal = await completionRefusal(row);
      approved = refusal === null;
      if (refusal) {
        const reason = overrideSchema.safeParse(override);
        if (!reason.success || !reason.data) throw new Error(`Refusing to complete ${threadId}: ${refusal}`);
        overrideReason = reason.data;
        overrideNote = `\n\nCompleted without the review gate: ${reason.data}`;
        bb.log.warn(`Completing ${threadId} with an override (${refusal}) Reason: ${reason.data}`);
      }
    }
    const replacement = result ? clip(result, MAX_RESULT_LENGTH) : null;
    // A replaced result drops the summary and report file that described the old one.
    // Before the write that queues cleanup, so cleanup cannot run ahead of the evidence. Never throws, never refuses completion.
    if (row.role === "worker") await ctx.snapshotCompletion(row);
    const now = Date.now();
    store.markComplete({ status: live.status, result: replacement, note: overrideNote, now, threadId, cleanupApprovedAt: approved && ctx.state.cleanupActive ? now : null, reviewSkipped });
    const completed = store.get(threadId)!;
    // The gate's last target completed: its idle actors (legacy tester and corrector included) complete with it, approved for cleanup like the targets.
    const gate = store.gateFor(threadId);
    if (gate && approved && gate.targets.every((target) => store.get(target.threadId)?.state === "complete")) {
      for (const id of [gate.reviewer_thread_id, gate.tester_thread_id, gate.fixer_thread_id, gate.corrector_thread_id]) {
        const actor = id ? store.get(id) : undefined;
        if (!actor || terminal(actor.state) || BUSY_STATUSES.has(actor.state)) continue;
        store.markComplete({ status: actor.status ?? actor.state, result: null, note: null, now, threadId: actor.thread_id, cleanupApprovedAt: ctx.state.cleanupActive ? now : null, reviewSkipped: null });
      }
    }
    if (reviewSkipped) ctx.observe.event("review_skipped", completed, reviewSkipped);
    if (overrideReason) ctx.observe.event("override", completed, overrideReason);
    ctx.enqueueCompletionComment(completed, overrideReason);
    const cleanup: "queued" | "override" | "unapproved" | "off" | null = row.role !== "worker" ? null
      : overrideNote !== null || reviewSkipped !== null ? "override" : !approved ? "unapproved" : ctx.state.cleanupActive ? "queued" : "off";
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
    return `Recorded the owner's approval of wave ${row.plan_wave}. ${ctx.workerReadyNextStep(store.get(row.thread_id)!) ?? ""}`.trim();
  }

  /** The line chief_complete and the CLI add for a worker's cleanup outcome; non-workers have none. */
  const cleanupLine = (cleanup: "queued" | "override" | "unapproved" | "off" | null) => cleanup === null ? "" : {
    queued: "\nCleanup queued: a background cleanup worker archives this task's threads (worker, reviewers, advisors, and the planner after its last wave) once nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there; any failure alerts you.",
    override: "\nNo cleanup: completed without the gate.",
    unapproved: "\nNo cleanup: the review gate did not pass.",
    off: "\nNo cleanup: the cleanupApproved setting is off.",
  }[cleanup];

  /** After a worker completes: flips its draft pull request to ready, best-effort. A forge failure
   * never undoes the completion. Without pr_url it flips by branch name. "skipped" means there was no pull request to flip. */
  async function readyPullRequest(row: ManagedRow): Promise<{ prReady: boolean | "skipped"; error?: string; line: string }> {
    if (row.role !== "worker" || !(row.pr_url ?? row.branch)) return { prReady: "skipped", line: "" };
    const cwd = await ctx.projectPath(row.project_id);
    // A branch names no repo: only the project's checkout on this server can resolve it.
    const unreachable = row.pr_url ? null : !cwd ? "no local checkout of the project to resolve its branch" : await ctx.checkoutHostSkip(row.project_id);
    const { ready, error } = unreachable ? { ready: false, error: unreachable } : row.pr_url ? await markPrReady(row.pr_url, cwd) : await markBranchReady(row.branch!, cwd!);
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
    ctx.observe.event("stopped", row, reason);
    return store.get(threadId)!;
  }
  return { cleanupLine, markComplete, readyPullRequest, recordOwnerApproval, stopThread };
}

