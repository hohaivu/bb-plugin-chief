import { gateDecision, type GateDecision } from "../plan/planProgress";
import type { ReviewGate } from "../db/threadStore";
import { reviewEngine } from "../review/prAgent";
import { createReviewStart } from "../review/reviewStart";
import { terminal, type ManagedRow } from "../types";
import { clip } from "../core/text";
import { isWriter, type PlanWave } from "../plan/waveSchedule";
import { BUSY_STATUSES, MAX_NUDGE_LENGTH } from "./constants";
import { bounded } from "./exec";
import { forgeEnv, prHead } from "../forge/forge";
import { heavySlotCount } from "../research/heavySlots";
import type { Ctx } from "./context";

const REVIEW_IDLE_WAIT_MS = 60_000;

const REVIEW_IDLE_POLL_MS = 2_000;

const DESIGN_REVIEW_REFUSAL = "Design-only work is approved by the owner only: show the user the artboards and record their decision with chief_owner_approval.";

export function createNextAction(ctx: Ctx) {
  const { bb, db, ledger, onSpecChain, planWavesFor, progress, reviewTargetsFor, schedule, settings, specWave, specWriters, store } = ctx;
  /** Wave n of a plan is a spec wave: the sentence saying its default call spawns its Spec Writer, else "". */
  function specFirstLine(planThreadId: string | null, waves: PlanWave[], n: number): string {
    return planThreadId && specWave(waves, n)
      ? ` Wave ${n} is marked spec: true: in this same turn also delegate its Spec Writer — chief_delegate (planThreadId: ${planThreadId}, wave: ${n}, kind: spec-writer) — which works in its own worktree beside the worker and folds its docs/ commits onto the branch. To go without one, record why: chief_skip_specs (planThreadId: ${planThreadId}, wave: ${n}, reason).`
      : "";
  }

  /** On a spec-bearing chain, the routes for a wrong spec and for a Spec delta that cannot be built. */
  function specRoutes(row: ManagedRow): string {
    const plans = row.plan_thread_id ? planWavesFor(row.plan_thread_id).map((wave) => wave.path).join(", ") : "";
    return `If the spec is wrong: chief_delegate (replaces: ${row.thread_id}, kind: spec-writer) with the fix, with the docs items in the mission. If the Spec delta cannot be built: start a fresh chief_plan with ${plans ? `the plan files (${plans}), ` : ""}this blocked report (bb chief inspect ${row.thread_id}), branch ${row.branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${row.thread_id}.`;
  }

  /** A blocked worker's in-place route: an environment or permission blocker is answered with the allowed step, not a fresh worker. */
  const inPlaceLine = (row: ManagedRow) => `If the blocker is an environment or permission problem (a blocked command, a dirty build-cache file, a needed permission), not a code, test or spec defect: answer it in place with chief_continue (threadId: ${row.thread_id}, instruction: the allowed step, at most ${MAX_NUDGE_LENGTH} characters); it keeps its worktree.`;

  /** Why a worker may not start a review now, or null. The review of a plan runs once, after every wave is ready. */
  function reviewRefusal(worker: ManagedRow): string | null {
    const block = progress.reviewBlock(worker);
    if (!block) return null;
    switch (block.kind) {
      case "design": return DESIGN_REVIEW_REFUSAL;
      case "superseded":
        return `${worker.thread_id} is superseded by ${block.latest.thread_id}. The plan's one review starts from the latest workers: chief_review (workerThreadId: ${block.latest.thread_id}) once every wave is ready.`;
      case "restack":
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Wave ${block.next} is stacked on it and still builds on the old head: restack it first — chief_delegate (replaces: ${block.successor.thread_id}).`;
      case "restacked":
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Wave ${block.next} was already restacked as ${block.successor.thread_id}; start the plan's one review from the latest chain-tip worker once every wave is ready.`;
      case "betweenWaves":
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Delegate wave ${block.next}: ${block.waves[block.next - 1]!.path} — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, replaces: ${worker.thread_id}).${specFirstLine(worker.plan_thread_id, block.waves, block.next)}`;
      case "sideWriter":
        return `${worker.thread_id} is a Spec Writer: it never starts a review. The plan's one review starts from an implementation chain tip (chief_review) once every wave and every Spec Writer is ready.`;
      case "writers":
        return `One review covers the whole plan once every Spec Writer is ready; ${block.writers.map(({ wave, writer }) => writer ? `wave ${wave}'s ${writer.thread_id} (${writer.state})` : `wave ${wave}'s Spec Writer is not delegated yet — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${wave}, kind: spec-writer), or record why not with chief_skip_specs`).join(", ")} ${block.writers.length > 1 ? "are" : "is"} not ready. Wait for their ready reports, then start the review.`;
      case "unready":
        return `The review gate opens only on ready work; ${block.rows.map((row) => `${row.thread_id} (${row.state})`).join(", ")} ${block.rows.length > 1 ? "have" : "has"} no ready report. Wait for the ready report, or chief_continue (threadId: ${block.rows[0]!.thread_id}) to finish it, then start the review.`;
      case "pending":
        return `One review covers the whole plan once every wave is ready; wave(s) ${block.pending.join(", ")} of ${block.waves.length} are not ready yet. Wait for their ready reports (delegate any wave not delegated yet), then start the review.`;
    }
  }

  /** A ready chain-tip worker's waiting line while other waves of its plan are not ready yet, else null. */
  function waveWaitLine(row: ManagedRow): string | null {
    const waiting = progress.waitingOn(row);
    return waiting
      ? `Wave ${row.plan_wave} of ${waiting.waves.length} is ready; the one review of the whole plan waits until wave(s) ${waiting.pending.join(", ")} are ready. Do not review yet.`
      : null;
  }

  /** A ready worker's exact next call: the wave that builds on it (no review runs between
   * waves; a design-only wave first asks the owner to approve its artboards), nothing while
   * other waves are still unready (waveWaitLine), the one review of the whole plan once every
   * wave is ready (named once, on the plan's first reviewable tip, unless forAlert) — or, with no
   * plan link at all, its own review call. */
  function workerReadyNextStep(row: ManagedRow, forAlert = false): string | null {
    const line = workerReadyStepLine(row, forAlert);
    if (!line || !row.plan_thread_id || row.plan_wave == null || schedule.sideLane(row)) return line;
    // A chain stacked on this wave starts now that this worker is ready.
    const waves = planWavesFor(row.plan_thread_id);
    const stacked = schedule.undelegatedHeads(row.plan_thread_id, waves).undelegated.filter((m) => waves[m - 1]?.stackOn === row.plan_wave);
    return line + stacked.map((m) => ` Wave ${m} is stacked on this chain: run chief_forge_init (planThreadId: ${row.plan_thread_id}, wave: ${m}), then chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${m}).`).join("");
  }

  function workerReadyStepLine(row: ManagedRow, forAlert: boolean): string | null {
    const step = progress.readyStep(row, forAlert);
    if (!step) return null;
    switch (step.kind) {
      case "designNext":
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready: its artboards need the owner's approval before any code. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval, first record it: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words); then delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}); ${specWave(step.waves, step.next) ? `it is a spec wave, so name the approved artboards in the missions of its worker and its Spec Writer.${specFirstLine(row.plan_thread_id, step.waves, step.next)}` : "it runs as a worker, so name the approved artboards in its mission."} On requested changes, delegate a fresh designer with chief_delegate (replaces: ${row.thread_id}) and the owner's feedback as its mission; it stays on wave ${row.plan_wave}. Never chief_review a design wave, and do not review between waves.`;
      case "designDone":
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready and nothing builds on it: its artboards need the owner's approval. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words), then chief_complete (threadId: ${row.thread_id}). Never chief_review it.`;
      case "restack":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready after its fix. Wave ${step.next} is stacked on it and still builds on the old head: once this worker is idle, restack it — chief_delegate (replaces: ${step.successor.thread_id}), with a mission to rebase ${step.successor.branch ?? `wave ${step.next}'s branch`} onto ${row.branch ?? "this branch"} and fix what the rebase breaks; the review's findings are attached automatically. Do not review between waves.`;
      case "nextWave":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready. Once it is idle, delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}).${specFirstLine(row.plan_thread_id, step.waves, step.next)} Do not review between waves.`;
      case "unplannedWriter":
        return `Spec Writer ${row.thread_id} committed the docs. Once it is idle, delegate the worker to implement against them: chief_delegate (replaces: ${row.thread_id}, kind: worker${row.unplanned_reason ? `, unplannedReason: ${row.unplanned_reason}` : ""}). Do not review yet.`;
      case "waitWriters":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready; the Spec Writer of ${step.pending.map(({ wave, writer }) => writer ? `wave ${wave} (${writer.thread_id}, ${writer.state})` : `wave ${wave} (not delegated)`).join(", ")} is not ready yet. Wait for its ready report: the Tester derives its tests from the committed docs, and the one review waits too. Do not delegate the next wave or review yet.`;
      case "unplanned":
        return gateStartLine(row.thread_id);
      case "review":
        return gateStartLine(step.namer.thread_id);
    }
  }

  const gateStartLine = (workerThreadId: string) => `Start the review gate: chief_review (workerThreadId: ${workerThreadId}). It starts one reviewer and one tester in parallel.`;

  /** A row's review gate and its decision, or null when no gate names the row. */
  function gateOf(row: ManagedRow): { gate: ReviewGate; decision: GateDecision<ManagedRow> } | null {
    const gate = store.gateFor(row.thread_id);
    if (!gate) return null;
    const ids = gate.targets.map((target) => target.threadId);
    const chainIds = new Set(ids.flatMap((id) => ledger.taskChain(id)));
    const writers = store.all().filter((other) => isWriter(other.kind) && other.role === "worker"
      && (gate.plan_thread_id ? other.plan_thread_id === gate.plan_thread_id : chainIds.has(other.thread_id) || chainIds.has(other.replaces_thread_id ?? "")));
    const decision = gateDecision<ManagedRow>({
      gate, row: store.get, startRefusal: null, verdictAt: ledger.newestVerdictAt(ids)?.at ?? null, writers, terminal,
    });
    return { gate, decision };
  }

  /** The one line every gate surface renders (next actions, alerts, roster, inspect, chief_complete refusals). */
  function gateLine(gate: ReviewGate, decision: GateDecision<ManagedRow>): string {
    const first = gate.targets[0]!.threadId;
    const ids = gate.targets.map((target) => target.threadId);
    const reviewer = gate.reviewer_thread_id ? store.get(gate.reviewer_thread_id) : undefined;
    const tester = gate.tester_thread_id ? store.get(gate.tester_thread_id) : undefined;
    const testerReport = tester ? `tester ${tester.thread_id}${tester.report_path ? ` (report: ${tester.report_path})` : ` (bb chief inspect ${tester.thread_id})`}` : "the tester";
    const verdictRef = reviewer ? `reviewer ${reviewer.thread_id}${reviewer.verdict_path ? ` (verdict: ${reviewer.verdict_path})` : ` (bb chief inspect ${reviewer.thread_id})`}` : "the reviewer";
    switch (decision.kind) {
      case "start": return gateStartLine(first);
      case "block": return decision.refusal;
      case "restart": {
        const blocked = decision.blocked.map((side) => ` ${side.kind === "tester" ? "Tester" : "Reviewer"} ${side.thread_id} is blocked: ${clip(side.blocker ?? "", 200)}; fix its environment first, and escalate to the user if you cannot.`).join("");
        return `The review gate's ${decision.sides.join(" and ")} ${decision.sides.length > 1 ? "are" : "is"} missing, failed or blocked.${blocked} Run chief_review (workerThreadId: ${first}) again: it starts only the ${decision.sides.join(" and ")}.`;
      }
      case "wait": return `The review gate is waiting on ${decision.who.map((side) => `${side.role === "reviewer" ? "reviewer" : side.kind ?? "worker"} ${side.thread_id} (${side.state})`).join(", ")}. Wait for their reports.`;
      case "fix": {
        const fixRun = gate.tester_thread_id ? `chief_delegate (replaces: ${gate.tester_thread_id}, kind: worker)` : "chief_delegate (replaces: <the gate tester>, kind: worker)";
        return `The review gate needs a fix: ${[decision.redTests ? `${testerReport} has failing tests` : "", decision.codeFindings ? `${verdictRef} has ${decision.codeFindings} blocking code finding${decision.codeFindings > 1 ? "s" : ""}` : ""].filter(Boolean).join("; ")}. Delegate the gate's one fix run: ${fixRun}; its brief carries the verdict, the findings and the failing tests. There is no re-review: its green run passes the gate.`;
      }
      case "docsRepair":
        return `The review gate's code passed, but ${verdictRef} has docs findings: chief_delegate (replaces: ${decision.writer.thread_id}, kind: spec-writer) with them as its mission, then wait for its ready report.`;
      case "wrongTest":
        return gate.corrector_thread_id
          ? `Fix run ${decision.fixer.thread_id} reports a wrong test: ${clip(decision.fixer.blocker ?? "", 200)}. The gate already had its corrector: escalate to the user.`
          : `Fix run ${decision.fixer.thread_id} reports a wrong test: ${clip(decision.fixer.blocker ?? "", 200)}. Read its evidence (bb chief inspect ${decision.fixer.thread_id}). If it holds, delegate the gate's one corrector: chief_delegate (replaces: ${decision.fixer.thread_id}, kind: tester); otherwise escalate to the user.`;
      case "escalate": return `The review gate cannot pass on its own: ${decision.why}. Escalate to the user.`;
      case "pass": return `The review gate passed. Complete ${ids.length > 1 ? "each target" : "it"}: ${ids.filter((id) => store.get(id)?.state !== "complete").map((id) => `chief_complete (threadId: ${id})`).join("; ")}; each marks its pull request ready.`;
    }
  }

  /** The plan advisors of planner P, oldest first: the one in flight, the decider (first advice wins) and the newest abandoned attempt. */
  function planAdvisors(plannerId: string) {
    const all = store.all().filter((r) => r.role === "advisor" && r.plan_thread_id === plannerId)
      .sort((a, b) => a.created_at - b.created_at);
    const inFlight = all.find((r) => r.advised_at == null && BUSY_STATUSES.has(r.state));
    const advised = all.filter((r) => r.advised_at != null);
    const decider = advised.length ? advised.reduce((a, b) => (b.advised_at! < a.advised_at! ? b : a)) : undefined;
    const abandoned = all.filter((r) => r.advised_at == null && r !== inFlight).at(-1);
    return { inFlight, decider, abandoned };
  }

  /** The planners revising planner P, newest first: one still working, and the one whose plan is in. */
  function revisionsOf(plannerId: string) {
    const all = store.all().filter((r) => r.role === "planner" && r.replaces_thread_id === plannerId).reverse();
    return {
      all,
      busy: all.find((r) => BUSY_STATUSES.has(r.state)),
      ready: all.find((r) => (r.state === "ready" || r.state === "complete") && !!r.plan_waves),
    };
  }

  /** Why a planner's waves may not be forge-initialised or delegated yet, naming the one next call; null when they may. */
  function planReviewRefusal(planner: ManagedRow): string | null {
    const P = planner.thread_id;
    if (planner.plan_review === "required") {
      const { inFlight, abandoned } = planAdvisors(P);
      if (inFlight) return `Plan ${P} is in its one advisor review (${inFlight.thread_id}): wait for ${inFlight.thread_id}'s report before chief_forge_init or chief_delegate.`;
      const waves = planWavesFor(P).filter((wave) => !wave.absent && !wave.design).length;
      const why = waves > 1 ? `Plan ${P} has ${waves} implementation waves` : `Plan ${P} is marked complex`;
      const ended = abandoned ? `Advisor ${abandoned.thread_id} ended without advice (state ${abandoned.state}). ` : "";
      return `${ended}${why}: get its one advisor review first — chief_consult (planThreadId: ${P}, title, mission: review this plan before delegation). Do not chief_forge_init or chief_delegate it yet.`;
    }
    if (planner.plan_review !== "changes") return null;
    const revisions = revisionsOf(P);
    if (planner.state === "complete" && revisions.ready) return `Plan ${P} was revised by ${revisions.ready.thread_id}: delegate ${revisions.ready.thread_id}'s waves instead.`;
    if (revisions.busy) return `Plan ${P} is being revised by ${revisions.busy.thread_id}: wait for ${revisions.busy.thread_id}'s ready alert, then delegate ${revisions.busy.thread_id}'s waves.`;
    return `The advisor requested changes to plan ${P}: chief_plan (revises: ${P}, title, mission: revise per the advisor) — the plugin attaches the plan files and the advice; delegate the revision's waves when its ready alert arrives; it gets no second review.`;
  }

  /** A plan advisor's line: only the deciding advisor renders one, from its planner's review outcome. */
  function planAdvisorAction(row: ManagedRow, forAlert: boolean): string | null {
    const planner = store.get(row.plan_thread_id!);
    if (!planner || planAdvisors(planner.thread_id).decider?.thread_id !== row.thread_id) return null;
    if (planner.plan_review === "approved") {
      const next = nextAction(planner, forAlert);
      return next ? `The advisor approves the plan. ${next}` : null;
    }
    if (planner.plan_review !== "changes") return null;
    const line = planReviewRefusal(planner);
    if (!line) return null;
    return row.last_report_state === "blocked"
      ? `Plan advisor blocked: ${clip(row.blocker ?? "", 200)}. That was the plan's one review: escalate to the user if it names a product decision, then ${line}`
      : line;
  }

  /** A row's single pending call, reused identically in the report intake's alert and
   * chief_roster's Pending block so the two surfaces never disagree. Purely a
   * function of already-persisted row state — no new columns, no new tracking. */
  function nextAction(row: ManagedRow, forAlert = false): string | null {
    if (row.role === "advisor" && row.plan_thread_id) return planAdvisorAction(row, forAlert);
    // A gate target or actor renders the gate's one line: on its first target, and on any row in an alert.
    const gated = (row.role === "worker" || row.role === "reviewer") && row.state !== "complete" ? gateOf(row) : null;
    if (gated) return forAlert || gated.gate.targets[0]!.threadId === row.thread_id ? gateLine(gated.gate, gated.decision) : null;
    // A chat fix run gets no review: its own green run completes it.
    if (row.fix_run === "chat" && row.state === "blocked") return `Chat fix run ${row.thread_id} is blocked: ${clip(row.blocker ?? "", 200)}. Escalate to the user.`;
    if (row.fix_run === "chat" && row.state === "ready") return `Chat fix run ${row.thread_id} is green (testsPassed). Complete it: chief_complete (threadId: ${row.thread_id}); it marks the pull request ready. No review.`;
    if (row.role === "planner" && row.replaces_thread_id && row.state === "blocked") {
      return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user, then chief_plan (revises: ${row.replaces_thread_id}) with the decision in context; it gets no review.`;
    }
    if (row.state === "blocked" && row.role === "worker") {
      if (row.kind === "tester" && onSpecChain(row)) {
        return `Tester blocked: ${clip(row.blocker ?? "", 200)}. Tester's recommendation: ${clip(row.recommendation ?? "none", 300)}. Route by cause. ${inPlaceLine(row)} If tests fail on product code: chief_delegate (replaces: ${row.thread_id}, kind: worker) with the failures as its mission; its ready alert then asks for a tester. ${specRoutes(row)}`;
      }
      if (isWriter(row.kind)) {
        return `Spec Writer blocked: ${clip(row.blocker ?? "", 200)}. ${inPlaceLine(row)} Retry it with the fix: chief_delegate (replaces: ${row.thread_id}, kind: spec-writer); a docs/ fold conflict on the branch takes the same route${schedule.sideLane(row) ? ` (the retry gets a fresh worktree from ${row.branch})` : ""}. ${row.plan_thread_id && schedule.sideLane(row) ? "The retry gets this wave's `## Docs needed` items with the blocker; one repair per wave, not separate fix and fold writers. " : ""}If the Spec delta cannot be written: start a fresh chief_plan with ${row.plan_thread_id ? `the plan files (${planWavesFor(row.plan_thread_id).map((wave) => wave.path).join(", ")}), ` : ""}this blocked report (bb chief inspect ${row.thread_id}), branch ${row.branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${row.thread_id}, kind: spec-writer.`;
      }
      if (row.kind !== "tester" && onSpecChain(row)) return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user. ${inPlaceLine(row)} ${specRoutes(row)}`;
      if (row.kind === "tester") {
        return `Tester blocked: ${clip(row.blocker ?? "", 200)}. ${inPlaceLine(row)} If tests fail on product code: delegate a fresh worker to fix it: chief_delegate (replaces: ${row.thread_id}, kind: worker) with the failures as its mission; its ready alert then asks for a tester.`;
      }
    }
    if (row.state === "blocked") return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user.${row.role === "worker" ? ` ${inPlaceLine(row)}` : ""}`;
    if (row.state !== "ready") return null;
    if (row.role === "planner") {
      if (!row.plan_waves) return null;
      const refusal = planReviewRefusal(row);
      if (refusal) return refusal;
      const waves = planWavesFor(row.thread_id);
      const { heads, undelegated, waiting } = schedule.undelegatedHeads(row.thread_id, waves);
      const waitingLine = waiting.length ? ` Waves ${waiting.join(", ")} are stacked and start once their parent wave is ready.` : "";
      if (!undelegated.length) return waiting.length ? waitingLine.trim() : null;
      if (heads.length === 1) {
        return `Delegate wave 1 now: run chief_forge_init (planThreadId: ${row.thread_id}, wave: 1), then chief_delegate (planThreadId: ${row.thread_id}, wave: 1).${specFirstLine(row.thread_id, waves, 1)} The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.${waitingLine}`;
      }
      return `Delegate wave${undelegated.length > 1 ? "s" : ""} ${undelegated.join(", ")} now, in parallel — for each wave run chief_forge_init (planThreadId: ${row.thread_id}, wave: N), then chief_delegate (planThreadId: ${row.thread_id}, wave: N), all in this turn. Each of these is an independent chain head and gets its own task title, branch, PR and worktree from its plan base (chief_forge_init derives it; omit base); its later waves continue that chain with replaces: the chain's latest worker, never a worker of another chain.${undelegated.map((n) => specFirstLine(row.thread_id, waves, n)).join("")} The plugin supplies each plan file; do not read the plans. Escalate to the user only for a genuine product or scope open question the planner named.${waitingLine}`;
    }
    if (row.role === "worker") return workerReadyNextStep(row, forAlert);
    if (row.role === "advisor") {
      const advised = row.worker_thread_id ? store.get(row.worker_thread_id) : undefined;
      return `The advisor changed nothing. Decide the next step yourself: hand its advice to a fresh worker with ${advised ? ctx.replacesCall(advised) : row.worker_thread_id ? `chief_delegate (replaces: ${row.worker_thread_id})` : "chief_delegate (through chief_plan first when planning is on)"} with the advice in its context, or escalate to the user if it names a genuine decision.`;
    }
    // A reviewer outside any gate: a branch review, or a legacy worker review whose targets now go through the gate.
    if (row.role !== "reviewer" || !row.verdict) return null;
    if (row.worker_thread_id) return `Reviewer ${row.thread_id} predates the review gate. ${gateStartLine(row.worker_thread_id)}`;
    return row.verdict === "approve"
      ? `The reviewer approves. chief_complete (threadId: ${row.thread_id}), then mark the pull request ready yourself (no worker owns it). Nits listed with an approve are optional.`
      : `The reviewer requires changes, and no managed worker owns branch ${row.branch}.${row.regression ? " The reviewer reports this change introduced a new problem; make the fix's brief name it." : ""} Hand the fix to a fresh worker with chief_delegate (branch: ${row.branch}${row.pr_url ? `, prUrl: ${row.pr_url}` : ""}; through chief_plan first when planning is on) with the findings in its context, then chief_complete this review. Escalate if the disagreement is a genuine decision.`;
  }

  /** Live status of a worker. When its row is already ready, waits up to REVIEW_IDLE_WAIT_MS
   * for its turn to end: the ready alert is sent from inside the worker's chief_report call,
   * so that turn is still ending when Chief acts on it. A worker that has not reported is not waited on. */
  async function waitIdleAfterReport(worker: ManagedRow) {
    let live = await bb.sdk.threads.get({ threadId: worker.thread_id });
    // ponytail: polls; defer the alert to thread.idle if a minute is not enough.
    for (const deadline = Date.now() + REVIEW_IDLE_WAIT_MS; worker.state === "ready" && BUSY_STATUSES.has(live.status) && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, REVIEW_IDLE_POLL_MS));
      live = await bb.sdk.threads.get({ threadId: worker.thread_id });
    }
    return live;
  }

  /** Throws the busy-worker refusal, counting it as a timing race for bb chief stats. */
  function busyRejection(worker: ManagedRow, status: string, before: string): never {
    store.countBusyRejection(worker.thread_id);
    throw new Error(`Worker ${worker.thread_id} is ${status}; wait until it is idle before ${before}.`);
  }

  const { startReview, startBranchReview } = createReviewStart<ManagedRow>({
    db, store, ledger, managedSpawn: ctx.managedSpawn, controlsThread: (...a) => ctx.controlsThread(...a),
    plan: { reviewRefusal, reviewTargetsFor, planWavesFor, specWriters, taskWriters: ctx.taskWriters, planBaseOf: ctx.planBaseOf },
    host: {
      settledLive: async (worker) => {
        const live = await waitIdleAfterReport(worker);
        if (BUSY_STATUSES.has(live.status)) busyRejection(worker, live.status, "starting a review");
        return live;
      },
      projectPath: ctx.projectPath,
      projectHost: ctx.projectHost,
      environmentHost: ctx.environmentHostId,
      localPath: async (environmentId) => {
        try {
          const environment = await bounded(() => bb.sdk.environments.get({ environmentId }), ctx.CLEANUP_READ_MS);
          const local = environment.hostId === (await bounded(() => bb.sdk.system.config(), ctx.CLEANUP_READ_MS)).primaryHostId;
          return local && environment.path ? environment.path : null;
        } catch (error) {
          bb.log.warn(`Could not read environment ${environmentId}: ${String(error)}`);
          return null;
        }
      },
      heavyPath: (hostId) => settings.get().then((values) => ctx.publishHeavy(hostId, heavySlotCount(values)))
        .catch((error) => { bb.log.warn(`Heavy-command slots are unavailable for a gate tester: ${String(error)}`); return null; }),
      checkoutSkip: (...a) => ctx.checkoutHostSkip(...a),
      recordedCommands: (...a) => ctx.recordedCommands(...a),
      writeFile: (...a) => ctx.writeStorageFile(...a),
      writeArtifact: (...a) => ctx.writeArtifact(...a),
      alertChief: (...a) => ctx.alertChief(...a),
      logError: (message) => bb.log.error(message),
    },
    forge: { head: prHead },
    git: { env: forgeEnv },
    engine: async () => reviewEngine(await settings.get()),
  });
  return { busyRejection, gateLine, gateOf, gateStartLine, nextAction, planAdvisors, planReviewRefusal, revisionsOf, specFirstLine, startBranchReview, startReview, waitIdleAfterReport, waveWaitLine, workerReadyNextStep };
}

