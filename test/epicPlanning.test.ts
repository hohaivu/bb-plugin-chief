import { afterEach, describe, expect, test, vi } from "vitest";
import { disposeAll, setup, start, status } from "./harness";
import { READY, type State, delegateWave, plan, report, rowOf, setLive, tool, workerOn } from "./flowHelpers";
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
    await expect(epicPlan(state, chief.threadId, { revises: planner.threadId, epic: false })).rejects.toThrow(/epic/);
    await expect(epicPlan(state, chief.threadId, { branch: "feature/x" })).rejects.toThrow(/epic/);
    await expect(epicPlan(state, chief.threadId, { branch: "feature/x", epic: false })).rejects.toThrow(/epic/);
    await tool(state, "chief_plan", { title: "Task", mission: "Plan it", undesignedReason: "small" }, chief.threadId);
    expect((await status(state)).threads.filter((row) => row.role === "planner")).toHaveLength(2);
  });

  test("the CLI keeps an explicit --epic=false: it refuses a revision and a branch, and the same revision with --epic omitted starts one", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "request_changes");
    const planners = async () => (await status(state)).threads.filter((row) => row.role === "planner").length;
    const run = (args: string[]) => state.harness.behavior.runCli(["plan", "--title", "T", "--mission", "Revise it", ...args, "--json"], { threadId: chief.threadId, projectId: "proj_1" });
    // The advisor asked for changes, so the only reason the first call can fail is the explicit false.
    expect((await run(["--epic=false", "--revises", planner.threadId])).exitCode).not.toBe(0);
    expect(await planners()).toBe(1);
    expect((await run(["--epic=false", "--branch", "feature/x", "--undesigned-reason", "small"])).exitCode).not.toBe(0);
    expect(await planners()).toBe(1);
    expect((await run(["--revises", planner.threadId])).exitCode).toBe(0);
    expect(await planners()).toBe(2);
  });
});

describe("epic consult and routing", () => {
  test("chief_consult on a task planner with no published waves is refused and launches no advisor", async () => {
    const state = await setup();
    const chief = await start(state);
    await tool(state, "chief_plan", { title: "Fix totals", mission: "Plan it", undesignedReason: "small" }, chief.threadId);
    const planner = await latestPlanner(state);
    await expect(consult(state, chief.threadId, planner.threadId)).rejects.toThrow();
    expect(await advisors(state)).toHaveLength(0);
  });

  test("during the advisor review a second ready or a blocked epic report is refused and the reviewed result stays", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await latestPlanner(state);
    await report(state, planner.threadId, epicReport);
    await consult(state, chief.threadId, planner.threadId);
    await expect(report(state, planner.threadId, { state: "ready", result: "Epic: https://github.com/o/r/issues/2" })).rejects.toThrow(/advisor review/);
    await expect(report(state, planner.threadId, { state: "blocked", blocker: "stuck", recommendation: "retry" })).rejects.toThrow(/advisor review/);
    expect(rowOf(state, planner.threadId)).toMatchObject({ last_report_state: "ready", result: epicReport.result });
    const [advisor] = await advisors(state);
    await report(state, advisor!.threadId, { state: "ready", result: "Reviewed.", verdict: "approve" });
    expect(lastText(state)).toContain("chief_complete");
  });

  test("a revision of an epic whose first revision blocked does not read as delivered, and nothing routes an epic to delegation", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "request_changes");
    const revise = () => tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId }, chief.threadId);
    await expect(epicPlan(state, chief.threadId, { revises: planner.threadId, epic: false })).rejects.toThrow(/epic/);
    await revise();
    const first = await latestPlanner(state);
    await report(state, first.threadId, { state: "blocked", blocker: "no access to the forge", recommendation: "retry" });
    await revise();
    const second = await latestPlanner(state);
    expect(second.threadId).not.toBe(first.threadId);
    await report(state, second.threadId, { state: "blocked", blocker: "still no access", recommendation: "retry" });
    expect(lastText(state)).not.toMatch(/chief_complete/);
    expect(lastText(state)).not.toMatch(/chief_delegate \(|chief_forge_init \(/);
    // The original's own Pending line still asks for a revision: two blocked attempts delivered nothing, so it must not offer to complete the first epic.
    const pending = String(await tool(state, "chief_roster", {}, chief.threadId)).split("\n").find((line) => line.includes(`(${planner.threadId})`) && line.startsWith("- planner"));
    expect(pending).toContain(`revises: ${planner.threadId}`);
    expect(pending).not.toContain("chief_complete");
  });

  test("a delivered epic revision refuses another revision with the completion route and starts no planner", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "request_changes");
    const revise = () => tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId }, chief.threadId);
    await revise();
    const revision = await latestPlanner(state);
    await report(state, revision.threadId, epicReport);
    const refusal = await revise().then(() => "", (error) => String(error));
    expect(refusal).toContain("chief_complete");
    expect(refusal).not.toMatch(/chief_delegate|delegate its waves/);
    expect((await status(state)).threads.filter((row) => row.role === "planner")).toHaveLength(2);
  });

  test("a revision that delivered keeps its result: a later blocked report is refused and a second revision starts no planner", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "request_changes");
    const revise = () => tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId }, chief.threadId);
    await revise();
    const revision = await latestPlanner(state);
    await report(state, revision.threadId, epicReport);
    await expect(report(state, revision.threadId, { state: "blocked", blocker: "stuck", recommendation: "retry" })).rejects.toThrow(/delivered/);
    await expect(report(state, revision.threadId, { state: "ready", result: "Epic: https://github.com/o/r/issues/9" })).rejects.toThrow(/delivered/);
    expect(rowOf(state, revision.threadId)).toMatchObject({ last_report_state: "ready", result: epicReport.result });
    await expect(revise()).rejects.toThrow(/chief_complete/);
    expect((await status(state)).threads.filter((row) => row.role === "planner")).toHaveLength(2);
  });

  test("once the approved epic is complete, a stopped advisor's continue and chief_plan revises report the outcome, with no consult or report to wait for", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await latestPlanner(state);
    await report(state, planner.threadId, epicReport);
    await consult(state, chief.threadId, planner.threadId);
    const [first] = await advisors(state);
    await report(state, first!.threadId, { state: "failed", result: "Provider failed." });
    await consult(state, chief.threadId, planner.threadId);
    const [, second] = await advisors(state);
    await report(state, second!.threadId, { state: "ready", result: "Sound.", verdict: "approve" });
    await tool(state, "chief_complete", { threadId: planner.threadId }, chief.threadId);
    expect(rowOf(state, planner.threadId).state).toBe("complete");
    const refuse = (call: Promise<unknown>) => call.then(() => "", (error) => String(error));
    const resumed = await refuse(tool(state, "chief_continue", { threadId: first!.threadId, instruction: "Keep going" }, chief.threadId));
    const revises = await refuse(tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId }, chief.threadId));
    for (const refusal of [resumed, revises]) {
      expect(refusal).toContain("complete");
      expect(refusal).not.toMatch(/chief_consult|ready report|chief_complete \(/);
    }
  });

  test("a reviewed epic keeps its result and completion route: a later ready or blocked report is refused", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "approve");
    const route = lastText(state);
    expect(route).toContain("chief_complete");
    await expect(report(state, planner.threadId, { state: "ready", result: "Epic: https://github.com/o/r/issues/2" })).rejects.toThrow(/review outcome/);
    await expect(report(state, planner.threadId, { state: "blocked", blocker: "stuck", recommendation: "retry" })).rejects.toThrow(/review outcome/);
    expect(rowOf(state, planner.threadId)).toMatchObject({ last_report_state: "ready", result: epicReport.result, plan_review: "approved" });
    expect(lastText(state)).toBe(route);
  });

  test("an approved epic refuses chief_plan revises without a delegate line, and a stopped first advisor's continue points at the epic's outcome", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await latestPlanner(state);
    await report(state, planner.threadId, epicReport);
    await consult(state, chief.threadId, planner.threadId);
    const [first] = await advisors(state);
    await report(state, first!.threadId, { state: "failed", result: "Provider failed." });
    await consult(state, chief.threadId, planner.threadId);
    const [, second] = await advisors(state);
    await report(state, second!.threadId, { state: "ready", result: "Sound.", verdict: "approve" });
    const revises = await tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId }, chief.threadId).then(() => "", (error) => String(error));
    expect(revises).toContain("chief_complete");
    expect(revises).not.toMatch(/Delegate it/);
    const resumed = await tool(state, "chief_continue", { threadId: first!.threadId, instruction: "Keep going" }, chief.threadId).then(() => "", (error) => String(error));
    expect(resumed).toContain("chief_complete");
    expect(resumed).not.toMatch(/delegate the plan/);
  });

  test("an epic revision refuses a second consult without a delegation route, and an inherited epic refuses a branch", async () => {
    const state = await setup();
    const chief = await start(state);
    await epicPlan(state, chief.threadId);
    const planner = await READY_EPIC_ADVISOR(state, chief.threadId, "request_changes");
    await expect(tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId, branch: "feature/x" }, chief.threadId)).rejects.toThrow(/epic/);
    expect((await status(state)).threads.filter((row) => row.role === "planner")).toHaveLength(1);
    await tool(state, "chief_plan", { title: "Checkout epic", mission: "Revise it", revises: planner.threadId }, chief.threadId);
    const revision = await latestPlanner(state);
    await report(state, revision.threadId, epicReport);
    const refusal = await consult(state, chief.threadId, revision.threadId).then(() => "", (error) => String(error));
    expect(refusal).not.toBe("");
    expect(refusal).not.toMatch(/chief_delegate|delegate its waves/);
  });

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

  // Contract: a wave line marks a worker delivered by its ready report, not by its lifecycle state.
  // Regression: a worker that reported ready and then completed reads as undelivered, or a completed one that only reported blocked reads as delivered.
  const waveLine = async (state: State, workerId: string) => String(await state.harness.behavior.callAgentTool("chief_log", {}, { threadId: workerId, projectId: "proj_1" })).split("\n").find((line) => line.startsWith("- wave 1:"))!;
  const wave1Worker = async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1);
    return { state, chief, worker: workerOn(state, planner.threadId, 1) };
  };

  test("a wave line shows a ready or completed worker that reported ready as delivered", async () => {
    const { state, chief, worker } = await wave1Worker();
    await report(state, worker.thread_id, { state: "ready", result: READY });
    expect(await waveLine(state, worker.thread_id)).toContain("delivered");
    await tool(state, "chief_complete", { threadId: worker.thread_id, skipReview: "owner: test" }, chief.threadId);
    expect(rowOf(state, worker.thread_id).state).toBe("complete");
    expect(await waveLine(state, worker.thread_id)).toContain("delivered");
  });

  test("a wave line does not show a worker completed after only a blocked report as delivered", async () => {
    const { state, chief, worker } = await wave1Worker();
    await report(state, worker.thread_id, { state: "blocked", blocker: "stuck", recommendation: "retry" });
    setLive(state, worker.thread_id, "idle");
    await tool(state, "chief_complete", { threadId: worker.thread_id, override: "owner: block abandoned" }, chief.threadId);
    expect(rowOf(state, worker.thread_id)).toMatchObject({ state: "complete", last_report_state: "blocked" });
    expect(await waveLine(state, worker.thread_id)).not.toContain("delivered");
  });
});
