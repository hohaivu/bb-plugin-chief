import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import { delegate, disposals, disposeAll, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  test.each(["planner", "advisor"])("upgrading an existing database keeps its rows and admits the %s role", async (role) => {
    // The rebuild that widens the role CHECK drops live tables, so the upgrade
    // path is driven here against a real database rather than only a fresh one.
    const { bb, harness } = createFakePluginHost({ pluginId: `chief-upgrade-${role}` });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes(`'${role}'`))));

    if (role === "advisor") {
      // reject_streak and parent_thread_id are pre-existing columns by this point
      // in the migration chain; the rebuild must carry their nondefault values over.
      db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at, reject_streak, parent_thread_id)
        VALUES ('thr_old', 'worker', 'proj_1', 'thr_chief', 'Existing work', 'ready', 1, 2, 2, 'thr_parent')`).run();
    } else {
      db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at)
        VALUES ('thr_old', 'worker', 'proj_1', 'thr_chief', 'Existing work', 'ready', 1, 2)`).run();
    }
    db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES ('host_1', 'senior', 'codex', 'gpt-6-astra', 'high', 3)`).run();

    bb.storage.migrate(db, MIGRATIONS);

    if (role === "advisor") {
      expect(db.prepare(`SELECT title, state, reject_streak, parent_thread_id FROM managed_threads WHERE thread_id='thr_old'`).get())
        .toEqual({ title: "Existing work", state: "ready", reject_streak: 2, parent_thread_id: "thr_parent" });
    } else {
      expect(db.prepare(`SELECT title, state, chief_thread_id FROM managed_threads WHERE thread_id='thr_old'`).get())
        .toEqual({ title: "Existing work", state: "ready", chief_thread_id: "thr_chief" });
    }
    expect(db.prepare(`SELECT model, reasoning_level FROM chief_models WHERE host_id='host_1' AND role='worker'`).get())
      .toEqual({ model: "gpt-6-astra", reasoning_level: "high" });
    // Widening that CHECK is the whole point of the rebuild.
    expect(() => db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, title, state, created_at, updated_at)
      VALUES ('thr_new', ?, 'proj_1', 'New role', 'idle', 4, 4)`).run(role)).not.toThrow();
    expect(() => db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES ('host_1', ?, 'codex', 'gpt-6-astra', 'high', 5)`).run(role)).not.toThrow();
    // Dropping the table dropped its index; the roster scan needs it back.
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='managed_threads_chief'`).get())
      .toBeTruthy();
  });

  test("adds reject_streak to an existing database and survives a restart", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-reject-streak" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    const beforeRejectStreak = MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("reject_streak")));
    bb.storage.migrate(db, beforeRejectStreak);

    db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at)
      VALUES ('thr_old', 'reviewer', 'proj_1', 'thr_chief', 'Existing review', 'ready', 1, 2)`).run();

    bb.storage.migrate(db, MIGRATIONS);

    expect(db.prepare(`SELECT title, reject_streak FROM managed_threads WHERE thread_id='thr_old'`).get())
      .toEqual({ title: "Existing review", reject_streak: 0 });
    expect(() => db.prepare(`UPDATE managed_threads SET reject_streak=reject_streak+1 WHERE thread_id='thr_old'`).run()).not.toThrow();
    // A restart re-runs the full, now-longer migration list against an already-upgraded database.
    expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();
  });

  test("drops the retired Jev tables and forgets its verified key on an existing database", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-drop-jev" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    const beforeDrop = MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("reject_streak")) + 1);
    bb.storage.migrate(db, beforeDrop);

    db.prepare(`INSERT INTO jev_scores (worker_thread_id, base_branch, evaluation, updated_at)
      VALUES ('thr_worker', 'main', '{}', 1)`).run();
    db.prepare(`INSERT INTO jev_metric_stats (metric, samples, abstained, score_sum, updated_at)
      VALUES ('correctness', 1, 0, 8, 1)`).run();
    db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('jev_verified', 'fingerprint')`).run();

    expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();

    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='jev_scores'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='jev_metric_stats'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT value FROM plugin_meta WHERE key='jev_verified'`).get()).toBeUndefined();
  });

  test("stops the supervisor service cleanly on abort", async () => {
    const state = await setup();
    const service = state.harness.behavior.runService("supervisor");
    service.controller.abort();
    await expect(service.done).resolves.toBeUndefined();
  });

  test("alerts a stalled thread once with evidence and a ladder, then once to stop it at twice the threshold", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });

      nowSpy.mockReturnValue(t0 + 61_000);
      await state.supervisorCycle();
      const afterSoft = state.sent.length;
      const softAlert = state.sent.at(-1).input[0].text;
      expect(softAlert).toContain("has been active for 1 minutes");
      expect(softAlert).toContain(`last output from ${worker.threadId}`);
      expect(softAlert).toContain("chief_stop");
      expect(softAlert).toContain(`chief_delegate (replaces: ${worker.threadId})`);
      expect(softAlert).toContain(`chief_consult (workerThreadId: ${worker.threadId})`);

      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterSoft);

      nowSpy.mockReturnValue(t0 + 121_000);
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterSoft + 1);
      const hardAlert = state.sent.at(-1).input[0].text;
      expect(hardAlert).toContain("twice the 1-minute stall threshold");
      expect(hardAlert).toContain("Stop it now with chief_stop");

      const afterHard = state.sent.length;
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterHard);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a supervisor that first sees a thread past twice the threshold sends only the stop alert", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });

      nowSpy.mockReturnValue(t0 + 121_000);
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(1);
      expect(state.sent.at(-1).input[0].text).toContain("Stop it now with chief_stop");

      await state.supervisorCycle();
      expect(state.sent).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a continued thread earns fresh stall alerts in its new active cycle", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });

      nowSpy.mockReturnValue(t0 + 121_000);
      await state.supervisorCycle();
      expect(state.sent.at(-1).input[0].text).toContain("Stop it now with chief_stop");

      const continueTime = t0 + 121_000;
      nowSpy.mockReturnValue(continueTime);
      const continued = await state.harness.behavior.runCli(["continue", worker.threadId, "--instruction", "Try again"]);
      expect(continued.exitCode).toBe(0);
      const afterContinue = state.sent.length;

      nowSpy.mockReturnValue(continueTime + 61_000);
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterContinue + 1);
      expect(state.sent.at(-1).input[0].text).toContain("has been active for 1 minutes");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a reviewer's stall ladder points at a fresh review, not a replacement worker", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;

    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(reviewer.threadId, { ...state.live.get(reviewer.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

      nowSpy.mockReturnValue(t0 + 61_000);
      await state.supervisorCycle();
      const alert = state.sent.at(-1).input[0].text;
      expect(alert).toContain(`chief_review (workerThreadId: ${worker.threadId})`);
      expect(alert).not.toContain("chief_delegate");
    } finally {
      nowSpy.mockRestore();
    }
  });
});
