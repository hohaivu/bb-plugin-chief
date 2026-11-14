import { afterEach, describe, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { CLOSE_OUT, chiefReview, delegate, disposeAll, elapse, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  test("creates the native section and files visible, clearly titled worktree threads", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    expect(state.section()?.name).toBe("Chief");
    expect(state.spawned[0]).toMatchObject({ title: "Chief · Asha", sectionId: "sec_chief", visibility: "visible", environment: { type: "project-default" } });
    expect(state.spawned[1]).toMatchObject({
      title: "Fix checkout totals",
      sectionId: "sec_chief",
      parentThreadId: chief.threadId,
      visibility: "visible",
      environment: { type: "host", hostId: "host_1", workspace: { type: "managed-worktree" } },
    });
  });

  test("files planner, worker and reviewer threads as children of their Chief", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: state.live.get(chief.threadId)!.projectId };
    expect((await state.harness.behavior.runCli(
      ["plan", "--title", "Plan checkout", "--mission", "Plan how to correct and verify the checkout totals"], opts,
    )).exitCode).toBe(0);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    expect(state.spawned.slice(1).map((entry: any) => entry.parentThreadId))
      .toEqual([chief.threadId, chief.threadId, chief.threadId]);
  });

  test.each([false, true])("sets lifecycleOwnerThreadId on child spawns only when cascadeArchive is %s", async (cascadeArchive) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true, cascadeArchive });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: state.live.get(chief.threadId)!.projectId };
    expect((await state.harness.behavior.runCli(
      ["plan", "--title", "Plan checkout", "--mission", "Plan how to correct and verify the checkout totals"], opts,
    )).exitCode).toBe(0);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    expect(state.spawned[0].lifecycleOwnerThreadId).toBeUndefined();
    expect(state.spawned.slice(1).map((entry: any) => entry.lifecycleOwnerThreadId))
      .toEqual(Array(3).fill(cascadeArchive ? chief.threadId : undefined));
  });

  test("after a transfer only the current owner sees and controls the work", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Original child worker");
    const ctx = { threadId: chief.threadId, projectId: "proj_1" };

    // Simulate a replacement Chief taking over the worker's chief_thread_id
    state.db.prepare(`UPDATE managed_threads SET chief_thread_id='thr_replacement' WHERE thread_id=?`).run(worker.threadId);

    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(worker.threadId)!, lastAssistantText: "x" });
    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, ctx);
    expect(JSON.stringify(roster)).not.toContain(worker.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, ctx)).rejects.toThrow("for this Chief");
    await expect(state.harness.behavior.callAgentTool("chief_continue", { threadId: worker.threadId, instruction: "Keep working" }, ctx)).rejects.toThrow("for this Chief");
    expect(state.db.prepare(`SELECT chief_thread_id FROM managed_threads WHERE thread_id=?`).get(worker.threadId))
      .toEqual({ chief_thread_id: "thr_replacement" });
  });

  test("auto-resolves and inspects an untracked child thread this plugin spawned outside chief_delegate", async () => {
    const state = await setup();
    const chief = await start(state);

    // Simulate a thread this plugin spawned (pluginMetadata + originPluginId prove it)
    // whose managed_threads row was never inserted, e.g. a restart in the gap.
    const childId = "thr_manual_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "Manual child task",
      sectionId: "sec_chief",
      visibility: "visible",
      status: "idle",
      originPluginId: "chief",
      parentThreadId: chief.threadId,
    }));
    state.seedPluginMetadata(childId, { role: "worker", chiefThreadId: chief.threadId });

    // Chief inspects the child thread directly - it auto-resolves and inspects
    const inspected = await state.harness.behavior.callAgentTool("chief_inspect", { threadId: childId }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(String(inspected)).toContain(childId);

    // Chief can continue it
    await state.harness.behavior.callAgentTool("chief_continue", { threadId: childId, instruction: "Proceed" }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1)).toMatchObject({ threadId: childId, senderThreadId: chief.threadId });
  });

  test("does not adopt a user-created sub-thread under Chief that this plugin never spawned", async () => {
    const state = await setup();
    const chief = await start(state);

    // A thread the user created directly in the BB UI under Chief: live, same
    // project, correct parent — but no pluginMetadata this plugin ever seeded.
    const childId = "thr_user_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "User's own sub-thread",
      sectionId: null,
      visibility: "visible",
      status: "idle",
      originPluginId: null,
      parentThreadId: chief.threadId,
    }));

    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: childId }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow("for this Chief");
    expect(state.db.prepare(`SELECT 1 FROM managed_threads WHERE thread_id=?`).get(childId)).toBeUndefined();
  });

  test("does not adopt a deleted or archived child thread even if this plugin spawned it", async () => {
    const state = await setup();
    const chief = await start(state);

    const childId = "thr_deleted_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "Deleted child",
      sectionId: null,
      visibility: "visible",
      status: "idle",
      originPluginId: "chief",
      parentThreadId: chief.threadId,
      deletedAt: Date.now(),
    }));
    state.seedPluginMetadata(childId, { role: "worker", chiefThreadId: chief.threadId });

    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: childId }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow("for this Chief");
    expect(state.db.prepare(`SELECT 1 FROM managed_threads WHERE thread_id=?`).get(childId)).toBeUndefined();
  });

  test("rejects chief_continue and chief_inspect from a Chief already superseded", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    // Trigger the real supersede path: an archived Chief with an orphaned active
    // worker gets replaced, and spawnChief marks the old Chief row complete.
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(chief.threadId)! });
    await state.supervisorCycle();
    const rows = (await status(state)).threads;
    expect(rows.find((row) => row.threadId === chief.threadId)?.state).toBe("complete");

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "Keep going" }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow();
    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow();
  });

  test("does not let a non-Chief caller insert a row via chief_inspect", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);

    const childId = "thr_worker_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "Child of a worker",
      sectionId: null,
      visibility: "visible",
      status: "idle",
      originPluginId: "chief",
      parentThreadId: worker.threadId,
    }));
    state.seedPluginMetadata(childId, { role: "worker", chiefThreadId: worker.threadId });

    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: childId }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow();
    expect(state.db.prepare(`SELECT 1 FROM managed_threads WHERE thread_id=?`).get(childId)).toBeUndefined();
  });

  test("starts or resolves a project Chief through RPC for frontend launchers", async () => {
    const state = await setup();
    const first = await state.harness.behavior.callRpc("start", { projectId: "proj_2" });
    const second = await state.harness.behavior.callRpc("start", { projectId: "proj_2" });

    expect(first).toEqual({ threadId: "thr_1", created: true });
    expect(second).toEqual({ threadId: "thr_1", created: false });
    expect(state.spawned[0]).toMatchObject({ projectId: "proj_2", title: "Chief · Second" });
  });

  // Contract (work-list spec, Removed): spawning a Chief neither reads nor writes thread tabs.
  test("starting a Chief makes no tabs call", async () => {
    const state = await setup();
    state.seedTabs("thr_1", [{ kind: "git-diff", id: "user_diff" }]);
    await state.harness.behavior.callRpc("start", { projectId: "proj_1" });
    await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.tabsGets()).toBe(0);
    expect(state.tabsUpdates).toEqual([]);
    expect(state.tabs("thr_1")).toEqual([{ kind: "git-diff", id: "user_diff" }]);
  });

  // Contract (work-list spec, Removed): the `pending` RPC and its realtime signal are gone; no store reload, sweep or state change publishes the channel.
  test("the pending RPC is unknown and nothing publishes the pending realtime channel", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await expect(state.harness.behavior.callRpc("pending", { threadId: chief.threadId })).rejects.toThrow();

    const worker = await delegate(state, chief.threadId, "Fix checkout totals"); // store write -> reload
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_roster", { todo: { text: "Follow up" } }, opts);
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(worker.threadId)!, lastAssistantText: "done" }); // sweep
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(worker.threadId)!, lastAssistantText: "boom" });
    await state.supervisorCycle();
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, ...CLOSE_OUT }, opts);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "pending")).toEqual([]);
  });

  // Contract (work-list spec, Added: startup unpin): at plugin start each active Chief loses a stale `pending` plugin-panel tab, and only that tab.
  describe("plugin start unpins the stale pending tab", () => {
    const stale = { kind: "plugin-panel", id: "plugin-panel:chief%3Apending%3A:none", pluginId: "chief", actionId: "pending", title: "Chief to-do", paramsJson: null };
    const userDiff = { kind: "git-diff", id: "user_diff" };
    // Looks like the stale tab but belongs to another plugin, or to another action of this one: both must stay.
    const otherPluginPending = { ...stale, id: "plugin-panel:other%3Apending%3A:none", pluginId: "other" };
    const ownOtherAction = { ...stale, id: "plugin-panel:chief%3Anotes%3A:none", actionId: "notes", title: "Notes" };
    const chiefRow = (db: any, id: string, state: string) => {
      db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, title, state, status, created_at, updated_at) VALUES (?, 'chief', 'proj_1', 'Chief · Asha', ?, 'idle', 1, 1)`).run(id, state);
    };
    const liveChief = (live: Map<string, any>, id: string) => live.set(id, makeThreadResponse({ id, projectId: "proj_1", environmentId: `env_${id}`, title: "Chief · Asha", sectionId: null, visibility: "visible", status: "idle", originPluginId: "chief" }));
    const withChiefs = (tabs: Record<string, any[]>, states: Record<string, string> = { thr_old: "idle" }) => ({ db, live, tabsStore }: any) => {
      for (const [id, state] of Object.entries(states)) { chiefRow(db, id, state); liveChief(live, id); }
      for (const [id, list] of Object.entries(tabs)) tabsStore.set(id, { revision: 7, tabs: list });
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

    test("an active Chief loses exactly that tab; the other tabs keep their order and content", async () => {
      const state = await setup({ seed: withChiefs({ thr_old: [userDiff, stale, otherPluginPending, ownOtherAction] }) });
      await vi.waitFor(() => expect(state.tabs("thr_old")).toEqual([userDiff, otherPluginPending, ownOtherAction]));
      expect(state.tabsUpdates).toEqual([{ threadId: "thr_old", expectedRevision: 7, tabs: [userDiff, otherPluginPending, ownOtherAction] }]);
    });

    test("every active Chief is unpinned; a complete Chief's tabs are left alone", async () => {
      const state = await setup({ seed: withChiefs(
        { thr_old: [stale], thr_idle: [userDiff, stale], thr_done: [stale] },
        { thr_old: "active", thr_idle: "idle", thr_done: "complete" },
      ) });
      await vi.waitFor(() => expect([state.tabs("thr_old"), state.tabs("thr_idle")]).toEqual([[], [userDiff]]));
      expect(state.tabs("thr_done")).toEqual([stale]);
    });

    test("an active Chief without that tab gets no tabs.update", async () => {
      const state = await setup({ seed: withChiefs({ thr_old: [userDiff, otherPluginPending, ownOtherAction] }) });
      await vi.waitFor(() => expect(state.tabsGets()).toBe(1)); // it looked
      await settle();
      expect(state.tabsUpdates).toEqual([]);
      expect(state.tabs("thr_old")).toEqual([userDiff, otherPluginPending, ownOtherAction]);
    });

    test("a revision conflict on the first tabs.update retries once and succeeds", async () => {
      const late = { kind: "git-diff", id: "late_tab" };
      // The user adds a tab between the unpin's read and its write.
      const state = await setup({
        seed: withChiefs({ thr_old: [userDiff, stale] }),
        onTabsGet: ({ threadId, call, tabsStore }) => {
          if (call === 1) tabsStore.set(threadId, { revision: 8, tabs: [userDiff, stale, late] });
        },
      });
      await vi.waitFor(() => expect(state.tabs("thr_old")).toEqual([userDiff, late]));
      expect(state.tabsUpdates.map((update) => update.expectedRevision)).toEqual([7, 8]);
    });

    test("two failures log a warning once; start completes and nothing throws", async () => {
      let warn: any;
      const state = await setup({ failTabsUpdates: 2, seed: (ctx) => { warn = vi.spyOn(ctx.bb.log, "warn"); withChiefs({ thr_old: [userDiff, stale] })(ctx); } });
      await vi.waitFor(() => expect(state.tabsUpdates).toHaveLength(2));
      await settle();
      expect(warn.mock.calls.map(([message]: [string]) => message).filter((message: string) => message.startsWith("Could not unpin the pending tab on thr_old"))).toHaveLength(1);
      expect(state.tabs("thr_old")).toEqual([userDiff, stale]);
      expect((await status(state)).threads.find((row) => row.threadId === "thr_old")).toBeDefined();
    });

    test("plugin start does not wait for the tabs read", async () => {
      // setup() resolves only if plugin start does, and the tabs read never settles.
      const state = await setup({ seed: withChiefs({ thr_old: [stale] }), onTabsGet: () => new Promise<void>(() => {}) });
      await vi.waitFor(() => expect(state.tabsGets()).toBe(1));
      expect(state.tabs("thr_old")).toEqual([stale]);
    });
  });

  test("creates multiple independent Chiefs for one project", async () => {
    const state = await setup();
    const first = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    const second = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });

    expect(first).toEqual({ threadId: "thr_1", created: true });
    expect(second).toEqual({ threadId: "thr_2", created: true });
    expect(state.spawned.map((thread) => thread.title)).toEqual([
      "Chief · Asha",
      "Chief · Asha · 2",
    ]);
    const rows = (await status(state)).threads.filter((thread) => thread.role === "chief");
    expect(rows).toHaveLength(2);
    expect(rows.every((thread) => thread.state !== "complete")).toBe(true);
  });

  test("keeps each same-project Chief's workers and controls independent", async () => {
    const state = await setup();
    const first = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    const second = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    const firstWorker = await delegate(state, first.threadId, "First Chief work");
    const secondWorker = await delegate(state, second.threadId, "Second Chief work");

    const roster = await state.harness.behavior.callAgentTool(
      "chief_roster",
      {},
      { threadId: first.threadId, projectId: "proj_1" },
    );
    expect(JSON.stringify(roster)).toContain(firstWorker.threadId);
    expect(JSON.stringify(roster)).not.toContain(secondWorker.threadId);
    await expect(
      state.harness.behavior.callAgentTool(
        "chief_continue",
        { threadId: secondWorker.threadId, instruction: "Cross-control" },
        { threadId: first.threadId, projectId: "proj_1" },
      ),
    ).rejects.toThrow("for this Chief");
  });

  test("keeps one active Chief per project and scopes each roster", async () => {
    const state = await setup();
    const [first, second] = await Promise.all([start(state, "proj_1"), start(state, "proj_2")]);
    const firstWorker = await delegate(state, first.threadId, "First project task");
    const secondWorker = await delegate(state, second.threadId, "Second project task");
    const all = (await status(state)).threads;
    expect(all.filter((row) => row.role === "chief" && row.state !== "complete")).toHaveLength(2);
    expect(all.find((row) => row.threadId === firstWorker.threadId)?.chiefThreadId).toBe(first.threadId);
    expect(all.find((row) => row.threadId === secondWorker.threadId)?.chiefThreadId).toBe(second.threadId);

    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: first.threadId, projectId: "proj_1" });
    expect(JSON.stringify(roster)).toContain("First project task");
    expect(JSON.stringify(roster)).not.toContain("Second project task");
  });

  test("adopting a replacement Chief preserves other projects and reattaches this project's workers", async () => {
    const state = await setup();
    const first = await start(state, "proj_1");
    const second = await start(state, "proj_2");
    const worker = await delegate(state, first.threadId, "Move with replacement");
    state.addLive("thr_adopted", "proj_1");
    expect((await state.harness.behavior.runCli(["adopt", "--thread", "thr_adopted"])).exitCode).toBe(0);
    const all = (await status(state)).threads;
    expect(all.find((row) => row.threadId === first.threadId)?.state).toBe("complete");
    expect(all.find((row) => row.threadId === second.threadId)?.state).not.toBe("complete");
    expect(all.find((row) => row.threadId === worker.threadId)?.chiefThreadId).toBe("thr_adopted");
  });

  test("reconciles missed live status without false deletion or stale active timing", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)).toMatchObject({ state: "active", status: "active" });
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "pending" });
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)).toMatchObject({ state: "pending", status: "pending" });
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)).toMatchObject({ state: "idle", status: "idle" });
  });

  test("keeps a ready report while the reporting turn is still live, then reviews", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    // chief_report runs inside the worker's own turn, so the live status is
    // still "active" for a while after the row is marked ready.
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    const before = state.db.prepare(`SELECT active_cycle FROM managed_threads WHERE thread_id=?`).get(worker.threadId) as any;
    await state.supervisorCycle();
    const after = state.db.prepare(`SELECT state, active_cycle FROM managed_threads WHERE thread_id=?`).get(worker.threadId) as any;
    expect(after.state).toBe("ready");
    expect(after.active_cycle).toBe(before.active_cycle);

    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    // Idle alone spawns no reviewer; Chief has to call chief_review itself.
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(0);
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
  });

  describe("waits for a just-reported worker to go idle", () => {
    const reviews = (state: Awaited<ReturnType<typeof setup>>) =>
      state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals");
    const reportWhileActive = async (state: Awaited<ReturnType<typeof setup>>) => {
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Totals fixed",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      return { chief, worker };
    };

    test("chief_review waits, then reviews", async () => {
      const state = await setup();
      const { chief, worker } = await reportWhileActive(state);
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const call = state.harness.behavior.callAgentTool(
          "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
        );
        await vi.advanceTimersByTimeAsync(4_000);
        expect(reviews(state)).toHaveLength(0);
        state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
        await vi.advanceTimersByTimeAsync(2_000);
        await call;
        expect(reviews(state)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("chief_review gives up after the wait cap", async () => {
      const state = await setup();
      const { chief, worker } = await reportWhileActive(state);
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const call = state.harness.behavior.callAgentTool(
          "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
        );
        const outcome = expect(call).rejects.toThrow("is active; wait until it is idle before starting a review");
        await vi.advanceTimersByTimeAsync(62_000);
        await outcome;
        expect(reviews(state)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("chief_review does not wait for a worker that has not reported", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        await expect(state.harness.behavior.callAgentTool(
          "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
        )).rejects.toThrow("is active; wait until it is idle before starting a review");
      } finally {
        vi.useRealTimers();
      }
    });

    test("chief_delegate replaces: waits, then hands off", async () => {
      const state = await setup();
      const { chief, worker } = await reportWhileActive(state);
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const call = delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
        await vi.advanceTimersByTimeAsync(4_000);
        state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
        await vi.advanceTimersByTimeAsync(2_000);
        expect((await call).threadId).not.toBe(worker.threadId);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test("keeps blocked while the live status is still stopping", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await state.harness.behavior.callAgentTool("chief_stop", {
      threadId: worker.threadId, reason: "looping on the same failing test",
    }, { threadId: chief.threadId, projectId: "proj_1" });
    // The live thread has not caught up to the stop yet.
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "stopping" });
    await state.supervisorCycle();
    const row = (await status(state)).threads.find((entry) => entry.threadId === worker.threadId)!;
    expect(row.state).toBe("blocked");
  });

  test("suppresses idle behind a queued (undelivered) report", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    const result = await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(result).toContain("Report queued for Chief");
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("is idle"))).toBe(false);
    const pending = state.db.prepare(`SELECT delivered_at FROM alert_outbox WHERE dedupe_key LIKE ?`).get(`${worker.threadId}:report:%`) as any;
    expect(pending).toBeDefined();
    expect(pending.delivered_at).toBeNull();
  });

  test("replaces a terminal Chief and transfers its workers and pending alerts", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for the successor",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(chief.threadId)! });
    elapse(31_000);
    await state.supervisorCycle();
    const rows = (await status(state)).threads;
    const replacement = rows.find((row) => row.role === "chief" && row.threadId !== chief.threadId);
    expect(replacement).toBeDefined();
    expect(rows.find((row) => row.threadId === worker.threadId)?.chiefThreadId).toBe(replacement!.threadId);
    expect(state.sent.at(-1)?.threadId).toBe(replacement!.threadId);
  });

  test("does not resurrect a terminal Chief when there are no active workers or pending alerts", async () => {
    const state = await setup();
    const chief = await start(state);
    expect(state.spawned).toHaveLength(1);
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(chief.threadId)! });
    await state.supervisorCycle();
    const rows = (await status(state)).threads;
    const activeChiefs = rows.filter((row) => row.role === "chief" && row.state !== "archived");
    expect(activeChiefs).toHaveLength(0);
    expect(state.spawned).toHaveLength(1);
  });

  test("does not auto-spawn Chief on startup or settings change by default", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
    expect(state.spawned).toHaveLength(0);
    await state.harness.behavior.setSettings({ chiefProject: "proj_2" });
    expect(state.spawned).toHaveLength(0);
    await state.supervisorCycle();
    expect(state.spawned).toHaveLength(0);
  });

  test("auto-spawns Chief on settings change when autoSpawn is enabled", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ autoSpawn: true });
    expect(state.spawned).toHaveLength(0);
    await state.harness.behavior.setSettings({ autoSpawn: true, chiefProject: "proj_1" });
    // allow async ensureChief triggered by onChange
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.spawned).toHaveLength(1);
    expect(state.spawned[0].title).toContain("Chief · Asha");
  });

  test("retries transient get and filing failures without classifying the thread deleted", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, sectionId: null, visibility: "hidden" });
    state.failNextGet(worker.threadId);
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).not.toBe("deleted");
    state.failNextUpdate(worker.threadId);
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).not.toBe("deleted");
    await state.supervisorCycle();
    expect(state.live.get(worker.threadId)).toMatchObject({ sectionId: "sec_chief", visibility: "visible" });
  });

  test("persists failed notifications and retries them before reporting delivery", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    const result = await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Tests pass and diff is ready",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(result).toContain("Report queued for Chief");
    expect(state.sent).toHaveLength(0);
    elapse(31_000);
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].threadId).toBe(chief.threadId);
    expect(state.sent[0].senderThreadId).toBe(worker.threadId);
  });

  test("stays silent on a plain idle event and alerts Chief once on a failed one", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    // BB's own native parent notice already covers a plain idle thread; the
    // plugin stays silent there. A failure with no transient cause is Chief's to reroute.
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "idle result",
    });
    expect(state.sent).toHaveLength(0);
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });
    await state.harness.behavior.emitThreadEvent("thread.failed", {
      thread: state.live.get(worker.threadId)!,
      error: "boom",
    });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].threadId).toBe(chief.threadId);
    const text = state.sent[0].input[0].text;
    expect(text).toContain(`worker “Fix checkout totals” (${worker.threadId}) failed.`);
    expect(text).toContain("No provider error was recorded.");
    expect(text).toContain("chief_consult");
  });
});
