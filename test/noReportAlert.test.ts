import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { delegate, disposeAll, planTwoWaves, setup, start, status } from "./harness";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
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
  const call = (state: S, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, projectId: "proj_1" });
  const roster = async (state: S, chiefId: string) => String(await call(state, "chief_roster", {}, chiefId));
  const rosterLine = async (state: S, chiefId: string, workerId: string) => (await roster(state, chiefId)).split("\n").find((l) => l.includes(`(${workerId}):`));
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
    ["active", { state: "active", result: "Still going" }],
  ])("a worker idle without a report stays in the roster until a %s report; reading it sends no alert", async (_name, report) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await turn(state, worker.threadId, "I stopped at step 3");
    const line = await rosterLine(state, chief.threadId, worker.threadId);
    expect(line).toBeTruthy();
    expect(await rosterLine(state, chief.threadId, worker.threadId)).toBe(line);
    expect(noreport(state, worker.threadId)).toHaveLength(1);
    await call(state, "chief_report", report, worker.threadId);
    expect(await roster(state, chief.threadId)).not.toContain(line!);
  });

  test.each([
    ["ready", { state: "ready", result: "Totals fixed" }],
    ["blocked", { state: "blocked", blocker: "No API access", recommendation: "Grant it" }],
    ["active", { state: "active", result: "Waiting on the user" }],
  ])("a turn with a %s report sends no noreport alert", async (name, report) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(worker.threadId)!, status: "active" } });
    await state.harness.behavior.callAgentTool("chief_report", report, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.db.prepare(`SELECT 1 FROM alert_outbox WHERE dedupe_key LIKE ?`).get(`${worker.threadId}:report:%`)).toBeTruthy();
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(worker.threadId)!, status: "idle" }, lastAssistantText: "done" });
    expect(noreport(state, worker.threadId)).toEqual([]);
    if (name === "active") expect(await rosterLine(state, chief.threadId, worker.threadId)).toBeUndefined();
  });
});

// Contract (src/runtime/nextAction.ts): missing-Report recovery in Pending covers worker rows only. A planner, plan advisor or epic revision that ends
// a turn without a Report renders Pending exactly as it did before recovery existed: the whole block is compared by row and call shape, never prose.
describe("plan threads keep their base Pending", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const call = (state: S, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, projectId: "proj_1" });
  const activeIdle = async (state: S, id: string) => {
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(id)!, status: "active" } });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(id)!, status: "idle" }, lastAssistantText: "stopped" });
  };
  // The whole Pending block: each line as its row's label and the tool names it calls. Labels replace thread IDs.
  const pending = async (state: S, chiefId: string, labels: Record<string, string>) => String(await call(state, "chief_roster", {}, chiefId)).split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => `${line.match(/^- (\w+)/)![1]} ${labels[line.match(/\(([^)]+)\):/)![1]] ?? "other"}: ${[...new Set(line.match(/chief_\w+/g))].sort().join(" ")}`);
  const planners = async (state: S) => (await status(state)).threads.filter((row) => row.role === "planner");
  const epicWithAdvisor = async (state: S, chiefId: string, verdict: "approve" | "request_changes" | null) => {
    await call(state, "chief_plan", { title: "Epic", mission: "Plan the epic", undesignedReason: "small", epic: true }, chiefId);
    const planner = (await planners(state)).at(-1)!;
    await call(state, "chief_report", { state: "ready", result: "Epic: https://github.com/o/r/issues/1" }, planner.threadId);
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Review this epic" }, chiefId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    if (verdict) await call(state, "chief_report", { state: "ready", result: "Reviewed the epic.", verdict }, advisor.threadId);
    return { planner, advisor };
  };
  const revise = async (state: S, chiefId: string, plannerId: string) => {
    await call(state, "chief_plan", { title: "Epic", mission: "Revise it", revises: plannerId }, chiefId);
    return (await planners(state)).at(-1)!;
  };

  test.each(["epic", "task"])("a %s planner and its undecided advisor both idle without a Report", async (kind) => {
    const state = await setup();
    const chief = await start(state);
    let planner, advisor;
    if (kind === "epic") ({ planner, advisor } = await epicWithAdvisor(state, chief.threadId, null));
    else {
      planner = (await planTwoWaves(state, chief.threadId)).planner;
      await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan" }, chief.threadId);
      advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    }
    await activeIdle(state, advisor.threadId);
    await activeIdle(state, planner.threadId);
    expect(await pending(state, chief.threadId, { [planner.threadId]: "planner", [advisor.threadId]: "advisor" })).toMatchInlineSnapshot(`[]`);
  });

  test("an epic revision idle without a Report, with its original idle too", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner } = await epicWithAdvisor(state, chief.threadId, "request_changes");
    const revision = await revise(state, chief.threadId, planner.threadId);
    await activeIdle(state, planner.threadId);
    await activeIdle(state, revision.threadId);
    expect(await pending(state, chief.threadId, { [planner.threadId]: "original", [revision.threadId]: "revision" })).toMatchInlineSnapshot(`
      [
        "advisor other: chief_plan",
      ]
    `);
  });

  test("an epic revision blocked, with its original idle", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner } = await epicWithAdvisor(state, chief.threadId, "request_changes");
    const revision = await revise(state, chief.threadId, planner.threadId);
    await call(state, "chief_report", { state: "blocked", blocker: "No repo access", recommendation: "Grant it" }, revision.threadId);
    await activeIdle(state, planner.threadId);
    await activeIdle(state, revision.threadId);
    expect(await pending(state, chief.threadId, { [planner.threadId]: "original", [revision.threadId]: "revision" })).toMatchInlineSnapshot(`
      [
        "advisor other: chief_plan",
      ]
    `);
  });

  test("a delivered epic revision that is busy again, and once idle", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner } = await epicWithAdvisor(state, chief.threadId, "request_changes");
    const revision = await revise(state, chief.threadId, planner.threadId);
    await call(state, "chief_report", { state: "ready", result: "Epic: https://github.com/o/r/issues/2" }, revision.threadId);
    const labels = { [planner.threadId]: "original", [revision.threadId]: "revision" };
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(revision.threadId)!, status: "active" } });
    expect(await pending(state, chief.threadId, labels)).toMatchInlineSnapshot(`
      [
        "advisor other: ",
        "planner original: ",
      ]
    `);
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(revision.threadId)!, status: "idle" }, lastAssistantText: "done" });
    expect(await pending(state, chief.threadId, labels)).toMatchInlineSnapshot(`
      [
        "advisor other: chief_plan",
        "planner original: chief_plan",
      ]
    `);
  });
});
