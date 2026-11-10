import { type RepairTarget } from "../plan/planProgress";
import { reviewEngine } from "../review/prAgent";
import { STOP_AFTER_REJECTIONS } from "../review/reviewLedger";
import { createReviewStart } from "../review/reviewStart";
import { type ManagedRow } from "../types";
import { clip } from "../core/text";
import { type PlanWave } from "../plan/waveSchedule";
import { BUSY_STATUSES } from "./constants";
import { bounded } from "./exec";
import { forgeEnv, prHead } from "../forge/forge";
import type { Ctx } from "./context";

const REVIEW_IDLE_WAIT_MS = 60_000;

const REVIEW_IDLE_POLL_MS = 2_000;

const DESIGN_REVIEW_REFUSAL = "Design-only work is approved by the owner only: show the user the artboards and record their decision with chief_owner_approval.";

export function createNextAction(ctx: Ctx) {
  const { bb, db, isTestWave, ledger, onSpecChain, planWavesFor, progress, reviewTargetsFor, schedule, settings, specWave, store, waveWorkers } = ctx;
  /** The next call once a delegated test wave is waived: its latest worker still owns the branch. */
  function waivedLine(owner: ManagedRow): string {
    return `Tests on wave ${owner.plan_wave} waived. ${owner.thread_id} still owns the branch: review it — chief_review (workerThreadId: ${owner.thread_id}) — or complete it without one — chief_complete (threadId: ${owner.thread_id}, skipReview: your reason).`;
  }

  /** Wave n of a plan is a spec wave: the sentence saying its default call spawns its Spec Writer, else "". */
  function specFirstLine(planThreadId: string | null, waves: PlanWave[], n: number): string {
    return planThreadId && specWave(waves, n)
      ? ` Wave ${n} is marked spec: true: that call spawns its Spec Writer, who commits the docs before its worker runs. To go without, record why: chief_skip_specs (planThreadId: ${planThreadId}, wave: ${n}, reason).`
      : "";
  }

  /** The Spec Writer's hand-off to its wave's worker. */
  function implementLine(row: ManagedRow): string {
    return row.plan_thread_id && row.plan_wave != null
      ? `Spec Writer ${row.thread_id} committed wave ${row.plan_wave}'s docs. Once it is idle, delegate the wave's worker to implement against them: chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, replaces: ${row.thread_id}, kind: worker). Do not delegate the next wave or review yet.`
      : `Spec Writer ${row.thread_id} committed the docs. Once it is idle, delegate the worker to implement against them: chief_delegate (replaces: ${row.thread_id}, kind: worker${row.unplanned_reason ? `, unplannedReason: ${row.unplanned_reason}` : ""}). Do not review yet.`;
  }

  /** On a spec-bearing chain, the routes for a wrong spec and for a Spec delta that cannot be built. */
  function specRoutes(row: ManagedRow): string {
    const plans = row.plan_thread_id ? planWavesFor(row.plan_thread_id).map((wave) => wave.path).join(", ") : "";
    return `If the spec is wrong: chief_delegate (replaces: ${row.thread_id}, kind: spec-writer) with the fix. If the Spec delta cannot be built: start a fresh chief_plan with ${plans ? `the plan files (${plans}), ` : ""}this blocked report (bb chief inspect ${row.thread_id}), branch ${row.branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${row.thread_id}.`;
  }

  /** Why a worker may not start a review now, or null. The review of a plan runs once, after every wave is ready. */
  function reviewRefusal(worker: ManagedRow): string | null {
    const block = progress.reviewBlock(worker);
    if (!block) return null;
    switch (block.kind) {
      case "design": return DESIGN_REVIEW_REFUSAL;
      case "superseded":
        return `${worker.thread_id} is superseded by ${block.latest.thread_id}. The plan's one review starts from the latest workers: chief_review (workerThreadId: ${block.latest.thread_id}) once every wave is ready.`;
      case "restack":
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Wave ${block.next} is stacked on it and still builds on the old head: restack it first — chief_delegate (replaces: ${block.successor.thread_id}${block.waves[block.next - 1]!.test ? ", kind: tester" : ""}).`;
      case "restacked":
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Wave ${block.next} was already restacked as ${block.successor.thread_id}; start the plan's one review from the latest chain-tip worker once every wave is ready.`;
      case "betweenWaves":
        return block.waves[block.next - 1]!.test
          ? `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Delegate test wave ${block.next}: ${block.waves[block.next - 1]!.path} — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, replaces: ${worker.thread_id}, kind: tester). To go without tests, record why: chief_skip_tests (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, reason).`
          : `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Delegate wave ${block.next}: ${block.waves[block.next - 1]!.path} — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, replaces: ${worker.thread_id}).${specFirstLine(worker.plan_thread_id, block.waves, block.next)}`;
      case "implement": {
        const writer = waveWorkers(worker.plan_thread_id!, block.wave).at(-1)!;
        return `Wave ${block.wave} of ${block.waves.length} still owes its implementation: no review runs until its worker implements against the Spec Writer's docs — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${block.wave}, replaces: ${writer.thread_id}, kind: worker).`;
      }
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
    const step = progress.readyStep(row, forAlert);
    if (!step) return null;
    switch (step.kind) {
      case "designNext":
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready: its artboards need the owner's approval before any code. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval, first record it: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words); then delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}); ${specWave(step.waves, step.next) ? `it starts with its Spec Writer, so name the approved artboards in its mission.${specFirstLine(row.plan_thread_id, step.waves, step.next)}` : "it runs as a worker, so name the approved artboards in its mission."} On requested changes, delegate a fresh designer with chief_delegate (replaces: ${row.thread_id}) and the owner's feedback as its mission; it stays on wave ${row.plan_wave}. Never chief_review a design wave, and do not review between waves.`;
      case "designDone":
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready and nothing builds on it: its artboards need the owner's approval. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words), then chief_complete (threadId: ${row.thread_id}). Never chief_review it.`;
      case "restack":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready after its fix. Wave ${step.next} is stacked on it and still builds on the old head: once this worker is idle, restack it — chief_delegate (replaces: ${step.successor.thread_id}${step.waves[step.next - 1]!.test ? ", kind: tester" : ""}), with a mission to rebase ${step.successor.branch ?? `wave ${step.next}'s branch`} onto ${row.branch ?? "this branch"} and fix what the rebase breaks; the review's findings are attached automatically. Do not review between waves.`;
      case "nextWave":
        if (step.waves[step.next - 1]!.test) {
          return `Wave ${row.plan_wave} of ${step.waves.length} is ready. Once it is idle, delegate test wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}, kind: tester). To go without tests, record why: chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, reason). Do not review between waves.`;
        }
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready. Once it is idle, delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}).${specFirstLine(row.plan_thread_id, step.waves, step.next)} Do not review between waves.`;
      case "implement":
        return implementLine(row);
      case "retest":
        if (row.kind === "spec-writer") return `A Spec Writer changed docs on test wave ${row.plan_wave}: rerun the tests against them — chief_delegate (replaces: ${row.thread_id}, kind: tester) — then review. If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, reason) or start the review: chief_review (workerThreadId: ${row.thread_id}).`;
        return `A worker changed code on test wave ${row.plan_wave} after the tests ran: rerun them — chief_delegate (replaces: ${row.thread_id}, kind: tester) — then review. If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, reason) or start the review: chief_review (workerThreadId: ${row.thread_id}).`;
      case "unplanned":
        return `${row.kind === "tester" ? "" : `Workers never test: delegate a tester on this branch first — chief_delegate (replaces: ${row.thread_id}, kind: tester) — or, to go without, pass testsSkipped (your reason) when you complete it. `}Start its review now: chief_review (workerThreadId: ${row.thread_id}), and complete the work on the reviewer's approve — or, if you judge a review unnecessary after reading its report and recorded commands, complete it without one: chief_complete (threadId: ${row.thread_id}, skipReview: your reason).`;
      case "review": {
        const branches = step.targets.map((target) => `${target.thread_id}${target.branch ? ` (${target.branch})` : ""}`).join(", ");
        return `${step.waves.length === 1 ? "The plan's only wave is" : `All ${step.waves.length} waves are`} ready. Start the one review of the whole plan now: chief_review (workerThreadId: ${step.namer.thread_id}). It covers every branch (${branches}). Complete each worker on that reviewer's approve — or, if you judge a review unnecessary, complete each of them without one: chief_complete (threadId: <each>, skipReview: your reason).`;
      }
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
      const waves = planWavesFor(P).filter((wave) => !wave.test).length;
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
    if (row.role === "planner" && row.replaces_thread_id && row.state === "blocked") {
      return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user, then chief_plan (revises: ${row.replaces_thread_id}) with the decision in context; it gets no review.`;
    }
    if (row.state === "blocked" && row.role === "worker") {
      const testWave = isTestWave(row) ? planWavesFor(row.plan_thread_id)[row.plan_wave! - 1]! : undefined;
      if (testWave?.testsSkipped) return waivedLine(row);
      if (row.kind === "tester" && onSpecChain(row)) {
        return `Tests failed: ${clip(row.blocker ?? "", 200)}. Tester's recommendation: ${clip(row.recommendation ?? "none", 300)}. Route by cause. If the product code is wrong: chief_delegate (replaces: ${row.thread_id}, kind: worker) with the failures as its mission; its ready alert then asks for a tester. ${specRoutes(row)} ${testWave
          ? `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, reason).`
          : "If you judge the failures acceptable, complete it with testsSkipped (your reason)."}`;
      }
      if (row.kind === "spec-writer") {
        return `Spec Writer blocked: ${clip(row.blocker ?? "", 200)}. Retry it with the fix: chief_delegate (replaces: ${row.thread_id}, kind: spec-writer). If the Spec delta cannot be written: start a fresh chief_plan with ${row.plan_thread_id ? `the plan files (${planWavesFor(row.plan_thread_id).map((wave) => wave.path).join(", ")}), ` : ""}this blocked report (bb chief inspect ${row.thread_id}), branch ${row.branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${row.thread_id}, kind: spec-writer.`;
      }
      if (row.kind !== "tester" && onSpecChain(row)) return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user. ${specRoutes(row)}`;
      if (row.kind === "tester") {
        return `Tests failed: ${clip(row.blocker ?? "", 200)}. Delegate a fresh worker to fix the product code: chief_delegate (replaces: ${row.thread_id}, kind: worker) with the failures as its mission; its ready alert then asks for a tester. ${testWave
          ? `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, reason).`
          : "If you judge the failures acceptable, complete it with testsSkipped (your reason)."}`;
      }
    }
    if (row.state === "blocked") return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user.`;
    if (row.state !== "ready") return null;
    if (row.role === "planner") {
      if (!row.plan_waves) return null;
      const refusal = planReviewRefusal(row);
      if (refusal) return refusal;
      const waves = planWavesFor(row.thread_id);
      const { heads, undelegated } = schedule.undelegatedHeads(row.thread_id, waves);
      if (!undelegated.length) return null;
      if (heads.length === 1) {
        return `Delegate wave 1 now: run chief_forge_init (planThreadId: ${row.thread_id}, wave: 1), then chief_delegate (planThreadId: ${row.thread_id}, wave: 1).${specFirstLine(row.thread_id, waves, 1)} The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.`;
      }
      return `Delegate wave${undelegated.length > 1 ? "s" : ""} ${undelegated.join(", ")} now, in parallel — for each wave run chief_forge_init (planThreadId: ${row.thread_id}, wave: N), then chief_delegate (planThreadId: ${row.thread_id}, wave: N), all in this turn. Each of these is an independent chain head and gets its own task title, branch, PR and worktree from the default base (chief_forge_init without base); its later waves continue that chain with replaces: the chain's latest worker, never a worker of another chain.${undelegated.map((n) => specFirstLine(row.thread_id, waves, n)).join("")} The plugin supplies each plan file; do not read the plans. Escalate to the user only for a genuine product or scope open question the planner named.`;
    }
    if (row.role === "worker") {
      // A reviewer that still covers this worker's latest report — either busy
      // (a review is actually in flight) or already reported on it — means its own
      // recommendation (below) covers this work now, so the worker itself must not
      // also ask for a review. The tie is report_seq equality, not updated_at: two
      // reports in the same millisecond are indistinguishable by timestamp, and a
      // reviewer that later completes (state moves to complete) must still count.
      // A re-pointed stale reviewer (delegate's `replaces:`) has its snapshot reset
      // to null, so it no longer matches and this still recommends chief_review.
      if (ledger.isCurrent(row)) return null;
      return workerReadyNextStep(row, forAlert);
    }
    if (row.role === "advisor") {
      if (row.worker_thread_id && ledger.ladder(row.worker_thread_id).rung === "stop") {
        return `The advisor changed nothing. The reviewer has now requested changes ${STOP_AFTER_REJECTIONS} times in a row: start no new worker, and escalate to the user with both positions, this advice, and your recommendation.`;
      }
      const advised = row.worker_thread_id ? store.get(row.worker_thread_id) : undefined;
      return `The advisor changed nothing. Decide the next step yourself: hand its advice to a fresh worker with ${advised ? ctx.replacesCall(advised) : row.worker_thread_id ? `chief_delegate (replaces: ${row.worker_thread_id})` : "chief_delegate (through chief_plan first when planning is on)"} with the advice in its context, or escalate to the user if it names a genuine decision.`;
    }
    const advice = progress.reviewAdvice(row);
    if (!advice) return null;
    const flagged = advice.kind !== "approve" && advice.regression ? " The reviewer reports this change introduced a new problem; make the fix's brief name it." : "";
    if (advice.kind === "stop") {
      return `The reviewer still requires changes after ${advice.streak} consecutive rounds, and the advisor's advice did not settle it. Stop: start no new worker. Escalate to the user with both positions (the reviewer's findings and the worker's), the consult's advice, and your recommendation; only the user can authorize another round.${flagged}`;
    }
    const { work } = advice;
    if (advice.kind === "approve") {
      if (work.layout === "plan") {
        return `The reviewer approves the whole plan. ${work.open.map((target) => `chief_complete (threadId: ${target.threadId})`).join("; ")}; each marks its pull request ready. Nits listed with an approve are optional: start no worker round for them alone.`;
      }
      const complete = work.layout === "single"
        ? `chief_complete (threadId: ${work.target.threadId}); it marks the pull request ready`
        : `chief_complete (threadId: ${row.thread_id}), then mark the pull request ready yourself (no worker owns it)`;
      return `The reviewer approves. ${complete}. Nits listed with an approve are optional: start no worker round for them alone.`;
    }
    // A tester's branch: a product fix goes to a worker, a test fix to a tester; replacing it needs the kind.
    const handoff = (target: RepairTarget) => target.spec
      ? `chief_delegate (replaces: ${target.threadId}, kind: worker) for product-code findings${target.tested ? `, chief_delegate (replaces: ${target.threadId}, kind: tester) for test-only findings` : ""} or chief_delegate (replaces: ${target.threadId}, kind: spec-writer) for docs findings`
      : target.tested
      ? `chief_delegate (replaces: ${target.threadId}, kind: worker) for product-code findings or chief_delegate (replaces: ${target.threadId}, kind: tester) for test-only findings`
      : `chief_delegate (replaces: ${target.threadId})`;
    // A stacked chain's waves each build on the one before, so they are fixed one at a time, never in parallel.
    if (work.layout === "plan") {
      const { open, stacks, loose } = work;
      const workers = open.map((target) => target.threadId).join(", ");
      const testerIds = open.filter((target) => target.tested).map((target) => target.threadId);
      const mixed = testerIds.length
        ? ` On ${testerIds.join(", ")} name the kind: kind: worker for product-code findings, kind: tester for test-only findings. Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests.`
        : "";
      if (advice.kind === "consult") {
        return `The reviewer still requires changes after ${advice.streak} consecutive rounds. Call chief_consult (workerThreadId: ${open[0]!.threadId}) now, before any further delegation, with every branch of the review (${workers}) in its context — one consult unlocks the fix for each. Then hand its advice to ${stacks.length
          ? `fresh workers with chief_delegate (replaces: …): on the stacked waves ${stacks.map((stack) => stack.map((target) => target.wave).join(" → ")).join("; ")} one at a time in wave order, the earliest wave the findings name first, then each later wave restacked on it as its ready report directs; any other branch the findings name in this turn. Run exactly one more review once every wave is ready.`
          : "one fresh worker per branch the findings name with chief_delegate (replaces: …), all in this turn, and run exactly one more review."}${mixed} If that review still requires changes, stop and escalate to the user.${flagged}`;
      }
      if (stacks.length) {
        return `The reviewer requires changes.${flagged} ${stacks.map((stack) => `Waves ${stack.map((target) => target.wave).join(" → ")} are stacked, each on the one before: fix them in wave order, never in parallel. Delegate the earliest of them the findings name now with chief_delegate (replaces: its worker) — ${stack.map((target) => `wave ${target.wave}: ${target.threadId}`).join(", ")} — then restack each later wave on it as each ready report directs, even one the findings do not name.`).join(" ")}${loose.length ? ` Hand the fixes on the other branches the findings name to fresh workers in this turn: ${loose.map(handoff).join(" / ")}.` : ""}${mixed} Their findings are attached automatically, and the next review covers every branch again once every wave is ready. Escalate if the disagreement is a genuine decision.`;
      }
      return `The reviewer requires changes.${flagged} Hand the fixes to fresh workers in this turn, one per branch the findings name: ${open.map(handoff).join(" / ")}; their findings are attached automatically.${mixed} Delegate all of them before any reports: the next review covers every branch again. Escalate if the disagreement is a genuine decision.`;
    }
    if (advice.kind === "consult") {
      return `The reviewer still requires changes after ${advice.streak} consecutive rounds. Call chief_consult${work.layout === "single" ? ` (workerThreadId: ${work.target.threadId})` : " with this branch and review in its context"} now, before any further delegation — required even when every finding names file:line and a concrete fix. Then hand its advice to one fresh worker with ${work.layout === "single" ? handoff(work.target) : `chief_delegate (branch: ${row.branch})`} and run exactly one more review.${work.layout === "single" && work.target.tested ? " Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests." : ""} If that review still requires changes, stop and escalate to the user.${flagged}`;
    }
    return work.layout === "single"
      ? `The reviewer requires changes.${flagged} Hand the fix to a fresh worker with ${handoff(work.target)}; its findings are attached automatically.${work.target.tested ? " Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests." : ""} Escalate if the disagreement is a genuine decision.`
      : `The reviewer requires changes, and no managed worker owns branch ${row.branch}.${flagged} Hand the fix to a fresh worker with chief_delegate (branch: ${row.branch}${row.pr_url ? `, prUrl: ${row.pr_url}` : ""}; through chief_plan first when planning is on) with the findings in its context, then chief_complete this review. Escalate if the disagreement is a genuine decision.`;
  }

  /** Live status of a worker. When its row is already ready, waits up to REVIEW_IDLE_WAIT_MS
   * for its turn to end: the ready alert is sent from inside the worker's chief_report call,
   * so that turn is still ending when Chief acts on it. A worker that has not reported is not waited on. */
  async function waitIdleAfterReport(worker: ManagedRow) {
    let live = await bb.sdk.threads.get({ threadId: worker.thread_id });
    // ponytail: polls; defer the alert to thread.idle if a minute is not enough.
    for (const deadline = Date.now() + REVIEW_IDLE_WAIT_MS; worker.state === "ready" && BUSY_STATUSES.has(live.status) && Date.now() < deadline;) {
      await ctx.researchSleep(REVIEW_IDLE_POLL_MS);
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
    plan: { reviewRefusal, reviewTargetsFor, planWavesFor },
    host: {
      settledLive: async (worker) => {
        const live = await waitIdleAfterReport(worker);
        if (BUSY_STATUSES.has(live.status)) busyRejection(worker, live.status, "starting a review");
        return live;
      },
      projectPath: ctx.projectPath,
      projectHost: async (projectId) => (await ctx.projectHostId(projectId)) ?? await ctx.defaultHostId(),
      environmentHost: ctx.environmentHostId,
      reusableEnvironment: async (threadId) => {
        try {
          const thread = await bounded(() => bb.sdk.threads.get({ threadId }), ctx.CLEANUP_READ_MS);
          if (thread.deletedAt !== null || thread.archivedAt !== null || BUSY_STATUSES.has(thread.status) || !thread.environmentId) return null;
          const environment = await bounded(() => bb.sdk.environments.get({ environmentId: thread.environmentId! }), ctx.CLEANUP_READ_MS);
          if (!environment.isWorktree || environment.status === "destroyed" || environment.lifecycle.phase === "destroyed" || environment.hostLifecycle === "removed") return null;
          return { environmentId: thread.environmentId, hostId: environment.hostId };
        } catch (error) {
          bb.log.warn(`Reviewer ${threadId} is not reusable, starting a fresh worktree: ${String(error)}`);
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
  return { busyRejection, nextAction, planAdvisors, planReviewRefusal, revisionsOf, specFirstLine, startBranchReview, startReview, waitIdleAfterReport, waivedLine, waveWaitLine, workerReadyNextStep };
}

