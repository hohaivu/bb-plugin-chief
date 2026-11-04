import type { WorkerKind } from "./roles";
import { clip, clipMiddle } from "./text";
import { chainOf, parentOf, successorOf, type createWaveSchedule } from "./waveSchedule";

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
  chief_thread_id: string | null;
  report_path: string | null;
  owner_approval: string | null;
  brief: string | null;
}

/** What one accepted chief_delegate hands the worker brief: the final kind and the plan facts it renders. */
export interface Admission {
  kind: WorkerKind;
  planPath?: string;
  waveTotal?: number;
  waveNext: number | null;
  waveIndependent: boolean;
  designWave: boolean;
  implementsDesign: number | null;
  contracts?: string;
  specSources: string[];
  specDocs: string[];
  baseline: boolean;
}

export type SpecWaiver = "waive" | "already-waived" | "already-waived-delegated";

/** One module owns who may run which plan wave next: role, Spec Writer and tester hand-off order, and the test and spec waivers.
 * It answers admission with data and throws the refusal sentence when an action is not allowed. Advice (what to call next) stays
 * with the callers. reviewRefusal is the planner's advisor-review gate, run where it always ran so the first refusal is unchanged. */
export function createPlanLifecycle<Row extends PlanRow>(
  rows: { get(threadId: string): Row | undefined },
  schedule: ReturnType<typeof createWaveSchedule<Row>>,
  ledger: { taskChain(workerThreadId: string): string[] },
  reviewRefusal: (planner: Row) => string | null,
) {
  const { planWavesFor, waveWorkers, specWave, specOwed, specReady, specChain } = schedule;

  /** Admits or refuses one chief_delegate. kind is the one the caller named (undefined: not named), resolvedKind the one
   * resolveDelegation gave; branch is the one the caller named. */
  function admitDelegation(request: {
    chiefId: string; prior?: Row; kind?: WorkerKind; resolvedKind: WorkerKind; planThreadId?: string; wave?: number; branch?: string;
  }): Admission {
    const { chiefId, prior, planThreadId, wave } = request;
    let kind = request.resolvedKind;
    let planPath: string | undefined;
    let waveTotal: number | undefined;
    let waveNext: number | null = null;
    let waveIndependent = false;
    let designWave = false;
    let implementsDesign: number | null = null;
    let contracts: string | undefined;
    let specSources: string[] = [];
    // Spec Writer reports a product worker, designer or tester on a spec-bearing chain reads; [] otherwise.
    const specDocs: string[] = [];
    // Baseline is read only for the wave this role works on (tester: plus its ancestors), never the whole chain.
    let baseline = false;
    // Replacing a tester or Spec Writer needs an explicit kind, so a product fix never lands on one by default.
    const explicitKind = "Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs/.";
    if ((prior?.kind === "tester" || prior?.kind === "spec-writer") && request.kind === undefined) throw new Error(explicitKind);
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
      // A tester may start fresh on its own branch once the tested wave's worker is complete (its PR merged, its branch gone).
      const testedWorker = waveWorkers(planThreadId, parent ?? wave).at(-1);
      const afterMerge = !prior && kind === "tester" && !!request.branch && testedWorker?.state === "complete";
      if (scheduled.absent) throw new Error(`Wave ${wave}'s tests were skipped (${scheduled.testsSkipped}); nothing to delegate.`);
      const waveRows = waveWorkers(planThreadId, wave);
      // (a) The replaced row's wave owes its implementation: only its own worker or Spec Writer may follow.
      if (prior?.plan_thread_id && prior.plan_wave != null) {
        const priorWaves = prior.plan_thread_id === planThreadId ? waves : planWavesFor(prior.plan_thread_id);
        const owed = prior.plan_wave;
        if (specOwed(prior.plan_thread_id, priorWaves, owed)) {
          const writer = waveWorkers(prior.plan_thread_id, owed).at(-1)!;
          const ready = specReady(prior.plan_thread_id, priorWaves, owed);
          const same = prior.plan_thread_id === planThreadId && wave === owed && prior.thread_id === writer.thread_id;
          // The one cross-plan exception: a fresh plan's wave-1 Spec Writer takes over a blocked Spec Writer's branch.
          const blocked = writer.state === "blocked" || (writer.state === "idle" && writer.last_report_state === "blocked");
          const freshPlan = kind === "spec-writer" && wave === 1 && prior.plan_thread_id !== planThreadId && prior.thread_id === writer.thread_id && blocked;
          if (!freshPlan && (!same || !(kind === "spec-writer" || ((kind === "worker" || kind === "designer") && ready)))) {
            const call = `chief_delegate (planThreadId: ${prior.plan_thread_id}, wave: ${owed}, replaces: ${writer.thread_id}`;
            throw new Error(ready
              ? `Wave ${owed}'s Spec Writer ${writer.thread_id} is ready: the wave's worker implements against its docs first — ${call}, kind: worker).`
              : `Wave ${owed}'s Spec Writer ${writer.thread_id} has not reported ready: retry it with the fix — ${call}, kind: spec-writer) — or, when the Spec delta cannot be written, start a fresh chief_plan with its report in context, then delegate its wave 1 with replaces: ${writer.thread_id}, kind: spec-writer.`);
          }
        }
      }
      // (a2) An owed wave admits only its Spec Writer's retry, or a ready Spec Writer's own worker or designer, whatever replaces: says.
      if (specOwed(planThreadId, waves, wave)) {
        const writer = waveRows.at(-1)!;
        const ready = specReady(planThreadId, waves, wave);
        if (prior?.thread_id !== writer.thread_id || !(kind === "spec-writer" || ((kind === "worker" || kind === "designer") && ready))) {
          const call = `chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, replaces: ${writer.thread_id}`;
          throw new Error(ready
            ? `Wave ${wave}'s Spec Writer ${writer.thread_id} is ready: the wave's worker implements against its docs first — ${call}, kind: worker).`
            : `Wave ${wave}'s Spec Writer ${writer.thread_id} has not reported ready: retry it with the fix — ${call}, kind: spec-writer).`);
        }
      }
      // (b) A wave that builds on a spec wave, at any depth, waits for that wave's worker.
      let owedAncestor = parent;
      while (owedAncestor !== null && !specOwed(planThreadId, waves, owedAncestor)) owedAncestor = parentOf(waves, owedAncestor);
      if (owedAncestor !== null) {
        const writer = waveWorkers(planThreadId, owedAncestor).at(-1)!;
        throw new Error(`Wave ${owedAncestor} still owes its implementation: its Spec Writer ${writer.thread_id} hands off to its worker first — chief_delegate (planThreadId: ${planThreadId}, wave: ${owedAncestor}, replaces: ${writer.thread_id}, kind: worker).`);
      }
      // (c) A spec wave's first delegation is its Spec Writer, unless Chief bypassed it.
      if (specWave(waves, wave) && !waveRows.length) {
        if (request.kind === undefined) kind = "spec-writer";
        else if (kind !== "spec-writer") {
          throw new Error(`Wave ${wave} is marked spec: true: its Spec Writer runs before its worker — chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}${prior ? `, replaces: ${prior.thread_id}` : ""}, kind: spec-writer). To go without, record why: chief_skip_specs (planThreadId: ${planThreadId}, wave: ${wave}, reason).`);
        }
      }
      // (d) A Spec Writer runs first on a spec wave (Initial), or replaces the latest row of a spec-bearing chain (Repair).
      if (kind === "spec-writer") {
        const latest = waveRows.at(-1);
        if (scheduled.specsSkipped) throw new Error(`Specs on wave ${wave} were bypassed (${scheduled.specsSkipped}); no Spec Writer runs on it.`);
        if (scheduled.design) throw new Error(`Wave ${wave} is design-only: no Spec Writer runs on it.`);
        const initial = specWave(waves, wave) && !latest;
        const repair = !!latest && prior?.thread_id === latest.thread_id && specChain(planThreadId, waves, wave);
        if (!initial && !repair) {
          throw new Error(latest && prior?.thread_id !== latest.thread_id && specChain(planThreadId, waves, wave)
            ? `A Spec Writer on wave ${wave} replaces its latest worker: chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, replaces: ${latest.thread_id}, kind: spec-writer).`
            : `Wave ${wave}: no spec on this chain, so no Spec Writer runs on it.`);
        }
      }
      if (kind === "spec-writer") {
        // Admitted above; a test wave's Spec Writer repair replaces its latest row, so the test-wave hand-off rules do not apply.
      } else if (scheduled.test) {
        // A test wave continues its parent's branch: its first hand-off replaces the parent wave's worker.
        const onPlan = prior?.plan_thread_id === planThreadId;
        const sameWave = onPlan && prior!.plan_wave === wave;
        if (!afterMerge && (!onPlan || !(sameWave || prior!.plan_wave === parent))) {
          const parentWorker = parent !== null ? waveWorkers(planThreadId, parent).at(-1) : undefined;
          throw new Error(`Wave ${wave} is a test wave: it runs on wave ${parent}'s branch. Delegate it as chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, replaces: ${parentWorker?.thread_id ?? `<wave ${parent}'s latest worker>`}, kind: tester).`);
        }
        if (request.kind === undefined) {
          if (sameWave) throw new Error(explicitKind);
          kind = "tester";
        }
        if (kind === "designer") throw new Error(`Wave ${wave} is a test wave: a designer cannot run it. Use kind: tester, or kind: worker to fix product code on it.`);
        if (kind === "worker" && !sameWave) throw new Error(`Wave ${wave} is a test wave: its first hand-off is kind: tester. kind: worker only replaces a worker on wave ${wave}, to fix product code.`);
      } else if (kind === "tester" && waves.some((other) => other.test)) {
        throw new Error(`Wave ${wave} is not a test wave: a tester runs only this plan's test waves (${waves.flatMap((other, index) => other.test ? [index + 1] : []).join(", ")}).`);
      } else if (kind === "tester" && !prior && !afterMerge) {
        throw new Error("kind: tester on a plan with no test wave needs replaces: of the worker whose branch it tests, or a new branch once that worker is complete.");
      }
      if (kind === "spec-writer") baseline = !!scheduled.baseline && waveRows.every((row) => row.kind === "spec-writer");
      if (kind === "tester") {
        for (let n: number | null = wave; n !== null; n = parentOf(waves, n)) {
          if (waves[n - 1]!.spec && waves[n - 1]!.baseline && !waves[n - 1]!.specsSkipped) baseline = true;
        }
      }
      if (specChain(planThreadId, waves, wave)) {
        for (const n of chainOf(waves, wave)) {
          const writer = waves[n - 1]!.spec && !waves[n - 1]!.specsSkipped ? waveWorkers(planThreadId, n).filter((row) => row.kind === "spec-writer").at(-1) : undefined;
          if (writer) specDocs.push(`Wave ${n} Spec Writer ${writer.thread_id}: report ${writer.report_path ?? "none"}`);
        }
      }
      if (kind === "tester" || kind === "spec-writer") {
        for (const n of chainOf(waves, wave)) {
          const entry = waves[n - 1]!;
          specSources.push(`Wave ${n} of ${waves.length}: ${entry.path}`, ...(entry.contracts ? [clip(entry.contracts, 3_000)] : []));
          if (entry.design) {
            const designer = waveWorkers(planThreadId, n).at(-1);
            specSources.push(`Approved design: wave ${n}'s artboards, owner's approval “${designer?.owner_approval ?? "none recorded"}”, designer report ${designer?.report_path ?? "none"}`);
          }
        }
      }
    } else {
      // (f) An unplanned Spec Writer that is its chain's latest row hands off only to a worker or designer, after a ready report.
      if (prior?.kind === "spec-writer") {
        const ready = prior.state === "ready" || (prior.state === "idle" && prior.last_report_state === "ready");
        if (kind === "tester" || ((kind === "worker" || kind === "designer") && !ready)) {
          throw new Error(ready
            ? `Spec Writer ${prior.thread_id} hands off to its worker: chief_delegate (replaces: ${prior.thread_id}, kind: worker).`
            : `Spec Writer ${prior.thread_id} has not reported ready: retry it with the fix — chief_delegate (replaces: ${prior.thread_id}, kind: spec-writer) — or start a fresh chief_plan with its report in context.`);
        }
      }
      if (kind === "tester" && !prior) throw new Error("kind: tester on unplanned work needs replaces: of the worker whose branch it tests.");
      const chain = prior ? ledger.taskChain(prior.thread_id).map((id) => rows.get(id)) : [];
      if (kind === "tester" || kind === "spec-writer") {
        const head = chain.at(-1);
        if (head?.brief) specSources = [clipMiddle(head.brief, 4_000)];
      }
      for (const writer of chain.filter((row) => row?.kind === "spec-writer").reverse()) specDocs.push(`Spec Writer ${writer!.thread_id}: report ${writer!.report_path ?? "none"}`);
    }
    // A Spec Writer's brief never lists the Spec Writer reports.
    return { kind, planPath, waveTotal, waveNext, waveIndependent, designWave, implementsDesign, contracts, specSources, specDocs: kind === "spec-writer" ? [] : specDocs, baseline };
  }

  /** chief_skip_tests's plan-side admission: refuses a wave that is not a test wave and a complete latest worker; the caller
   * still checks that worker is not busy. parent is the wave its advice sentence names. */
  function waiveTests(planThreadId: string, wave: number) {
    const waves = planWavesFor(planThreadId);
    if (!waves[wave - 1]?.test) throw new Error(`Wave ${wave} of planner ${planThreadId} is not a test wave (test: true).`);
    const latest = waveWorkers(planThreadId, wave).at(-1);
    if (latest?.state === "complete") throw new Error(`Wave ${wave}'s worker ${latest.thread_id} is complete: nothing left to waive.`);
    return { latest, alreadyWaived: !!waves[wave - 1]!.testsSkipped, parent: parentOf(waves, wave) };
  }

  /** chief_skip_specs's admission. The wave must be a spec implementation wave (specsSkipped stays in, so a repeat is idempotent);
   * "waive" means record it, the other two mean it already is (and whether a worker was delegated on it since). */
  function waiveSpecs(planThreadId: string, wave: number): { outcome: SpecWaiver; parent: number | null } {
    const waves = planWavesFor(planThreadId);
    const scheduled = waves[wave - 1];
    if (!scheduled?.spec || scheduled.test || scheduled.design) throw new Error(`Wave ${wave} of planner ${planThreadId} is not a spec: true implementation wave.`);
    const parent = parentOf(waves, wave);
    const latest = waveWorkers(planThreadId, wave).at(-1);
    if (scheduled.specsSkipped) return { outcome: latest ? "already-waived-delegated" : "already-waived", parent };
    if (latest) throw new Error(`Wave ${wave} already has worker ${latest.thread_id}: chief_skip_specs only bypasses a Spec Writer before the wave's first delegation. Re-plan with a fresh chief_plan instead.`);
    return { outcome: "waive", parent };
  }

  return { admitDelegation, waiveTests, waiveSpecs };
}
