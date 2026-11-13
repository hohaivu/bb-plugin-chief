import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { CLOSE_OUT, PLAN_FIXTURE, TEST_WAVE, completeWorker, delegate, disposeAll, setup, start, status, wave } from "./test/harness";
import { plan, report, reviewed, tool, type State } from "./test/testerHelpers";
import { skipSpecs, specPlan } from "./test/specWriterHelpers";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

const DSN = "https://publickey123@o9.ingest.sentry.io/4242";
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
const events = (state: State, kind?: string) =>
  state.db.prepare(`SELECT kind, thread_id, role, plan_thread_id, plan_wave, detail, event_id FROM chief_events ${kind ? "WHERE kind=?" : ""} ORDER BY id`).all(...(kind ? [kind] : [])) as
    { kind: string; thread_id: string | null; role: string | null; plan_thread_id: string | null; plan_wave: number | null; detail: string | null; event_id: string }[];
const failWith = async (state: State, threadId: string, detail: string) => {
  await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(threadId)! });
  state.seedEvents(threadId, [{ type: "provider/error", createdAt: Date.now(), data: { message: "Provider error", detail } }]);
  await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(threadId)!, error: null });
};

describe("event ledger: one row at each detection point", () => {
  test("a failed tool call ledgers the tool and the first message line, and the caller still gets the tool's own error", async () => {
    const state = await setup();
    const chief = await start(state);
    await expect(tool(state, "chief_inspect", { threadId: "thr_nope" }, chief.threadId)).rejects.toThrow("No managed thread thr_nope for this Chief");
    expect(events(state, "tool_error")).toEqual([expect.objectContaining({ thread_id: chief.threadId, role: "chief", detail: "chief_inspect: No managed thread thr_nope for this Chief." })]);
  });

  test("a dead ledger never replaces the tool's error", async () => {
    const state = await setup();
    const chief = await start(state);
    state.db.exec("DROP TABLE chief_events");
    await expect(tool(state, "chief_inspect", { threadId: "thr_nope" }, chief.threadId)).rejects.toThrow("No managed thread thr_nope for this Chief");
  });

  test("a successful tool call returns the tool's own result and writes no tool_error row", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId, "Fix checkout totals");
    expect(await tool(state, "chief_roster", {}, chief.threadId)).toContain("Fix checkout totals");
    expect(events(state, "tool_error")).toEqual([]);
  });

  test("a stall and a hard stall each write one row for the thread and cycle, however many ticks see them", async () => {
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
      await state.supervisorCycle();
      expect(events(state).filter((row) => row.kind === "stall" || row.kind === "hard_stall").map((row) => row.kind)).toEqual(["stall"]);
      nowSpy.mockReturnValue(t0 + 121_000);
      await state.supervisorCycle();
      await state.supervisorCycle();
    } finally { nowSpy.mockRestore(); }
    expect(events(state).filter((row) => row.kind === "stall" || row.kind === "hard_stall").map((row) => [row.kind, row.thread_id, row.role])).toEqual([["stall", worker.threadId, "worker"], ["hard_stall", worker.threadId, "worker"]]);
  });

  test("a transient provider failure writes one provider_transient row per thread and cycle", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, "Connection error.");
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(worker.threadId)!, error: null });
    expect(events(state, "provider_transient")).toEqual([expect.objectContaining({ thread_id: worker.threadId, detail: "connection" })]);
    expect(events(state, "thread_failed")).toEqual([]);
  });

  test("a non-transient failure writes one thread_failed row, even when the failed event repeats", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, "context window exceeded");
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(worker.threadId)!, error: null });
    expect(events(state, "thread_failed")).toEqual([expect.objectContaining({ thread_id: worker.threadId, role: "worker", detail: expect.stringContaining("context window exceeded") })]);
    expect(events(state, "provider_transient")).toEqual([]);
  });

  test("a blocked report writes a blocked row with the first line of the blocker", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "blocked", blocker: "Need the staging key\nsecond line", recommendation: "Ask the owner" });
    expect(events(state, "blocked")).toEqual([expect.objectContaining({ thread_id: worker.threadId, detail: "Need the staging key" })]);
  });

  test("a reviewer's request_changes writes one row per rejected worker with its round; an approve writes none", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "ready", result: "Done" });
    await reviewed(state, chief.threadId, worker.threadId, "approve");
    expect(events(state, "request_changes")).toEqual([]);
    await reviewed(state, chief.threadId, worker.threadId, "request_changes");
    expect(events(state, "request_changes")).toEqual([expect.objectContaining({ thread_id: worker.threadId, role: "worker", detail: "round=1" })]);
  });

  test("an advisor's request_changes on a plan writes plan_review_changes tagged with the advisor", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)]);
    await tool(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan before delegation" }, chief.threadId);
    const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
    await report(state, advisor.threadId, { state: "ready", result: "Wave 2 is missing a contract.", verdict: "request_changes" });
    expect(events(state, "plan_review_changes")).toEqual([expect.objectContaining({ thread_id: advisor.threadId, role: "advisor" })]);
  });

  test("completing with both skips writes review_skipped and tests_skipped with each reason; an override writes override", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await completeWorker(state, chief.threadId, worker.threadId);
    expect(events(state).filter((row) => row.thread_id === worker.threadId).map((row) => [row.kind, row.detail])).toEqual([
      ["review_skipped", CLOSE_OUT.skipReview], ["tests_skipped", CLOSE_OUT.testsSkipped],
    ]);

    const second = await delegate(state, chief.threadId, "Second");
    await report(state, second.threadId, { state: "ready", result: "Done" });
    await tool(state, "chief_complete", { threadId: second.threadId, testsSkipped: "no tests here", override: "owner said ship it" }, chief.threadId);
    expect(events(state).filter((row) => row.thread_id === second.threadId).map((row) => [row.kind, row.detail])).toEqual([
      ["tests_skipped", "no tests here"], ["override", "owner said ship it"],
    ]);
  });

  test("chief_stop writes a stopped row with its reason", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await tool(state, "chief_stop", { threadId: worker.threadId, reason: "looping" }, chief.threadId);
    expect(events(state, "stopped")).toEqual([expect.objectContaining({ thread_id: worker.threadId, detail: "looping" })]);
  });

  test("chief_skip_tests and chief_skip_specs each write one row tagged with the plan and wave, and a repeat adds none", async () => {
    const state = await setup();
    const { chief, planner } = await specPlan(state);
    await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
    await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
    await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "no tests for a docs wave" }, chief.threadId);
    await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "no tests for a docs wave" }, chief.threadId);
    expect(events(state, "specs_skipped")).toEqual([expect.objectContaining({ plan_thread_id: planner.threadId, plan_wave: 1, detail: "docs are unchanged" })]);
    expect(events(state, "tests_skipped")).toEqual([expect.objectContaining({ plan_thread_id: planner.threadId, plan_wave: 2, detail: "no tests for a docs wave" })]);
  });

  test("a nudge writes a chars=N row and never reaches Sentry; a stop does", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const state = await setup();
      await state.harness.behavior.setSettings({ sentryDsn: DSN });
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await tool(state, "chief_continue", { threadId: worker.threadId, instruction: "Keep going" }, chief.threadId);
      await flush();
      expect(events(state, "nudge")).toEqual([expect.objectContaining({ thread_id: worker.threadId, detail: "chars=10" })]);
      expect(fetchMock).not.toHaveBeenCalled();
      await tool(state, "chief_stop", { threadId: worker.threadId, reason: "stuck" }, chief.threadId);
      await flush();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("ledger and Sentry through the real report transaction", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 }); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function blockedWorker() {
    const state = await setup();
    await state.harness.behavior.setSettings({ sentryDsn: DSN });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    return { state, worker };
  }

  test("a report that rolls back leaves no row and sends nothing; the committed retry sends exactly once", async () => {
    const { state, worker } = await blockedWorker();
    // The report's own outbox write is the last statement of the transaction: failing it rolls the whole report back.
    state.db.exec("CREATE TRIGGER fail_pending BEFORE INSERT ON alert_outbox WHEN NEW.dedupe_key LIKE '%:pending-%' BEGIN SELECT RAISE(ABORT, 'outbox down'); END");
    await expect(report(state, worker.threadId, { state: "blocked", blocker: "Need the staging key", recommendation: "Ask" })).rejects.toThrow();
    await flush();
    expect(events(state, "blocked")).toEqual([]);
    // The failed chief_report call itself is a tool_error (spec: failed tool calls are mirrored); the rolled-back blocked event is not.
    const sentKinds = () => fetchMock.mock.calls.map((call) => JSON.parse((call[1].body as string).split("\n")[2]!).tags.kind);
    expect(sentKinds()).toEqual(["tool_error"]);

    state.db.exec("DROP TRIGGER fail_pending");
    await report(state, worker.threadId, { state: "blocked", blocker: "Need the staging key", recommendation: "Ask" });
    await flush();
    expect(events(state, "blocked")).toHaveLength(1);
    expect(sentKinds()).toEqual(["tool_error", "blocked"]);
    const [header, , item] = (fetchMock.mock.calls[1]![1].body as string).split("\n").map((line) => JSON.parse(line));
    expect(item.event_id).toBe(events(state, "blocked")[0]!.event_id);
    expect(header.event_id).toBe(item.event_id);
    expect(item.tags).toMatchObject({ kind: "blocked", role: "worker", thread_id: worker.threadId });
  });

  test("a ledger row sends nothing when the DSN is unset", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "blocked", blocker: "Need the staging key", recommendation: "Ask" });
    await flush();
    expect(events(state, "blocked")).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a row whose receipt is gone before the send is never posted", async () => {
    const { state, worker } = await blockedWorker();
    await report(state, worker.threadId, { state: "blocked", blocker: "Need the staging key", recommendation: "Ask" });
    state.db.exec("DELETE FROM chief_events"); // the same macrotask: the send has not run yet
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
