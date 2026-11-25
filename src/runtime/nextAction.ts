import { gateDecision, type GateDecision } from "../plan/planProgress";
import { displayTarget, repairTarget, type ReviewGate } from "../db/threadStore";
import { reviewEngine } from "../review/prAgent";
import { createReviewStart } from "../review/reviewStart";
import { terminal, type ManagedRow } from "../types";
import { clip } from "../core/text";
import { isReady, isWriter, type PlanWave } from "../plan/waveSchedule";
import { BUSY_STATUSES, MAX_NUDGE_LENGTH } from "./constants";
import { bounded } from "./exec";
import { forgeEnv, prHead } from "../forge/forge";
import type { Ctx } from "./context";
import { researcherNextLine } from "../research/research";

const REVIEW_IDLE_WAIT_MS = 60_000;

const REVIEW_IDLE_POLL_MS = 2_000;

const DESIGN_REVIEW_REFUSAL = "Design-only work is approved by the owner only: show the user the artboards and record their decision with chief_owner_approval.";

export function createNextAction(ctx: Ctx) {
  const { bb, db, ledger, onSpecChain, planReview, planWavesFor, progress, reviewTargetsFor, schedule, settings, specWriters, store } = ctx;
  /** The plan's Spec Writer entries still owed: delegate the one missing writer or wait for a delegated one; the review gate waits for it. */
  function writersLine(planThreadId: string | null, pending: { wave: number; writer?: ManagedRow | null }[]): string {
    return pending.map(({ wave, writer }) => writer
      ? `wave ${wave}'s Spec Writer ${writer.thread_id} (${writer.state}) is not ready yet.`
      : `Every wave is ready: delegate the plan's one Spec Writer now — chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, kind: spec-writer) — which covers the Spec delta of every spec: true wave in its own side worktree and folds docs/ onto the branch; or go without it: chief_skip_specs (planThreadId: ${planThreadId}, reason).`).join(" ")
      + " The review gate waits for its ready report.";
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
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Delegate wave ${block.next}: ${block.waves[block.next - 1]!.path} — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, replaces: ${worker.thread_id}).`;
      case "sideWriter":
        return `${worker.thread_id} is a Spec Writer: it never starts a review. The plan's one review starts from an implementation chain tip (chief_review) once every wave and every Spec Writer is ready.`;
      case "writers":
        return `One review covers the whole plan once the plan's Spec Writer is ready. ${writersLine(worker.plan_thread_id, block.writers)}`;
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
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready: its artboards need the owner's approval before any code. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval, record it: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words); the reply then names the call that delegates wave ${step.next}. On requested changes, delegate a fresh designer with chief_delegate (replaces: ${row.thread_id}) and the owner's feedback as its mission; it stays on wave ${row.plan_wave}. Never chief_review a design wave, and do not review between waves.`;
      case "designDone":
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready and nothing builds on it: its artboards need the owner's approval. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words), then chief_complete (threadId: ${row.thread_id}). Never chief_review it.`;
      case "designApproved":
        return step.next !== null
          ? `Design wave ${row.plan_wave} of ${step.waves.length} is approved by the owner. Delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}); name the approved artboards in its mission. Never chief_review a design wave.`
          : `Design wave ${row.plan_wave} of ${step.waves.length} is approved by the owner. Complete it with chief_complete (threadId: ${row.thread_id}). Never chief_review it.`;
      case "restack":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready after its fix. Wave ${step.next} is stacked on it and still builds on the old head: once this worker is idle, restack it — chief_delegate (replaces: ${step.successor.thread_id}), with a mission to rebase ${step.successor.branch ?? `wave ${step.next}'s branch`} onto ${row.branch ?? "this branch"} and fix what the rebase breaks; the review's findings are attached automatically. Do not review between waves.`;
      case "nextWave":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready. Once it is idle, delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}). Do not review between waves.`;
      case "unplannedWriter":
        return `Spec Writer ${row.thread_id} committed the docs. Once it is idle, delegate the worker to implement against them: chief_delegate (replaces: ${row.thread_id}, kind: worker${row.unplanned_reason ? `, unplannedReason: ${row.unplanned_reason}` : ""}). Do not review yet.`;
      case "waitWriters":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready; ${writersLine(row.plan_thread_id, step.pending)} Do not review yet.`;
      case "unplanned":
        return gateStartLine(row.thread_id);
      case "review":
        return gateStartLine(step.namer.thread_id);
    }
  }

  const gateStartLine = (workerThreadId: string) => `Start the review gate: chief_review (workerThreadId: ${workerThreadId}). It starts one reviewer.`;

  /** A row's review gate and its decision, or null when no gate names the row. */
  function gateOf(row: ManagedRow): { gate: ReviewGate; decision: GateDecision<ManagedRow> } | null {
    const gate = store.gateFor(row.thread_id);
    if (!gate) return null;
    const ids = gate.targets.map((target) => target.threadId);
    const chainIds = new Set(ids.flatMap((id) => ledger.taskChain(id)));
    const writers = store.all().filter((other) => isWriter(other.kind) && other.role === "worker"
      && (gate.plan_thread_id ? other.plan_thread_id === gate.plan_thread_id : chainIds.has(other.thread_id) || chainIds.has(other.replaces_thread_id ?? "")));
    const settledReviewer = ledger.newestVerdictReviewer(ids);
    const decision = gateDecision<ManagedRow>({
      gate, row: store.get, startRefusal: null, verdictAt: ledger.newestVerdictAt(ids)?.at ?? null, settledReviewer: settledReviewer ? store.get(settledReviewer) : undefined, writers, terminal,
    });
    return { gate, decision };
  }

  /** The one line every gate surface renders (next actions, alerts, roster, inspect, chief_complete refusals). */
  function gateLine(gate: ReviewGate, decision: GateDecision<ManagedRow>): string {
    const first = repairTarget(gate).threadId;
    const ids = gate.targets.map((target) => target.threadId);
    const reviewer = gate.reviewer_thread_id ? store.get(gate.reviewer_thread_id) : undefined;
    const verdictRef = reviewer ? `reviewer ${reviewer.thread_id}${reviewer.verdict_path ? ` (verdict: ${reviewer.verdict_path})` : ` (bb chief inspect ${reviewer.thread_id})`}` : "the reviewer";
    switch (decision.kind) {
      case "start": return gateStartLine(first);
      case "block": return decision.refusal;
      case "restart": {
        const blocked = decision.blocked.map((side) => ` Reviewer ${side.thread_id} is blocked: ${clip(side.blocker ?? "", 200)}; fix its environment first, and escalate to the user if you cannot.`).join("");
        return `The review gate's reviewer is missing, failed or blocked.${blocked} Run chief_review (workerThreadId: ${first}) again: it starts only the reviewer.`;
      }
      case "wait": return `The review gate is waiting on ${decision.who.map((side) => `${side.role === "reviewer" ? "reviewer" : side.kind ?? "worker"} ${side.thread_id} (${side.state})`).join(", ")}. Wait for their reports.`;
      case "fix": {
        // A fix decision with a fix run set means that run never reported: it is replaced, not the first target.
        const replaced = gate.fixer_thread_id ?? first;
        return `The review gate needs a fix: ${verdictRef} has ${decision.codeFindings} blocking code finding${decision.codeFindings > 1 ? "s" : ""}. Delegate the gate's one fix run: chief_delegate (replaces: ${replaced}, kind: worker); its brief carries the verdict and the findings. Its ready run passes the gate; after it, one advisory re-review may run with chief_review (workerThreadId: ${first}).`;
      }
      case "docsRepair":
        return `The review gate's code passed, but ${verdictRef} has docs findings: chief_delegate (replaces: ${decision.writer.thread_id}, kind: spec-writer) with them as its mission, then wait for its ready report.`;
      case "escalate": return `The review gate cannot pass on its own: ${decision.why}. Escalate to the user.`;
      case "pass": {
        // An implementation-lane Spec Writer that replaced a target completes on this pass too.
        const writers = store.all().filter((other) => other.role === "worker" && isWriter(other.kind) && !schedule.sideLane(other) && !terminal(other.state)
          && ledger.taskChain(other.thread_id).some((id) => ids.includes(id))).map((other) => other.thread_id);
        return `The review gate passed. Complete ${ids.length > 1 ? "each target" : "it"}: ${[...ids.filter((id) => store.get(id)?.state !== "complete"), ...writers].map((id) => `chief_complete (threadId: ${id})`).join("; ")}; each marks its pull request ready.`;
      }
    }
  }

  /** Why a planner's waves may not be forge-initialised or delegated yet, naming the one next call; null when they may. */
  function planReviewRefusal(planner: ManagedRow): string | null {
    const P = planner.thread_id;
    const { epic, closed, review } = planReview.status(planner);
    if (closed) return `Epic ${P} is complete: its review outcome stands. Do not consult, revise, continue or complete it again.`;
    if (review.kind === "inReview") return `${epic ? "Epic" : "Plan"} ${P} is in its one advisor review (${review.advisor.thread_id}): wait for ${review.advisor.thread_id}'s report${epic ? "." : " before chief_forge_init or chief_delegate."}`;
    if (review.kind !== "changes") return null;
    const { by, busy } = review;
    if (epic) {
      if (by) return `Epic ${P} was revised by ${by.thread_id}: tell the user ${by.thread_id}'s epic link (bb chief inspect ${by.thread_id}), then chief_complete (threadId: ${by.thread_id}) and chief_complete (threadId: ${P}). Delegate nothing.`;
      if (busy) return `Epic ${P} is being revised by ${busy.thread_id}: wait for ${busy.thread_id}'s ready alert.`;
      return `The advisor requested changes to epic ${P}: chief_plan (revises: ${P}, title, mission: revise per the advisor) — the plugin attaches the planner's report and the advice; it gets no second review. Delegate nothing.`;
    }
    if (review.delivered && by) return `Plan ${P} was revised by ${by.thread_id}: delegate ${by.thread_id}'s waves instead.`;
    if (busy) return `Plan ${P} is being revised by ${busy.thread_id}: wait for ${busy.thread_id}'s ready alert, then delegate ${busy.thread_id}'s waves.`;
    return `The advisor requested changes to plan ${P}: chief_plan (revises: ${P}, title, mission: revise per the advisor) — the plugin attaches the plan files and the advice; delegate the revision's waves when its ready alert arrives; it gets no second review.`;
  }

  /** A ready epic planner's call once planReviewRefusal passed: consult once, then tell the user and complete. Never a forge-init or delegate line: an epic has no waves. */
  function epicPlannerAction(row: ManagedRow): string | null {
    const P = row.thread_id;
    const link = `the epic link from its result (bb chief inspect ${P})`;
    const never = "Do not chief_forge_init or chief_delegate: a slice becomes a task plan only on a new order.";
    const { revises, review } = planReview.status(row);
    if (revises) {
      return `Epic revision ${P} is ready; it gets no review. Tell the user ${link}, then chief_complete (threadId: ${P}) and chief_complete (threadId: ${revises}). ${never}`;
    }
    if (review.kind === "approved") return `The epic is approved. Tell the user ${link}, then chief_complete (threadId: ${P}). ${never}`;
    if (review.kind === "unadvised") return `The advisor review of epic ${P} did not report: chief_consult (planThreadId: ${P}) again, or escalate to the user.`;
    return `Epic ${P} is ready. Run chief_consult (planThreadId: ${P}) once for the advisor's second opinion, then tell the user ${link}. ${never}`;
  }

  const missingReportLine = (row: ManagedRow) => `Finished its turn without a chief_report. Inspect it with chief_inspect (threadId: ${row.thread_id}), then chief_continue it asking for its chief_report, or decide yourself.`;

  /** A chain owner's held route: the plan's deliver, consult or complete call. A planner that went ready -> active -> idle without a new report still holds it. */
  function plannerRoute(P: ManagedRow): string | null {
    if (!planReview.hasPlan(P)) return null;
    const refusal = planReviewRefusal(P);
    if (refusal) return refusal;
    if (P.plan_epic) return epicPlannerAction(P);
    const waves = planWavesFor(P.thread_id);
    const { heads, undelegated, waiting } = schedule.undelegatedHeads(P.thread_id, waves);
    const waitingLine = waiting.length ? ` Waves ${waiting.join(", ")} are stacked and start once their parent wave is ready.` : "";
    if (!undelegated.length) return waiting.length ? waitingLine.trim() : null;
    if (heads.length === 1) {
      return `Delegate wave 1 now: run chief_forge_init (planThreadId: ${P.thread_id}, wave: 1), then chief_delegate (planThreadId: ${P.thread_id}, wave: 1). The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.${waitingLine}`;
    }
    return `Delegate wave${undelegated.length > 1 ? "s" : ""} ${undelegated.join(", ")} now, in parallel — for each wave run chief_forge_init (planThreadId: ${P.thread_id}, wave: N), then chief_delegate (planThreadId: ${P.thread_id}, wave: N), all in this turn. Each of these is an independent chain head and gets its own task title, branch, PR and worktree from its plan base (chief_forge_init derives it; omit base); its later waves continue that chain with replaces: the chain's latest worker, never a worker of another chain. The plugin supplies each plan file; do not read the plans. Escalate to the user only for a genuine product or scope open question the planner named.${waitingLine}`;
  }

  const blockedLine = (row: ManagedRow) => `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user.`;

  /** Every planner and plan-advisor row's line. planReview.owner names the chain's one owner: only it renders a line in Pending, any chain row renders the owner's line in an alert.
   * A busy owner waits; a held result (deliver, consult or complete route) comes before the missing-Report recovery. */
  function planChainAction(row: ManagedRow, forAlert: boolean): string | null {
    const chain = planReview.owner(row);
    if (!chain.owner || (!forAlert && chain.owner !== row.thread_id)) return null;
    const owner = store.get(chain.owner);
    if (!owner || BUSY_STATUSES.has(owner.state) || owner.state === "failed") return null;
    switch (chain.kind) {
      case "planning":
      case "revising":
      case "advising":
        if (owner.state === "blocked") {
          return chain.kind === "revising" ? `Blocked: ${clip(owner.blocker ?? "", 200)} — decide or escalate to the user, then chief_plan (revises: ${owner.replaces_thread_id}) with the decision in context; it gets no review.` : blockedLine(owner);
        }
        return ctx.turnMissingReport(owner) ? missingReportLine(owner) : null;
      case "revise": {
        const line = planReviewRefusal(owner);
        const { decider } = chain;
        if (!line) return null;
        return decider?.last_report_state === "blocked"
          ? `Plan advisor blocked: ${clip(decider.blocker ?? "", 200)}. That was the plan's one review: escalate to the user if it names a product decision, then ${line}`
          : line;
      }
      case "consult":
      case "approved":
      case "plan":
      case "revised":
        return owner.state === "blocked" ? blockedLine(owner) : plannerRoute(owner);
    }
  }

  /** A row's single pending call, reused identically in the report intake's alert and
   * chief_roster's Pending block so the two surfaces never disagree. Purely a
   * function of already-persisted row state — no new columns, no new tracking. */
  function nextAction(row: ManagedRow, forAlert = false): string | null {
    if (row.role === "planner" || (row.role === "advisor" && row.plan_thread_id)) return planChainAction(row, forAlert);
    // A gate target or actor renders the gate's one line: on the gate's display target, and on any row in an alert.
    const gated = (row.role === "worker" || row.role === "reviewer") && row.state !== "complete" ? gateOf(row) : null;
    if (gated) return forAlert || displayTarget(gated.gate, (id) => store.get(id)?.state) === row.thread_id ? gateLine(gated.gate, gated.decision) : null;
    // A chat fix run gets no review: its own green run completes it.
    if (row.fix_run === "chat" && row.state === "blocked") return `Chat fix run ${row.thread_id} is blocked: ${clip(row.blocker ?? "", 200)}. Escalate to the user.`;
    if (row.fix_run === "chat" && row.state === "ready") return `Chat fix run ${row.thread_id} is ready. Complete it: chief_complete (threadId: ${row.thread_id}); it marks the pull request ready. No review.`;
    if (row.state === "blocked" && row.role === "worker") {
      if (isWriter(row.kind)) {
        return `Spec Writer blocked: ${clip(row.blocker ?? "", 200)}. ${inPlaceLine(row)} Retry it with the fix: chief_delegate (replaces: ${row.thread_id}, kind: spec-writer); a docs/ fold conflict on the branch takes the same route${schedule.sideLane(row) ? ` (the retry gets a fresh worktree from ${row.branch})` : ""}. ${row.plan_thread_id && schedule.sideLane(row) ? "The retry gets this wave's `## Docs needed` items with the blocker; one repair per wave, not separate fix and fold writers. " : ""}If the Spec delta cannot be written: start a fresh chief_plan with ${row.plan_thread_id ? `the plan files (${planWavesFor(row.plan_thread_id).map((wave) => wave.path).join(", ")}), ` : ""}this blocked report (bb chief inspect ${row.thread_id}), branch ${row.branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${row.thread_id}, kind: spec-writer.`;
      }
      if (onSpecChain(row)) return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user. ${inPlaceLine(row)} ${specRoutes(row)}`;
    }
    if (row.role === "researcher") {
      const line = researcherNextLine(row, ctx.state.plannerActive);
      if (line) return line;
    }
    if (row.state === "blocked") return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user.${row.role === "worker" ? ` ${inPlaceLine(row)}` : ""}`;
    // A design wave that went ready -> active -> idle without a new report still holds its ready report: chief_owner_approval admits it, so Pending shares its route.
    // That approved-design route (#296) is authoritative and comes before the missing-Report recovery. Recovery here covers worker rows (Worker, Designer, Spec Writer); plan-chain rows recover in planChainAction.
    const heldDesign = row.state === "idle" && isReady(row) && schedule.isDesignWave(row);
    if (row.role === "worker" && !heldDesign && ctx.turnMissingReport(row)) return missingReportLine(row);
    if (row.state !== "ready" && !heldDesign) return null;
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
  return { busyRejection, gateLine, gateOf, gateStartLine, nextAction, planReviewRefusal, startBranchReview, startReview, waitIdleAfterReport, waveWaitLine, workerReadyNextStep };
}

