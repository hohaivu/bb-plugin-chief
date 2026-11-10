import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { MIGRATIONS } from "./src/db/migrations";
import { APPROVE, CLOSE_OUT, NO_DEVIATIONS, completeWorker, configurationContext, delegate, disposals, disposeAll, planTwoWaves, readyAction, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("auto-completing absorbed supporting threads", () => {
  const P = { projectId: "proj_1" };
  // The sweep runs off the reload and awaits a fresh threads.get per row; let it drain.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stateOf = (state: Awaited<ReturnType<typeof setup>>, id: string) =>
    (state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(id) as { state: string }).state;
  const call = (state: Awaited<ReturnType<typeof setup>>, tool: string, params: object, threadId: string) =>
    state.harness.behavior.callAgentTool(tool, params, { threadId, ...P });
  async function reviewed(state: Awaited<ReturnType<typeof setup>>, chiefId: string, workerId: string, verdict: "approve" | "request_changes") {
    await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, workerId);
    await call(state, "chief_review", { workerThreadId: workerId }, chiefId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer" && row.workerThreadId === workerId && row.state !== "complete")!;
    const findings = verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "Wrong total", fix: "Fix it" }];
    await call(state, "chief_report", { state: "ready", result: "Checked", verdict, findings }, reviewer.threadId);
    return reviewer.threadId;
  }
  async function consulted(state: Awaited<ReturnType<typeof setup>>, chiefId: string, workerId: string) {
    await call(state, "chief_consult", { title: "Advice", mission: "Diagnose", workerThreadId: workerId }, chiefId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor" && row.state !== "complete")!;
    await call(state, "chief_report", { state: "ready", result: "Try X" }, advisor.threadId);
    return advisor.threadId;
  }

  test("chief_complete on a worker completes its reviewer and advisor, idempotently", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    const advisor = await consulted(state, chief.threadId, worker.threadId);
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect([stateOf(state, reviewer), stateOf(state, advisor)]).toEqual(["complete", "complete"]);
    const before = state.db.prepare(`SELECT thread_id, state, updated_at FROM managed_threads ORDER BY thread_id`).all();
    await call(state, "chief_roster", {}, chief.threadId);
    await expect(call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId)).resolves.toBeDefined();
    expect(state.db.prepare(`SELECT thread_id, state, updated_at FROM managed_threads WHERE thread_id<>? ORDER BY thread_id`).all(worker.threadId))
      .toEqual((before as any[]).filter((row) => row.thread_id !== worker.threadId));
  });

  test("a busy reviewer is swept only after it goes idle", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer)! });
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect(stateOf(state, reviewer)).toBe("active");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
    await settle();
    expect(stateOf(state, reviewer)).toBe("complete");
  });

  // Contract (work-list spec, Contracts that stay): the sweep still runs on `failed` events (the `idle` case is the test above) once pendingReady is set.
  test("a busy reviewer is swept once it fails", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer)! });
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect(stateOf(state, reviewer)).toBe("active");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "failed" });
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(reviewer)!, lastAssistantText: "boom" });
    await settle();
    expect(stateOf(state, reviewer)).toBe("complete");
  });

  test("replaces: completes the prior worker's advisor and hides the re-pointed reviewer's stale line", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "request_changes");
    const advisor = await consulted(state, chief.threadId, worker.threadId);
    const fresh = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await settle();
    expect(stateOf(state, advisor)).toBe("complete");
    await settle();
    expect(stateOf(state, reviewer)).toBe("ready");
    const roster = String(await call(state, "chief_roster", {}, chief.threadId));
    expect(roster).not.toContain(`replaces: ${fresh.threadId}`);
    expect(roster).not.toContain(`(${reviewer}):`);
  });

  test("a planner completes only after its final wave and every linked worker is done", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    const cli = async (args: string[]) => {
      const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], { threadId: chief.threadId, ...P });
      expect(result.exitCode).toBe(0);
      return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
    };
    const wave1 = await cli(["--plan-thread", planner.threadId, "--wave", "1"]);
    const wave2 = await cli(["--replaces", wave1, "--plan-thread", planner.threadId, "--wave", "2"]);
    await settle();
    expect(stateOf(state, wave1)).toBe("complete");
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("ready");
    const fix = await cli(["--replaces", wave2, "--kind", "worker"]);
    await settle();
    expect(stateOf(state, wave2)).toBe("complete");
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("ready");
    expect(state.archivedThreads).toEqual([]);
    await call(state, "chief_report", { state: "ready", result: `Fixed${NO_DEVIATIONS}` }, fix);
    await call(state, "chief_complete", { threadId: fix, skipReview: "review is not under test" }, chief.threadId);
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("complete");
    expect(state.archivedThreads).toEqual([]);
  });

  test("completing an approved final-wave planned worker completes its planner and reviewer and archives nothing", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    const cli = async (args: string[]) => {
      const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], { threadId: chief.threadId, ...P });
      expect(result.exitCode).toBe(0);
      return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
    };
    const wave1 = await cli(["--plan-thread", planner.threadId, "--wave", "1"]);
    const wave2 = await cli(["--replaces", wave1, "--plan-thread", planner.threadId, "--wave", "2"]);
    const reviewer = await reviewed(state, chief.threadId, wave2, "approve");
    const advisor = await consulted(state, chief.threadId, wave2);
    await call(state, "chief_complete", { threadId: wave2 }, chief.threadId);
    await settle();
    await settle();
    expect([wave2, planner.threadId, reviewer, advisor].map((id) => stateOf(state, id))).toEqual(["complete", "complete", "complete", "complete"]);
    expect([state.archivedEnvs, state.archivedThreads]).toEqual([[], []]);
  });

  test("completing an approved unplanned worker archives no threads", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await reviewed(state, chief.threadId, worker.threadId, "approve");
    const reply = String(await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId));
    expect(reply).not.toMatch(/Worktree|Archived|release/);
    expect(stateOf(state, worker.threadId)).toBe("complete");
    expect([state.archivedEnvs, state.archivedThreads]).toEqual([[], []]);
  });

  test("a replaces: hand-off completes the prior worker without archiving", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await reviewed(state, chief.threadId, worker.threadId, "approve");
    await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await settle();
    expect(stateOf(state, worker.threadId)).toBe("complete");
    expect([state.archivedEnvs, state.archivedThreads]).toEqual([[], []]);
  });

  test("archiving a complete worker keeps its row complete", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await completeWorker(state, chief.threadId, worker.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, archivedAt: 2 });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(worker.threadId)! });
    expect(stateOf(state, worker.threadId)).toBe("complete");
  });

  test("a reviewer that reported ready while still live-active is swept only after it goes idle", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: "Done" }, worker.threadId);
    await call(state, "chief_review", { workerThreadId: worker.threadId }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!.threadId;
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer)! });
    await call(state, "chief_report", { state: "ready", result: "Checked", ...APPROVE }, reviewer);
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect(stateOf(state, reviewer)).toBe("ready");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
    await settle();
    expect(stateOf(state, reviewer)).toBe("complete");
  });

  test("a reviewer seen idle once is not swept when it later turns active unseen or its read fails", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" }); // no lifecycle event
    const other = await delegate(state, chief.threadId, "Other");
    const failing = await reviewed(state, chief.threadId, other.threadId, "approve");
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    state.failNextGet(failing);
    await call(state, "chief_complete", { threadId: other.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect([stateOf(state, reviewer), stateOf(state, failing)]).toEqual(["ready", "ready"]);
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(failing)!, lastAssistantText: "done" }); // a later reload retries
    await settle();
    expect(stateOf(state, failing)).toBe("complete");
  });

  test("startup sweeps absorbed rows only once their live status is known and idle", async () => {
    const liveStatus: Record<string, string> = { thr_plan: "idle", thr_work: "idle", thr_rev: "idle", thr_busy: "active" };
    const { bb, harness } = createFakePluginHost({
      pluginId: "chief-sweep",
      sdk: {
        threadSections: { list: async () => [{ id: "sec", name: "Chief", createdAt: 1, updatedAt: 1 }], create: async () => ({ id: "sec" }) },
        projects: { get: async () => ({ id: "proj_1", name: "P", kind: "standard" }), fileContent: async () => { throw new Error("missing"); } },
        threads: {
          // thr_unknown has no live answer: its read keeps failing, so its status stays unobserved.
          get: async ({ threadId }: { threadId: string }) => {
            if (!liveStatus[threadId]) throw new Error("transient get");
            return makeThreadResponse({ id: threadId, projectId: "proj_1", sectionId: "sec", visibility: "visible", status: liveStatus[threadId] });
          },
          update: async () => ({}),
        },
      },
    });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const insert = db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, worker_thread_id, title, state, status, verdict, plan_waves, plan_thread_id, plan_wave, reviewed_report_seq, created_at, updated_at)
      VALUES (?, ?, 'proj_1', 'thr_chief', ?, ?, ?, 'idle', ?, ?, ?, ?, ?, 1, 1)`);
    insert.run("thr_plan", "planner", null, "Plan", "ready", null, JSON.stringify([{ path: "a" }]), null, null, null);
    insert.run("thr_work", "worker", null, "Work", "complete", null, null, "thr_plan", 1, null);
    insert.run("thr_rev", "reviewer", "thr_work", "Review", "ready", "approve", null, null, null, 1);
    insert.run("thr_busy", "reviewer", "thr_work", "Busy review", "ready", "approve", null, null, null, 1);
    insert.run("thr_unknown", "advisor", "thr_work", "Advice", "ready", null, null, null, null, null);
    // A reviewer's coverage lives in the review_targets ledger, not in managed_threads.worker_thread_id.
    const cover = db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id) VALUES (?, 'thr_work')`);
    cover.run("thr_rev");
    cover.run("thr_busy");
    await plugin(bb);
    expect(db.prepare(`SELECT thread_id, state FROM managed_threads WHERE thread_id<>'thr_work' ORDER BY thread_id`).all()).toEqual([
      { thread_id: "thr_busy", state: "ready" },
      { thread_id: "thr_plan", state: "complete" },
      { thread_id: "thr_rev", state: "complete" },
      { thread_id: "thr_unknown", state: "ready" },
    ]);
  });

  test("the roster Pending lines list only threads with a next action; supporting and in-progress rows are not listed", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    await state.harness.behavior.runCli(["delegate", "--title", "Planned", "--mission", "Do it", "--plan-thread", planner.threadId, "--wave", "1", "--json"], { threadId: chief.threadId, ...P });
    const ready = await delegate(state, chief.threadId, "Ready work");
    await call(state, "chief_report", { state: "ready", result: "Done" }, ready.threadId);
    const blockedWorker = await delegate(state, chief.threadId, "Blocked review target");
    await call(state, "chief_report", { state: "ready", result: "Done" }, blockedWorker.threadId);
    await call(state, "chief_review", { workerThreadId: blockedWorker.threadId }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await call(state, "chief_report", { state: "blocked", blocker: "No access", recommendation: "Grant it" }, reviewer.threadId);
    await call(state, "chief_consult", { title: "Idle advice", mission: "Think" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(advisor.threadId)!, lastAssistantText: "hm" });

    const roster = String(await call(state, "chief_roster", {}, chief.threadId));
    const pendingLines = roster.split("\n").filter((line) => /\(thr_[^)]+\): /.test(line));
    // Only a thread with a next action is listed; the planner, the idle advisor, the planned worker in progress and the worker already under review are not.
    expect([...pendingLines].sort()).toEqual([
      `- reviewer “Review · Blocked review target” (${reviewer.threadId}): Blocked: No access — decide or escalate to the user.`,
      `- worker “Ready work” (${ready.threadId}): ${readyAction(ready.threadId)}`,
    ]);
  });

  test("chief_complete lists open todos for a worker; instructions name the close-todo rule", async () => {
    const state = await setup();
    const chief = await start(state);
    // Completing an unplanned worker needs a ready report, a tester or testsSkipped, and a review or skipReview; none is under test here.
    const closeOut = { testsSkipped: "todos are under test", skipReview: "todos are under test" };
    const quiet = await delegate(state, chief.threadId, "Quiet");
    await call(state, "chief_report", { state: "ready", result: "Done" }, quiet.threadId);
    expect(String(await call(state, "chief_complete", { threadId: quiet.threadId, ...closeOut }, chief.threadId))).not.toContain("Open todos");
    await call(state, "chief_roster", { todo: { text: "Ship totals" } }, chief.threadId);
    const worker = await delegate(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: "Done" }, worker.threadId);
    const reply = String(await call(state, "chief_complete", { threadId: worker.threadId, ...closeOut }, chief.threadId));
    expect(reply).toContain(`Open todos: #1 Ship totals — close any this work finished with chief_roster todo { id, state: "done" }.`);
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(JSON.stringify(configured)).toContain("When work a todo tracks is finished, close that todo in the same turn");
  });
});
