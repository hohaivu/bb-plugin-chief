export type PlanWave = { path: string; contracts?: string; dependsOn?: number[]; design?: boolean };
export type WaveLink = { dependsOn?: number[] };

/** Wave n's parent (1-based): its dependsOn, else the previous wave; null for a chain head. */
export function parentOf(waves: WaveLink[], n: number): number | null {
  const dependsOn = waves[n - 1]?.dependsOn;
  return dependsOn ? dependsOn[0] ?? null : n > 1 ? n - 1 : null;
}
/** The wave that builds on wave n, or null for a chain tip. */
export function successorOf(waves: WaveLink[], n: number): number | null {
  const index = waves.findIndex((_, i) => parentOf(waves, i + 1) === n);
  return index < 0 ? null : index + 1;
}
/** Wave n's whole chain, head to tip. */
export function chainOf(waves: WaveLink[], n: number): number[] {
  let head = n;
  for (let parent = parentOf(waves, head); parent !== null; parent = parentOf(waves, head)) head = parent;
  const chain = [head];
  for (let next = successorOf(waves, head); next !== null; next = successorOf(waves, next)) chain.push(next);
  return chain;
}
/** Every chain's tip. */
export function tips(waves: WaveLink[]): number[] {
  return waves.flatMap((_, index) => successorOf(waves, index + 1) === null ? [index + 1] : []);
}
/** Every chain's head: the waves with no parent. */
export function heads(waves: WaveLink[]): number[] {
  return waves.flatMap((_, index) => parentOf(waves, index + 1) === null ? [index + 1] : []);
}

/** What the schedule reads of a managed_threads row; the server's ManagedRow satisfies it. */
interface WaveRow {
  thread_id: string;
  role: string;
  state: string;
  last_report_state: string | null;
  created_at: number;
  plan_thread_id: string | null;
  plan_wave: number | null;
  plan_waves: string | null;
}

/** One module owns the plan-wave graph and the state derived from it: which worker holds a wave, which waves are
 * still pending, which workers one review covers, and whether a worker ends its plan. It returns data and
 * decisions, never sentences. rows reads the server's live row cache, which is reloaded after writes. */
export function createWaveSchedule<Row extends WaveRow>(rows: () => ReadonlyMap<string, Row>) {
  /** A worker's linked planner's persisted wave schedule, or [] when unlinked. */
  function planWavesFor(planThreadId: string | null): PlanWave[] {
    if (!planThreadId) return [];
    const planner = rows().get(planThreadId);
    return planner?.plan_waves ? (JSON.parse(planner.plan_waves) as PlanWave[]) : [];
  }

  /** True for a worker delegated on a plan wave marked design: true. */
  function isDesignWave(row: Row): boolean {
    return row.role === "worker" && !!row.plan_thread_id && row.plan_wave != null && !!planWavesFor(row.plan_thread_id)[row.plan_wave - 1]?.design;
  }

  /** Linked workers of a planner, optionally for one wave, oldest first. */
  function waveWorkers(planThreadId: string, wave?: number): Row[] {
    return [...rows().values()]
      .filter((other) => other.role === "worker" && other.plan_thread_id === planThreadId && (wave === undefined || other.plan_wave === wave))
      .sort((a, b) => a.created_at - b.created_at);
  }

  /** The waves of a plan whose latest worker is not ready or complete (or does not exist yet). An idle worker
   * whose latest report was ready counts as ready: a later non-report turn moves its row off ready, not its report. */
  function pendingWaves(planThreadId: string, waves: PlanWave[]): number[] {
    return waves.flatMap((_, index) => {
      const latest = waveWorkers(planThreadId, index + 1).at(-1);
      const ready = latest?.state === "ready" || latest?.state === "complete"
        || (latest?.state === "idle" && latest.last_report_state === "ready");
      return ready ? [] : [index + 1];
    });
  }

  /** A planner's chain heads, and those of them still to delegate. One chain: any linked worker counts as
   * delegated, as before parallel waves existed. */
  function undelegatedHeads(planThreadId: string, waves: PlanWave[]) {
    const chainHeads = heads(waves);
    const undelegated = chainHeads.length === 1
      ? (waveWorkers(planThreadId).length ? [] : chainHeads)
      : chainHeads.filter((head) => !waveWorkers(planThreadId, head).length);
    return { heads: chainHeads, undelegated };
  }

  /** The workers one review of this chain tip covers, in wave order: the latest worker of every wave,
   * minus design waves and workers already complete (the one passed in always stays). A replaces: chain's
   * earlier waves are complete, so they drop out; a stacked chain whose waves each have their own PR is
   * covered wave by wave. A worker with no plan link (or #simple) covers only itself. Assumes reviewRefusal passed. */
  function reviewTargetsFor(worker: Row): Row[] {
    const waves = planWavesFor(worker.plan_thread_id);
    if (!waves.length || worker.plan_wave == null) return [worker];
    return waves.flatMap((_, index) => {
      const latest = waveWorkers(worker.plan_thread_id!, index + 1).at(-1);
      return latest && !isDesignWave(latest) && (latest.thread_id === worker.thread_id || latest.state !== "complete") ? [latest] : [];
    });
  }

  /** Whether a worker ends its plan (always, unplanned): its wave is a chain tip and every
   * chain's tip has a ready or complete latest worker. */
  function onFinalWave(worker: Row): boolean {
    if (!worker.plan_thread_id) return true;
    const waves = planWavesFor(worker.plan_thread_id);
    if (worker.plan_wave == null || !waves.length || successorOf(waves, worker.plan_wave) !== null) return false;
    return tips(waves).every((tip) => ["ready", "complete"].includes(waveWorkers(worker.plan_thread_id!, tip).at(-1)?.state ?? ""));
  }

  return { planWavesFor, isDesignWave, waveWorkers, pendingWaves, undelegatedHeads, reviewTargetsFor, onFinalWave };
}
