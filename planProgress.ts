import { chainOf, heads, successorOf, tips, type PlanWave } from "./waveSchedule";
import type { createWaveSchedule } from "./waveSchedule";
import type { createReviewLedger, ReviewTarget } from "./reviewLedger";

/** What plan progress reads of a managed_threads row; the server's ManagedRow satisfies it. */
export interface ProgressRow {
  thread_id: string;
  role: string;
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
}

/** The two row-state tests the server owns: a terminal row, and a live thread status that is busy. */
export interface ProgressStates {
  terminal: (state: string) => boolean;
  busy: (status: string) => boolean;
}

export type SegmentState =
  | { kind: "notDelegated" | "approved" | "changesRequested" | "inReview" }
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
  const { planWavesFor, isDesignWave, waveWorkers, pendingWaves, reviewTargetsFor, onFinalWave } = schedule;

  /** Why a worker may not start a review now, or null (a plan's one review runs once, after every wave is ready). */
  function reviewBlock(worker: Row):
    | null
    | { kind: "design" }
    | { kind: "superseded"; latest: Row }
    | { kind: "betweenWaves"; waves: PlanWave[]; next: number }
    | { kind: "pending"; waves: PlanWave[]; pending: number[] } {
    if (isDesignWave(worker)) return { kind: "design" };
    const waves = planWavesFor(worker.plan_thread_id);
    if (!waves.length || worker.plan_wave == null) return null;
    const planThreadId = worker.plan_thread_id!;
    const latest = waveWorkers(planThreadId, worker.plan_wave).at(-1);
    if (latest && latest.thread_id !== worker.thread_id) return { kind: "superseded", latest };
    const next = successorOf(waves, worker.plan_wave);
    if (next !== null) return { kind: "betweenWaves", waves, next };
    const pending = pendingWaves(planThreadId, waves);
    return pending.length ? { kind: "pending", waves, pending } : null;
  }

  /** The waves a ready chain-tip worker waits on, or null. */
  function waitingOn(row: Row): { waves: PlanWave[]; pending: number[] } | null {
    if (row.role !== "worker" || row.state !== "ready" || !row.plan_thread_id || row.plan_wave == null) return null;
    const waves = planWavesFor(row.plan_thread_id);
    if (successorOf(waves, row.plan_wave) !== null) return null;
    const pending = pendingWaves(row.plan_thread_id, waves);
    return pending.length ? { waves, pending } : null;
  }

  /** A ready worker's next step, or null (#simple work stays with the server). The plan's one review is named once,
   * on its first reviewable tip, unless forAlert. */
  function readyStep(row: Row, forAlert = false):
    | null
    | { kind: "designNext"; waves: PlanWave[]; next: number }
    | { kind: "designDone"; waves: PlanWave[] }
    | { kind: "nextWave"; waves: PlanWave[]; next: number }
    | { kind: "unplanned" }
    | { kind: "review"; waves: PlanWave[]; namer: Row; targets: Row[] } {
    const waves = planWavesFor(row.plan_thread_id);
    const next = row.plan_thread_id && row.plan_wave != null ? successorOf(waves, row.plan_wave) : null;
    const design = !!waves[row.plan_wave! - 1]?.design;
    if (next !== null && design) return { kind: "designNext", waves, next };
    if (design) return { kind: "designDone", waves };
    if (next !== null) return { kind: "nextWave", waves, next };
    if (!row.plan_thread_id || row.plan_wave == null || !waves.length) return { kind: "unplanned" };
    if (waitingOn(row)) return null;
    const targets = reviewTargetsFor(row);
    // The targets whose current report no review covers yet. The plan's one call is named on the first of them
    // (whichever tip a replaces: successor or an earlier review left stale), so Pending never drops it.
    // Only a chain tip can start the review (reviewBlock), so a stale earlier wave is never the namer.
    const stale = targets.filter((target) => !ledger.isCurrent(target) && successorOf(waves, target.plan_wave!) === null);
    if (!stale.length) return null;
    const namer = stale.find((target) => target.state === "ready") ?? stale[0]!;
    if (!forAlert && namer.thread_id !== row.thread_id) return null;
    return { kind: "review", waves, namer, targets };
  }

  /** A reviewer verdict's open branches: the covered targets, those whose worker is not complete yet, and whether
   * the review spans a plan. Null when a covered target was re-pointed to a fresh worker (its findings were handed off)
   * or every covered worker is already complete. */
  function fixRound(reviewer: { thread_id: string }): { covered: ReviewTarget[]; open: ReviewTarget[]; plan: boolean } | null {
    const covered = ledger.targets(reviewer.thread_id);
    if (covered.some((target) => target.report_seq === null)) return null;
    // Workers independently marked complete already absorbed this reviewer's verdict; only the rest still need a call.
    const open = covered.filter((target) => rows().get(target.worker_thread_id)?.state !== "complete");
    if (covered.length && !open.length) return null;
    return { covered, open, plan: covered.length > 1 };
  }

  /** A planner's progress: one segment per chain, and how many waves are done. */
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
      const state: SegmentState = !current ? { kind: "notDelegated" }
        : approved ? { kind: "approved" }
        : reviewerCovers && reviewer!.verdict === "request_changes" ? { kind: "changesRequested" }
        : reviewerCovers && states.busy(reviewer!.state) ? { kind: "inReview" }
        : { kind: "worker", state: current.state };
      done += Math.max(0, chain.indexOf(currentWave)) + (approved ? 1 : 0);
      return { wave: currentWave, state };
    });
    return { done, total: waves.length, segments };
  }

  /** Whether a planner is absorbed: every chain's tip has a complete worker, and every linked worker is terminal. */
  function plannerAbsorbed(planner: Row): boolean {
    const linked = waveWorkers(planner.thread_id);
    return tips(planWavesFor(planner.thread_id)).every((tip) => linked.some((w) => w.plan_wave === tip && w.state === "complete"))
      && linked.every((w) => states.terminal(w.state));
  }

  /** The wave that builds on a worker's wave, or null for a chain tip. */
  function nextWave(row: Row): { waves: PlanWave[]; next: number | null } {
    const waves = planWavesFor(row.plan_thread_id);
    return { waves, next: successorOf(waves, row.plan_wave!) };
  }

  return { reviewBlock, waitingOn, readyStep, fixRound, waveProgress, plannerAbsorbed, nextWave, onFinalWave };
}
