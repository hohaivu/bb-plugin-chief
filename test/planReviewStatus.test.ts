import { afterEach, describe, expect, test, vi } from "vitest";
import { PLAN_FIXTURE, disposeAll, setup, start, status, wave } from "./harness";
import { type State, plan, report, rowOf, tool } from "./flowHelpers";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (src/plan/planReview.ts owns the planner review state): a blocked revision never counts as delivered, a delivered revision
// closes further revisions, and a plan in advisor review refuses a new plan report. Rows and launch counts only; no wording is pinned.

const consult = (state: State, chiefThreadId: string, planThreadId: string) =>
  tool(state, "chief_consult", { planThreadId, title: "Plan", mission: "Review this plan" }, chiefThreadId);
const planners = async (state: State) => (await status(state)).threads.filter((row) => row.role === "planner");
const revise = (state: State, chiefThreadId: string, planThreadId: string) =>
  tool(state, "chief_plan", { title: "Plan", mission: "Revise per the advisor", revises: planThreadId }, chiefThreadId);
const reviewed = async (state: State, chiefThreadId: string, planThreadId: string) => {
  await consult(state, chiefThreadId, planThreadId);
  const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
  await report(state, advisor.threadId, { state: "ready", result: "Reviewed.", verdict: "request_changes" });
};

describe("planner review status", () => {
  test("a task plan: a blocked revision allows one retry, the delivered revision completes the original, and nothing revises again", async () => {
    const state = await setup();
    const chief = await start(state);
    const original = await plan(state, chief.threadId);
    await reviewed(state, chief.threadId, original.threadId);

    const before = state.spawned.length;
    await revise(state, chief.threadId, original.threadId);
    const first = (await planners(state)).at(-1)!;
    await report(state, first.threadId, { state: "blocked", blocker: "no access", recommendation: "retry" });
    await revise(state, chief.threadId, original.threadId);
    expect(state.spawned.length).toBe(before + 2);
    expect(rowOf(state, first.threadId).state).toBe("complete");

    const second = (await planners(state)).at(-1)!;
    expect(second.threadId).not.toBe(first.threadId);
    await report(state, second.threadId, { state: "ready", result: "Revised.", plan: [{ body: PLAN_FIXTURE }] });
    expect(rowOf(state, original.threadId).state).toBe("complete");

    const after = state.spawned.length;
    await expect(revise(state, chief.threadId, original.threadId)).rejects.toThrow();
    expect(state.spawned.length).toBe(after);
  });

  test("an epic: a blocked revision allows one retry, the delivered revision keeps its result, and nothing revises again", async () => {
    const state = await setup();
    const chief = await start(state);
    await tool(state, "chief_plan", { title: "Epic", mission: "Plan the epic", undesignedReason: "small", epic: true }, chief.threadId);
    const original = (await planners(state)).at(-1)!;
    await report(state, original.threadId, { state: "ready", result: "Epic: https://github.com/o/r/issues/1" });
    await reviewed(state, chief.threadId, original.threadId);

    const before = state.spawned.length;
    await revise(state, chief.threadId, original.threadId);
    const first = (await planners(state)).at(-1)!;
    await report(state, first.threadId, { state: "blocked", blocker: "no access", recommendation: "retry" });
    await revise(state, chief.threadId, original.threadId);
    expect(state.spawned.length).toBe(before + 2);

    const second = (await planners(state)).at(-1)!;
    const result = "Epic: https://github.com/o/r/issues/2";
    await report(state, second.threadId, { state: "ready", result });
    await expect(report(state, second.threadId, { state: "ready", result: "Epic: https://github.com/o/r/issues/3" })).rejects.toThrow();
    await expect(report(state, second.threadId, { state: "blocked", blocker: "stuck", recommendation: "retry" })).rejects.toThrow();
    expect(rowOf(state, second.threadId)).toMatchObject({ result, last_report_state: "ready" });

    const after = state.spawned.length;
    await expect(revise(state, chief.threadId, original.threadId)).rejects.toThrow();
    expect(state.spawned.length).toBe(after);
  });

  test("a ready task plan in advisor review refuses a new plan report and keeps its waves", async () => {
    const state = await setup();
    const chief = await start(state);
    const original = await plan(state, chief.threadId);
    await consult(state, chief.threadId, original.threadId);
    expect(rowOf(state, original.threadId).plan_review).toBe("required");

    const waves = rowOf(state, original.threadId).plan_waves;
    const launched = state.spawned.length;
    await expect(report(state, original.threadId, { state: "ready", result: "Again.", plan: [{ body: wave(1) }] })).rejects.toThrow();
    expect(rowOf(state, original.threadId).plan_waves).toBe(waves);
    expect(state.spawned.length).toBe(launched);
  });
});
