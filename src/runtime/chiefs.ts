import { createManagedSpawn } from "../research/managedSpawn";
import { type ManagedRow } from "../types";
import type { Ctx } from "./context";

interface ChiefHandoff { fromChiefThreadId: string; title: string; request: string; context: string; /** Set when a Coordinator hands the task off: the new Chief becomes its child. */ coordinatorThreadId?: string }

export function createChiefs(ctx: Ctx) {
  const { bb, chiefCountForProject, db, latestChiefForProject, settings, store } = ctx;
  // Not on managedSpawn: it picks the model after building its prompt, skips the cooldown check, hands over between spawn and insert, and has no parent or brief file.
  // `stopped` is the abandoned supervisor tick's check: no call starts once it reads true. A spawn already dispatched is still recorded, or the next tick would spawn a second Chief.
  async function spawnChief(target: string, previous?: ManagedRow, handoff?: ChiefHandoff, stopped?: () => boolean) {
    const abandoned = () => { if (stopped?.()) throw new Error("abandoned"); };
    abandoned();
    const sectionId = await ctx.ensureSection(stopped);
    abandoned();
    const name = await ctx.projectName(target);
    abandoned();
    // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
    // the rules into every Chief turn, so the spawn prompt does not repeat them.
    await ctx.readRules(target, stopped);
    abandoned();
    const count = (chiefCountForProject.get(target) as { count: number }).count;
    const title = handoff ? `Chief · ${name} · ${handoff.title}` : count === 0 ? `Chief · ${name}` : `Chief · ${name} · ${count + 1}`;
    const prompt = [
      `You are Chief for ${name}. You supervise the ordinary BB threads in the Chief sidebar section.`,
      "",
      "You own the forge for every delegation: run chief_forge_init (planned work only on a plan chain's head wave, since a chain has one branch and one pull request; unplanned work: pass the mission, successCriteria and constraints you will give chief_delegate, since the pull request body is the reviewer's brief), and pass the branch, issueUrl and prUrl it returns to chief_delegate. If it returns a script instead, run it from the project checkout and use the CHIEF_FORGE line it prints. The Git workflow section of the Chief procedure in your instructions has the rest.",
      "Lifecycle alerts are prompts to decide: continue, review, complete, or escalate.",
      "",
      "Call chief_roster for the current work list, then wait for work.",
      ...(handoff ? ["", handoffSection(handoff)] : []),
    ].join("\n");
    // The new Chief runs in the spawning thread's permission mode; unknown (no caller, lookup fails) keeps the project default.
    const permissionMode = handoff
      ? (await bb.sdk.threads.defaultExecutionOptions({ threadId: handoff.fromChiefThreadId }).catch(() => null))?.permissionMode
      : undefined;
    abandoned();
    const hostId = await ctx.projectHostId(target);
    abandoned();
    const execution = await ctx.execution("chief", hostId);
    abandoned();
    const thread = await bb.sdk.threads.spawn({
      projectId: target,
      environment: { type: "project-default" },
      sectionId,
      visibility: "visible",
      title,
      ...execution,
      ...(permissionMode ? { permissionMode } : {}),
      prompt,
      pluginMetadata: { role: "chief" },
    });
    if (previous && previous.thread_id !== thread.id) handOver(previous.thread_id, thread.id, target);
    store.insert({
      threadId: thread.id, role: "chief", projectId: target, title, state: "starting", status: thread.status,
      coordinatorThreadId: handoff?.coordinatorThreadId ?? (previous ? ctx.liveCoordinatorId(previous) : undefined),
    });
    return { threadId: thread.id, created: true as const };
  }

  /** The handed-off task as a new Chief reads it: its first message ends with this text, and brief.md holds the same text. */
  function handoffSection(handoff: ChiefHandoff) {
    return [
      "## Handed-off task",
      handoff.coordinatorThreadId
        ? `Handed off by Coordinator ${handoff.fromChiefThreadId}. It supervises you as a child Chief and sees you in its Children block. It gets an alert when you call chief_escalate, finish all your work, fail, end, or stall (a turn that runs too long, or idle with open work). Answer each message it sends you by running \`bb thread tell ${handoff.fromChiefThreadId}\` with your answer, not only in this thread. The owner answers each Need you in this thread or in the Coordinator's thread; an answer given there reaches you as a \`bb thread tell\` from the Coordinator that starts with \`Owner's decision (relayed by Coordinator):\`; act on it as the owner's decision.`
        : `Handed off by Chief ${handoff.fromChiefThreadId}. It keeps no link to you: it will not see your roster or alerts, and you do not report to it.`,
      "",
      "### Owner's request (verbatim)",
      handoff.request,
      "",
      "### Context",
      handoff.context,
      "",
      "Own this task through completion under your normal rules. Start with chief_roster. Plan it with your own chief_plan when planning applies; the handing-off Chief's planners, workers and reviewers stay with it, so their plan, report and verdict files are evidence only. Then forge, delegate, review and complete. The handoff is evidence, not proof. This handoff is saved at $BB_THREAD_STORAGE/brief.md; re-read it after any context compaction.",
    ].join("\n");
  }

  /** Supersedes a Chief: marks it complete and moves its open work, todos and undelivered alerts to its successor. */
  function handOver(previousId: string, nextId: string, projectId: string) {
    if (ctx.isCoordinator(store.get(previousId)) || ctx.isCoordinator(store.get(nextId))) throw new Error("A Coordinator owns no managed work: it cannot hand work over or take it.");
    if (!ctx.compatibleSuccessor(store.get(previousId), store.get(nextId))) throw new Error(`Chief ${nextId} belongs to another Coordinator: work from ${previousId} cannot move to it.`);
    const now = Date.now();
    store.batch(() => {
      store.completeChief(previousId, now);
      store.inheritCoordinator(previousId, nextId, now);
      store.moveOpenWork(nextId, now, projectId, previousId);
      db.prepare(`UPDATE alert_outbox SET target_thread_id=?
        WHERE target_thread_id=? AND delivered_at IS NULL`).run(nextId, previousId);
      db.prepare(`UPDATE chief_todos SET chief_thread_id=? WHERE chief_thread_id=?`).run(nextId, previousId);
    });
    // Best effort and async (never rejects); the successor's row may not exist yet, so the project comes from the caller.
    void ctx.copyDecisions(previousId, nextId, projectId);
  }

  /** Best-effort: drops the pending panel tab an earlier version pinned on a Chief thread. Never throws. */
  async function unpinPendingTab(threadId: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { revision, tabs } = await bb.sdk.threads.tabs.get({ threadId });
        const kept = tabs.filter((tab) => !(tab.kind === "plugin-panel" && tab.pluginId === bb.pluginId && tab.actionId === "pending"));
        if (kept.length === tabs.length) return;
        await bb.sdk.threads.tabs.update({ threadId, expectedRevision: revision, tabs: kept });
        return;
      } catch (error) {
        // ponytail: retries any error once, not only revision conflicts
        if (attempt === 1) bb.log.warn(`Could not unpin the pending tab on ${threadId}: ${String(error)}`);
      }
    }
  }

  async function createChief(projectId: string, handoff?: ChiefHandoff) {
    return spawnChief(projectId, undefined, handoff);
  }
  /** A dedicated successor for an orphan whose project Chief belongs to another Coordinator: it hands over from the orphan and inherits its live link. */
  function replaceChief(orphaned: ManagedRow, stopped?: () => boolean) {
    return spawnChief(orphaned.project_id, orphaned, undefined, stopped);
  }
  async function ensureChief(projectId?: string, stopped?: () => boolean): Promise<{ threadId: string; created: boolean }> {
    if (stopped?.()) throw new Error("abandoned");
    const values = await settings.get();
    if (stopped?.()) throw new Error("abandoned");
    const target = projectId ?? values.chiefProject;
    if (!target) throw new Error("Configure a default Chief project first: bb plugin config chief set chiefProject <proj-id>");
    const inFlight = ctx.state.chiefStarts.get(target);
    if (inFlight) {
      try { return await inFlight; }
      catch (error) {
        // A flight the abandoned tick owned is not this caller's: run its own, unless it is stopped too.
        if (!(error instanceof Error && error.message === "abandoned") || stopped?.()) throw error;
        if (ctx.state.chiefStarts.get(target) === inFlight) ctx.state.chiefStarts.delete(target);
        return ensureChief(projectId, stopped);
      }
    }
    const start = (async () => {
      const existing = ctx.chiefForProject(target);
      if (existing) {
        await ctx.reconcileThread(existing, await ctx.ensureSection(stopped), stopped);
        if (stopped?.()) throw new Error("abandoned");
        const reconciled = store.get(existing.thread_id);
        if (reconciled && !["failed", "deleted", "archived", "complete"].includes(reconciled.state)) {
          return { threadId: existing.thread_id, created: false };
        }
      }
      const previous = latestChiefForProject.get(target) as ManagedRow | undefined;
      return spawnChief(target, previous, undefined, stopped);
    })();
    ctx.state.chiefStarts.set(target, start);
    try {
      return await start;
    } finally {
      ctx.state.chiefStarts.delete(target);
    }
  }

  const managedSpawn = createManagedSpawn({ bb, db, spawnExecution: ctx.spawnExecution, ensureSection: ctx.ensureSection, readRules: ctx.readRules, lifecycleOwner: ctx.lifecycleOwner, insertThread: store.insert, persistBrief: (...a) => ctx.persistBrief(...a) });
  return { createChief, ensureChief, replaceChief, handOver, handoffSection, managedSpawn, unpinPendingTab };
}

