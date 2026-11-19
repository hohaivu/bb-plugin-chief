import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "../src/db/migrations";
import { delegate, disposals, disposeAll, setup, start, status } from "./harness";
import { forgeAnswers, forged } from "./gateForge";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";
import { STOP_GRACE_MS } from "../src/runtime/lifecycle";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
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

  test("an abandoned supervisor tick starts no further rule read after its in-flight read settles", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    // A second project, so a read remains after the first one.
    await state.harness.behavior.setSettings({ chiefProject: "proj_second" });
    let reads = 0;
    let release!: () => void;
    let reached!: () => void;
    const first = new Promise<void>((resolve) => { reached = resolve; });
    state.harness.sdk.stub("projects.fileContent", async () => {
      reads += 1;
      if (reads > 1) throw new Error("no rules file");
      reached();
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("no rules file");
    });
    const service = state.harness.behavior.runService("supervisor");
    await first;
    const aborted = Date.now();
    service.controller.abort();
    await service.done;
    const settledIn = Date.now() - aborted;
    expect(settledIn).toBeGreaterThanOrEqual(STOP_GRACE_MS - 50);
    expect(settledIn).toBeLessThan(5_000);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(1);
  }, STOP_GRACE_MS + 5_000);

  test("an abandoned supervisor tick drops its hung alert send and starts no other; the next supervisor delivers the skipped row", async () => {
    const state = await setup();
    const chief = await start(state);
    const insert = state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts) VALUES (?, ?, ?, ?, ?, 0)");
    insert.run("test:hung", chief.threadId, chief.threadId, "hung alert", Date.now() - 120_000);
    insert.run("test:skipped", chief.threadId, chief.threadId, "skipped alert", Date.now() - 120_000);
    const texts: string[] = [];
    let reached!: () => void;
    const first = new Promise<void>((resolve) => { reached = resolve; });
    state.harness.sdk.stub("threads.send", async (args: any) => {
      const text = args.input[0].text as string;
      texts.push(text);
      if (text.includes("hung alert")) { reached(); return new Promise(() => {}); }
      return { ok: true, delivery: "sent" };
    });
    const service = state.harness.behavior.runService("supervisor");
    await first;
    service.controller.abort();
    await service.done;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const row = (key: string) => state.db.prepare("SELECT attempts, delivered_at, last_error FROM alert_outbox WHERE dedupe_key=?").get(key) as any;
    // The hung send's deadline ended with the tick: unsent, not acknowledged, and no second delivery started.
    expect(row("test:hung")).toMatchObject({ attempts: 0, delivered_at: null, last_error: "abandoned" });
    expect(row("test:skipped")).toMatchObject({ attempts: 0, delivered_at: null });
    expect(texts.filter((text) => text.includes("skipped alert"))).toHaveLength(0);

    // The abandoned row keeps its attempt budget, is flagged uncertain, and is retried by the next supervisor.
    expect(state.db.prepare("SELECT uncertain FROM alert_outbox WHERE dedupe_key='test:hung'").get()).toMatchObject({ uncertain: 1 });
    state.harness.sdk.stub("threads.send", async () => ({ ok: true, delivery: "sent" }));
    await state.supervisorCycle();
    expect(row("test:skipped").delivered_at).not.toBeNull();
    expect(row("test:hung").delivered_at).not.toBeNull();
  }, STOP_GRACE_MS + 5_000);

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
      // chief_inspect appears only in the soft ladder, so it tells the soft alert from the stop alert.
      expect(softAlert).toContain("chief_inspect");
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
      expect(hardAlert).toContain(worker.threadId);
      expect(hardAlert).toContain("chief_stop");
      expect(hardAlert).not.toContain("chief_inspect");

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
      const alert = state.sent.at(-1).input[0].text;
      expect(alert).toContain("chief_stop");
      expect(alert).not.toContain("chief_inspect");

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
      expect(state.sent.at(-1).input[0].text).not.toContain("chief_inspect");

      const continueTime = t0 + 121_000;
      nowSpy.mockReturnValue(continueTime);
      const continued = await state.harness.behavior.runCli(["continue", worker.threadId, "--instruction", "Try again"]);
      expect(continued.exitCode).toBe(0);
      const afterContinue = state.sent.length;

      nowSpy.mockReturnValue(continueTime + 61_000);
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterContinue + 1);
      expect(state.sent.at(-1).input[0].text).toContain("chief_inspect");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a reviewer's stall ladder points at a fresh review, not a replacement worker", async () => {
    const state = await setup();
    forgeAnswers(state);
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", forged());
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
