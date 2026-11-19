import { afterEach, describe, expect, test, vi } from "vitest";
import { delegate, disposeAll, setup, start, status } from "./harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contract (docs/specs/work-list.md, "handOver moves chief_todos and undelivered alerts"): when a Chief ends, its todos and its undelivered
// alerts go to the successor, so the successor keeps the open work. The successor is another live Chief when there is one, else a new replacement.
// Regression: a todo left on the superseded Chief, or an undelivered alert never reaching the successor.
describe("work list: hand-over", () => {
  test("an ended Chief's todos and undelivered alert go to a live Chief, then to the replacement when none is left", async () => {
    const state = await setup();
    const ctx = (threadId: string) => ({ threadId, projectId: "proj_1" });
    const todo = (chief: string, text: string) => state.harness.behavior.callAgentTool("chief_roster", { todo: { text } }, ctx(chief));
    const owners = () => state.db.prepare(`SELECT text, chief_thread_id FROM chief_todos ORDER BY id`).all();
    const archive = async (threadId: string) => {
      state.live.set(threadId, { ...state.live.get(threadId)!, archivedAt: Date.now() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(threadId)! });
      state.db.prepare(`UPDATE alert_outbox SET last_attempt_at = last_attempt_at - 31000 WHERE last_attempt_at IS NOT NULL`).run(); // skip the 30 s retry backoff of the failed send
      await state.supervisorCycle();
    };

    const a = (await start(state)).threadId;
    const b = (JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!) as { threadId: string }).threadId;
    await todo(a, "Alpha");
    await todo(b, "Delta");
    const worker = (await delegate(state, a, "Fix checkout totals")).threadId;
    state.failNextSend(); // the report alert stays undelivered, so the hand-off has one to move
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for the successor" }, ctx(worker));
    const reportTarget = () => state.db.prepare(`SELECT target_thread_id, delivered_at IS NOT NULL AS delivered FROM alert_outbox WHERE source_thread_id=?`).all(worker);
    expect(reportTarget()).toEqual([{ target_thread_id: a, delivered: 0 }]);

    await archive(a);
    expect(owners()).toEqual([{ text: "Alpha", chief_thread_id: b }, { text: "Delta", chief_thread_id: b }]);
    expect(reportTarget()).toEqual([{ target_thread_id: b, delivered: 1 }]);
    expect(state.sent.filter((message) => message.threadId === b && String(message.input[0].text).includes(`Worker report from Fix checkout totals (${worker})`))).toHaveLength(1);

    await archive(b);
    const replacement = (await status(state)).threads.find((row: { role: string; threadId: string }) => row.role === "chief" && ![a, b].includes(row.threadId))!.threadId;
    expect(owners()).toEqual([{ text: "Alpha", chief_thread_id: replacement }, { text: "Delta", chief_thread_id: replacement }]);
  });
});
