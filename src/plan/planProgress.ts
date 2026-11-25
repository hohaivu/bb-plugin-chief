import { chainOf, heads, isReady, isSettled, isWriter, successorOf, tips, type PlanWave } from "./waveSchedule";
import type { ReviewGate } from "../db/threadStore";
import type { ReportFinding } from "../types";
import type { createWaveSchedule } from "./waveSchedule";
import type { createReviewLedger } from "../review/reviewLedger";

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
  regression: number | null;
  findings: string | null;
  blocker: string | null;
  owner_approval: string | null;
}

/** A fix run that stopped before its first report: it no longer holds its gate slot. Never a live (starting/active/stopping) row. */
export const neverReported = (row: Pick<ProgressRow, "last_report_state" | "state">) => row.last_report_state === null && ["idle", "blocked", "failed"].includes(row.state);

/** What the review gate asks for next. First match wins (gateDecision). */
export type GateDecision<Row> =
  | { kind: "start" }
  | { kind: "block"; refusal: string }
  | { kind: "restart"; sides: "reviewer"[]; blocked: Row[] }
  | { kind: "wait"; who: Row[] }
  | { kind: "fix"; codeFindings: number }
  | { kind: "docsRepair"; replaces: Row }
  | { kind: "escalate"; why: string }
  | { kind: "pass" };

/** The review gate's next step. Pure: it reads only what it is given.
 * startRefusal: the readiness refusal for an unopened gate (null: it may start). writers: every Spec Writer row of the gate's plan or task. */
export function gateDecision<Row extends ProgressRow>(input: {
  gate: ReviewGate | undefined;
  row: (threadId: string) => Row | undefined;
  startRefusal: string | null;
  verdictAt: number | null;
  /** The reviewer of the newest recorded verdict on the gate's targets. */
  settledReviewer?: Row;
  writers: Row[];
  terminal: (state: string) => boolean;
}): GateDecision<Row> {
  const { gate, row } = input;
  if (!gate) return input.startRefusal ? { kind: "block", refusal: input.startRefusal } : { kind: "start" };
  const moved = gate.targets.find((target) => row(target.threadId)?.report_seq !== target.reportSeq);
  if (moved) return { kind: "escalate", why: `${moved.threadId} changed after the gate pinned it (report ${moved.reportSeq})` };
  const actor = (id: string | null) => (id ? row(id) : undefined);
  // After the fix run, a pending or failed advisory re-review never holds the gate: the last settled verdict stands.
  const named = actor(gate.reviewer_thread_id);
  const advisoryOpen = !!gate.fixer_thread_id && !!input.settledReviewer && named?.thread_id !== input.settledReviewer.thread_id;
  const reviewer = advisoryOpen ? input.settledReviewer : named;
  // Legacy tester_thread_id and corrector_thread_id are never read: the reviewer alone holds the gate.
  if (!reviewer || ["failed", "blocked", "archived", "deleted"].includes(reviewer.state)) return { kind: "restart", sides: ["reviewer"], blocked: reviewer?.state === "blocked" ? [reviewer] : [] };
  if (!isReady(reviewer) && reviewer.state !== "complete") return { kind: "wait", who: [reviewer] };
  // Docs findings go only to a Spec Writer repair created after the verdict.
  const findings = (reviewer!.findings ? JSON.parse(reviewer!.findings) as ReportFinding[] : []).filter((entry) => entry.severity === "blocking");
  const docsFindings = findings.filter((entry) => entry.file.startsWith("docs/"));
  // The current repairs: those delegated after the verdict that no later repair replaced.
  const repairs = (input.verdictAt === null ? [] : input.writers.filter((writer) => writer.created_at > input.verdictAt!))
    .filter((writer, _, all) => !all.some((other) => other.replaces_thread_id === writer.thread_id));
  // Every repair delegated after the verdict must settle; the newest live one is the one waited on.
  const repair = repairs.find((writer) => !isSettled(writer) && !input.terminal(writer.state)) ?? repairs.at(-1);
  const gateWriters = gate.targets.map((target) => row(target.threadId)).filter((target): target is Row => !!target && isWriter(target.kind));
  // A finding names no owner, so several writers' docs findings never auto-pass: Chief checks every repair, then completes with override.
  const multiDocs = !!docsFindings.length && gateWriters.length > 1;
  const multiEscalate = { kind: "escalate" as const, why: `the review found docs findings and the gate has ${gateWriters.length} Spec Writers (${gateWriters.map((writer) => writer.thread_id).join(", ")}); assign each finding to its owning writer: chief_delegate (replaces: <that writer>, kind: spec-writer) with only its findings, once per owning writer. Chief checks every docs repair, then completes with override` };
  const docsSettled = !docsFindings.length || (!multiDocs && !!repairs.length && repairs.every(isSettled));
  const docsWait = !!docsFindings.length && !!repair && !isSettled(repair) && !input.terminal(repair.state);
  const done = (fixRow: Row) => isReady(fixRow) || fixRow.state === "complete";
  // A fix run that stopped before it reported is absent: the gate asks for its fix run again.
  const fixer = [actor(gate.fixer_thread_id)].find((row) => row && !neverReported(row));
  if (fixer) {
    if (fixer.state === "blocked") return { kind: "escalate", why: `fix run ${fixer.thread_id} is blocked: answer its blocker with chief_continue (threadId: ${fixer.thread_id}), or escalate` };
    if (fixer.state === "failed") return { kind: "escalate", why: `fix worker ${fixer.thread_id} failed: chief_continue (threadId: ${fixer.thread_id}) it, or escalate` };
    if (!done(fixer)) return { kind: "wait", who: [fixer] };
    if (docsSettled) return { kind: "pass" };
  }
  const codeFindings = findings.length - docsFindings.length;
  if (!fixer && codeFindings) return { kind: "fix", codeFindings };
  if (docsSettled) return { kind: "pass" };
  if (docsWait) return { kind: "wait", who: [repair!] };
  if (multiDocs) return multiEscalate;
  // A planned gate's repair needs a side-lane writer. An unplanned gate has none: the Spec Writer replaces its ready fix run, else its first target.
  const replaces = gateWriters[0] ?? (gate.plan_thread_id ? undefined : fixer && done(fixer) ? fixer : row(gate.targets[0]!.threadId));
  return replaces ? { kind: "docsRepair", replaces } : { kind: "escalate", why: `the review found docs findings and no side-lane Spec Writer of this gate can repair them` };
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
  const { planWavesFor, isDesignWave, specChain, laneOf, sideLane, waveWorkers, specWriters, latestWorker, latestSideWriter, latestWriter, writerPending, pendingWaves, reviewTargetsFor, onFinalWave } = schedule;

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

  /** Why a worker may not start a review now, or null (a plan's one review runs once, after every wave is ready). */
  function reviewBlock(worker: Row):
    | null
    | { kind: "design" }
    | { kind: "superseded"; latest: Row }
    | { kind: "restack" | "restacked"; waves: PlanWave[]; next: number; successor: Row }
    | { kind: "betweenWaves"; waves: PlanWave[]; next: number }
    | { kind: "sideWriter" }
    | { kind: "pending"; waves: PlanWave[]; pending: number[] }
    | { kind: "writers"; waves: PlanWave[]; writers: { wave: number; writer: Row | undefined }[] }
    | { kind: "unready"; rows: Row[] } {
    if (isDesignWave(worker)) return { kind: "design" };
    const waves = planWavesFor(worker.plan_thread_id);
    if (!waves.length || worker.plan_wave == null) {
      // An unplanned task: the worker needs a ready report, and so does the task's newest Spec Writer.
      const writer = ledger.taskChain(worker.thread_id).map((id) => rows().get(id)).find((row) => !!row && isWriter(row.kind));
      const unready = [worker, ...(writer && writer !== worker ? [writer] : [])].filter((row) => !isSettled(row));
      return unready.length ? { kind: "unready", rows: unready } : null;
    }
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
    return writers.length ? { kind: "writers", waves, writers } : null;
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
    | { kind: "designApproved"; waves: PlanWave[]; next: number | null }
    | { kind: "restack"; waves: PlanWave[]; next: number; successor: Row }
    | { kind: "nextWave"; waves: PlanWave[]; next: number }
    | { kind: "unplanned" }
    | { kind: "unplannedWriter" }
    | { kind: "waitWriters"; waves: PlanWave[]; pending: { wave: number; writer: Row | undefined }[] }
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
      return pendingWaves(planThreadId, waves).length || pendingWriters(planThreadId, waves).length ? null : reviewStep();
    }
    const next = planThreadId && row.plan_wave != null ? successorOf(waves, row.plan_wave) : null;
    const design = !!waves[row.plan_wave! - 1]?.design;
    if (design && row.owner_approval) return { kind: "designApproved", waves, next };
    if (next !== null && design) return { kind: "designNext", waves, next };
    if (design) return { kind: "designDone", waves };
    // An unplanned Spec Writer hands off to its worker, after a ready report.
    if (isWriter(row.kind) && (!planThreadId || row.plan_wave == null || !waves.length)) return { kind: "unplannedWriter" };
    const stack = restackOf(row, waves);
    if (stack) return stack.restacked ? null : { kind: "restack", waves, next: stack.next, successor: stack.successor };
    if (next !== null) return { kind: "nextWave", waves, next };
    if (!planThreadId || row.plan_wave == null || !waves.length) return { kind: "unplanned" };
    if (waitingOn(row)) return null;
    const writers = pendingWriters(planThreadId, waves);
    if (writers.length) return { kind: "waitWriters", waves, pending: writers };
    return reviewStep();
  }

  /** The row sits on a spec-bearing chain: a plan chain with a Spec Writer on an unbypassed spec wave, or an unplanned task chain holding a Spec Writer. */
  function onSpecChain(row: Row): boolean {
    if (row.plan_thread_id && row.plan_wave != null) return specChain(row.plan_thread_id, planWavesFor(row.plan_thread_id), row.plan_wave);
    return ledger.taskChain(row.thread_id).some((id) => isWriter(rows().get(id)?.kind));
  }

  /** A planner's progress: one segment per chain, and how many of all its waves are done. An absent legacy test wave
   * counts as done and stays in the total. */
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
    // Absent (legacy test, never delegated) waves are on no chain, so they are counted once here.
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

  return { reviewBlock, waitingOn, readyStep, onSpecChain, waveProgress, plannerAbsorbed, onFinalWave };
}
