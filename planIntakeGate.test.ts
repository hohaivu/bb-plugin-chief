import { afterEach, describe, expect, test, vi } from "vitest";
import { PLAN_FIXTURE, chiefReview, delegate, disposeAll, execFileMock, ghHead, rowOf, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contract (plan-1 "plan intake"; docs/specs/report-intake.md, docs/specs/plan-chains.md): a plan is implementation waves only. 1 to 8 waves
// are accepted as a string or an array; the `test` wave flag is refused through the real chief_report tool; the plugin never requires a plan review
// (plan_review stays null whatever the wave count; a `complex` key is stripped, not refused). A persisted legacy test wave (raw `test: true`,
// written before the review gate) is absent, not delegable and not a pending wave; with a worker row on it it is an ordinary wave.
// Everything here runs the real tools; only the forge answer and the legacy plan JSON (written by direct SQL) are seeded.

type State = Awaited<ReturnType<typeof setup>>;
const CTX = (threadId: string) => ({ threadId, projectId: "proj_1" });

async function newPlanner(state: State, chiefId: string, extra: string[] = []) {
  const before = new Set((await status(state)).threads.map((row) => row.threadId));
  const result = await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "Checkout totals fix needs no design discussion", ...extra, "--json"], CTX(chiefId));
  expect(result.exitCode, result.stderr).toBe(0);
  return (await status(state)).threads.find((row) => row.role === "planner" && !before.has(row.threadId))!;
}
const report = (state: State, threadId: string, params: Record<string, unknown>) => state.harness.behavior.callAgentTool("chief_report", params, CTX(threadId));
const waves = (count: number, extra: (n: number) => object = () => ({})) => Array.from({ length: count }, (_, i) => ({ body: i === 0 ? PLAN_FIXTURE : wave(i + 1), ...extra(i + 1) }));

describe("plan intake: wave count and the test flag", () => {
  test.each([
    ["a one-wave string", PLAN_FIXTURE, 1],
    ["a one-wave array", waves(1), 1],
    ["an eight-wave array", waves(8), 8],
  ] as [string, string | object[], number][])("%s is accepted", async (_name, plan, count) => {
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await report(state, planner.threadId, { state: "ready", result: "Planned.", plan });
    expect(JSON.parse(rowOf(state, planner.threadId).plan_waves)).toHaveLength(count);
  });

  test("a nine-wave array is refused and stores nothing", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await expect(report(state, planner.threadId, { state: "ready", result: "Planned.", plan: waves(9) })).rejects.toThrow("plan has 9 waves; max 8. Merge waves.");
    expect(rowOf(state, planner.threadId).plan_waves).toBeNull();
  });

  test.each([[true], [false]])("a wave with test: %s is refused through chief_report, naming the wave", async (flag) => {
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await expect(report(state, planner.threadId, { state: "ready", result: "Planned.", plan: waves(2, (n) => (n === 2 ? { test: flag } : {})) }))
      .rejects.toThrow("plan wave 2:");
    expect(rowOf(state, planner.threadId).plan_waves).toBeNull();
  });
});

describe("plan intake: plan_review", () => {
  test.each([
    ["one wave", waves(1)],
    ["two implementation waves", waves(2)],
    ["one implementation wave and one design wave", waves(2, (n) => (n === 1 ? { design: true } : {}))],
    ["two implementation waves and a design wave", waves(3, (n) => (n === 1 ? { design: true } : {}))],
    ["eight implementation waves", waves(8)],
  ] as [string, object[]][])("%s: plan_review stays null", async (_name, plan) => {
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await report(state, planner.threadId, { state: "ready", result: "Planned.", plan });
    expect(rowOf(state, planner.threadId).plan_review).toBeNull();
  });

  test("a `complex` key on a planner's ready report is neither refused nor stored", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await report(state, planner.threadId, { state: "ready", result: "Planned.", plan: waves(2), complex: true });
    expect(rowOf(state, planner.threadId).plan_review).toBeNull();
    expect(JSON.parse(rowOf(state, planner.threadId).plan_waves)).toHaveLength(2);
  });

  test("a `complex` key on a non-planner report is not refused either", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "active", result: "Working.", complex: true });
    expect(rowOf(state, worker.threadId).state).toBe("active");
  });

  test("a planner ready report resets a stale `required` to null", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await report(state, planner.threadId, { state: "ready", result: "Planned.", plan: waves(2) });
    state.db.prepare("UPDATE managed_threads SET plan_review='required' WHERE thread_id=?").run(planner.threadId);
    await report(state, planner.threadId, { state: "ready", result: "Planned again.", plan: waves(2) });
    expect(rowOf(state, planner.threadId).plan_review).toBeNull();
  });

  test("a revision of a reviewed plan stays null", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await report(state, planner.threadId, { state: "ready", result: "Planned.", plan: waves(2) });
    await state.harness.behavior.callAgentTool("chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan" }, CTX(chief.threadId));
    const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
    await report(state, advisor.threadId, { state: "ready", result: "Split wave 2.", verdict: "request_changes" });
    expect(rowOf(state, planner.threadId).plan_review).toBe("changes");
    await state.harness.behavior.callAgentTool("chief_plan", { title: "Rework checkout", mission: "Revise it", revises: planner.threadId }, CTX(chief.threadId));
    const revision = (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    expect(revision.threadId).not.toBe(planner.threadId);
    await report(state, revision.threadId, { state: "ready", result: "Revised.", plan: waves(2) });
    expect(rowOf(state, revision.threadId).plan_review).toBeNull();
  });
});

// Cutover: a plan persisted as [build, {test: true}] by the build before the review gate. The server never rewrites it: its raw JSON keeps wave 2.
describe("legacy test wave cutover", () => {
  const FORGED = ["--branch", "feature/fix-checkout-totals", "--pr-url", "https://github.com/o/r/pull/7"];

  async function legacyPlan() {
    execFileMock.mockResolvedValue({ stdout: ghHead("feature/fix-checkout-totals"), stderr: "" });
    const state = await setup();
    const chief = await start(state);
    const planner = await newPlanner(state, chief.threadId);
    await report(state, planner.threadId, { state: "ready", result: "Planned.", plan: PLAN_FIXTURE });
    const [build] = JSON.parse(rowOf(state, planner.threadId).plan_waves);
    state.db.prepare("UPDATE managed_threads SET plan_waves=? WHERE thread_id=?").run(JSON.stringify([build, { path: `${build.path}.test`, test: true }]), planner.threadId);
    const opts = ["delegate", "--title", "Fix checkout totals", "--mission", "Do it", "--plan-thread", planner.threadId, "--wave", "1", ...FORGED, "--json"];
    const delegated = JSON.parse((await state.harness.behavior.runCli(opts, CTX(chief.threadId))).stdout!) as { threadId: string };
    return { state, chief, planner, worker: delegated.threadId };
  }

  test("with no row on wave 2 it is absent: nothing pends, the review is not held back, and admission names the review gate", async () => {
    const { state, chief, planner, worker } = await legacyPlan();
    expect(JSON.parse(rowOf(state, planner.threadId).plan_waves)).toHaveLength(2);
    await report(state, worker, { state: "ready", result: "Built totals.\n\n## Deviations from plan\nNone" });
    const next = String((await state.harness.behavior.callAgentTool("chief_roster", {}, CTX(chief.threadId))));
    expect(next).toContain("waves: 1/2 done");
    expect(next).not.toContain("wave: 2");
    await expect(state.harness.behavior.callAgentTool("chief_delegate", { title: "Tests", mission: "Test it", planThreadId: planner.threadId, wave: 2, replaces: worker, kind: "worker" }, CTX(chief.threadId)))
      .rejects.toThrow("Wave 2 is a legacy test wave");
    const review = await chiefReview(state, chief.threadId, { workerThreadId: worker });
    expect(review.created).toBe(true);
  });
});
