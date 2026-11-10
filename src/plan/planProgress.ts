import { chainOf, heads, isReady, isWriter, parentOf, successorOf, tips, type PlanWave } from "./waveSchedule";
import type { createWaveSchedule } from "./waveSchedule";
import type { createReviewLedger, ReviewTarget } from "../review/reviewLedger";

/** What plan progress reads of a managed_threads row; the server's ManagedRow satisfies it. */
export interface ProgressRow {
  thread_id: string;
  role: string;
  kind: string | null;
  state: string;
  last_report_state: string | null;
  created_at: number;
  plan_thread_id: string | null;
  plan_wave: number | null;
  plan_waves: string | null;
  replaces_thread_id: string | null;
  report_seq: number;
  branch: string | null;
  verdict: string | null;
  worker_thread_id: string | null;
  reject_streak: number;
  regression: number | null;
  retest_skipped: string | null;
}

/** Where Chief hands a chain's tester rerun: a tester on the chain's live owner (wave: the plan wave it runs on), the tester already
 * running, a worker hand-off first (a Spec Writer owns an unplanned branch), or nothing yet (restack the chain first). */
export type RetestRoute<Row> = { kind: "tester"; wave?: number; replaces: Row } | { kind: "wait"; tester: Row } | { kind: "workerFirst"; replaces: Row } | { kind: "none" };
/** A fix that changed code after a reviewer's rejection and still owes a tester rerun; tester is the newest tester started after it. */
export type RetestDebt<Row = ProgressRow> = { fix: Row; tester?: Row; route: RetestRoute<Row> };

/** One worker a reviewer covers: its lane (a side-lane Spec Writer or an implementation row), its wave, whether it is a tester branch (a tester row or a worker on a test wave),
 * and whether it sits on a spec-bearing chain. */
export interface RepairTarget { threadId: string; wave: number | null; tested: boolean; spec: boolean; lane: "side" | "implementation" }
/** What a reviewer verdict covers: a whole plan (stacks are legacy chains fixed in wave order; loose is every other
 * open target), one managed worker, or a branch no worker owns. */
export type RepairWork =
  | { layout: "plan"; open: RepairTarget[]; stacks: RepairTarget[][]; loose: RepairTarget[] }
  | { layout: "single"; target: RepairTarget }
  | { layout: "branch" };
export type ReviewAdvice =
  | { kind: "approve"; work: RepairWork }
  | { kind: "fix" | "consult"; work: RepairWork; streak: number; regression: boolean }
  | { kind: "stop"; streak: number; regression: boolean };

/** The two row-state tests the server owns: a terminal row, and a live thread status that is busy. */
export interface ProgressStates {
  terminal: (state: string) => boolean;
  busy: (status: string) => boolean;
}

export type SegmentState =
  | { kind: "notDelegated" | "approved" | "changesRequested" | "inReview" | "testsSkipped" }
  | { kind: "worker"; state: string };

/** One module owns how far a plan has progressed: it combines the wave graph (waveSchedule.ts) with the review
 * ledger (reviewLedger.ts) and answers each question once. It returns data and decisions, never sentences: the
 * server formats every result at its call site. rows reads the server's live row cache, which is reloaded after writes. */
export function createPlanProgress<Row extends ProgressRow>(
  rows: () => ReadonlyMap<string, Row>,
  schedule: ReturnType<typeof createWaveSchedule<Row>>,
  ledger: ReturnType<typeof createReviewLedger<Row>>,
  states: ProgressStates,
) {
  const { planWavesFor, rawWaves, chainTests, chainWaiver, isDesignWave, isTestWave, specChain, laneOf, sideLane, waveWorkers, specWriters, latestWorker, latestSideWriter, latestWriter, writerPending, chainOwner, pendingWaves, reviewTargetsFor, onFinalWave } = schedule;

  /** Spec waves of a plan (or of the given waves) whose Spec Writer is owed, with their newest writer if any. */
  function pendingWriters(planThreadId: string, waves: PlanWave[], among: number[] = waves.map((_, index) => index + 1)) {
    return among.filter((n) => writerPending(planThreadId, waves, n)).map((wave) => ({ wave, writer: latestWriter(planThreadId, wave) }));
  }

  /** A same-wave fix worker's later wave to restack, or null. Set only when the worker replaces a worker of its own
   * wave (a fix round, not a first-time hand-off between waves) and the wave that builds on it has a live worker.
   * restacked: that worker was created after this one, so it was already restacked on this fix. */
  function restackOf(worker: Row, waves: PlanWave[]): { next: number; successor: Row; restacked: boolean } | null {
    if (!worker.plan_thread_id || worker.plan_wave == null || waves[worker.plan_wave - 1]?.design) return null;
    const next = successorOf(waves, worker.plan_wave);
    const prior = worker.replaces_thread_id ? rows().get(worker.replaces_thread_id) : undefined;
    if (next === null || !prior || prior.plan_thread_id !== worker.plan_thread_id || prior.plan_wave !== worker.plan_wave) return null;
    const successor = latestWorker(worker.plan_thread_id, next);
    if (!successor || states.terminal(successor.state)) return null;
    return { next, successor, restacked: successor.created_at >= worker.created_at };
  }

  /** The tester reruns a plan's (or an unplanned task's) review still owes after a rejection: one debt per chain, and the fixes
   * whose rerun Chief waived. Debt is read from the rows, never from a tester: a fix is a code row created after the chain's newest
   * verdict, when that verdict is request_changes. It is paid by a tester started after the fix that reported ready, a waived test wave
   * on the raw chain, retest_skipped on the fix, or a review that covers the fix's report. */
  function retestDebts(row: Row): { owed: RetestDebt<Row>[]; waived: { fix: Row; reason: string }[] } {
    const owed: RetestDebt<Row>[] = [];
    const waived: { fix: Row; reason: string }[] = [];
    const byAge = (a: Row, b: Row) => a.created_at - b.created_at;
    const evaluate = (chainRows: Row[], waiver: string | undefined, route: (fix: Row, tester: Row | undefined) => RetestRoute<Row>) => {
      const rejection = ledger.newestVerdictAt(chainRows.map((r) => r.thread_id));
      if (rejection?.verdict !== "request_changes") return;
      const fix = chainRows.filter((r) => r.role === "worker" && (r.kind ?? "worker") === "worker" && !sideLane(r) && !isDesignWave(r) && r.created_at > rejection.at).at(-1);
      if (!fix) return;
      const tester = chainRows.filter((r) => r.kind === "tester" && r.created_at > fix.created_at).at(-1);
      if ((tester && (isReady(tester) || (tester.state === "complete" && tester.last_report_state === "ready"))) || waiver || ledger.isCurrent(fix)) return;
      if (fix.retest_skipped) waived.push({ fix, reason: fix.retest_skipped });
      else owed.push({ fix, tester, route: route(fix, tester) });
    };
    const planThreadId = row.plan_thread_id;
    if (planThreadId && row.plan_wave != null && planWavesFor(planThreadId).length) {
      // The raw graph keeps an absent waived test wave on its chain.
      const waves = rawWaves(planThreadId);
      for (const head of heads(waves)) {
        const chain = chainOf(waves, head);
        const owner = chainOwner(planThreadId, waves, head);
        const test = chainTests(planThreadId, head).at(-1);
        evaluate(chain.flatMap((n) => waveWorkers(planThreadId, n)).sort(byAge), chainWaiver(planThreadId, head), (_, tester) => {
          if (!owner) return { kind: "none" };
          if (tester && tester.thread_id === owner.thread_id && tester.state === "active") return { kind: "wait", tester };
          if (test === undefined) return { kind: "tester", wave: owner.plan_wave!, replaces: owner };
          return owner.plan_wave === test || owner.plan_wave === parentOf(waves, test) ? { kind: "tester", wave: test, replaces: owner } : { kind: "none" };
        });
      }
    } else {
      const owner = [...rows().values()].filter((r) => r.role === "worker" && !states.terminal(r.state) && ledger.taskChain(r.thread_id).includes(row.thread_id)).sort(byAge).at(-1) ?? row;
      const chainRows = ledger.taskChain(owner.thread_id).flatMap((id) => rows().get(id) ?? []).sort(byAge);
      evaluate(chainRows, undefined, (_, tester) => tester && tester.thread_id === owner.thread_id && tester.state === "active" ? { kind: "wait", tester }
        : isWriter(owner.kind) ? { kind: "workerFirst", replaces: owner } : { kind: "tester", replaces: owner });
    }
    return { owed, waived };
  }

  /** Why a worker may not start a review now, or null (a plan's one review runs once, after every wave is ready).
   * retestWaived: Chief records why it reviews without the owed tester reruns, so the retest check is skipped. */
  function reviewBlock(worker: Row, retestWaived = false):
    | null
    | { kind: "design" }
    | { kind: "superseded"; latest: Row }
    | { kind: "restack" | "restacked"; waves: PlanWave[]; next: number; successor: Row }
    | { kind: "betweenWaves"; waves: PlanWave[]; next: number }
    | { kind: "sideWriter" }
    | { kind: "pending"; waves: PlanWave[]; pending: number[] }
    | { kind: "writers"; waves: PlanWave[]; writers: { wave: number; writer: Row | undefined }[] }
    | { kind: "retest"; debts: RetestDebt<Row>[] } {
    if (isDesignWave(worker)) return { kind: "design" };
    const waves = planWavesFor(worker.plan_thread_id);
    const retest = () => {
      const { owed } = retestWaived ? { owed: [] } : retestDebts(worker);
      return owed.length ? { kind: "retest" as const, debts: owed } : null;
    };
    if (!waves.length || worker.plan_wave == null) return retest();
    const planThreadId = worker.plan_thread_id!;
    // A side-lane Spec Writer is one of the plan's review targets; the one review starts from an implementation chain tip.
    if (sideLane(worker)) {
      const newest = latestSideWriter(planThreadId, worker.plan_wave);
      return newest && newest.thread_id !== worker.thread_id ? { kind: "superseded", latest: newest } : { kind: "sideWriter" };
    }
    const latest = latestWorker(planThreadId, worker.plan_wave);
    if (latest && latest.thread_id !== worker.thread_id) return { kind: "superseded", latest };
    const stack = restackOf(worker, waves);
    if (stack) return { kind: stack.restacked ? "restacked" : "restack", waves, next: stack.next, successor: stack.successor };
    const next = successorOf(waves, worker.plan_wave);
    if (next !== null) return { kind: "betweenWaves", waves, next };
    const pending = pendingWaves(planThreadId, waves);
    if (pending.length) return { kind: "pending", waves, pending };
    const writers = pendingWriters(planThreadId, waves);
    return writers.length ? { kind: "writers", waves, writers } : retest();
  }

  /** The waves a ready chain-tip worker waits on, or null. */
  function waitingOn(row: Row): { waves: PlanWave[]; pending: number[] } | null {
    if (row.role !== "worker" || row.state !== "ready" || !row.plan_thread_id || row.plan_wave == null || sideLane(row)) return null;
    const waves = planWavesFor(row.plan_thread_id);
    if (successorOf(waves, row.plan_wave) !== null) return null;
    const pending = pendingWaves(row.plan_thread_id, waves);
    return pending.length ? { waves, pending } : null;
  }

  /** A ready worker's next step, or null. The plan's one review is named once,
   * on its first reviewable tip, unless forAlert. */
  function readyStep(row: Row, forAlert = false):
    | null
    | { kind: "designNext"; waves: PlanWave[]; next: number }
    | { kind: "designDone"; waves: PlanWave[] }
    | { kind: "restack"; waves: PlanWave[]; next: number; successor: Row }
    | { kind: "nextWave"; waves: PlanWave[]; next: number }
    | { kind: "unplanned" }
    | { kind: "unplannedWriter" }
    | { kind: "waitWriters"; waves: PlanWave[]; pending: { wave: number; writer: Row | undefined }[] }
    | { kind: "tester"; waves: PlanWave[]; test: number; replaces: Row }
    | { kind: "retest"; waves: PlanWave[] }
    | { kind: "retestOwed"; waves: PlanWave[]; debts: RetestDebt<Row>[] }
    | { kind: "review"; waves: PlanWave[]; namer: Row; targets: Row[] } {
    const waves = planWavesFor(row.plan_thread_id);
    const planThreadId = row.plan_thread_id;
    // The plan's one review, named on an implementation chain tip once every wave and every Spec Writer is ready.
    // The targets whose current report no review covers yet; the plan's one call is named on the first of them
    // (whichever tip a replaces: successor or an earlier review left stale), so Pending never drops it.
    // Only an implementation chain tip can start the review (reviewBlock), so a stale earlier wave or a Spec Writer is never the namer.
    const reviewStep = () => {
      const targets = reviewTargetsFor(row);
      const tipRows = targets.filter((target) => !sideLane(target) && successorOf(waves, target.plan_wave!) === null);
      const stale = targets.filter((target) => !ledger.isCurrent(target) && (sideLane(target) || tipRows.includes(target)));
      if (!stale.length) return null;
      const staleTips = stale.filter((target) => tipRows.includes(target));
      const namers = staleTips.length ? staleTips : tipRows;
      const namer = namers.find((target) => target.state === "ready") ?? namers[0];
      if (!namer || (!forAlert && namer.thread_id !== row.thread_id)) return null;
      return { kind: "review" as const, waves, namer, targets };
    };
    if (planThreadId && row.plan_wave != null && sideLane(row)) {
      const chain = chainOf(waves, row.plan_wave);
      if (pendingWriters(planThreadId, waves, chain).length) return null;
      // The last writer of the chain is ready: release the test wave that waited for it.
      for (const test of chain) {
        const parent = parentOf(waves, test);
        const tested = parent === null ? undefined : latestWorker(planThreadId, parent);
        if (waves[test - 1]!.test && !waves[test - 1]!.testsSkipped && tested && isReady(tested) && !waveWorkers(planThreadId, test).length) {
          return { kind: "tester", waves, test, replaces: chainOwner(planThreadId, waves, parent!)! };
        }
      }
      const sideReview = pendingWaves(planThreadId, waves).length || pendingWriters(planThreadId, waves).length ? null : reviewStep();
      const sideOwed = sideReview ? retestDebts(row).owed : [];
      return sideOwed.length ? { kind: "retestOwed", waves, debts: sideOwed } : sideReview;
    }
    const next = planThreadId && row.plan_wave != null ? successorOf(waves, row.plan_wave) : null;
    const design = !!waves[row.plan_wave! - 1]?.design;
    if (next !== null && design) return { kind: "designNext", waves, next };
    if (design) return { kind: "designDone", waves };
    // An unplanned Spec Writer hands off to its worker, after a ready report.
    if (isWriter(row.kind) && (!planThreadId || row.plan_wave == null || !waves.length)) return { kind: "unplannedWriter" };
    const stack = restackOf(row, waves);
    if (stack) return stack.restacked ? null : { kind: "restack", waves, next: stack.next, successor: stack.successor };
    if (next !== null) {
      // A test wave waits for every Spec Writer of its chain: the Tester derives its tests from the committed docs.
      const waiting = waves[next - 1]!.test ? pendingWriters(planThreadId!, waves, chainOf(waves, row.plan_wave!)) : [];
      return waiting.length ? { kind: "waitWriters", waves, pending: waiting } : { kind: "nextWave", waves, next };
    }
    if (!planThreadId || row.plan_wave == null || !waves.length) {
      const unplannedOwed = retestDebts(row).owed;
      return unplannedOwed.length ? { kind: "retestOwed", waves, debts: unplannedOwed } : { kind: "unplanned" };
    }
    // A fix after a rejection owes a tester rerun before any review; this is the rows' debt, not advice.
    const owed = retestDebts(row).owed;
    if (owed.some((debt) => debt.fix.thread_id === row.thread_id)) return { kind: "retestOwed", waves, debts: owed };
    // A worker changed code on a test wave after the tests ran: offer a rerun until a review covers that report.
    const wave = waves[row.plan_wave - 1];
    if (wave?.test && !wave.testsSkipped && row.kind !== "tester" && !ledger.isCurrent(row)) return { kind: "retest", waves };
    if (waitingOn(row)) return null;
    const writers = pendingWriters(planThreadId, waves);
    if (writers.length) return { kind: "waitWriters", waves, pending: writers };
    const review = reviewStep();
    return review && owed.length ? { kind: "retestOwed", waves, debts: owed } : review;
  }

  /** A reviewer verdict's open branches: the covered targets, those whose worker is not complete yet, and whether
   * the review spans a plan. stacks groups the open targets of one chain (two or more, each in wave order): they build
   * on each other, so they are fixed one at a time. loose is every other open target, a side-lane Spec Writer always (it never builds on an implementation row). Null when a covered target was re-pointed to a fresh worker (its findings were handed off)
   * or every covered worker is already complete. */
  function fixRound(reviewer: { thread_id: string }): { covered: ReviewTarget[]; open: ReviewTarget[]; plan: boolean; stacks: ReviewTarget[][]; loose: ReviewTarget[] } | null {
    const covered = ledger.targets(reviewer.thread_id);
    if (covered.some((target) => target.report_seq === null)) return null;
    // Workers independently marked complete already absorbed this reviewer's verdict; only the rest still need a call.
    const open = covered.filter((target) => rows().get(target.worker_thread_id)?.state !== "complete");
    if (covered.length && !open.length) return null;
    const chains = new Map<string, { target: ReviewTarget; wave: number }[]>();
    for (const target of open) {
      const worker = rows().get(target.worker_thread_id);
      if (!worker?.plan_thread_id || worker.plan_wave == null || sideLane(worker)) continue;
      const key = `${worker.plan_thread_id}:${chainOf(planWavesFor(worker.plan_thread_id), worker.plan_wave)[0]}`;
      chains.set(key, [...(chains.get(key) ?? []), { target, wave: worker.plan_wave }]);
    }
    const stacks = [...chains.values()].filter((chain) => chain.length > 1)
      .map((chain) => chain.sort((a, b) => a.wave - b.wave).map((entry) => entry.target));
    const stacked = new Set(stacks.flat());
    return { covered, open, plan: covered.length > 1, stacks, loose: open.filter((target) => !stacked.has(target)) };
  }

  /** The row sits on a spec-bearing chain: a plan chain with a Spec Writer on an unbypassed spec wave, or an unplanned task chain holding a Spec Writer. */
  function onSpecChain(row: Row): boolean {
    if (row.plan_thread_id && row.plan_wave != null) return specChain(row.plan_thread_id, planWavesFor(row.plan_thread_id), row.plan_wave);
    return ledger.taskChain(row.thread_id).some((id) => isWriter(rows().get(id)?.kind));
  }

  /** The repair decision after a reviewer verdict, or null (no verdict, or nothing left to repair). Advice, not permission:
   * the rung comes from the reviewer's carried streak, and chief_delegate's ledger.replacement still decides each replaces:. */
  function reviewAdvice(reviewer: Row): ReviewAdvice | null {
    if (reviewer.role !== "reviewer" || !reviewer.verdict) return null;
    const round = fixRound(reviewer);
    if (!round) return null;
    const target = (threadId: string): RepairTarget => {
      const row = rows().get(threadId);
      return { threadId, wave: row?.plan_wave ?? null, tested: !!row && (row.kind === "tester" || isTestWave(row)), spec: !!row && onSpecChain(row), lane: row ? laneOf(row) : "implementation" };
    };
    const ofTarget = (entry: ReviewTarget) => target(entry.worker_thread_id);
    const work: RepairWork = round.plan
      ? { layout: "plan", open: round.open.map(ofTarget), stacks: round.stacks.map((stack) => stack.map(ofTarget)), loose: round.loose.map(ofTarget) }
      : reviewer.worker_thread_id ? { layout: "single", target: target(reviewer.worker_thread_id) } : { layout: "branch" };
    if (reviewer.verdict === "approve") return { kind: "approve", work };
    const rung = ledger.rung(reviewer.reject_streak);
    const regression = !!reviewer.regression;
    return rung === "stop" ? { kind: "stop", streak: reviewer.reject_streak, regression } : { kind: rung, work, streak: reviewer.reject_streak, regression };
  }

  /** A planner's progress: one segment per chain, and how many of all its waves are done. A test wave Chief waived
   * (chief_skip_tests) counts as done, delegated or not, and stays in the total. */
  function waveProgress(planner: Row): { done: number; total: number; segments: { wave: number; state: SegmentState }[] } {
    const waves = planWavesFor(planner.thread_id);
    const chainHeads = heads(waves);
    let done = 0;
    const segments = chainHeads.map((head) => {
      const chain = chainOf(waves, head);
      // The chain's current worker: its highest plan_wave linked to this planner,
      // breaking ties (a same-wave fix worker) by the newest.
      const current = waveWorkers(planner.thread_id)
        .filter((other) => chain.includes(other.plan_wave ?? 0) || (chainHeads.length === 1 && other.plan_wave == null))
        .reduce<Row | undefined>((best, other) => (
          !best || (other.plan_wave ?? 0) > (best.plan_wave ?? 0)
            || ((other.plan_wave ?? 0) === (best.plan_wave ?? 0) && other.created_at >= best.created_at)
        ) ? other : best, undefined);
      const currentWave = current?.plan_wave ?? head;
      const isFinalWave = currentWave === chain.at(-1);
      const reviewer = current ? ledger.covering(current.thread_id) : undefined;
      // Only trust the reviewer's verdict/busy-ness for the wave's state when it
      // still covers the current worker's latest report — the same report_seq tie
      // nextAction uses, so a stale (re-pointed but not-yet-reported) reviewer
      // does not show an approval or rejection that predates the current attempt.
      const reviewerCovers = reviewer != null && ledger.isCurrent(current!);
      const approved = isFinalWave && reviewerCovers && reviewer!.verdict === "approve";
      const waived = isFinalWave && !!current && !!waves[currentWave - 1]?.testsSkipped;
      const state: SegmentState = !current ? { kind: "notDelegated" }
        : approved ? { kind: "approved" }
        : reviewerCovers && reviewer!.verdict === "request_changes" ? { kind: "changesRequested" }
        : reviewerCovers && states.busy(reviewer!.state) ? { kind: "inReview" }
        : waived ? { kind: "testsSkipped" }
        : { kind: "worker", state: current.state };
      done += Math.max(0, chain.indexOf(currentWave)) + (approved || waived ? 1 : 0);
      return { wave: currentWave, state };
    });
    // Absent (waived before delegation) waves are on no chain, so they are counted once here.
    done += waves.filter((wave) => wave.absent).length;
    return { done, total: waves.length, segments };
  }

  /** Whether a planner is absorbed: every chain's tip has a complete worker, every linked worker and side-lane Spec Writer is terminal, and no spec wave still owes its writer. */
  function plannerAbsorbed(planner: Row): boolean {
    const linked = waveWorkers(planner.thread_id);
    const waves = planWavesFor(planner.thread_id);
    return !pendingWriters(planner.thread_id, waves).length
      && specWriters(planner.thread_id).every((w) => states.terminal(w.state))
      && tips(waves).every((tip) => linked.some((w) => w.plan_wave === tip && w.state === "complete"))
      && linked.every((w) => states.terminal(w.state));
  }

  /** The wave that builds on a worker's wave, or null for a chain tip. */
  function nextWave(row: Row): { waves: PlanWave[]; next: number | null } {
    const waves = planWavesFor(row.plan_thread_id);
    return { waves, next: successorOf(waves, row.plan_wave!) };
  }

  return { reviewBlock, retestDebts, waitingOn, readyStep, reviewAdvice, onSpecChain, waveProgress, plannerAbsorbed, nextWave, onFinalWave };
}
