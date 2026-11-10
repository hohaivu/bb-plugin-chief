/** spec: an implementation wave whose `## Spec delta` a Spec Writer turns into docs/ in parallel with the wave's worker, on a side branch folded onto the chain branch.
 * baseline: a spec wave whose `## Spec baseline` heading names new docs/specs files whose current behaviour its Spec Writer documents first; set at intake, never re-parsed.
 * specsSkipped: Chief's reason for going without that Spec Writer (chief_skip_specs, until a Spec Writer was delegated on the wave).
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
  replaces_thread_id: string | null;
}

const FINISHED = ["complete", "archived", "deleted"];
/** Ready, or idle after a ready report: a later non-report turn moves a row off ready, not its report. */
export const isReady = (row: { state: string; last_report_state: string | null }) => row.state === "ready" || (row.state === "idle" && row.last_report_state === "ready");
/** Ready or complete: a row its successor may build on. */
export const isSettled = (row: { state: string; last_report_state: string | null }) => isReady(row) || row.state === "complete";
/** The one place the Spec Writer kind is named. */
export const isWriter = (kind: string | null | undefined) => kind === "spec-writer";
export type Lane = "side" | "implementation";

/** One module owns the plan-wave graph and the state derived from it: which worker holds a wave, which waves are
 * still pending, which workers one review covers, and whether a worker ends its plan. It returns data and
 * decisions, never sentences. rows reads the server's live row cache, which is reloaded after writes. */
export function createWaveSchedule<Row extends WaveRow>(rows: () => ReadonlyMap<string, Row>) {
  /** A worker's linked planner's persisted wave schedule, or [] when unlinked. A waived test wave no worker was
   * ever delegated on is marked absent, so the graph helpers skip it. */
  function planWavesFor(planThreadId: string | null): PlanWave[] {
    return rawWaves(planThreadId).map((wave, index) => wave.testsSkipped && !laneRows(planThreadId!, index + 1).length ? { ...wave, absent: true } : wave);
  }

  /** The planner's persisted waves with absent never set (the graph helpers' raw input), or [] when unlinked. */
  function rawWaves(planThreadId: string | null): PlanWave[] {
    const planner = planThreadId ? rows().get(planThreadId) : undefined;
    return planner?.plan_waves ? (JSON.parse(planner.plan_waves) as PlanWave[]) : [];
  }

  /** The test waves on wave n's raw chain (an absent waived wave counts), head to tip. */
  function chainTests(planThreadId: string | null, n: number): number[] {
    const waves = rawWaves(planThreadId);
    return chainOf(waves, n).filter((m) => waves[m - 1]?.test);
  }

  /** The testsSkipped reason of the first test wave on wave n's raw chain that has one. */
  function chainWaiver(planThreadId: string | null, n: number): string | undefined {
    const waves = rawWaves(planThreadId);
    return chainTests(planThreadId, n).map((m) => waves[m - 1]!.testsSkipped).find(Boolean);
  }

  /** True for a worker delegated on a plan wave marked test: true. */
  function isTestWave(row: Row): boolean {
    return row.role === "worker" && !!row.plan_thread_id && row.plan_wave != null && !!planWavesFor(row.plan_thread_id)[row.plan_wave - 1]?.test;
  }

  /** True for a worker delegated on a plan wave marked design: true. */
  function isDesignWave(row: Row): boolean {
    return row.role === "worker" && !!row.plan_thread_id && row.plan_wave != null && !!planWavesFor(row.plan_thread_id)[row.plan_wave - 1]?.design;
  }

  /** Wave n runs a Spec Writer beside its worker: an implementation wave marked spec, not bypassed. */
  function specWave(waves: PlanWave[], n: number): boolean {
    const wave = waves[n - 1];
    return !!wave?.spec && !wave.test && !wave.design && !wave.specsSkipped;
  }

  /** The row and its whole replaces ancestry are spec-writers (a missing ancestor ends the walk): the writer never took over a worker's environment. */
  function writerAncestry(row: Row): boolean {
    const seen = new Set<string>();
    for (let current: Row | undefined = row; current; current = current.replaces_thread_id ? rows().get(current.replaces_thread_id) : undefined) {
      if (!isWriter(current.kind) || seen.has(current.thread_id)) return false;
      seen.add(current.thread_id);
    }
    return true;
  }

  /** The one lane rule. A side-lane Spec Writer is a spec-writer on a spec wave whose whole replaces ancestry is spec-writers
   * (prior: the row it replaces, if any): it works in its own worktree and never takes over the chain's. Every other worker-role row
   * is implementation lane. Admission asks it for a delegation not yet a row; sideLane and laneOf ask it for a row. */
  function laneFor(waves: PlanWave[], wave: number, kind: string | null, prior?: Row): Lane {
    return isWriter(kind) && specWave(waves, wave) && (!prior || writerAncestry(prior)) ? "side" : "implementation";
  }

  function laneOf(row: Row): Lane {
    if (row.role !== "worker" || !row.plan_thread_id || row.plan_wave == null) return "implementation";
    return laneFor(rawWaves(row.plan_thread_id), row.plan_wave, row.kind, row.replaces_thread_id ? rows().get(row.replaces_thread_id) : undefined);
  }

  function sideLane(row: Row): boolean {
    return laneOf(row) === "side";
  }

  /** Whether a live row may sit on the branch of a new row of this lane on this plan wave: a side-lane Spec Writer has its own
   * worktree beside the chain's implementation row, and implementation rows share one. */
  function coexists(row: Row, planThreadId: string, wave: number | undefined, lane: Lane): boolean {
    return row.plan_thread_id === planThreadId && (lane === "side" ? !sideLane(row) || row.plan_wave !== wave : sideLane(row));
  }

  /** Every worker-role row of a planner in any lane, optionally for one wave, oldest first. */
  function laneRows(planThreadId: string, wave?: number): Row[] {
    return [...rows().values()]
      .filter((other) => other.role === "worker" && other.plan_thread_id === planThreadId && (wave === undefined || other.plan_wave === wave))
      .sort((a, b) => a.created_at - b.created_at);
  }

  /** Linked implementation-lane workers of a planner, optionally for one wave, oldest first. */
  function waveWorkers(planThreadId: string, wave?: number): Row[] {
    return laneRows(planThreadId, wave).filter((row) => !sideLane(row));
  }

  /** Linked side-lane Spec Writers of a planner, optionally for one wave, oldest first. */
  function specWriters(planThreadId: string, wave?: number): Row[] {
    return laneRows(planThreadId, wave).filter(sideLane);
  }

  /** Wave n's newest implementation-lane row. */
  function latestWorker(planThreadId: string, n: number): Row | undefined {
    return waveWorkers(planThreadId, n).at(-1);
  }

  /** Wave n's newest side-lane Spec Writer. */
  function latestSideWriter(planThreadId: string, n: number): Row | undefined {
    return specWriters(planThreadId, n).at(-1);
  }

  /** Wave n's Spec Writer rows of either lane: side-lane ones oldest first, then implementation-lane (legacy) ones. */
  function writersAt(planThreadId: string, n: number): Row[] {
    return [...specWriters(planThreadId, n), ...waveWorkers(planThreadId, n).filter((row) => isWriter(row.kind))];
  }

  /** Wave n's newest Spec Writer row of either lane. */
  function latestWriter(planThreadId: string, n: number): Row | undefined {
    return laneRows(planThreadId, n).filter((row) => isWriter(row.kind)).at(-1);
  }

  /** A writer is owed on wave n: a spec wave with no Spec Writer row in any lane, or whose latest one is not ready and not complete. */
  function writerPending(planThreadId: string, waves: PlanWave[], n: number): boolean {
    if (!specWave(waves, n)) return false;
    const latest = latestWriter(planThreadId, n);
    return !latest || !isSettled(latest);
  }

  /** The Spec Writers of one task, the one provenance rule for docs/ commits: the writers in the task's replaces: chain (chainIds, from the
   * review ledger), plus the side-lane writers on the waves of the row's plan chain, in any state. Never a writer of another plan, chain or task. */
  function taskWriters(row: Row, chainIds: string[]): Row[] {
    const planThreadId = row.plan_thread_id;
    const chainWaves = planThreadId && row.plan_wave != null ? chainOf(rawWaves(planThreadId), row.plan_wave) : [];
    const found = [
      ...chainIds.flatMap((id) => rows().get(id) ?? []).filter((other) => isWriter(other.kind)),
      ...(planThreadId ? specWriters(planThreadId).filter((other) => other.plan_wave != null && chainWaves.includes(other.plan_wave)) : []),
    ];
    return [...new Map(found.map((other) => [other.thread_id, other])).values()];
  }

  /** The newest of a chain's rows, a live one before a finished one. */
  const newestLive = (chainRows: Row[]): Row | undefined => {
    const sorted = [...chainRows].sort((a, b) => a.created_at - b.created_at);
    return sorted.filter((row) => !FINISHED.includes(row.state)).at(-1) ?? sorted.at(-1);
  };

  /** The newest implementation-lane row over every wave of wave n's chain, a live row before a finished one: the worker
   * the chain's next wave replaces. waves may be raw (absent cleared): an absent wave has no rows. */
  function chainOwner(planThreadId: string, waves: PlanWave[], n: number): Row | undefined {
    return newestLive(chainOf(waves, n).flatMap((m) => waveWorkers(planThreadId, m)));
  }

  /** The newest row of any lane over wave n's chain: the chain has been started. */
  function chainStarted(planThreadId: string, waves: PlanWave[], n: number): Row | undefined {
    return newestLive(chainOf(waves, n).flatMap((m) => laneRows(planThreadId, m)));
  }

  /** Wave n's chain is spec-bearing: some unbypassed spec wave on it has had a Spec Writer, in any lane. */
  function specChain(planThreadId: string, waves: PlanWave[], n: number): boolean {
    return chainOf(waves, n).some((m) => !!waves[m - 1]?.spec && !waves[m - 1]!.specsSkipped
      && laneRows(planThreadId, m).some((row) => isWriter(row.kind)));
  }

  /** The waves of a plan whose latest implementation row is not ready or complete (or does not exist yet). An idle worker
   * whose latest report was ready counts as ready. A waived test wave is never pending: absent, or done whatever its worker's state. */
  function pendingWaves(planThreadId: string, waves: PlanWave[]): number[] {
    return waves.flatMap((wave, index) => {
      if (wave.testsSkipped) return [];
      const latest = latestWorker(planThreadId, index + 1);
      return latest && isSettled(latest) ? [] : [index + 1];
    });
  }

  /** A planner's chain heads, and those of them still to delegate. One chain: any linked implementation worker counts as
   * delegated, as before parallel waves existed. */
  function undelegatedHeads(planThreadId: string, waves: PlanWave[]) {
    const chainHeads = heads(waves);
    const undelegated = chainHeads.length === 1
      ? (waveWorkers(planThreadId).length ? [] : chainHeads)
      : chainHeads.filter((head) => !waveWorkers(planThreadId, head).length);
    return { heads: chainHeads, undelegated };
  }

  /** The rows one review of this chain tip covers, in wave order: the latest implementation row of every wave,
   * minus design waves and rows already complete (the one passed in always stays), then the latest non-complete side-lane
   * Spec Writer of each spec wave. A replaces: chain's earlier waves are complete, so they drop out; a chain has one branch and PR
   * (only a legacy plan's stacked waves, each with its own PR, are covered wave by wave). A worker with no plan link covers
   * only itself. Assumes reviewRefusal passed. */
  function reviewTargetsFor(worker: Row): Row[] {
    const waves = planWavesFor(worker.plan_thread_id);
    if (!waves.length || worker.plan_wave == null) return [worker];
    const keep = (latest: Row | undefined) => latest && !isDesignWave(latest) && (latest.thread_id === worker.thread_id || latest.state !== "complete") ? [latest] : [];
    return [
      ...waves.flatMap((_, index) => keep(latestWorker(worker.plan_thread_id!, index + 1))),
      ...waves.flatMap((_, index) => keep(latestSideWriter(worker.plan_thread_id!, index + 1))),
    ];
  }

  /** Whether a worker ends its plan (always, unplanned): its wave is a chain tip and every
   * chain's tip has a ready or complete latest worker. */
  function onFinalWave(worker: Row): boolean {
    if (!worker.plan_thread_id) return true;
    if (sideLane(worker)) return false;
    const waves = planWavesFor(worker.plan_thread_id);
    if (worker.plan_wave == null || !waves.length || successorOf(waves, worker.plan_wave) !== null) return false;
    return tips(waves).every((tip) => ["ready", "complete"].includes(latestWorker(worker.plan_thread_id!, tip)?.state ?? ""));
  }

  return { planWavesFor, rawWaves, chainTests, chainWaiver, isDesignWave, isTestWave, laneFor, laneOf, sideLane, coexists, waveWorkers, specWriters, taskWriters, specWave, latestWorker, latestSideWriter, writersAt, latestWriter, writerPending, chainOwner, chainStarted, specChain, pendingWaves, undelegatedHeads, reviewTargetsFor, onFinalWave };
}
