/** spec: an implementation wave whose `## Spec delta` a Spec Writer turns into docs/ before the wave's worker runs.
 * baseline: a spec wave whose `## Spec baseline` heading names new docs/specs files whose current behaviour its Spec Writer documents first; set at intake, never re-parsed.
 * specsSkipped: Chief's reason for going without that Spec Writer (chief_skip_specs, before the wave's first delegation).
 * testsSkipped: Chief's recorded reason for going without this test wave (chief_skip_tests). absent is never persisted:
 * planWavesFor sets it on a waived wave no worker was ever delegated on, and the graph helpers then skip that wave. */
export type PlanWave = { path: string; contracts?: string; dependsOn?: number[]; design?: boolean; test?: boolean; testsSkipped?: string; spec?: boolean; baseline?: boolean; specsSkipped?: string; title?: string; absent?: boolean };

/** The first heading, else the first non-empty line, of a wave body: what the wave is about, for the tracking issue's schedule. */
export function waveTitle(body: string): string | undefined {
  const line = body.split("\n").map((entry) => entry.replace(/^\s*(?:#+\s*|[-*]\s+)/, "").trim()).find(Boolean);
  return line ? line.slice(0, 120) : undefined;
}
export type WaveLink = { dependsOn?: number[]; absent?: boolean };

/** Wave n's parent (1-based): its dependsOn, else the previous wave; null for a chain head. */
export function parentOf(waves: WaveLink[], n: number): number | null {
  const dependsOn = waves[n - 1]?.dependsOn;
  return dependsOn ? dependsOn[0] ?? null : n > 1 ? n - 1 : null;
}
/** The wave that builds on wave n, or null for a chain tip. */
export function successorOf(waves: WaveLink[], n: number): number | null {
  const index = waves.findIndex((wave, i) => !wave.absent && parentOf(waves, i + 1) === n);
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
  return waves.flatMap((wave, index) => !wave.absent && successorOf(waves, index + 1) === null ? [index + 1] : []);
}
/** Every chain's head: the waves with no parent. */
export function heads(waves: WaveLink[]): number[] {
  return waves.flatMap((_, index) => parentOf(waves, index + 1) === null ? [index + 1] : []);
}

/** What the schedule reads of a managed_threads row; the server's ManagedRow satisfies it. */
interface WaveRow {
  thread_id: string;
  role: string;
  kind: string | null;
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
  /** A worker's linked planner's persisted wave schedule, or [] when unlinked. A waived test wave no worker was
   * ever delegated on is marked absent, so the graph helpers skip it. */
  function planWavesFor(planThreadId: string | null): PlanWave[] {
    if (!planThreadId) return [];
    const planner = rows().get(planThreadId);
    const waves = planner?.plan_waves ? (JSON.parse(planner.plan_waves) as PlanWave[]) : [];
    return waves.map((wave, index) => wave.testsSkipped && !waveWorkers(planThreadId, index + 1).length ? { ...wave, absent: true } : wave);
  }

  /** True for a worker delegated on a plan wave marked test: true. */
  function isTestWave(row: Row): boolean {
    return row.role === "worker" && !!row.plan_thread_id && row.plan_wave != null && !!planWavesFor(row.plan_thread_id)[row.plan_wave - 1]?.test;
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

  /** Wave n runs a Spec Writer before its worker: an implementation wave marked spec, not bypassed. */
  function specWave(waves: PlanWave[], n: number): boolean {
    const wave = waves[n - 1];
    return !!wave?.spec && !wave.test && !wave.design && !wave.specsSkipped;
  }

  /** Implementation is owed on wave n: a spec wave whose latest row is a Spec Writer, in any state (complete included). */
  function specOwed(planThreadId: string, waves: PlanWave[], n: number): boolean {
    return specWave(waves, n) && waveWorkers(planThreadId, n).at(-1)?.kind === "spec-writer";
  }

  /** specOwed, and its Spec Writer reported ready (ready, or idle after a ready report): the worker may take over. */
  function specReady(planThreadId: string, waves: PlanWave[], n: number): boolean {
    if (!specOwed(planThreadId, waves, n)) return false;
    const latest = waveWorkers(planThreadId, n).at(-1)!;
    return latest.state === "ready" || (latest.state === "idle" && latest.last_report_state === "ready");
  }

  /** Wave n's chain is spec-bearing: some unbypassed spec wave on it has had a Spec Writer. */
  function specChain(planThreadId: string, waves: PlanWave[], n: number): boolean {
    return chainOf(waves, n).some((m) => !!waves[m - 1]?.spec && !waves[m - 1]!.specsSkipped
      && waveWorkers(planThreadId, m).some((row) => row.kind === "spec-writer"));
  }

  /** The waves of a plan whose latest worker is not ready or complete (or does not exist yet). An idle worker
   * whose latest report was ready counts as ready: a later non-report turn moves its row off ready, not its report.
   * A wave whose latest row is a Spec Writer is pending first, whatever that row's state or the test waiver.
   * A waived test wave is otherwise never pending: absent, or done whatever its worker's state. */
  function pendingWaves(planThreadId: string, waves: PlanWave[]): number[] {
    return waves.flatMap((wave, index) => {
      if (specOwed(planThreadId, waves, index + 1)) return [index + 1];
      if (wave.testsSkipped) return [];
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
   * earlier waves are complete, so they drop out; a chain has one branch and PR (only a legacy plan's stacked waves, each with
   * its own PR, are covered wave by wave). A worker with no plan link covers only itself. Assumes reviewRefusal passed. */
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

  return { planWavesFor, isDesignWave, isTestWave, waveWorkers, specWave, specOwed, specReady, specChain, pendingWaves, undelegatedHeads, reviewTargetsFor, onFinalWave };
}
