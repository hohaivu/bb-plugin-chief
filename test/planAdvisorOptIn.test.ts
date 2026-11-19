import { afterEach, describe, expect, test, vi } from "vitest";
import { PLAN_FIXTURE, disposeAll, setup, start, status, wave } from "./harness";
import { type State, plan, refusal, report, rowOf, tool } from "./flowHelpers";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (opt-in plan advisor; docs/specs/report-intake.md, docs/software-factory.md): a plan delegates at once. Chief may start one
// advisor with chief_consult (planThreadId). plan_review becomes `required` only after that launch succeeds; forge init and delegate refuse the plan only
// while that advisor is in flight. A stopped advisor or a legacy `required` row blocks nothing. Approve -> delegate; request_changes -> chief_plan (revises).
// Everything runs the real tools; only the host's thread spawn is made to fail where a launch failure is the contract.

const twoWaves = () => [{ body: PLAN_FIXTURE }, { body: wave(2) }];
const consult = (state: State, chiefThreadId: string, planThreadId: string) =>
  tool(state, "chief_consult", { planThreadId, title: "Plan", mission: "Review this plan before delegation" }, chiefThreadId);
const advisors = async (state: State) => (await status(state)).threads.filter((row: { role: string }) => row.role === "advisor");
const forgeInit = (state: State, chiefThreadId: string, planThreadId: string) =>
  tool(state, "chief_forge_init", { title: "Wave 1 work", planThreadId, wave: 1 }, chiefThreadId);
const delegateOne = (state: State, chiefThreadId: string, planThreadId: string) =>
  tool(state, "chief_delegate", { title: "Wave 1 work", mission: "Do it", planThreadId, wave: 1 }, chiefThreadId);
const workerCount = (state: State, planThreadId: string) =>
  (state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE role='worker' AND plan_thread_id=?").get(planThreadId) as { n: number }).n;
const roster = async (state: State) => String((await state.harness.behavior.runCli(["status", "--project", "proj_1"])).stdout);

async function plannedChief(waves: object[] = twoWaves()) {
  const state = await setup();
  const chief = await start(state);
  const planner = await plan(state, chief.threadId, waves);
  return { state, chief, planner };
}

describe("a plan with no review", () => {
  test("a multi-wave plan is forge-initialised and delegated at once, and its ready alert never names chief_consult", async () => {
    const { state, chief, planner } = await plannedChief();
    expect(rowOf(state, planner.threadId).plan_review).toBeNull();
    expect(state.sent.at(-1).input[0].text).not.toContain("chief_consult");
    expect(await forgeInit(state, chief.threadId, planner.threadId)).toContain("Wave 1 work");
    await delegateOne(state, chief.threadId, planner.threadId);
    expect(workerCount(state, planner.threadId)).toBe(1);
  });
});

describe("chief_consult on a plan", () => {
  test("starts an advisor on a plan with no review and sets `required` once it launched", async () => {
    const { state, chief, planner } = await plannedChief();
    await consult(state, chief.threadId, planner.threadId);
    expect(await advisors(state)).toHaveLength(1);
    expect(rowOf(state, planner.threadId).plan_review).toBe("required");
  });

  test("a launch that throws leaves no advisor row and plan_review null, and the plan still delegates", async () => {
    const { state, chief, planner } = await plannedChief();
    state.failNextSpawn();
    await expect(consult(state, chief.threadId, planner.threadId)).rejects.toThrow("spawn refused");
    expect(await advisors(state)).toHaveLength(0);
    expect(rowOf(state, planner.threadId).plan_review).toBeNull();
    await delegateOne(state, chief.threadId, planner.threadId);
  });

  test("while that advisor is in flight, forge init and delegate refuse naming it, and a second consult is refused", async () => {
    const { state, chief, planner } = await plannedChief();
    await consult(state, chief.threadId, planner.threadId);
    const [advisor] = await advisors(state);
    const wait = `Plan ${planner.threadId} is in its one advisor review (${advisor!.threadId}): wait for ${advisor!.threadId}'s report before chief_forge_init or chief_delegate.`;
    expect(await refusal(forgeInit(state, chief.threadId, planner.threadId))).toContain(wait);
    expect(await refusal(delegateOne(state, chief.threadId, planner.threadId))).toContain(wait);
    await expect(consult(state, chief.threadId, planner.threadId)).rejects.toThrow();
    expect(await advisors(state)).toHaveLength(1);
    expect(await roster(state)).toContain(`plan review: in review (${advisor!.threadId})`);
  });

  test("plan intake refuses a replacement during review and preserves the eventual decision on resubmission", async () => {
    const { state, chief, planner } = await plannedChief();
    await consult(state, chief.threadId, planner.threadId);
    const [advisor] = await advisors(state);
    const original = rowOf(state, planner.threadId);
    const replacement = { state: "ready", result: "Simplified plan.", plan: PLAN_FIXTURE };

    expect(await refusal(report(state, planner.threadId, replacement))).toContain(`(${advisor!.threadId}); wait for its report`);
    expect(rowOf(state, planner.threadId).plan_waves).toBe(original.plan_waves);
    expect(rowOf(state, planner.threadId).plan_review).toBe("required");

    await report(state, advisor!.threadId, { state: "ready", result: "Revisit the plan.", verdict: "request_changes" });
    await report(state, planner.threadId, replacement);
    expect(JSON.parse(rowOf(state, planner.threadId).plan_waves)).toHaveLength(1);
    expect(rowOf(state, planner.threadId).plan_review).toBe("changes");
    expect(await refusal(delegateOne(state, chief.threadId, planner.threadId))).toContain("chief_plan");
  });

  test("a stopped advisor blocks nothing: the plan delegates, the roster says `consulted, no advice`, and a fresh consult may start", async () => {
    const { state, chief, planner } = await plannedChief();
    await consult(state, chief.threadId, planner.threadId);
    const [advisor] = await advisors(state);
    await report(state, advisor!.threadId, { state: "failed", result: "Provider failed." });
    expect(rowOf(state, planner.threadId).plan_review).toBe("required");
    expect(await roster(state)).toContain("plan review: consulted, no advice");
    await consult(state, chief.threadId, planner.threadId);
    expect(await advisors(state)).toHaveLength(2);
    const [, second] = await advisors(state);
    await report(state, second!.threadId, { state: "failed", result: "Provider failed again." });
    await delegateOne(state, chief.threadId, planner.threadId);
    expect(workerCount(state, planner.threadId)).toBe(1);
  });

  test("an approve ends the wait and gives the delegate line; a second consult is refused as already reviewed", async () => {
    const { state, chief, planner } = await plannedChief();
    await consult(state, chief.threadId, planner.threadId);
    const [advisor] = await advisors(state);
    await report(state, advisor!.threadId, { state: "ready", result: "The plan is sound.", verdict: "approve" });
    expect(rowOf(state, planner.threadId).plan_review).toBe("approved");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_delegate (planThreadId: ${planner.threadId}, wave: 1`);
    expect(await refusal(consult(state, chief.threadId, planner.threadId))).toContain("already had its one review");
    await delegateOne(state, chief.threadId, planner.threadId);
  });

  test("request_changes gives `changes`: delegate refuses with the chief_plan (revises) route, and a second consult is refused", async () => {
    const { state, chief, planner } = await plannedChief();
    await consult(state, chief.threadId, planner.threadId);
    const [advisor] = await advisors(state);
    await report(state, advisor!.threadId, { state: "ready", result: "Split wave 2.", verdict: "request_changes" });
    expect(rowOf(state, planner.threadId).plan_review).toBe("changes");
    expect(await refusal(delegateOne(state, chief.threadId, planner.threadId))).toContain(`chief_plan`);
    expect(await refusal(consult(state, chief.threadId, planner.threadId))).toContain("already had its one review");
  });

  test("a revision planner is refused a consult, and its waves delegate with no review", async () => {
    const { state, chief, planner } = await plannedChief();
    await consult(state, chief.threadId, planner.threadId);
    const [advisor] = await advisors(state);
    await report(state, advisor!.threadId, { state: "ready", result: "Split wave 2.", verdict: "request_changes" });
    await tool(state, "chief_plan", { title: "Rework checkout", mission: "Revise it", revises: planner.threadId }, chief.threadId);
    const revision = (await status(state)).threads.filter((row: { role: string }) => row.role === "planner").at(-1)!;
    await report(state, revision.threadId, { state: "ready", result: "Revised.", plan: twoWaves() });
    expect(rowOf(state, revision.threadId).plan_review).toBeNull();
    expect(await refusal(consult(state, chief.threadId, revision.threadId))).toContain("a revision gets no review");
    await delegateOne(state, chief.threadId, revision.threadId);
  });
});
