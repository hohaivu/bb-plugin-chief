import { advisorBrief, plannerBrief, resolveDelegation, workerBrief } from "../research/delegationBrief";
import { MAX_CARRIED_FAILS } from "../report/reportIntake";
import { researchLine } from "../research/research";
import { CONTINUE_REMINDERS } from "../core/roles";
import { type FailEntry, type ManagedRow, type ReportFinding, terminal } from "../types";
import { clip } from "../core/text";
import { z } from "zod";
import { consultParams, delegateParams, logParams, planParams } from "../tools/shapes";
import { BUSY_STATUSES, MAX_NUDGE_LENGTH } from "./constants";
import type { Ctx } from "./context";

/** chief_continue calls per stall episode that re-arm the stall clock; later ones still deliver the nudge but leave the alert schedule alone. A report resets the count. */
const MAX_STALL_RESETS = 2;

const MAX_LOG_READ = 30;

export function createDelegation(ctx: Ctx) {
  const { bb, coexists, db, latestSideWriter, latestWorker, ledger, planWavesFor, plans, progress, reviewerFails, store } = ctx;
  /** A fresh managed worktree based on an open branch: the environment of a read-only role started with `branch`. */
  async function branchEnvironment(projectId: string, branch: string) {
    return {
      type: "host" as const,
      hostId: ((await ctx.projectHostId(projectId)) ?? await ctx.defaultHostId()) as string,
      workspace: { type: "managed-worktree" as const, baseBranch: { kind: "named" as const, name: branch } },
    };
  }

  /** A plan is read-only work in the project-default environment — its own worktree in projects whose default is a worktree, else the project checkout; with a branch, a fresh worktree on it. Nothing is implemented until Chief delegates. */
  async function startPlan(params: z.infer<typeof planParams>, callerThreadId?: string | null) {
    if (!(await ctx.plannerEnabled())) {
      throw new Error("Planning is off. Turn on “Plan before delegating” in Chief's settings, or delegate this work directly.");
    }
    const { chief, projectId } = await ctx.owningChief(callerThreadId);
    const revision = params.revises ? revisionInput(params.revises, chief.thread_id) : undefined;
    // A revision stays on the branch its original planner read.
    const branch = params.branch ?? (params.revises ? store.get(params.revises)?.branch ?? undefined : undefined);
    const prepared = await ctx.managedSpawn.prepare(projectId, { role: "planner", hostId: await ctx.projectHostId(projectId) });
    const title = `Plan · ${params.title.replace(/^Plan · /, "")}`;
    const prompt = plannerBrief({
      title: params.title, chiefThreadId: chief.thread_id, mission: params.mission, context: params.context,
      research: researchLine("planner", await ctx.researchSettings()) !== null, revision, branch,
    });
    const warning = branch ? null : await ctx.freshenChiefCheckout(chief, "planner");
    const thread = await ctx.managedSpawn.launch(prepared,
      { projectId, environment: branch ? await branchEnvironment(projectId, branch) : { type: "project-default" }, title, prompt },
      { role: "planner", chiefThreadId: chief.thread_id, replacesThreadId: params.revises ?? null, ...(branch ? { branch } : {}) },
      // Earlier revision attempts that failed or stopped are superseded atomically with the new one.
      params.revises ? (newId) => {
        const now = Date.now();
        for (const earlier of ctx.revisionsOf(params.revises!).all) {
          if (earlier.thread_id !== newId && !BUSY_STATUSES.has(earlier.state) && !terminal(earlier.state)) store.completeSuperseded(earlier.thread_id, now);
        }
      } : undefined);
    void (params.revises ? ctx.trackerSync.join(store.get(thread.id)!) : ctx.trackerSync.start(store.get(thread.id)!, params.mission));
    return { threadId: thread.id, title, projectId, ...(warning ? { warning } : {}) };
  }

  /** chief_plan revises: P is allowed only once P's one review asked for changes and no revision is in or working; returns the revision brief input. */
  function revisionInput(plannerId: string, chiefThreadId: string): NonNullable<Parameters<typeof plannerBrief>[0]["revision"]> {
    const planner = store.get(plannerId);
    if (!planner || planner.role !== "planner" || !ctx.controlsThread(planner, chiefThreadId)) throw new Error(`No managed planner ${plannerId} for this Chief.`);
    if (planner.plan_review !== "changes") {
      if (!planner.plan_review && planner.replaces_thread_id) throw new Error(`${plannerId} is already the revision of ${planner.replaces_thread_id}; a revision gets no review — delegate its waves.`);
      throw new Error(ctx.planReviewRefusal(planner) ?? `Plan ${plannerId} needs no revision: only a plan whose one advisor review asked for changes is revised. Delegate it.`);
    }
    const revisions = ctx.revisionsOf(plannerId);
    if (planner.state === "complete") throw new Error(`Plan ${plannerId} was revised by ${revisions.ready?.thread_id ?? "an earlier revision"}: delegate ${revisions.ready?.thread_id ?? "its"} waves.`);
    if (revisions.busy) throw new Error(`Plan ${plannerId} is being revised by ${revisions.busy.thread_id}: wait for ${revisions.busy.thread_id}.`);
    const decider = ctx.planAdvisors(plannerId).decider!;
    const blocked = decider.last_report_state === "blocked";
    return {
      plannerThreadId: plannerId,
      planPaths: planWavesFor(plannerId).map((wave) => wave.path),
      advisorThreadId: decider.thread_id,
      advisorReportPath: decider.report_path,
      advisorSummary: decider.summary ?? (decider.result ? clip(decider.result, 800) : null),
      ...(blocked ? { blocker: decider.blocker, recommendation: decider.recommendation } : {}),
    };
  }

  /** A consult is read-only, like a review: with a worker it reuses that
   * worker's worktree so the advisor can reproduce the failing change; without
   * one it runs in the project's own checkout, like a plan. */
  async function startConsult(params: z.infer<typeof consultParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await ctx.owningChief(callerThreadId);
    if (params.planThreadId) return startPlanConsult(params, params.planThreadId, chief.thread_id, projectId);
    if (params.workerThreadId && params.branch) throw new Error(`The advisor reuses worker ${params.workerThreadId}'s worktree and branch; omit branch.`);
    const worker = params.workerThreadId ? store.get(params.workerThreadId) : undefined;
    if (params.workerThreadId && (!worker || worker.role !== "worker" || !ctx.controlsThread(worker, chief.thread_id))) {
      throw new Error(`No managed worker ${params.workerThreadId} for this Chief.`);
    }
    let workerLive: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
    if (worker) {
      workerLive = await bb.sdk.threads.get({ threadId: worker.thread_id });
      if (BUSY_STATUSES.has(workerLive.status)) ctx.busyRejection(worker, workerLive.status, "starting a consult");
      if (workerLive.deletedAt !== null || workerLive.archivedAt !== null) throw new Error(`Worker ${worker.thread_id} is not consultable.`);
      if (!workerLive.environmentId) throw new Error(`Worker ${worker.thread_id} has no reusable environment.`);
    }
    const hostId = worker ? await ctx.environmentHostId(workerLive!.environmentId!) : await ctx.projectHostId(projectId);
    const prepared = await ctx.managedSpawn.prepare(projectId, { role: "advisor", hostId });
    const title = `Consult · ${params.title.replace(/^Consult · /, "")}`;
    const reviews = worker ? ctx.taskReviews(worker) : [];
    const prompt = advisorBrief({ title: params.title, chiefThreadId: chief.thread_id, mission: params.mission, context: params.context, worker, reviews, branch: params.branch });
    const thread = await ctx.managedSpawn.launch(prepared, {
      projectId,
      environment: worker
        ? { type: "reuse", environmentId: workerLive!.environmentId! }
        : params.branch ? await branchEnvironment(projectId, params.branch) : { type: "project-default" },
      title, prompt,
    }, { role: "advisor", chiefThreadId: chief.thread_id, workerThreadId: worker?.thread_id ?? null, ...(params.branch ? { branch: params.branch } : {}) });
    return { threadId: thread.id, title, projectId };
  }

  /** chief_consult planThreadId: the plan's one read-only advisor review, in the project's own checkout. */
  async function startPlanConsult(params: z.infer<typeof consultParams>, plannerId: string, chiefThreadId: string, projectId: string) {
    if (params.workerThreadId) throw new Error("Use one of workerThreadId or planThreadId.");
    const planner = store.get(plannerId);
    if (!planner || planner.role !== "planner" || !ctx.controlsThread(planner, chiefThreadId) || !planner.plan_waves || planner.state === "complete") {
      throw new Error(`No managed planner ${plannerId} with an open plan for this Chief.`);
    }
    if (planner.plan_review !== "required") {
      if (!planner.plan_review) throw new Error(`Only a plan with more than one implementation wave (design and test waves do not count), or a complex plan, gets an advisor review; ${plannerId} does not (a revision never does): delegate it.`);
      const { decider } = ctx.planAdvisors(plannerId);
      throw new Error(`Plan ${plannerId} already had its one review (${decider?.thread_id ?? "?"}): ${ctx.planReviewRefusal(planner) ?? ctx.nextAction(planner) ?? "delegate its waves."}`);
    }
    const { inFlight } = ctx.planAdvisors(plannerId);
    if (inFlight) throw new Error(`Plan ${plannerId} is already in review by ${inFlight.thread_id}: wait for ${inFlight.thread_id}, or chief_stop it first.`);
    const branch = params.branch ?? planner.branch ?? undefined;
    const prepared = await ctx.managedSpawn.prepare(projectId, { role: "advisor", hostId: await ctx.projectHostId(projectId) });
    const title = `Consult · ${params.title.replace(/^Consult · /, "")}`;
    const prompt = advisorBrief({
      title: params.title, chiefThreadId, mission: params.mission, context: params.context, reviews: [], branch,
      plan: {
        plannerThreadId: plannerId, paths: planWavesFor(plannerId).map((wave) => wave.path),
        summary: planner.result ? clip(planner.result, 1_500) : null, reportPath: planner.report_path,
      },
    });
    const thread = await ctx.managedSpawn.launch(prepared,
      { projectId, environment: branch ? await branchEnvironment(projectId, branch) : { type: "project-default" }, title, prompt },
      { role: "advisor", chiefThreadId, planThreadId: plannerId, ...(branch ? { branch } : {}) });
    return { threadId: thread.id, title, projectId };
  }
  function delegate(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const run = ctx.state.delegating.then(() => startWorker(params, callerThreadId));
    ctx.state.delegating = run.catch(() => undefined);
    return run;
  }

  /** Fails ruled out along a replaces: chain, newest first, from worker threadId back to the chain head. */
  function chainFails(threadId: string): FailEntry[] {
    // Stored oldest-first; `at` is the report time (absent on older rows, which sort as oldest).
    type Stored = FailEntry & { at?: number };
    const parse = (json: string | null) => (json ? JSON.parse(json) as Stored[] : []).reverse();
    const all: Stored[] = [];
    for (const id of ledger.taskChain(threadId)) {
      const worker = store.get(id);
      if (!worker) continue;
      const reviewers = (reviewerFails.all(id) as { fails: string }[]).flatMap((row) => parse(row.fails));
      all.push(...parse(worker.fails), ...reviewers);
    }
    // Newest first across workers and reviewers, before dedup and the cap, so the latest basis wins.
    all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const seen = new Set<string>();
    const out: FailEntry[] = [];
    for (const entry of all) {
      const key = `${entry.scope}\u0000${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: clip(entry.text, 400), scope: clip(entry.scope, 120), basis: clip(entry.basis, 200) });
      if (out.length >= MAX_CARRIED_FAILS) break;
    }
    return out;
  }

  async function startWorker(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await ctx.owningChief(callerThreadId);
    const prior = params.replaces ? store.get(params.replaces) : undefined;
    if (params.replaces && (!prior || prior.role !== "worker" || !ctx.controlsThread(prior, chief.thread_id) || prior.project_id !== projectId)) {
      throw new Error(`No managed worker ${params.replaces} for this Chief.`);
    }
    if (prior) {
      // The escalation ladder: round 2 needs a consult that gave its advice on this task, round 3 needs the user.
      // Read from the task's verdict history, not the open reviewer: a fresh or completed reviewer,
      // a re-pointed snapshot, or a second replaces: before the next review must not reset it.
      // Only the exact retest tester hand-off the review refusal renders skips the consult and user rungs.
      const retestHandoff = params.kind === "tester" && progress.retestDebts(prior).owed.some((debt) => debt.route.kind === "tester" && debt.route.replaces.thread_id === prior.thread_id);
      const needs = retestHandoff ? null : ledger.replacement(prior, !!params.userApprovedRound);
      if (needs?.needs === "user") {
        throw new Error(`The reviewer has requested changes ${needs.streak} times in a row on ${prior.thread_id}. Do not delegate another round: escalate to the user with both positions, the consult's advice and your recommendation. Only the user can authorize another round; once they do, repeat this call with userApprovedRound: true (CLI: --user-approved-round).`);
      }
      if (needs?.needs === "consult") {
        throw new Error(`The reviewer has requested changes ${needs.streak} times in a row on ${prior.thread_id}. Call chief_consult (workerThreadId: ${prior.thread_id}) and wait for it to send its advice (a ready or blocked report; a status-only, stopped or completed-unreported consult does not count) before delegating the one more round.`);
      }
    }
    let priorLive: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
    if (prior) {
      priorLive = await ctx.waitIdleAfterReport(prior);
      if (BUSY_STATUSES.has(priorLive.status)) ctx.busyRejection(prior, priorLive.status, "replacing it");
      if (priorLive.deletedAt !== null || priorLive.archivedAt !== null) throw new Error(`Worker ${prior.thread_id} is not replaceable.`);
      if (!priorLive.environmentId) throw new Error(`Worker ${prior.thread_id} has no reusable environment.`);
      if (params.branch && params.branch !== prior.branch) throw new Error(`replaces: ${prior.thread_id} carries branch ${prior.branch}; pass no --branch or the same one.`);
    }
    const resolved = resolveDelegation(params, prior);
    const { issueUrl, planThreadId, wave, verifyCommand, unplannedReason } = resolved;
    // Planning on means every new delegation starts from a plan wave. replaces: hands off
    // an already-gated delegation, so it passes; the escape hatch must say why.
    const plannerOn = await ctx.plannerEnabled();
    if (planThreadId === undefined && !prior && !params.unplannedReason && plannerOn) {
      throw new Error("Planning is on: call chief_plan first, then delegate its waves with planThreadId and wave. To skip the plan, pass unplannedReason (CLI: --unplanned-reason) with your reason.");
    }
    const { kind, planPath, waveTotal, waveNext, waveIndependent, stackBase, designWave, implementsDesign, contracts, specSources, specDocs, baseline, specWave, lane, sideChain } = plans.admitDelegation({
      chiefId: chief.thread_id, prior, kind: params.kind, resolvedKind: resolved.kind, planThreadId, wave, branch: params.branch, prUrl: params.prUrl,
    });
    if (params.evidenceOnly && kind !== "tester") throw new Error("evidenceOnly is only for a tester: pass kind: tester (CLI --kind tester), or drop evidenceOnly.");
    // A first side-lane writer folds onto the chain's one branch and pull request, whatever Chief passed.
    const branch = sideChain?.branch ?? resolved.branch;
    const prUrl = sideChain ? sideChain.prUrl ?? undefined : resolved.prUrl;
    if (implementsDesign !== null) {
      // The design worker whose artboards this wave builds on: the one being replaced, else the wave's latest.
      const designer = prior && prior.plan_thread_id === planThreadId && prior.plan_wave === implementsDesign
        ? prior
        : latestWorker(planThreadId!, implementsDesign);
      if (!designer?.owner_approval) {
        throw new Error(`Wave ${implementsDesign} is design-only and wave ${wave} implements it: the owner must approve its artboards first. ${designer ? `Show the user the artboards from ${designer.thread_id}'s report, then record their decision with chief_owner_approval (workerThreadId: ${designer.thread_id}) and repeat this call.` : `No worker has delegated wave ${implementsDesign} yet.`}`);
      }
    }
    // One task branch carries one implementation-lane worker plus one side-lane Spec Writer per spec wave of the same plan:
    // a second worktree cannot check out a branch another one already holds, and the spawn would fail with a raw git error.
    const holder = branch
      ? store.all().find((row) => row.role === "worker" && !terminal(row.state)
        && row.project_id === projectId && row.branch === branch && row.thread_id !== params.replaces
        && !(planThreadId !== undefined && coexists(row, planThreadId, wave, lane)))
      : undefined;
    if (holder) {
      throw new Error(`Branch ${branch} already carries the active worker “${holder.title}” (${holder.thread_id}). Complete that worker, or give this delegation its own branch and pull request.`);
    }
    const hostId = prior ? await ctx.environmentHostId(priorLive!.environmentId!) : (await ctx.projectHostId(projectId)) ?? await ctx.defaultHostId();
    const prepared = await ctx.managedSpawn.prepare(projectId, { role: kind, hostId });
    const planContextLine = planPath !== undefined ? `Plan file (wave ${wave} of ${waveTotal}): ${planPath}` : undefined;
    // Read before the reviewer row is re-pointed below, so a `replaces` chain always
    // hands the fresh worker the review that prompted the handoff.
    const findings = prior ? ledger.openReview(prior.thread_id) : undefined;
    const ruledOut = prior ? chainFails(prior.thread_id) : [];
    let structured: ReportFinding[] | undefined;
    try { structured = findings?.findings ? JSON.parse(findings.findings) as ReportFinding[] : undefined; } catch { structured = undefined; }
    const { prompt, reviewerBrief } = workerBrief({
      title: params.title, chiefThreadId: chief.thread_id, params, wave, waveTotal, waveNext, waveIndependent, stackBase, designWave, implementsDesign,
      contracts, planContextLine, kind, verifyCommand, branch, issueUrl, prUrl, prior, findings, structured, ruledOut, specSources, baseline,
      specDocs, specWave, lane, evidenceOnly: params.evidenceOnly,
    });
    // A first side-lane writer never reuses the chain's worktree: its own managed worktree is cut from the chain branch.
    const thread = await ctx.managedSpawn.launch(prepared, {
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
      title: params.title, prompt,
    }, {
      role: "worker", chiefThreadId: chief.thread_id, brief: reviewerBrief,
      branch, issueUrl, prUrl, planThreadId, planWave: wave, unplannedReason, replacesThreadId: prior?.thread_id ?? null,
      kind: kind === "worker" ? null : kind, plannerOn, verifyCommand,
    });
    if (prior) {
      const now = Date.now();
      store.batch(() => {
        store.completeSuperseded(prior.thread_id, now);
        ledger.repoint(prior.thread_id, thread.id, now);
      });
    }
    void (!prior && !planThreadId ? ctx.trackerSync.start(store.get(thread.id)!, params.mission) : ctx.trackerSync.join(store.get(thread.id)!));
    return { threadId: thread.id, title: params.title, projectId };
  }

  const stallCapNote = ` Stall clock not reset: ${MAX_STALL_RESETS} nudges since the last report; the hard stall alert keeps its schedule.`;

  async function continueThread(threadId: string, instruction: string, callerChiefThreadId?: string | null) {
    const row = store.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker, planner, reviewer, or advisor ${threadId}.`);
    const callerChief = callerChiefThreadId ? store.get(callerChiefThreadId) : undefined;
    const effectiveChiefId = (callerChief && callerChief.role === "chief")
      ? callerChief.thread_id
      : (row.chief_thread_id ?? undefined);
    const handoff = `Hand it to a fresh worker instead: ${ctx.replacesCall(row)} keeps the same worktree, branch, and pull request.`;
    if (row.role === "worker" && (row.state === "ready" || row.state === "complete")) {
      throw new Error(`Worker ${threadId} already reported ${row.state}. chief_continue never reuses a finished worker for more work — deferred acceptance criteria, a rebase or restack, or a new task. ${handoff}`);
    }
    if (row.role !== "worker" && (row.state === "ready" || row.state === "complete")) {
      throw new Error(`${threadId} already reported; chief_continue is only a nudge to a thread still working. ${ctx.rerouteSteps(row)}`);
    }
    if (instruction.trim().length > MAX_NUDGE_LENGTH) {
      throw new Error(`chief_continue is a short nudge of at most ${MAX_NUDGE_LENGTH} characters to a thread that is still working. ${row.role === "worker" ? handoff : ctx.rerouteSteps(row)}`);
    }
    // Planners, reviewers, advisors, and researchers all stay out of the files; only a worker
    // edits. The instruction leads so the child reads what it says first, ahead of
    // the read-only reminder. steer-if-active steers a running turn instead of
    // waiting in BB's queue, and starts a turn when the thread is idle.
    const reminder = CONTINUE_REMINDERS[row.role] ?? null;
    const text = reminder ? `${instruction}\n\n${reminder}` : instruction;
    await bb.sdk.threads.send({
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text, mentions: [] }],
      senderThreadId: effectiveChiefId,
    });
    ctx.observe.event("nudge", row, `chars=${instruction.length}`);
    const now = Date.now();
    // The store decides from the stored counter inside one synchronous transaction, not the pre-send snapshot:
    // overlapping continues and an interleaved report (which zeroes it) must each see the current value.
    const capped = store.markContinued(threadId, now, MAX_STALL_RESETS);
    return capped;
  }

  const insertPlanLog = db.prepare<[string, string, number | null, string, string, string, string, string]>(
    `INSERT INTO plan_log (plan_thread_id, author_thread_id, wave, kind, text, scope, basis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  function appendPlanLog(row: ManagedRow, entries: z.infer<typeof logParams>["entries"] & {}) {
    const at = new Date().toISOString();
    for (const entry of entries) {
      insertPlanLog.run(row.plan_thread_id!, row.thread_id, row.plan_wave, entry.kind, entry.text, entry.scope, entry.basis, at);
    }
  }

  /** chief_log: append the caller's entries, then return unread peer entries and every wave's current owner and state. */
  function planLog(row: ManagedRow, entries: z.infer<typeof logParams>["entries"]): string {
    const planThreadId = row.plan_thread_id!;
    const unread = db.prepare(`SELECT * FROM plan_log WHERE plan_thread_id=? AND id>? AND author_thread_id<>? ORDER BY id LIMIT ?`)
      .all(planThreadId, row.log_read_id ?? 0, row.thread_id, MAX_LOG_READ + 1) as {
        id: number; author_thread_id: string; wave: number | null; kind: string; text: string; scope: string; basis: string;
      }[];
    const shown = unread.slice(0, MAX_LOG_READ);
    const write = () => {
      if (entries?.length) appendPlanLog(row, entries);
      // Only the cursor moves: never state, report_seq or the alert outbox.
      if (shown.length) store.markLogRead(row.thread_id, shown.at(-1)!.id);
    };
    // Appended entries alone touch no managed row, so only a moved cursor reloads.
    if (shown.length) store.batch(write);
    else db.transaction(write)();
    const more = unread.length > MAX_LOG_READ
      ? (db.prepare(`SELECT COUNT(*) AS n FROM plan_log WHERE plan_thread_id=? AND id>? AND author_thread_id<>?`)
        .get(planThreadId, shown.at(-1)!.id, row.thread_id) as { n: number }).n
      : 0;
    const waves = planWavesFor(planThreadId);
    return [
      entries?.length ? `Appended ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.` : null,
      "## Unread peer entries",
      ...(shown.length
        ? shown.map((entry) => `- #${entry.id} ${entry.kind} wave ${entry.wave ?? "?"} @thread:${entry.author_thread_id} [${entry.scope}] ${entry.text} (basis: ${entry.basis})`)
        : ["- none"]),
      ...(more ? [`${more} more unread: call chief_log again.`] : []),
      "", "## Waves",
      ...waves.map((_, index) => {
        const line = (current: ManagedRow, label = "") => {
          const last = (current.result ?? current.status ?? "").split("\n").find((entry) => entry.trim()) ?? "";
          return `${label}@thread:${current.thread_id} ${current.state}${last ? ` | ${clip(last.trim(), 160)}` : ""}`;
        };
        const current = latestWorker(planThreadId, index + 1);
        const writer = latestSideWriter(planThreadId, index + 1);
        if (!current && !writer) return `- wave ${index + 1}: not delegated`;
        return `- wave ${index + 1}: ${[current ? line(current) : "no implementation row", ...(writer ? [line(writer, "Spec Writer ")] : [])].join("; ")}`;
      }),
    ].filter((line) => line !== null).join("\n");
  }
  return { appendPlanLog, continueThread, delegate, planLog, stallCapNote, startConsult, startPlan };
}

