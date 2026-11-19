import { type ManagedRow, type ManagedThread, terminal } from "../types";
import { BUSY_STATUSES } from "./constants";
import type { Ctx } from "./context";

export function createSweep(ctx: Ctx) {
  const { bb, ledger, progress, store } = ctx;
  /** A supporting row whose work was absorbed: a reviewer or advisor of a complete worker,
   * a researcher that reported ready (its report alert carries the result), or a planner once
   * every branch's final wave is complete and every linked worker is terminal. */
  function absorbed(row: ManagedRow) {
    if (terminal(row.state) || BUSY_STATUSES.has(row.state)) return false;
    if (row.role === "researcher") return row.state === "ready";
    if (row.role === "reviewer") {
      const covered = ledger.targets(row.thread_id);
      return covered.length > 0 && covered.every((target) => store.get(target.worker_thread_id)?.state === "complete");
    }
    if (row.role === "advisor") {
      if (row.plan_thread_id) return store.get(row.plan_thread_id)?.state === "complete";
      return !!row.worker_thread_id && store.get(row.worker_thread_id)?.state === "complete";
    }
    if (row.role !== "planner" || !row.plan_waves) return false;
    return progress.plannerAbsorbed(row);
  }
  /** Completes absorbed rows, each only after a fresh threads.get shows it live and not busy.
   * A failed or busy read leaves the row alone (fail closed); a later reload retries. */
  async function completeAbsorbed(signal?: AbortSignal) {
    let completed = 0;
    for (const id of store.all().filter(absorbed).map((row) => row.thread_id)) {
      if (signal?.aborted) break;
      const live = await bb.sdk.threads.get({ threadId: id }).catch(() => null);
      if (signal?.aborted) break;
      if (!live || BUSY_STATUSES.has(live.status) || live.deletedAt !== null || live.archivedAt !== null) continue;
      const row = store.get(id);
      if (!row || !absorbed(row)) continue; // changed while the read was in flight
      store.completeAbsorbed(id, live.status); // refreshes without the sweep: this runs inside it
      completed += 1;
    }
    return completed;
  }
  /** Single-flight: a request during a flight queues exactly one more pass instead of a racing one, and each pass has its own owner.
   * `signal` is an abandoned supervisor tick's: a pass only it asked for reads, writes and alerts no more once it aborts.
   * A request without a signal is independent: its pass runs unsignalled, whoever else is queued with it. */
  function sweep(signal?: AbortSignal) {
    // An abandoned tick's pass would do nothing: starting one would clear `sweeping` before this call stores the flight, and strand every later request.
    if (signal?.aborted) return ctx.state.sweeping ?? Promise.resolve();
    if (ctx.state.sweeping) {
      const queued = ctx.state.sweepAgain ??= { independent: false };
      if (signal) queued.signal = signal; else queued.independent = true;
      return ctx.state.sweeping;
    }
    ctx.state.sweeping = (async () => {
      // Taking the queue in the same microtask as the loop check means no queued pass is lost in between.
      try {
        let owner = signal;
        for (;;) {
          if (!owner?.aborted) {
            await completeAbsorbed(owner);
            if (!owner?.aborted) for (const row of store.all()) ctx.alertCoordinator(row, { kind: "state" }, owner);
          }
          const queued = ctx.state.sweepAgain;
          ctx.state.sweepAgain = null;
          owner = queued && !queued.independent ? queued.signal : undefined;
          if (!queued) break;
        }
      } catch (error) {
        bb.log.warn(`Absorbed-thread sweep failed: ${String(error)}`);
      } finally {
        ctx.state.sweeping = null;
      }
    })();
    return ctx.state.sweeping;
  }
  function toManaged(row: ManagedRow): ManagedThread {
    return {
      threadId: row.thread_id,
      role: row.role,
      projectId: row.project_id,
      chiefThreadId: row.chief_thread_id,
      workerThreadId: row.worker_thread_id,
      title: row.title,
      state: row.state,
      status: row.status,
      result: row.result,
      blocker: row.blocker,
      recommendation: row.recommendation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  return { sweep, toManaged };
}

