import { afterEach, describe, expect, test, vi } from "vitest";
import { disposeAll, setup, start, status } from "./harness";
import { READY, type State, delegateWave, plan, report, rowOf, tool, workerOn } from "./flowHelpers";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (epic planning mode; docs/specs/plan-chains.md, docs/specs/report-intake.md): `chief_plan epic: true` starts an epic planner
// that reports ready with no plan; intake accepts that only for an epic planner. Chief consults once; on approve it completes the planner
// and never gets a delegate / forge-init line; a revision stays an epic planner. Routing and intake run for real; no wording is pinned.

const epicPlan = (state: State, chiefThreadId: string, extra: object = {}) =>
  tool(state, "chief_plan", { title: "Checkout epic", mission: "Plan the checkout epic", undesignedReason: "small", epic: true, ...extra }, chiefThreadId);
const latestPlanner = async (state: State) => (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
const epicReport = { state: "ready", result: "Epic: https://github.com/o/r/issues/1" };
const consult = (state: State, chiefThreadId: string, planThreadId: string) =>
  tool(state, "chief_consult", { planThreadId, title: "Epic", mission: "Review this epic" }, chiefThreadId);
const advisors = async (state: State) => (await status(state)).threads.filter((row) => row.role === "advisor");
const lastText = (state: State) => state.sent.at(-1).input[0].text as string;
const READY_EPIC_ADVISOR = async (state: State, chiefThreadId: string, verdict: "approve" | "request_changes") => {
  const planner = await latestPlanner(state);
  await report(state, planner.threadId, epicReport);
  await consult(state, chiefThreadId, planner.threadId);
  const [advisor] = await advisors(state);
  await report(state, advisor!.threadId, { state: "ready", result: "Reviewed the epic.", verdict });
  return planner;
};

describe("epic planner intake", () => {
  test("an epic planner is stored as epic, and its ready report with no plan is accepted", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await latestPlanner(state);
    expect(rowOf(state, planner.threadId).plan_epic).toBe(1);
    await report(state, planner.threadId, epicReport);
    expect(rowOf(state, planner.threadId).last_report_state).toBe("ready");
  });

  test("an epic planner's report that carries a plan is refused", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await latestPlanner(state);
    await expect(report(state, planner.threadId, { ...epicReport, plan: [{ body: "x" }] })).rejects.toThrow(/epic planner/);
  });

  test("a task planner's ready report with no plan is still refused", async () => {
    const state = await setup();
    const chief = await start(state);
    await tool(state, "chief_plan", { title: "Fix totals", mission: "Plan it", undesignedReason: "small" }, chief.threadId);
    const planner = await latestPlanner(state);
    expect(rowOf(state, planner.threadId).plan_epic).toBeFalsy();
    await expect(report(state, planner.threadId, { state: "ready", result: "No plan." })).rejects.toThrow(/plan is missing/);
  });
});

describe("epic input", () => {
  test("epic with revises or with branch is refused, and omitting epic keeps a task plan valid", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId);
    await expect(epicPlan(state, chief.threadId, { revises: planner.threadId })).rejects.toThrow(/epic/);
    await expect(epicPlan(state, chief.threadId, { branch: "feature/x" })).rejects.toThrow(/epic/);
    await tool(state, "chief_plan", { title: "Task", mission: "Plan it", undesignedReason: "small" }, chief.threadId);
  });
});

describe("epic consult and routing", () => {
  test("chief_consult starts one advisor on a ready epic planner; a second consult is refused", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await latestPlanner(state);
    await expect(consult(state, chief.threadId, planner.threadId)).rejects.toThrow();
    await report(state, planner.threadId, epicReport);
    await consult(state, chief.threadId, planner.threadId);
    expect(await advisors(state)).toHaveLength(1);
    expect(rowOf(state, planner.threadId).plan_review).toBe("required");
    await expect(consult(state, chief.threadId, planner.threadId)).rejects.toThrow();
  });

  test("a ready epic planner's alert routes to chief_consult and never to forge init or delegate", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await latestPlanner(state);
    await report(state, planner.threadId, epicReport);
    expect(lastText(state)).toContain("chief_consult");
    expect(lastText(state)).not.toMatch(/chief_delegate \(|chief_forge_init \(/);
  });

  test("an approve completes the epic with no delegate line, and delegate and forge init refuse the epic", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "approve");
    expect(rowOf(state, planner.threadId).plan_review).toBe("approved");
    expect(lastText(state)).toContain("chief_complete");
    expect(lastText(state)).not.toMatch(/chief_delegate \(|chief_forge_init \(/);
    await expect(delegateWave(state, chief.threadId, planner.threadId, 1)).rejects.toThrow();
    await expect(tool(state, "chief_forge_init", { title: "Wave 1", planThreadId: planner.threadId, wave: 1 }, chief.threadId)).rejects.toThrow();
  });

  test("request_changes routes to chief_plan revises; the revision stays an epic planner and its ready report routes to complete", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "request_changes");
    expect(lastText(state)).toContain("chief_plan");
    await tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId }, chief.threadId);
    const revision = await latestPlanner(state);
    expect(revision.threadId).not.toBe(planner.threadId);
    expect(rowOf(state, revision.threadId).plan_epic).toBe(1);
    await report(state, revision.threadId, epicReport);
    expect(lastText(state)).toContain("chief_complete");
    expect(lastText(state)).not.toMatch(/chief_delegate \(|chief_forge_init \(/);
  });
});

describe("chief_log", () => {
  test("a wave line shows its worker's branch", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1);
    const worker = workerOn(state, planner.threadId, 1);
    state.db.prepare(`UPDATE managed_threads SET branch=? WHERE thread_id=?`).run("feature/block-a", worker.thread_id);
    await report(state, worker.thread_id, { state: "ready", result: READY }); // a store write reloads the row cache
    const text = await state.harness.behavior.callAgentTool("chief_log", {}, { threadId: worker.thread_id, projectId: "proj_1" }) as string;
    expect(text).toContain("branch feature/block-a");
  });
});
