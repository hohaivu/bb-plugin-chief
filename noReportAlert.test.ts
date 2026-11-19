import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { delegate, disposeAll, setup, start } from "./test/harness";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// With parent notifications `stuck`, BB no longer reports a managed turn that ended without chief_report; Chief's own alert does.
describe("finished-without-report alert", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const turn = async (state: S, id: string, lastAssistantText: string | null) => {
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(id)!, status: "active" } });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(id)!, status: "idle" }, lastAssistantText });
  };
  const noreport = (state: S, id: string) => (state.db.prepare(`SELECT dedupe_key, message FROM alert_outbox WHERE dedupe_key LIKE ? ORDER BY dedupe_key`)
    .all(`${id}:noreport:%`) as { dedupe_key: string; message: string }[]);
  const cycle = (state: S, id: string) => (state.db.prepare(`SELECT active_cycle FROM managed_threads WHERE thread_id=?`).get(id) as any).active_cycle;

  test("managed spawns carry parentNotifications stuck; a Chief spawn does not", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    expect(state.spawned[0]).not.toHaveProperty("parentNotifications");
    expect(state.spawned[1]).toMatchObject({ parentNotifications: "stuck" });
  });

  test("one alert per turn without a report, with the last text; a new turn alerts again", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await turn(state, worker.threadId, "I stopped at step 3");
    const first = cycle(state, worker.threadId);
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(worker.threadId)!, status: "idle" }, lastAssistantText: "again" });
    let rows = noreport(state, worker.threadId);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`${worker.threadId}:noreport:${first}`]);
    expect(rows[0].message).toContain("I stopped at step 3");
    expect(rows[0].message).toContain(worker.threadId);

    await turn(state, worker.threadId, "still stuck");
    rows = noreport(state, worker.threadId);
    expect(cycle(state, worker.threadId)).toBe(first + 1);
    expect(rows.map((r) => r.dedupe_key)).toEqual([`${worker.threadId}:noreport:${first}`, `${worker.threadId}:noreport:${first + 1}`]);
  });

  test.each([
    ["ready", { state: "ready", result: "Totals fixed" }],
    ["blocked", { state: "blocked", blocker: "No API access", recommendation: "Grant it" }],
    ["active", { state: "active", result: "Waiting on the user" }],
  ])("a turn with a %s report sends no noreport alert", async (_name, report) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(worker.threadId)!, status: "active" } });
    await state.harness.behavior.callAgentTool("chief_report", report, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.db.prepare(`SELECT 1 FROM alert_outbox WHERE dedupe_key LIKE ?`).get(`${worker.threadId}:report:%`)).toBeTruthy();
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(worker.threadId)!, status: "idle" }, lastAssistantText: "done" });
    expect(noreport(state, worker.threadId)).toEqual([]);
  });
});
