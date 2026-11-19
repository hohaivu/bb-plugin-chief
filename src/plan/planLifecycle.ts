import type { WorkerKind } from "../core/roles";
import { clip, clipMiddle } from "../core/text";
import { chainOf, isReady, isSettled, isWriter, parentOf, successorOf, type createWaveSchedule } from "./waveSchedule";

/** What admission reads of a managed_threads row; the server's ManagedRow satisfies it. The first block is the wave schedule's own row. */
interface PlanRow {
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
  branch: string | null;
  chief_thread_id: string | null;
  report_path: string | null;
  owner_approval: string | null;
  brief: string | null;
  pr_url: string | null;
}

/** What one accepted chief_delegate hands the worker brief: the final kind and the plan facts it renders. */
export interface Admission {
  kind: WorkerKind;
  planPath?: string;
  waveTotal?: number;
  waveNext: number | null;
  waveIndependent: boolean;
  /** The plan base a fresh chain head is stacked on (its branch and PR are based on it); absent on the project default. */
  stackBase?: string;
  designWave: boolean;
  implementsDesign: number | null;
  contracts?: string;
  specSources: string[];
  specDocs: string[];
  baseline: boolean;
  /** A worker or designer on a spec wave: it builds from the plan alone while the wave's Spec Writer records the docs in parallel. */
  specWave: boolean;
  /** side: a Spec Writer in its own side worktree beside the chain's implementation row. */
  lane: "side" | "implementation";
  /** A first side-lane writer's chain branch and pull request, from the chain's implementation row. */
  sideChain?: { branch: string; prUrl: string | null };
}

export type SpecWaiver = "waive" | "already-waived";

/** One module owns who may run which plan wave next: role, Spec Writer hand-off order, and the spec waiver.
 * It answers admission with data and throws the refusal sentence when an action is not allowed. Advice (what to call next) stays
 * with the callers. reviewRefusal is the planner's advisor-review gate, run where it always ran so the first refusal is unchanged. */
export function createPlanLifecycle<Row extends PlanRow>(
  rows: { get(threadId: string): Row | undefined },
  schedule: ReturnType<typeof createWaveSchedule<Row>>,
  ledger: { taskChain(workerThreadId: string): string[] },
  reviewRefusal: (planner: Row) => string | null,
) {
  const { planWavesFor, waveWorkers, specWriters, writersAt, latestWorker, specWave, planWriterWave, pendingWaves, specChain, writerPending, latestWriter, chainOwner, laneFor, sideLane, planBase } = schedule;

  /** Admits or refuses one chief_delegate. kind is the one the caller named (undefined: not named), resolvedKind the one
   * resolveDelegation gave; branch is the one the caller named. */
  function admitDelegation(request: {
    chiefId: string; prior?: Row; kind?: WorkerKind; resolvedKind: WorkerKind; planThreadId?: string; wave?: number; branch?: string; prUrl?: string;
  }): Admission {
    const { chiefId, prior, planThreadId, wave } = request;
    let kind = request.resolvedKind;
    let planPath: string | undefined;
    let waveTotal: number | undefined;
    let waveNext: number | null = null;
    let waveIndependent = false;
    let stackBase: string | undefined;
    let designWave = false;
    let implementsDesign: number | null = null;
    let contracts: string | undefined;
    let specSources: string[] = [];
    // Spec Writer reports a product worker or designer on a spec-bearing chain reads; [] otherwise.
    const specDocs: string[] = [];
    // Baseline is read only for the wave this role works on, never the whole chain.
    let baseline = false;
    let lane: Admission["lane"] = "implementation";
    let planFirst = false;
    let sideChain: Admission["sideChain"];
    // Replacing a Spec Writer needs an explicit kind, so a product fix never lands on one by default.
    const explicitKind = "Name the kind: kind: worker to change product code, kind: spec-writer to change docs/.";
    if (isWriter(prior?.kind) && request.kind === undefined) throw new Error(explicitKind);
    if (planThreadId !== undefined) {
      const planner = rows.get(planThreadId);
      if (!planner || planner.role !== "planner" || !(planner.thread_id !== chiefId && planner.chief_thread_id === chiefId)) {
        throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      }
      const planRefusal = reviewRefusal(planner);
      if (planRefusal) throw new Error(planRefusal);
      const waves = planWavesFor(planThreadId);
      if (wave === undefined || wave < 1 || wave > waves.length) {
        throw new Error(`Wave ${wave ?? "?"} is out of range: planner ${planThreadId} scheduled ${waves.length} wave(s).`);
      }
      const scheduled = waves[wave - 1]!;
      planPath = scheduled.path;
      waveTotal = waves.length;
      waveNext = successorOf(waves, wave);
      waveIndependent = wave > 1 && parentOf(waves, wave) === null && !prior;
      contracts = scheduled.contracts;
      // A design-only wave draws as a designer unless the caller named a kind.
      designWave = !!scheduled.design;
      if (designWave && request.kind === undefined) kind = "designer";
      const parent = parentOf(waves, wave);
      if (parent !== null && waves[parent - 1]?.design) implementsDesign = parent;
      if (scheduled.absent) throw new Error(`Wave ${wave} is a legacy test wave: nothing to delegate.`);
      const waveRows = waveWorkers(planThreadId, wave);
      const owner = chainOwner(planThreadId, waves, wave);
      const ownerCall = (n: number) => `chief_delegate (planThreadId: ${planThreadId}, wave: ${n}, replaces: ${owner?.thread_id ?? "<the chain's latest worker>"})`;
      // A spec wave's Spec Writer works in its own side worktree beside the wave's worker; a replaced worker takes the implementation lane.
      lane = laneFor(waves, wave, kind, prior);
      const blockedPrior = !!prior && (prior.state === "blocked" || (prior.state === "idle" && prior.last_report_state === "blocked"));
      // The one cross-plan exception, per lane: a fresh plan's wave-1 Spec Writer takes over a blocked Spec Writer's branch.
      const freshPlan = isWriter(kind) && wave === 1 && !!prior && isWriter(prior.kind) && prior.plan_thread_id !== planThreadId && prior.plan_thread_id !== null && blockedPrior;
      // (a) A side-lane writer is replaced only by its own docs repair (or, for a legacy head writer with no worker yet, by that wave's worker).
      if (prior && sideLane(prior) && !freshPlan) {
        const same = prior.plan_thread_id === planThreadId && prior.plan_wave === wave;
        const legacyHandoff = same && (kind === "worker" || kind === "designer") && isReady(prior) && !waveRows.length;
        if (!legacyHandoff && !(same && isWriter(kind))) {
          throw new Error(`${prior.thread_id} is wave ${prior.plan_wave}'s Spec Writer, which works in its own side worktree: only its docs fix replaces it — chief_delegate (planThreadId: ${prior.plan_thread_id}, wave: ${prior.plan_wave}, replaces: ${prior.thread_id}, kind: spec-writer). Product and test work continues the chain's implementation row — ${ownerCall(wave)}.`);
        }
      }
      // (d) A Spec Writer is a side-lane writer on an unwaived spec wave (first, or its own repair); on any other wave except a design-only one it replaces the chain's current implementation row.
      if (isWriter(kind)) {
        if (scheduled.design) {
          const next = successorOf(waves, wave);
          const nextOwner = next !== null ? chainOwner(planThreadId, waves, next) : undefined;
          throw new Error(`Wave ${wave} is design-only: it changes no repository files. Route its docs need to wave ${next ?? "<its successor>"}: put it in that wave's Spec Writer mission when the wave is spec: true, else chief_delegate (planThreadId: ${planThreadId}, wave: ${next ?? "<its successor>"}, replaces: ${nextOwner?.thread_id ?? "<that wave's chain owner>"}, kind: spec-writer) once its worker has reported.`);
        }
        if (lane === "side") {
          if (!prior) {
            const anchor = planWriterWave(waves);
            if (wave !== anchor) throw new Error(`A plan has one Spec Writer: it runs on wave ${anchor} once every wave is ready and covers the Spec delta of every spec: true wave — chief_delegate (planThreadId: ${planThreadId}, wave: ${anchor}, kind: spec-writer).`);
            const pending = pendingWaves(planThreadId, waves);
            if (pending.length) throw new Error(`The plan's Spec Writer starts once every wave is ready; wave(s) ${pending.join(", ")} of ${waves.length} are not ready yet.`);
          }
          const live = specWriters(planThreadId, wave).filter((row) => !["complete", "archived", "deleted"].includes(row.state) && row.thread_id !== prior?.thread_id);
          if (live.length) throw new Error(`Wave ${wave}'s Spec Writer ${live[0]!.thread_id} is still live: fix its docs with chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, replaces: ${live[0]!.thread_id}, kind: spec-writer).`);
        } else if (!(owner && prior?.thread_id === owner.thread_id && prior.plan_wave === wave)) {
          throw new Error(owner
            ? `A Spec Writer here replaces the chain's current implementation row: chief_delegate (planThreadId: ${planThreadId}, wave: ${owner.plan_wave}, replaces: ${owner.thread_id}, kind: spec-writer).`
            : `A Spec Writer here replaces the chain's current implementation row, but no worker has started wave ${wave}'s chain yet.`);
        }
      }
      // One plan chain, one branch, PR and implementation worktree: a chain's waves share its latest worker's environment through replaces:.
      const chain = chainOf(waves, wave);
      const chainLead = chain[0]!;
      const chainWorker = owner;
      const sameChain = `chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, replaces: ${chainWorker?.thread_id})`;
      // (i) Another chain of this plan keeps its own branch: replaces: never crosses chains.
      if (prior?.plan_thread_id === planThreadId && prior.plan_wave != null && !chain.includes(prior.plan_wave)) {
        throw new Error(`Wave ${wave} belongs to the chain of waves ${chain.join(", ")}; ${prior.thread_id} works on wave ${prior.plan_wave}, another chain. An independent chain starts its own branch with chief_forge_init on its head wave ${chainLead}, or replaces that chain's latest worker${chainWorker ? ` — ${sameChain}` : ""}.`);
      }
      // (iv) A replacement keeps its prior's pull request; a prUrl only fills a prior that had none.
      if (prior?.plan_thread_id === planThreadId && prior.pr_url && request.prUrl && request.prUrl !== prior.pr_url) {
        throw new Error(`replaces: ${prior.thread_id} carries pull request ${prior.pr_url}; pass no prUrl or the same one. A plan chain has one pull request.`);
      }
      // A first side-lane writer starts no chain: it needs the chain's branch.
      if (lane === "side" && !prior) {
        if (owner) {
          if (request.branch && request.branch !== owner.branch) throw new Error(`branch ${request.branch} is not the chain's branch ${owner.branch} (worker ${owner.thread_id}); a Spec Writer folds onto the chain's one branch.`);
          sideChain = { branch: owner.branch!, prUrl: owner.pr_url };
        } else if (request.branch) {
          sideChain = { branch: request.branch, prUrl: request.prUrl ?? null };
        } else {
          throw new Error(`Wave ${wave}'s Spec Writer needs the chain's branch: run chief_forge_init on head wave ${chainLead} first and pass its branch and prUrl.`);
        }
      }
      // (ii) A later wave continues its chain, and (iii) a started chain is never started twice: both go to the chain's implementation row.
      if (!prior && lane !== "side" && (parentOf(waves, wave) !== null || chainWorker)) {
        throw new Error(chainWorker
          ? `Wave ${wave}'s chain (waves ${chain.join(", ")}) already has worker ${chainWorker.thread_id} on wave ${chainWorker.plan_wave}; a chain has one branch, PR and worktree. Continue it with replaces: ${chainWorker.thread_id} — ${sameChain}.`
          : `Wave ${wave} builds on wave ${parentOf(waves, wave)}: delegate its chain head, wave ${chainLead}, first (chief_forge_init, then chief_delegate), then continue with replaces: the chain's latest worker.`);
      }
      // A fresh chain head on a plan base starts only once the base is ready and cut on a branch: never from the default base.
      const pb = !prior && parent === null && (lane !== "side" || !owner) ? planBase(planThreadId, wave) : null;
      if (pb) {
        if (pb.waiting || !pb.base) throw new Error(`Wave ${wave} is stacked: ${pb.waiting ?? pb.unresolved}. Delegate it after that.`);
        if (!request.branch) throw new Error(`Wave ${wave} stacks on ${pb.base}: run chief_forge_init (planThreadId: ${planThreadId}, wave: ${wave}) and pass its branch.`);
        stackBase = pb.base;
      }
      if (lane === "side") baseline = wave === planWriterWave(waves) ? waves.some((entry, i) => specWave(waves, i + 1) && !!entry.baseline) : !!scheduled.baseline;
      // A worker or designer on a spec wave builds from the plan alone.
      if (!isWriter(kind) && !(specWave(waves, wave) && (kind === "worker" || kind === "designer")) && specChain(planThreadId, waves, wave)) {
        for (const n of chainOf(waves, wave)) {
          if (!waves[n - 1]!.spec || waves[n - 1]!.specsSkipped) continue;
          for (const writer of writersAt(planThreadId, n).sort((x, y) => x.created_at - y.created_at)) {
            specDocs.push(`Wave ${n} Spec Writer ${writer.thread_id}: report ${writer.report_path ?? "none"}`);
          }
        }
      }
      planFirst = specWave(waves, wave) && (kind === "worker" || kind === "designer");
      if (isWriter(kind)) {
        // The side-lane writer covers every wave of the plan, contracts excluded; others read their chain.
        const sources = lane === "side" ? waves.flatMap((entry, i) => entry.absent ? [] : [i + 1]) : chainOf(waves, wave);
        for (const n of sources) {
          const entry = waves[n - 1]!;
          specSources.push(`Wave ${n} of ${waves.length}: ${entry.path}`, ...(entry.contracts && isWriter(kind) && lane !== "side" && n === wave ? [clip(entry.contracts, 3_000)] : []));
          if (entry.design) {
            const designer = latestWorker(planThreadId, n);
            specSources.push(`Approved design: wave ${n}'s artboards, owner's approval “${designer?.owner_approval ?? "none recorded"}”, designer report ${designer?.report_path ?? "none"}`);
          }
        }
      }
    } else {
      // (f) An unplanned Spec Writer that is its chain's latest row hands off only to a worker or designer, after a ready report.
      if (prior && isWriter(prior.kind)) {
        const ready = prior.state === "ready" || (prior.state === "idle" && prior.last_report_state === "ready");
        if ((kind === "worker" || kind === "designer") && !ready) {
          throw new Error(`Spec Writer ${prior.thread_id} has not reported ready: retry it with the fix — chief_delegate (replaces: ${prior.thread_id}, kind: spec-writer) — or start a fresh chief_plan with its report in context.`);
        }
      }
      const chain = prior ? ledger.taskChain(prior.thread_id).map((id) => rows.get(id)) : [];
      if (isWriter(kind)) {
        const head = chain.at(-1);
        if (head?.brief) specSources = [clipMiddle(head.brief, 4_000)];
      }
      for (const writer of chain.filter((row) => isWriter(row?.kind)).reverse()) specDocs.push(`Spec Writer ${writer!.thread_id}: report ${writer!.report_path ?? "none"}`);
    }
    // A Spec Writer's brief never lists the Spec Writer reports.
    return { kind, planPath, waveTotal, waveNext, waveIndependent, stackBase, designWave, implementsDesign, contracts, specSources, specDocs: isWriter(kind) ? [] : specDocs, baseline, specWave: planFirst, lane, sideChain };
  }

  /** chief_skip_specs's admission, plan level: "waive" lists every spec wave with no Spec Writer row to record the reason on;
   * "already-waived" means a previous call did. Refused once the plan's Spec Writer was delegated. */
  function waiveSpecs(planThreadId: string): { outcome: SpecWaiver; waves: number[] } {
    const waves = planWavesFor(planThreadId);
    // A plan-level bypass already ran: a retained legacy writer may now be the computed anchor, so check this first.
    if (waves.some((wave) => wave.specsSkipped)) return { outcome: "already-waived", waves: [] };
    const anchor = planWriterWave(waves);
    if (anchor === null) {
      throw new Error(`Planner ${planThreadId} has no spec: true implementation wave.`);
    }
    const writer = writersAt(planThreadId, anchor)[0];
    if (writer) throw new Error(`The plan's Spec Writer ${writer.thread_id} was already delegated: chief_skip_specs only bypasses a Spec Writer that was never delegated. Fix its docs with chief_delegate (replaces: ${writer.thread_id}, kind: spec-writer), or re-plan with a fresh chief_plan.`);
    return { outcome: "waive", waves: waves.flatMap((_, i) => specWave(waves, i + 1) && !writersAt(planThreadId, i + 1).length ? [i + 1] : []) };
  }

  return { admitDelegation, waiveSpecs };
}
