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
  async function completeAbsorbed() {
    let completed = 0;
    for (const id of store.all().filter(absorbed).map((row) => row.thread_id)) {
      const live = await bb.sdk.threads.get({ threadId: id }).catch(() => null);
      if (!live || BUSY_STATUSES.has(live.status) || live.deletedAt !== null || live.archivedAt !== null) continue;
      const row = store.get(id);
      if (!row || !absorbed(row)) continue; // changed while the read was in flight
      store.completeAbsorbed(id, live.status); // refreshes without the sweep: this runs inside it
      completed += 1;
    }
    return completed;
  }
  /** Single-flight: a reload during a sweep queues exactly one more pass instead of a racing one.
   */
  function sweep() {
    if (ctx.state.sweeping) { ctx.state.sweepAgain = true; return ctx.state.sweeping; }
    ctx.state.sweeping = (async () => {
      do {
        ctx.state.sweepAgain = false;
        await completeAbsorbed();
        for (const row of store.all()) ctx.alertCoordinator(row, { kind: "state" });
      } while (ctx.state.sweepAgain);
    })().catch((error) => bb.log.warn(`Absorbed-thread sweep failed: ${String(error)}`)).finally(() => { ctx.state.sweeping = null; });
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

