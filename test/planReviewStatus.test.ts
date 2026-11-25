import { afterEach, describe, expect, test, vi } from "vitest";
import { PLAN_FIXTURE, disposeAll, setup, start, status, wave } from "./harness";
import { type State, plan, report, rowOf, tool } from "./flowHelpers";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";
import { createPlanReview } from "../src/plan/planReview";

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

  const activeIdle = async (state: Awaited<ReturnType<typeof setup>>, id: string) => {
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...state.live.get(id)!, status: "active" } });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...state.live.get(id)!, status: "idle" }, lastAssistantText: "stopped" });
  };

  test("an advisor that ended its turn without advice still holds the review; archiving it frees chief_consult", async () => {
    const state = await setup();
    const chief = await start(state);
    const original = await plan(state, chief.threadId);
    await consult(state, chief.threadId, original.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await activeIdle(state, advisor.threadId);

    const launched = state.spawned.length;
    await expect(consult(state, chief.threadId, original.threadId)).rejects.toThrow();
    expect(state.spawned.length).toBe(launched);

    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(advisor.threadId)! });
    await consult(state, chief.threadId, original.threadId);
    expect(state.spawned.length).toBe(launched + 1);
  });

  test("a delivered epic revision that went active and idle again still refuses another revision", async () => {
    const state = await setup();
    const chief = await start(state);
    await tool(state, "chief_plan", { title: "Epic", mission: "Plan the epic", undesignedReason: "small", epic: true }, chief.threadId);
    const original = (await planners(state)).at(-1)!;
    await report(state, original.threadId, { state: "ready", result: "Epic: https://github.com/o/r/issues/1" });
    await reviewed(state, chief.threadId, original.threadId);
    await revise(state, chief.threadId, original.threadId);
    const revision = (await planners(state)).at(-1)!;
    await report(state, revision.threadId, { state: "ready", result: "Epic: https://github.com/o/r/issues/2" });
    await activeIdle(state, revision.threadId);

    const launched = state.spawned.length;
    await expect(revise(state, chief.threadId, original.threadId)).rejects.toThrow();
    expect(state.spawned.length).toBe(launched);
  });

  test("a task plan whose advisor ended its turn without advice refuses a new plan report", async () => {
    const state = await setup();
    const chief = await start(state);
    const original = await plan(state, chief.threadId);
    await consult(state, chief.threadId, original.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await activeIdle(state, advisor.threadId);

    const waves = rowOf(state, original.threadId).plan_waves;
    await expect(report(state, original.threadId, { state: "ready", result: "Again.", plan: [{ body: wave(1) }] })).rejects.toThrow();
    expect(rowOf(state, original.threadId).plan_waves).toBe(waves);
  });
});

// The module against bare rows: values the tools never write still read as main read them (baseline f639f4c).
describe("planner review over odd rows", () => {
  const row = (over: Record<string, unknown>) => ({ thread_id: "p", role: "planner", state: "ready", created_at: 1, plan_thread_id: null, plan_waves: null, plan_epic: null, plan_review: null, replaces_thread_id: null, last_report_state: null, advised_at: null, ...over });
  const review = (rows: ReturnType<typeof row>[]) => createPlanReview(() => rows, (id) => rows.find((r) => r.thread_id === id), (s) => s === "active");
  const advisor = row({ thread_id: "a", role: "advisor", state: "ready", plan_thread_id: "p", advised_at: 5 });

  test("an unrecognized review value is no review outcome: no revision, no refusal line, roster keeps the changes fallback", () => {
    const planner = row({ plan_waves: "[]", plan_review: "weird" });
    const m = review([planner, advisor]);
    expect(m.revisionRefusal(planner).kind).toBe("notChanges");
    expect(m.status(planner).review.kind).toBe("unrecognized");
    expect(m.revisionRefusal({ ...planner, plan_review: "changes" }).kind).toBe("ok");
  });

  test("an epic planner is worth a next action without a ready last report, though it has no reviewable result", () => {
    const epic = row({ plan_epic: 1, last_report_state: null });
    const m = review([epic]);
    expect(m.hasPlan(epic)).toBe(true);
    expect(m.hasResult(epic)).toBe(false);
  });

  test("a complete epic revision whose last report is blocked is not a delivered revision, even with waves", () => {
    const epic = row({ plan_epic: 1, plan_review: "changes", state: "ready", last_report_state: "ready" });
    const revision = row({ thread_id: "r", replaces_thread_id: "p", plan_epic: 1, plan_waves: "[]", state: "complete", last_report_state: "blocked" });
    const m = review([epic, advisor, revision]);
    expect(m.revisions("p").delivered).toBeUndefined();
    expect(m.revisionRefusal(epic).kind).toBe("ok");
  });
});
