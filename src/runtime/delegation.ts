import { DOCS_WORK_FILE, advisorBrief, plannerBrief, resolveDelegation, workerBrief } from "../research/delegationBrief";
import { MAX_CARRIED_FAILS, sectionOf } from "../report/reportIntake";
import { isWriter } from "../plan/waveSchedule";
import { wrongTestEvidence, neverReported } from "../plan/planProgress";
import { worktreeEnvironment } from "../research/managedSpawn";
import { heavySlotCount } from "../research/heavySlots";
import { isReady } from "../plan/waveSchedule";
import type { ReviewGate } from "../db/threadStore";
import { CONTINUE_REMINDERS, planAdmissions } from "../core/roles";
import { type FailEntry, type ManagedRow, type ReportFinding, terminal } from "../types";
import { clip } from "../core/text";
import { prMerged } from "../forge/forge";
import { z } from "zod";
import { consultParams, delegateParams, logParams, planParams } from "../tools/shapes";
import { BUSY_STATUSES, MAX_NUDGE_LENGTH } from "./constants";
import type { Ctx } from "./context";

/** chief_continue calls per stall episode that re-arm the stall clock; later ones still deliver the nudge but leave the alert schedule alone. A report resets the count. */
const MAX_STALL_RESETS = 2;

const MAX_LOG_READ = 30;

/** The `## Failing tests` section of a tester's result, or null. */
const failingTests = (result: string | null) => /^#{1,6}[ \t]+failing tests[^\n]*\n([\s\S]*?)(?=^#{1,6}[ \t]|(?![\s\S]))/im.exec(result ?? "")?.[1]?.trim() || null;

export function createDelegation(ctx: Ctx) {
  const { bb, coexists, db, latestSideWriter, latestWorker, ledger, planWavesFor, plans, progress, reviewerFails, schedule, store } = ctx;
  /** A read-only role's environment: a fresh worktree on `branch` when it names one, else the project default. */
  async function readerEnvironment(projectId: string, branch?: string) {
    return branch ? worktreeEnvironment(await ctx.projectHost(projectId), branch) : { type: "project-default" as const };
  }

  /** A plan is read-only work in the project-default environment — its own worktree in projects whose default is a worktree, else the project checkout; with a branch, a fresh worktree on it. Nothing is implemented until Chief delegates. */
  async function startPlan(params: z.infer<typeof planParams>, callerThreadId?: string | null) {
    if (!(await ctx.plannerEnabled())) {
      throw new Error("Planning is off. Turn on “Plan before delegating” in Chief's settings, or delegate this work directly.");
    }
    const { chief, projectId } = await ctx.owningChief(callerThreadId);
    const revision = params.revises ? revisionInput(params.revises, chief.thread_id) : undefined;
    // A revision keeps the design its original planner was bound to; every refusal below runs before any freshen or spawn.
    const revised = params.revises ? store.get(params.revises) : undefined;
    const researchThreadId = params.researchThreadId ?? revised?.research_thread_id ?? undefined;
    if (!researchThreadId && !params.revises && !params.undesignedReason && (await ctx.researchSettings()).enabled) {
      throw new Error("chief_plan needs researchThreadId (an approved chief_research design: true) or undesignedReason.");
    }
    let design: { researcherThreadId: string; designPath: string; factsPath: string } | undefined;
    let researchReportSeq: number | null = null;
    if (revised?.research_thread_id) {
      // A revision reads only the exact snapshot pair its original plan was bound to.
      const bound = await approvedDesign(revised.research_thread_id, revised.research_report_seq, projectId);
      design = { researcherThreadId: revised.research_thread_id, designPath: bound.designPath, factsPath: bound.factsPath };
      researchReportSeq = revised.research_report_seq;
    } else if (researchThreadId) {
      const researcher = store.get(researchThreadId);
      if (!researcher || researcher.role !== "researcher" || !ctx.controlsThread(researcher, chief.thread_id)) throw new Error(`No managed researcher ${researchThreadId} for this Chief.`);
      if (researcher.research_design !== 1) throw new Error(`Researcher ${researchThreadId} ran without design: chief_plan researchThreadId needs a chief_research design: true researcher.`);
      if (researcher.last_report_state !== "ready" || (researcher.state !== "ready" && researcher.state !== "complete")) {
        throw new Error(`Researcher ${researchThreadId} has no approved design yet: its last report is ${researcher.last_report_state ?? "missing"}; wait for its ready report.`);
      }
      const bound = await bindDesign(researcher, projectId);
      researchReportSeq = researcher.report_seq;
      design = { researcherThreadId: researchThreadId, designPath: bound.designPath, factsPath: bound.factsPath };
    }
    // A revision stays on the branch its original planner read.
    const branch = params.branch ?? revised?.branch ?? undefined;
    const prepared = await ctx.managedSpawn.prepare(projectId, { role: "planner", hostId: await ctx.projectHostId(projectId) });
    const title = `Plan · ${params.title.replace(/^Plan · /, "")}`;
    const prompt = plannerBrief({
      title: params.title, chiefThreadId: chief.thread_id, mission: params.mission, context: params.context,
      revision, branch, design, undesignedReason: params.undesignedReason,
    });
    const warning = branch ? null : await ctx.freshenChiefCheckout(chief, "planner");
    const thread = await ctx.managedSpawn.launch(prepared,
      { projectId, environment: await readerEnvironment(projectId, branch), title, prompt },
      { role: "planner", chiefThreadId: chief.thread_id, replacesThreadId: params.revises ?? null, researchThreadId: researchThreadId ?? null, researchReportSeq, ...(branch ? { branch } : {}) },
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

  /** The user-approved design bound to a plan: write-once snapshots of design.md and the full ready result, keyed by the researcher's
   * ready report, in its Chief artifact dir. An existing snapshot is reused and never rewritten, so the design cannot change under a plan. */
  async function bindDesign(researcher: ManagedRow, projectId: string) {
    const id = researcher.thread_id;
    const designName = `design-approved-r${researcher.report_seq}.md`;
    const factsName = `facts-approved-r${researcher.report_seq}.md`;
    const snapshot = async (name: string, source: () => Promise<string>) => {
      // A failed read must not look like "absent": the snapshot is write-once.
      const existing = await ctx.readArtifactIfPresent(id, projectId, name).catch((error) => {
        throw new Error(`Could not read ${name} for researcher ${id} (${String((error as Error)?.message ?? error).slice(0, 200)}); nothing was started. Retry chief_plan.`);
      });
      if (existing) return existing;
      const text = await source();
      return { path: await ctx.writeArtifact(id, projectId, name, text), text };
    };
    const designSnap = await snapshot(designName, async () => {
      const text = await ctx.readStorageFile(id, "design.md");
      if (!text?.trim()) throw new Error(`Researcher ${id}'s design.md is missing or empty; it cannot be planned.`);
      if (text.length > 40_000) throw new Error(`Researcher ${id}'s design.md is ${text.length} characters, over the 40,000 limit; ask it to shorten the design.`);
      return text;
    });
    const factsSnap = await snapshot(factsName, async () => {
      if (!researcher.result?.trim()) throw new Error(`Researcher ${id}'s ready report has no result (fact report).`);
      return researcher.result;
    });
    return { designPath: designSnap.path, factsPath: factsSnap.path, designText: designSnap.text };
  }

  /** A plan's bound design: reads only the exact snapshot pair of ready report `seq`; never design.md, never creates. Missing or unreadable refuses. */
  async function approvedDesign(researcherId: string, seq: number | null, projectId: string) {
    if (seq == null) throw new Error(`The plan's design binding to researcher ${researcherId} has no ready report; nothing was started.`);
    const read = async (name: string) => {
      const found = await ctx.readArtifactIfPresent(researcherId, projectId, name).catch((error) => {
        throw new Error(`Could not read ${name} for researcher ${researcherId} (${String((error as Error)?.message ?? error).slice(0, 200)}); nothing was started. Retry.`);
      });
      if (!found) throw new Error(`The approved design snapshot ${name} of researcher ${researcherId} is missing; nothing was started.`);
      return found;
    };
    const designSnap = await read(`design-approved-r${seq}.md`);
    const factsSnap = await read(`facts-approved-r${seq}.md`);
    return { designPath: designSnap.path, factsPath: factsSnap.path, designText: designSnap.text };
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

  async function startConsult(params: z.infer<typeof consultParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await ctx.owningChief(callerThreadId);
    return startPlanConsult(params, params.planThreadId, chief.thread_id, projectId);
  }

  /** chief_consult planThreadId: an optional read-only advisor review of a plan, in the project's own checkout. */
  async function startPlanConsult(params: z.infer<typeof consultParams>, plannerId: string, chiefThreadId: string, projectId: string) {
    const planner = store.get(plannerId);
    if (!planner || planner.role !== "planner" || !ctx.controlsThread(planner, chiefThreadId) || !planner.plan_waves || planner.state === "complete") {
      throw new Error(`No managed planner ${plannerId} with an open plan for this Chief.`);
    }
    if (planner.replaces_thread_id) throw new Error(`${plannerId} is a revision; a revision gets no review: delegate its waves.`);
    if (planner.plan_review && planner.plan_review !== "required") {
      const { decider } = ctx.planAdvisors(plannerId);
      throw new Error(`Plan ${plannerId} already had its one review (${decider?.thread_id ?? "?"}): ${ctx.planReviewRefusal(planner) ?? ctx.nextAction(planner) ?? "delegate its waves."}`);
    }
    const { inFlight } = ctx.planAdvisors(plannerId);
    if (inFlight) throw new Error(`Plan ${plannerId} is already in review by ${inFlight.thread_id}: wait for ${inFlight.thread_id}, or chief_stop it first.`);
    if (planAdmissions.has(plannerId)) throw new Error(`Plan ${plannerId} is being submitted or already entering review: retry chief_consult once its ready alert arrives.`);
    planAdmissions.add(plannerId);
    try {
    const branch = params.branch ?? planner.branch ?? undefined;
    const prepared = await ctx.managedSpawn.prepare(projectId, { role: "advisor", hostId: await ctx.projectHostId(projectId) });
    const title = `Consult · ${params.title.replace(/^Consult · /, "")}`;
    const prompt = advisorBrief({
      title: params.title, chiefThreadId, mission: params.mission, context: params.context, branch,
      plan: {
        plannerThreadId: plannerId, paths: planWavesFor(plannerId).map((wave) => wave.path),
        summary: planner.result ? clip(planner.result, 1_500) : null, reportPath: planner.report_path,
      },
    });
    const thread = await ctx.managedSpawn.launch(prepared,
      { projectId, environment: await readerEnvironment(projectId, branch), title, prompt },
      { role: "advisor", chiefThreadId, planThreadId: plannerId, ...(branch ? { branch } : {}) });
    // Set after the launch: a failed launch leaves no gate.
    store.setPlanReview(plannerId, "required");
    return { threadId: thread.id, title, projectId };
    } finally { planAdmissions.delete(plannerId); }
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

  type FixAdmission = { run: "gate" | "corrector"; gate: ReviewGate } | { run: "chat"; gate?: undefined };

  /** A replaces: that is a fix run: the gate's one fix worker (replaces its tester), its one corrector (replaces a blocked fix run),
   * or a chat fix (replaces a completed gate target or fix run while its environment lives). Throws on a refused one; null for any other delegation. */
  function fixAdmission(prior: ManagedRow, kind: string | undefined): FixAdmission | null {
    const gate = store.gateFor(prior.thread_id);
    const escalate = (fixer: string) => `The gate already had its fix run (${fixer}): escalate to the user.`;
    if (gate && gate.tester_thread_id === prior.thread_id) {
      if (kind === undefined) throw new Error("Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs/.");
      if (kind !== "worker") throw new Error(`${prior.thread_id} is review gate ${gate.gate_key}'s tester: only the gate's one fix run replaces it — chief_delegate (replaces: ${prior.thread_id}, kind: worker).`);
      const fixer = gate.fixer_thread_id ? store.get(gate.fixer_thread_id) : undefined;
      if (fixer && neverReported(fixer)) throw new Error(`Fix run ${fixer.thread_id} stopped before it reported and its environment holds its partial work: chief_delegate (replaces: ${fixer.thread_id}, kind: worker).`);
      if (gate.fixer_thread_id) throw new Error(escalate(gate.fixer_thread_id));
      const decision = ctx.gateOf(prior)!.decision;
      if (decision.kind !== "fix") throw new Error(`Review gate ${gate.gate_key} needs no fix run. ${ctx.gateLine(gate, decision)}`);
      return { run: "gate", gate };
    }
    if (gate && gate.fixer_thread_id === prior.thread_id && !gate.corrector_thread_id && neverReported(prior)) {
      if (kind !== "worker") throw new Error(`Fix run ${prior.thread_id} stopped before it reported, so the gate's fix-run slot is free (a corrector replaces only a fix run that reported blocked with wrong-test evidence): chief_delegate (replaces: ${prior.thread_id}, kind: worker).`);
      const decision = ctx.gateOf(prior)!.decision;
      if (decision.kind !== "fix") throw new Error(`Review gate ${gate.gate_key} needs no fix run. ${ctx.gateLine(gate, decision)}`);
      return { run: "gate", gate };
    }
    if (gate && prior.state !== "complete" && gate.fixer_thread_id === prior.thread_id) {
      if (kind !== "tester") throw new Error(escalate(prior.thread_id));
      if (gate.corrector_thread_id) throw new Error(`Review gate ${gate.gate_key} already had its corrector (${gate.corrector_thread_id}): escalate to the user.`);
      if (prior.last_report_state !== "blocked" || !wrongTestEvidence(prior.blocker)) throw new Error(`A corrector replaces fix run ${prior.thread_id} only after it reports blocked with wrong-test evidence; it is ${prior.state}${prior.last_report_state === "blocked" ? " and its blocker names no test file:line" : ""}. Answer its blocker with chief_continue (threadId: ${prior.thread_id}), or escalate.`);
      return { run: "corrector", gate };
    }
    if (gate && gate.fixer_thread_id === prior.thread_id && gate.corrector_thread_id && kind === "tester") throw new Error(`Review gate ${gate.gate_key} already had its corrector (${gate.corrector_thread_id}): escalate to the user.`);
    if (gate && gate.corrector_thread_id === prior.thread_id && neverReported(prior)) {
      if (kind !== "tester") throw new Error(`Corrector ${prior.thread_id} stopped before it reported: delegate the gate's corrector again — chief_delegate (replaces: ${prior.thread_id}, kind: tester).`);
      return { run: "corrector", gate };
    }
    if (gate && prior.state !== "complete" && gate.corrector_thread_id === prior.thread_id) throw new Error(`${prior.thread_id} is review gate ${gate.gate_key}'s corrector: there is no second fix. Escalate to the user.`);
    if (prior.state === "complete" && (prior.fix_run || gate?.targets.some((target) => target.threadId === prior.thread_id))) {
      if (kind !== "worker") throw new Error(`A change after completion is a fix run: chief_delegate (replaces: ${prior.thread_id}, kind: worker).`);
      return { run: "chat" };
    }
    return null;
  }

  /** The fix run's brief section input: the gate's evidence for a gate fix or corrector; nothing replayed for a chat fix. */
  function fixRunBrief(fix: FixAdmission, prior: ManagedRow) {
    if (fix.run === "chat") return { run: "chat" as const, branch: prior.branch };
    const reviewer = fix.gate.reviewer_thread_id ? store.get(fix.gate.reviewer_thread_id) : undefined;
    const tester = fix.gate.tester_thread_id ? store.get(fix.gate.tester_thread_id) : undefined;
    let findings: ReportFinding[] = [];
    try { findings = reviewer?.findings ? JSON.parse(reviewer.findings) as ReportFinding[] : []; } catch { findings = []; }
    // The corrector's evidence is the gate's fix run, also when it replaces a corrector that never reported.
    const fixer = fix.run === "corrector" && fix.gate.fixer_thread_id ? store.get(fix.gate.fixer_thread_id) : undefined;
    return {
      run: fix.run, fixerThreadId: fixer?.thread_id ?? null,
      fixerReport: fixer ? fixer.report_path ?? fixer.blocker : null,
      targets: fix.gate.targets,
      reviewer: reviewer ? { threadId: reviewer.thread_id, verdict: reviewer.verdict, verdictPath: reviewer.verdict_path, findings } : null,
      tester: tester ? { threadId: tester.thread_id, reportPath: tester.report_path, failingTests: failingTests(tester.result) } : null,
    };
  }

  async function startWorker(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await ctx.owningChief(callerThreadId);
    const prior = params.replaces ? store.get(params.replaces) : undefined;
    if (params.replaces && (!prior || prior.role !== "worker" || !ctx.controlsThread(prior, chief.thread_id) || prior.project_id !== projectId)) {
      throw new Error(`No managed worker ${params.replaces} for this Chief.`);
    }
    let priorLive: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
    if (prior) {
      priorLive = await ctx.waitIdleAfterReport(prior);
      if (BUSY_STATUSES.has(priorLive.status)) ctx.busyRejection(prior, priorLive.status, "replacing it");
      if (priorLive.deletedAt !== null || priorLive.archivedAt !== null) throw new Error(`Worker ${prior.thread_id} is not replaceable.`);
      if (!priorLive.environmentId) throw new Error(`Worker ${prior.thread_id} has no reusable environment.`);
      if (params.branch && params.branch !== prior.branch) throw new Error(`replaces: ${prior.thread_id} carries branch ${prior.branch}; pass no --branch or the same one.`);
    }
    const fix = prior ? fixAdmission(prior, params.kind) : null;
    if (fix?.run === "chat") {
      // A chat fix lands on the PR, so the forge must say it is still open and unmerged; merged, closed, missing or unknown refuses.
      const url = prior!.pr_url ?? store.gateFor(prior!.thread_id)?.targets.find((target) => target.threadId === prior!.thread_id)?.prUrl;
      const pr = url ? await prMerged(url, await ctx.projectPath(projectId)) : null;
      if (!pr?.open || pr.merged) throw new Error(`A chat fix for ${prior!.thread_id} needs its pull request open and unmerged, but ${url ? `the forge reports ${url} ${pr ? (pr.merged ? "merged" : "closed") : "unknown"}` : "it has no pull request"}. Start new work with chief_delegate (no replaces:), or retry when the forge answers.`);
    }
    // An open review gate pinned its targets: fixes go through the gate's fix run, and its one tester is the gate's.
    const gate = prior ? store.gateFor(prior.thread_id) : params.planThreadId ? store.gate(`plan:${params.planThreadId}`) : undefined;
    if (!fix && gate?.targets.some((target) => store.get(target.threadId)?.state !== "complete")) {
      if (prior && gate.targets.some((target) => target.threadId === prior.thread_id) && params.kind !== "spec-writer") {
        throw new Error(`The review gate pinned ${prior.thread_id}; fixes go through the gate's fix run. ${ctx.gateLine(gate, ctx.gateOf(prior)!.decision)}`);
      }
      if (params.kind === "tester" && !params.evidenceOnly) throw new Error(`Review gate ${gate.gate_key} is open: its one tester writes the tests. Pass evidenceOnly for an evidence-only tester.`);
      // One writable owner per gate: a docs repair waits for the fix run and the corrector.
      const busyFixer = isWriter(params.kind) && [gate.fixer_thread_id, gate.corrector_thread_id].map((id) => (id ? store.get(id) : undefined))
        .find((actor) => actor && !terminal(actor.state) && !isReady(actor) && !["blocked", "failed"].includes(actor.state) && actor.last_report_state !== "blocked");
      if (busyFixer) throw new Error(`Review gate ${gate.gate_key}'s ${busyFixer.kind === "tester" ? "corrector" : "fix run"} ${busyFixer.thread_id} is still working on the branch: wait for its report, then repair the docs.`);
    }
    const resolved = resolveDelegation(params, prior);
    const { issueUrl, verifyCommand } = resolved;
    // A fix run is no plan wave: a gate's fix run and corrector stay linked to the gate's plan like its tester; a chat fix is linked to none.
    const planThreadId = fix ? fix.gate?.plan_thread_id ?? undefined : resolved.planThreadId;
    const wave = fix ? undefined : resolved.wave;
    const unplannedReason = fix ? undefined : resolved.unplannedReason;
    // Planning on means every new delegation starts from a plan wave. replaces: hands off
    // an already-gated delegation, so it passes; the escape hatch must say why.
    const plannerOn = await ctx.plannerEnabled();
    if (planThreadId === undefined && !prior && !params.unplannedReason && plannerOn) {
      throw new Error("Planning is on: call chief_plan first, then delegate its waves with planThreadId and wave. To skip the plan, pass unplannedReason (CLI: --unplanned-reason) with your reason.");
    }
    const { kind, planPath, waveTotal, waveNext, waveIndependent, stackBase, designWave, implementsDesign, contracts, specSources, specDocs, baseline, specWave, lane, sideChain } = fix
      ? { kind: fix.run === "corrector" ? "tester" as const : "worker" as const, waveNext: null, waveIndependent: false, designWave: false, implementsDesign: null, specSources: [], specDocs: [], baseline: false, specWave: false, lane: "implementation" as const, planPath: undefined, waveTotal: undefined, stackBase: undefined, contracts: undefined, sideChain: undefined }
      : plans.admitDelegation({
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
    // One task branch carries one implementation-lane worker plus the plan's side-lane Spec Writer:
    // a second worktree cannot check out a branch another one already holds, and the spawn would fail with a raw git error.
    const holder = branch
      ? store.all().find((row) => row.role === "worker" && !terminal(row.state)
        && row.project_id === projectId && row.branch === branch && row.thread_id !== params.replaces
        && !(planThreadId !== undefined && coexists(row, planThreadId, wave, lane))
        // A gate fix run works on the pinned targets' branch: its targets and tester do not hold it.
        && !(fix?.gate && (fix.gate.tester_thread_id === row.thread_id || fix.gate.targets.some((target) => target.threadId === row.thread_id)))
        // A docs repair does not wait on a gate's fixer, corrector or tester that is no longer busy; a busy one still holds the branch.
        && !(isWriter(kind) && gate && !BUSY_STATUSES.has(row.state)
          && [gate.fixer_thread_id, gate.corrector_thread_id, gate.tester_thread_id].includes(row.thread_id)))
      : undefined;
    if (holder) {
      throw new Error(`Branch ${branch} already carries the active worker “${holder.title}” (${holder.thread_id}). Complete that worker, or give this delegation its own branch and pull request.`);
    }
    const hostId = prior ? await ctx.environmentHostId(priorLive!.environmentId!) : await ctx.projectHost(projectId);
    const prepared = await ctx.managedSpawn.prepare(projectId, { role: kind, hostId });
    // Nothing in this preparation may fail the delegation: without a path the brief simply has no wrapper.
    const heavyPath = isWriter(kind) || !hostId ? null
      : await ctx.settings.get().then((values) => ctx.publishHeavy(hostId, heavySlotCount(values)))
        .catch((error) => { bb.log.warn(`Heavy-command slots are unavailable for ${params.title}: ${String(error)}`); return null; });
    const planContextLine = planPath !== undefined ? `Plan file (wave ${wave} of ${waveTotal}): ${planPath}` : undefined;
    // Read before the reviewer row is re-pointed below, so a `replaces` chain always
    // hands the fresh worker the review that prompted the handoff.
    // A fix run gets the gate's evidence (or, for a chat fix, none) instead of an open review.
    const findings = prior && !fix ? ledger.openReview(prior.thread_id) : undefined;
    const ruledOut = prior ? chainFails(prior.thread_id) : [];
    let structured: ReportFinding[] | undefined;
    try { structured = findings?.findings ? JSON.parse(findings.findings) as ReportFinding[] : undefined; } catch { structured = undefined; }
    // A side-lane writer (first or same-plan repair) carries every known docs item of the waves it owns, and a blocked prior writer's blocker.
    const docsWork = isWriter(kind) && lane === "side" && planThreadId !== undefined && wave !== undefined && (!prior || prior.plan_thread_id === planThreadId) ? [
      ...schedule.ownedWorkers(planThreadId, wave).flatMap((row) => {
        const text = sectionOf(row.result ?? "", "docs needed")?.trim();
        return text && !/^none\.?$/i.test(text) ? [{ id: row.thread_id, kind: row.kind ?? "worker", wave: row.plan_wave, text }] : [];
      }),
      ...(prior?.blocker && prior.last_report_state === "blocked" ? [{ id: prior.thread_id, kind: "spec-writer", wave: prior.plan_wave, blocker: true, text: prior.blocker }] : []),
    ] : [];
    const { prompt, reviewerBrief, docsWorkFile } = workerBrief({
      title: params.title, chiefThreadId: chief.thread_id, params, wave, waveTotal, waveNext, waveIndependent, stackBase, designWave, implementsDesign,
      contracts, planContextLine, kind, verifyCommand, branch, issueUrl, prUrl, prior, findings, structured, ruledOut, specSources, baseline,
      specDocs, specWave, lane, evidenceOnly: params.evidenceOnly, docsWork, heavyPath, fixRun: fix ? fixRunBrief(fix, prior!) : undefined,
      sharedReview: !!findings && ledger.targets(findings.thread_id).length > 1,
    });
    // A side-lane writer, first or repair, never reuses a worktree: its own managed worktree is cut from the chain branch, so a stale or half-rebased side checkout never reaches the fold.
    const thread = await ctx.managedSpawn.launch(prepared, {
      projectId,
      environment: prior && lane !== "side"
        ? { type: "reuse", environmentId: priorLive!.environmentId! }
        : worktreeEnvironment(hostId as string, branch),
      title: params.title, prompt,
    }, {
      role: "worker", chiefThreadId: chief.thread_id, brief: reviewerBrief,
      branch, issueUrl, prUrl, planThreadId, planWave: wave, unplannedReason, replacesThreadId: prior?.thread_id ?? null,
      kind: kind === "worker" ? null : kind, plannerOn, verifyCommand, evidenceOnly: kind === "tester" && params.evidenceOnly ? true : null,
    }, fix && ((threadId) => store.batch(() => {
      if (fix.run !== "chat") store.setGateActor(fix.gate!.gate_key, fix.run === "gate" ? "fixer_thread_id" : "corrector_thread_id", threadId);
      if (fix.run !== "corrector") store.setFixRun(threadId, fix.run);
    })) || undefined);
    // The overflow file is written after the spawn, once the thread's own storage exists; the brief names it by $BB_THREAD_STORAGE.
    if (docsWorkFile) {
      // The file is the only place the omitted source items live, so a failed write rolls the launch back: the new thread is stopped and unlinked
      // from the plan (the prior writer stays the scheduler's owner and the review gate stays closed), and Chief gets a retryable error.
      try {
        await ctx.retryWhileProvisioning(() => ctx.writeStorageFile(thread.id, DOCS_WORK_FILE, docsWorkFile));
      } catch (error) {
        const stopFailure = await bb.sdk.threads.stop({ threadId: thread.id }).then(() => undefined, (stopError: unknown) => String(stopError));
        store.rollBackLaunch(thread.id, Date.now(), stopFailure === undefined);
        if (stopFailure !== undefined) bb.log.warn(`Could not stop ${thread.id} after its docs work list failed: ${stopFailure}`);
        throw new Error(`Could not write the docs work list for the repair writer ${thread.id} (${clip(String(error), 300)}). ${stopFailure === undefined
          ? "That thread was stopped and retired from the plan"
          : `Stopping that thread FAILED (${clip(stopFailure, 200)}): it may still be running without the work list, and it still holds the branch, so a retry is refused until you stop and archive it`}; ${prior ? `${prior.thread_id} stays the owner of the docs work` : "nothing else changed"}. Repeat this chief_delegate call${stopFailure === undefined ? "" : " after that"}.`);
      }
    }
    if (prior) {
      const now = Date.now();
      store.completeSuperseded(prior.thread_id, now);
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
    const handoff = `Hand it to a fresh worker instead: ${ctx.replacesCall(row)} ${ctx.sideLane(row) ? "starts a fresh worktree on the same branch and pull request" : "keeps the same worktree, branch, and pull request"}.`;
    if (row.role === "worker" && (row.state === "ready" || row.state === "complete")) {
      throw new Error(`Worker ${threadId} already reported ${row.state}. chief_continue never reuses a finished worker for more work — deferred acceptance criteria, a rebase or restack, or a new task. ${handoff}`);
    }
    // An unadvised advisor's gate ends when its plan is replaced or decided: resuming it would run ungated.
    if (row.role === "advisor" && row.plan_thread_id && row.advised_at == null && store.get(row.plan_thread_id)?.plan_review !== "required") {
      throw new Error(`Advisor ${threadId} reviewed a plan revision that was since replaced or decided; it cannot be resumed. Start a fresh chief_consult (planThreadId: ${row.plan_thread_id}), or delegate the plan without it.`);
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
  return { appendPlanLog, approvedDesign, continueThread, delegate, planLog, stallCapNote, startConsult, startPlan };
}

