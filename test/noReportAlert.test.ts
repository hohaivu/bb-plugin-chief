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

  test("an approved plan's idle planner shows the recovery line on its own row, not on its ready advisor's", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await call(state, "chief_report", { state: "ready", result: "The plan is sound.", verdict: "approve" }, advisor.threadId);
    await turn(state, planner.threadId, "I stopped");
    const line = await rosterLine(state, chief.threadId, planner.threadId);
    expect(line).toContain(`chief_inspect (threadId: ${planner.threadId})`);
    expect(line).toContain("chief_continue");
    expect(await rosterLine(state, chief.threadId, advisor.threadId)).toBeUndefined();
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

// Contract (src/runtime/nextAction.ts): the missing-Report recovery line yields to a more specific route; it is never shown when the row cannot use it.
// Assertions read tool names and call shapes, never prose.
describe("missing-Report recovery precedence", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const activeIdle = async (state: S, id: string) => {
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(id)!, status: "active" } });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(id)!, status: "idle" }, lastAssistantText: "stopped" });
  };
  const call = (state: S, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, projectId: "proj_1" });
  const rosterLines = async (state: S, chiefId: string, id: string) => String(await call(state, "chief_roster", {}, chiefId)).split("\n").filter((l) => l.includes(`(${id}):`));
  // The recovery line is the one that inspects the row and offers chief_continue; tool names and the target ID identify it, not prose.
  const recovers = (line: string | undefined, id: string) => !!line?.includes(`chief_inspect (threadId: ${id})`) && line.includes("chief_continue");
  // The roster's Pending lines that hold `call`.
  const pendingWith = async (state: S, chiefId: string, fragment: string) => String(await call(state, "chief_roster", {}, chiefId)).split("\n").filter((l) => l.startsWith("- ") && l.includes(fragment));
  const epicWithAdvisor = async (state: S, chiefId: string, verdict: "approve" | "request_changes") => {
    await call(state, "chief_plan", { title: "Epic", mission: "Plan the epic", undesignedReason: "small", epic: true }, chiefId);
    const planner = (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    await call(state, "chief_report", { state: "ready", result: "Epic: https://github.com/o/r/issues/1" }, planner.threadId);
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Review this epic" }, chiefId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await call(state, "chief_report", { state: "ready", result: "Reviewed the epic.", verdict }, advisor.threadId);
    return { planner, advisor };
  };

  test("an idle advisor with no decision gets one advisor-owned recovery line; continue and a report clear it", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await activeIdle(state, advisor.threadId);

    const lines = await rosterLines(state, chief.threadId, advisor.threadId);
    expect(lines).toHaveLength(1);
    expect(recovers(lines[0], advisor.threadId)).toBe(true);
    expect(recovers((await rosterLines(state, chief.threadId, planner.threadId)).join("\n"), planner.threadId)).toBe(false);

    await call(state, "chief_continue", { threadId: advisor.threadId, instruction: "Report your verdict with chief_report." }, chief.threadId);
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(advisor.threadId)!, status: "active" } });
    expect(recovers((await rosterLines(state, chief.threadId, advisor.threadId)).join("\n"), advisor.threadId)).toBe(false);
    await call(state, "chief_report", { state: "ready", result: "The plan is sound.", verdict: "approve" }, advisor.threadId);
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(advisor.threadId)!, status: "idle" }, lastAssistantText: "done" });
    expect(recovers((await rosterLines(state, chief.threadId, advisor.threadId)).join("\n"), advisor.threadId)).toBe(false);
  });

  test("a stale advisor (its planner no longer waits on it) gets no continue call", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    // The direct write reaches the row cache on the store's next write: the advisor's turn below.
    state.db.prepare(`UPDATE managed_threads SET plan_review='approved' WHERE thread_id=?`).run(planner.threadId);
    await activeIdle(state, advisor.threadId);
    expect((await rosterLines(state, chief.threadId, advisor.threadId)).join("\n")).not.toContain("chief_continue");
  });

  test("a decided epic planner idle without a Report keeps its completion route, and chief_consult's refusal names it too", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner, advisor } = await epicWithAdvisor(state, chief.threadId, "approve");
    await activeIdle(state, planner.threadId);

    const complete = `chief_complete (threadId: ${planner.threadId})`;
    const lines = await rosterLines(state, chief.threadId, planner.threadId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(complete);
    expect(recovers(lines[0], planner.threadId)).toBe(false);
    // The advisor row stays silent while the planner shows the one action.
    expect((await rosterLines(state, chief.threadId, advisor.threadId)).join("\n")).not.toContain(complete);

    const refusal = await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Again" }, chief.threadId).then(() => "", (error: Error) => error.message);
    expect(refusal).toContain(complete);
    expect(refusal).not.toContain("chief_continue");
  });

  test("an idle epic planner whose advisor requested changes has one Pending owner for the revision call; the advisor's alert and consult refusal keep it", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner, advisor } = await epicWithAdvisor(state, chief.threadId, "request_changes");
    const revise = `chief_plan (revises: ${planner.threadId}`;
    // The advisor's own report alert carries the call.
    const alert = state.db.prepare(`SELECT message FROM alert_outbox WHERE dedupe_key LIKE ?`).all(`${advisor.threadId}:report:%`) as { message: string }[];
    expect(alert.some((row) => row.message.includes(revise))).toBe(true);
    for (const idle of [false, true]) {
      if (idle) await activeIdle(state, planner.threadId);
      const pending = await pendingWith(state, chief.threadId, revise);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toContain(`(${planner.threadId}):`);
      expect(recovers(pending[0], planner.threadId)).toBe(false);
    }
    const refusal = await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Again" }, chief.threadId).then(() => "", (error: Error) => error.message);
    expect(refusal).toContain(revise);
  });

  test("an approved epic has one Pending owner for its completion call; the advisor's alert and consult refusal keep it", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner, advisor } = await epicWithAdvisor(state, chief.threadId, "approve");
    const complete = `chief_complete (threadId: ${planner.threadId})`;
    const alert = state.db.prepare(`SELECT message FROM alert_outbox WHERE dedupe_key LIKE ?`).all(`${advisor.threadId}:report:%`) as { message: string }[];
    expect(alert.some((row) => row.message.includes(complete))).toBe(true);
    for (const idle of [false, true]) {
      if (idle) await activeIdle(state, planner.threadId);
      const pending = await pendingWith(state, chief.threadId, complete);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toContain(`(${planner.threadId}):`);
    }
    const refusal = await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Again" }, chief.threadId).then(() => "", (error: Error) => error.message);
    expect(refusal).toContain(complete);
  });

  test("an idle task planner whose advisor requested changes has one Pending owner, the revision call; a planner with no advisor decision keeps its recovery line", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    await activeIdle(state, planner.threadId);
    expect((await pendingWith(state, chief.threadId, "chief_continue")).filter((l) => recovers(l, planner.threadId))).toHaveLength(1);

    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await call(state, "chief_report", { state: "ready", result: "Wave 2 is wrong.", verdict: "request_changes" }, advisor.threadId);
    await activeIdle(state, planner.threadId);

    const pending = String(await call(state, "chief_roster", {}, chief.threadId)).split("\n").filter((l) => l.startsWith("- "));
    expect(pending.filter((l) => l.includes(`chief_plan (revises: ${planner.threadId}`))).toHaveLength(1);
    expect(pending.filter((l) => recovers(l, planner.threadId))).toHaveLength(0);
  });

  const refusalOf = (state: S, tool: string, params: object, chiefId: string) => call(state, tool, params, chiefId).then(() => "", (error: Error) => error.message);
  // An epic whose advisor requested changes, revised once; the revision has reported ready (delivered).
  const deliveredRevision = async (state: S, chiefId: string) => {
    const { planner } = await epicWithAdvisor(state, chiefId, "request_changes");
    await call(state, "chief_plan", { title: "Epic", mission: "Revise it", revises: planner.threadId }, chiefId);
    const revision = (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    await call(state, "chief_report", { state: "ready", result: "Epic: https://github.com/o/r/issues/2" }, revision.threadId);
    return { planner, revision };
  };
  const planners = async (state: S) => (await status(state)).threads.filter((row) => row.role === "planner");

  test("a delivered epic revision, ready or idle with no Report, has one Pending row carrying both completions; consult and revision admission refuse with it", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner, revision } = await deliveredRevision(state, chief.threadId);

    const complete = [`chief_complete (threadId: ${revision.threadId})`, `chief_complete (threadId: ${planner.threadId})`];
    const revises = `chief_plan (revises: ${planner.threadId}`;
    for (const idle of [false, true]) {
      if (idle) await activeIdle(state, revision.threadId);
      // One owner across all of Pending; no revision call anywhere.
      expect(await pendingWith(state, chief.threadId, revises)).toHaveLength(0);
      const delivery = await pendingWith(state, chief.threadId, "chief_complete");
      expect(delivery).toHaveLength(1);
      expect(delivery[0]).toContain(`(${revision.threadId}):`);
      expect(complete.every((c) => delivery[0].includes(c))).toBe(true);
    }
    for (const refusal of [
      await refusalOf(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Again" }, chief.threadId),
      await refusalOf(state, "chief_plan", { title: "Epic", mission: "Revise again", revises: planner.threadId }, chief.threadId),
    ]) {
      expect(refusal).toContain(complete[0]);
      expect(refusal).not.toContain(revises);
    }
    expect(await planners(state)).toHaveLength(2);
  });

  test("an archived delivered epic revision is no completion target: Pending, consult and revision admission route to a new revision", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner, revision } = await deliveredRevision(state, chief.threadId);
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: { ...state.live.get(revision.threadId)!, status: "idle" } });

    const revises = `chief_plan (revises: ${planner.threadId}`;
    expect(await pendingWith(state, chief.threadId, `chief_complete (threadId: ${revision.threadId})`)).toHaveLength(0);
    const owner = await pendingWith(state, chief.threadId, revises);
    expect(owner).toHaveLength(1);
    expect(owner[0]).toContain(`(${planner.threadId}):`);
    const refusal = await refusalOf(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Again" }, chief.threadId);
    expect(refusal).toContain(revises);
    expect(refusal).not.toContain(`chief_complete (threadId: ${revision.threadId})`);
    await call(state, "chief_plan", { title: "Epic", mission: "Revise again", revises: planner.threadId }, chief.threadId);
    expect(await planners(state)).toHaveLength(3);
  });

  test("a reactivated delivered epic revision waits while busy, with no completion call anywhere, and returns to one completion row once idle", async () => {
    const state = await setup();
    const chief = await start(state);
    const { planner, revision } = await deliveredRevision(state, chief.threadId);
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(revision.threadId)!, status: "active" } });

    expect(await pendingWith(state, chief.threadId, "chief_complete")).toHaveLength(0);
    expect(await pendingWith(state, chief.threadId, `chief_plan (revises: ${planner.threadId}`)).toHaveLength(0);
    const waiting = await pendingWith(state, chief.threadId, revision.threadId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toContain(`(${planner.threadId}):`);
    const refusal = await refusalOf(state, "chief_plan", { title: "Epic", mission: "Revise again", revises: planner.threadId }, chief.threadId);
    expect(refusal).toContain(revision.threadId);
    expect(refusal).not.toContain("chief_complete");
    expect(await planners(state)).toHaveLength(2);

    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(revision.threadId)!, status: "idle" }, lastAssistantText: "done" });
    const delivery = await pendingWith(state, chief.threadId, "chief_complete");
    expect(delivery).toHaveLength(1);
    expect(delivery[0]).toContain(`(${revision.threadId}):`);
  });

  describe("an idle undecided advisor owns recovery: the ready planner's competing route is suppressed, and only the newest idle advisor owns it", () => {
    const readyEpic = async (state: S, chiefId: string) => {
      await call(state, "chief_plan", { title: "Epic", mission: "Plan the epic", undesignedReason: "small", epic: true }, chiefId);
      const planner = (await planners(state)).at(-1)!;
      await call(state, "chief_report", { state: "ready", result: "Epic: https://github.com/o/r/issues/1" }, planner.threadId);
      return planner;
    };
    const consult = async (state: S, chiefId: string, plannerId: string) => {
      await call(state, "chief_consult", { planThreadId: plannerId, title: "Plan", mission: "Review this plan" }, chiefId);
      return (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
    };
    const pendingRecoveries = async (state: S, chiefId: string, ids: string[]) =>
      (await pendingWith(state, chiefId, "chief_continue")).filter((line) => ids.some((id) => recovers(line, id)));

    test.each(["epic", "task"])("%s plan", async (kind) => {
      const state = await setup();
      const chief = await start(state);
      const plannerId = kind === "epic" ? (await readyEpic(state, chief.threadId)).threadId : (await planTwoWaves(state, chief.threadId)).planner.threadId;
      const first = await consult(state, chief.threadId, plannerId);
      await activeIdle(state, first.threadId);
      // The planner's consult-again or wave-delegation route names its planThreadId; none may remain next to the advisor's recovery.
      expect(await pendingWith(state, chief.threadId, `planThreadId: ${plannerId}`)).toHaveLength(0);
      expect(await pendingRecoveries(state, chief.threadId, [first.threadId])).toHaveLength(1);

      // A second consult is admitted (the first is not in flight): only the newest idle advisor owns recovery.
      const second = await consult(state, chief.threadId, plannerId);
      expect(await pendingRecoveries(state, chief.threadId, [first.threadId, second.threadId])).toHaveLength(0);
      await activeIdle(state, second.threadId);
      const owner = await pendingRecoveries(state, chief.threadId, [first.threadId, second.threadId]);
      expect(owner).toHaveLength(1);
      expect(recovers(owner[0], second.threadId)).toBe(true);
      expect(await pendingWith(state, chief.threadId, `planThreadId: ${plannerId}`)).toHaveLength(0);

      // With no eligible advisor the planner's own route returns.
      for (const advisor of [first, second]) await state.harness.behavior.emitThreadEvent("thread.archived", { thread: { ...state.live.get(advisor.threadId)!, status: "idle" } });
      expect(await pendingRecoveries(state, chief.threadId, [first.threadId, second.threadId])).toHaveLength(0);
      expect((await pendingWith(state, chief.threadId, `planThreadId: ${plannerId}`)).length).toBeGreaterThan(0);
    });
  });

  test("a blocked deciding advisor and an idle unreported epic planner leave one revision call in Pending; the advisor's alert keeps it", async () => {
    const state = await setup();
    const chief = await start(state);
    await call(state, "chief_plan", { title: "Epic", mission: "Plan the epic", undesignedReason: "small", epic: true }, chief.threadId);
    const planner = (await planners(state)).at(-1)!;
    await call(state, "chief_report", { state: "ready", result: "Epic: https://github.com/o/r/issues/1" }, planner.threadId);
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Epic", mission: "Review this epic" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await call(state, "chief_report", { state: "blocked", blocker: "No repo access", recommendation: "Grant it" }, advisor.threadId);

    const revises = `chief_plan (revises: ${planner.threadId}`;
    const alert = state.db.prepare(`SELECT message FROM alert_outbox WHERE dedupe_key LIKE ?`).all(`${advisor.threadId}:report:%`) as { message: string }[];
    expect(alert.some((row) => row.message.includes(revises))).toBe(true);
    for (const idle of [false, true]) {
      if (idle) await activeIdle(state, planner.threadId);
      const pending = await pendingWith(state, chief.threadId, revises);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toContain(`(${planner.threadId}):`);
    }
  });
});
