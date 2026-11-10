import { createReportIntake } from "../../reportIntake";
import { type ManagedRow } from "../types";
import { clip } from "../../text";
import { spawnMetadataSchema } from "../tools/shapes";
import { transientFailure } from "./util";
import type { ThreadInput } from "./artifacts";
import type { Ctx } from "./context";

const RECONCILE_INTERVAL_MS = 30_000;

export function createLifecycle(ctx: Ctx) {
  const { bb, db, ledger, settings, store } = ctx;
  /** The caller's managed row. While insertThread has not run yet, `pending` holds the row recovered from spawn-seeded
   * metadata and nothing is written: the caller persists it with insertThread once it has decided to proceed. */
  async function lookupRow(threadId: string, callerProjectId: string): Promise<{ row?: ManagedRow; pending?: ThreadInput }> {
    const row = store.get(threadId);
    if (row) return { row };
    // configure() already falls back to pluginMetadata seeded at spawn time
    // because insertThread only runs after threads.spawn resolves; a report can
    // land in that same gap for a brand-new thread. Recover the same seed here
    // instead of throwing, so exposing the tool and executing it close together.
    // pluginMetadata is writable by any API client, another plugin, or the
    // thread's own agent, so only trust it once originPluginId proves this
    // thread was actually created by our own spawn call.
    const live = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const seeded = live?.originPluginId === bb.pluginId
      ? spawnMetadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null))
      : undefined;
    if (!seeded?.success) return {};
    return {
      pending: {
        threadId,
        role: seeded.data.role,
        projectId: live?.projectId ?? callerProjectId,
        chiefThreadId: seeded.data.chiefThreadId ?? null,
        title: live?.title ?? live?.titleFallback ?? threadId,
        state: "active",
        status: live?.status ?? "active",
      },
    };
  }

  /** The caller's managed row, persisting a spawn-seeded recovery at once. */
  async function managedRow(threadId: string, callerProjectId: string) {
    const { row, pending } = await lookupRow(threadId, callerProjectId);
    if (pending) {
      if (!store.get(threadId)) store.insert(pending);
      return store.get(threadId);
    }
    return row;
  }

  const intake = createReportIntake({
    db, store, ledger, lookupRow, writePlan: ctx.writePlan, writeArtifact: ctx.writeArtifact, writeAlert: ctx.writeAlert, alertChief: ctx.alertChief, enqueueVerdictComments: ctx.enqueueVerdictComments, enqueueBlockedComment: ctx.enqueueBlockedComment,
    appendPlanLog: ctx.appendPlanLog, recordedCommands: (...a) => ctx.recordedCommands(...a), reportStamp: ctx.reportStamp,
    trackFiles: (row, files) => void ctx.trackerSync.attachFiles(row, files),
    actionLine: (current) => ctx.nextAction(current, true) ?? ctx.waveWaitLine(current)
      ?? (current.role === "researcher" ? "Research is advisory: use its findings, check anything doubtful against the code, and note any failures or timeout it reports. Nothing to review or complete." : null)
      ?? "Inspect live evidence with chief_inspect and choose: continue, review, complete, or escalate to the user.",
    warn: (message) => bb.log.warn(message),
  });

  function stateFromLive(row: ManagedRow, status: string) {
    // Complete is Chief's decision, not a live status: nothing the thread does later reopens it.
    if (row.state === "complete") return "complete";
    if (status === "error") return "failed";
    if (["ready", "blocked", "complete"].includes(row.state)) return row.state;
    if (["active", "starting", "pending", "stopping"].includes(status)) return status;
    return "idle";
  }

  async function reconcileThread(row: ManagedRow, sectionId: string) {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: row.thread_id });
    } catch (error) {
      bb.log.warn(`Transient thread read failure for ${row.thread_id}; will retry: ${String(error)}`);
      return false;
    }
    const now = Date.now();
    if (thread.deletedAt !== null) {
      store.markDeleted(row.thread_id, now);
      return true;
    }
    if (thread.archivedAt !== null) {
      if (row.state === "archived") return true;
      store.markArchived(row.thread_id, thread.status, now);
      return true;
    }
    if (thread.sectionId !== sectionId || thread.visibility !== "visible") {
      try {
        await bb.sdk.threads.update({ threadId: row.thread_id, sectionId, visibility: "visible" });
      } catch (error) {
        bb.log.warn(`Transient thread filing failure for ${row.thread_id}; will retry: ${String(error)}`);
      }
    }
    // The reads above may have spanned a report or lifecycle event: decide from the row as it is now (#127), never the one captured before them.
    const current = store.get(row.thread_id);
    if (!current) return true;
    row = current;
    const parentChanged = !!thread.parentThreadId && row.parent_thread_id !== thread.parentThreadId;
    const nextState = stateFromLive(row, thread.status) as ManagedRow["state"];
    // Unchanged: skip the write and the reload, which recomputes every Chief's checklist.
    if (!parentChanged && nextState === row.state && thread.status === row.status && (nextState !== "active" || row.active_since !== null)) return true;
    const enteringActive = nextState === "active" && row.state !== "active";
    // One reload covers the parent write and the state write.
    store.batch(() => {
      if (parentChanged) store.setParent(row.thread_id, thread.parentThreadId!, now);
      store.syncLive({
        threadId: row.thread_id, state: nextState, status: thread.status,
        activeSince: nextState === "active" ? (row.state === "active" ? row.active_since ?? now : now) : null,
        enteringActive, now,
      });
    });
    return true;
  }

  async function reconcile() {
    const sectionId = await ctx.ensureSection();
    // A complete or deleted row never changes state again (stateFromLive), so only open rows cost a read.
    for (const row of store.all()) {
      if (row.state !== "deleted" && row.state !== "complete") await reconcileThread(row, sectionId);
    }
    const projects = new Set(store.all().map((row) => row.project_id));
    const configured = (await settings.get()).chiefProject;
    if (configured) projects.add(configured);
    for (const projectId of projects) await ctx.readRules(projectId);
  }

  async function lifecycle(kind: string, thread: { id: string; status?: string }) {
    // Before the early returns: the blocker may be unmanaged, hidden, or already complete.
    if ((kind === "idle" || kind === "failed") && ctx.state.pendingReady) void ctx.sweep();
    const row = store.get(thread.id);
    if (!row) return;
    // Complete is final: an archive (often Chief's own auto-archive) keeps the row complete, so a
    // planner waiting on its final-wave worker still sees it complete; only a delete moves it.
    if (row.state === "complete" && kind !== "deleted") return;
    const now = Date.now();
    if (row.role === "chief") {
      const state = kind === "active" ? "active"
        : kind === "idle" ? "idle"
          : kind === "failed" ? "failed"
            : kind === "archived" ? "archived" : "deleted";
      store.recordState(thread.id, state, thread.status ?? state, now);
      if (state === "idle") ctx.alertCoordinator(store.get(thread.id)!, { kind: "done" });
      return;
    }
    if (kind === "active") {
      const enteringActive = row.state !== "active";
      store.markActive(thread.id, thread.status ?? "active", enteringActive ? now : row.active_since ?? now, enteringActive, now);
      return;
    }
    const observed = kind === "idle" ? "idle" : kind === "failed" ? "failed" : kind === "archived" ? "archived" : "deleted";
    const state = observed === "idle" && ["ready", "blocked", "complete"].includes(row.state) ? row.state : observed;
    store.recordState(thread.id, state, thread.status ?? observed, now);
    if (kind !== "failed" || !row.chief_thread_id) return;
    const failure = await ctx.lastProviderError(thread.id);
    const transient = failure && transientFailure(failure.text);
    if (!failure || !transient) {
      // ponytail: a repeated failed event while already failed is the same failure, not a second one.
      if (row.state !== "failed") {
        store.countError(thread.id);
      }
      // `error:` never `failed:`, so the legacy backfill never copies a non-transient failure; the outbox dedupes per cycle.
      await ctx.alertChief(row, `error:${row.active_cycle}`, [
        `${row.role} “${row.title}” (${row.thread_id}) failed.`,
        ...(failure ? [`Provider error: ${clip(failure.text, 400)}`] : ["No provider error was recorded."]),
        ctx.rerouteSteps(row),
      ].join("\n"));
      return;
    }
    const { usageLimit, resetSeconds } = transient;
    const unrecorded = ctx.recordFailure(row, "provider", usageLimit ? "usage_limit" : "connection");
    const cooling = usageLimit ? await ctx.noteCooldown(thread.id, failure) : null;
    const resetAt = resetSeconds === null ? null : failure.at + resetSeconds * 1000;
    const minutes = resetAt === null ? null : Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000) + 1);
    const backoff = minutes !== null ? `${minutes}m` : usageLimit ? "15m" : "2m";
    await ctx.alertChief(row, `failed:${row.active_cycle}`, [
      `${row.role} “${row.title}” (${row.thread_id}) failed on a transient provider error: ${usageLimit ? "provider usage limit (HTTP 429)" : "connection/provider error"}.`,
      `Provider error: ${clip(failure.text, 400)}`,
      ...(!usageLimit ? [] : resetAt !== null
        ? [`Usage limit resets at ${new Date(resetAt).toISOString()} (about ${minutes} min from now).`]
        : ["The error does not say when the usage limit resets."]),
      ...(cooling ? [`New chief_delegate/chief_review/chief_plan/chief_consult/chief_research work on ${cooling.providerId}/${cooling.model} is refused until ${new Date(cooling.until).toISOString()}; other models on ${cooling.providerId} stay usable.`] : []),
      `Do not spawn a replacement: a fresh thread on the same provider and model hits the same error. Retry this same thread with: bb thread retry ${row.thread_id} --send-at ${backoff} --reason "${usageLimit ? "usage limit reset" : "transient provider error"}"`,
      "If the retry fails the same way again, escalate to the user (wait for the limit or switch provider/model) instead of retrying again.",
      ...(unrecorded ? [unrecorded] : []),
    ].join("\n"));
  }
  return { intake, lifecycle, managedRow, reconcile, reconcileThread };
}

export function registerLifecycle(ctx: Ctx) {
  const { bb, settings, store } = ctx;
  bb.events.on("thread.active", ({ thread }) => ctx.lifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread }) => ctx.lifecycle("idle", thread));
  bb.events.on("thread.failed", ({ thread }) => ctx.lifecycle("failed", thread));
  bb.events.on("thread.archived", ({ thread }) => ctx.lifecycle("archived", thread));
  bb.events.on("thread.deleted", ({ thread }) => ctx.lifecycle("deleted", thread));

  bb.background.service("supervisor", {
    async start(signal) {
      const wake = () => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, RECONCILE_INTERVAL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      while (!signal.aborted) {
        try {
          await ctx.reconcile();
          await ctx.sweep(); // safety net for idle events missed across a reload, or a blocker archived without idling
          await ctx.checkUnreported(store.all());
          const values = await settings.get();
          ctx.state.cleanupActive = values.cleanupApproved;
          const parsed = Number(values.stallMinutes);
          const threshold = (Number.isFinite(parsed) && parsed > 0 ? parsed : 15) * 60_000;
          const now = Date.now();
          for (const row of store.all()) {
            if (row.role === "chief" || row.state !== "active" || row.active_since === null) continue;
            const elapsed = now - row.active_since;
            if (elapsed < threshold) continue;
            const hard = elapsed >= 2 * threshold;
            if ((hard ? row.stop_alerted_cycle : row.stall_alerted_cycle) === row.active_cycle) continue;
            // Every tick until sent re-enters here; the primary key keeps one row.
            const unrecorded = ctx.recordFailure(row, hard ? "hard_stall" : "stall", null);
            const output = await ctx.lastOutput(row.thread_id);
            const minutes = Math.round(threshold / 60_000);
            const sent = await ctx.alertChief(row, `stall:${row.active_cycle}${hard ? ":hard" : ""}`, [
              `${row.role} “${row.title}” (${row.thread_id}) has been active for ${Math.round(elapsed / 60_000)} minutes${hard ? `, twice the ${minutes}-minute stall threshold` : ` (stall threshold ${minutes})`}.`,
              `Last output: ${output ? clip(output, 400) : "(none available)"}`,
              hard
                ? "Stop it now with chief_stop unless that output shows it finishing. Its worktree and branch are kept."
                : `Inspect it with chief_inspect. If it is progressing, leave it. If it is stuck or looping, chief_stop it: its worktree and branch are kept. At ${2 * minutes} minutes you will be told to stop it.`,
              ctx.rerouteSteps(row),
              ...(unrecorded ? [unrecorded] : []),
            ].join("\n"));
            if (sent) {
              store.markStallAlerted(row.thread_id, row.active_cycle, hard ? row.active_cycle : row.stop_alerted_cycle);
            }
          }
          // Hand an archived or deleted Chief's open work to the project's live Chief, starting
          // one if none is left. A failed Chief is not replaced: a failed turn is recoverable
          // (touchCallerChief), and its next event returns it to idle or active. Alerts from
          // open work follow the work; an alert whose source is already finished is not worth
          // a new Chief the user just deleted.
          const orphanedChiefs = store.all().filter((row) =>
            row.role === "chief" && (row.state === "archived" || row.state === "deleted")
            && store.all().some((child) => child.chief_thread_id === row.thread_id && !["failed", "deleted", "archived", "complete"].includes(child.state)));
          for (const orphaned of orphanedChiefs) {
            const next = await ctx.ensureChief(orphaned.project_id);
            if (next.threadId !== orphaned.thread_id) ctx.handOver(orphaned.thread_id, next.threadId, orphaned.project_id);
          }
          if (values.autoSpawn && values.chiefProject) await ctx.ensureChief(values.chiefProject);
          // Replace terminal Chiefs and retarget their queued alerts before any
          // pending delivery is attempted.
          await ctx.retryAlerts();
          await ctx.observeCleanup();
          void ctx.forgeComments.drain();
          void ctx.trackerSync.sync();
        } catch (error) {
          bb.log.warn(`Supervisor reconciliation failed: ${String(error)}`);
        }
        await wake();
      }
    },
  });

  settings.onChange((next, previous) => {
    if (next.autoSpawn && next.chiefProject && next.chiefProject !== previous.chiefProject) {
      void ctx.ensureChief(next.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
    }
    ctx.state.plannerActive = next.plannerEnabled;
    ctx.state.cleanupActive = next.cleanupApproved;
    ctx.state.researchActive = ctx.researchFrom(next);
  });}

