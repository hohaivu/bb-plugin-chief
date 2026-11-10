import { test } from "vitest";
import { checkPlan } from "../src/report/reportIntake";
import { PLAN_FIXTURE, TEST_WAVE, approvePlan, delegate, setup, start, status, wave } from "./harness";

export type State = Awaited<ReturnType<typeof setup>>;
export const ctxOf = (state: State, chiefThreadId: string) => ({ threadId: chiefThreadId, projectId: state.live.get(chiefThreadId)!.projectId });
export const tool = (state: State, name: string, params: object, chiefThreadId: string) =>
  state.harness.behavior.callAgentTool(name, params, ctxOf(state, chiefThreadId)) as Promise<any>;
export const report = (state: State, threadId: string, params: object) =>
  state.harness.behavior.callAgentTool("chief_report", params, { threadId, projectId: "proj_1" }) as Promise<any>;
export const rowOf = (state: State, threadId: string) => state.db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(threadId) as any;
export const setLive = (state: State, threadId: string, status: string) => state.live.set(threadId, { ...state.live.get(threadId)!, status } as any);

/** A planner whose ready report carries `waves` (default: one implementation wave, then its test wave). */
export async function plan(state: State, chiefThreadId: string, waves: object[] = [{ body: PLAN_FIXTURE }, TEST_WAVE(2)]) {
  await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chiefThreadId));
  const planner = (await status(state)).threads.filter((row) => row.role === "planner" && row.chiefThreadId === chiefThreadId).at(-1)!;
  await report(state, planner.threadId, { state: "ready", result: "Waves written.", plan: waves });
  return planner;
}

export const delegateWave = (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, extra: object = {}) =>
  tool(state, "chief_delegate", { title: `Wave ${waveNo}`, mission: "Do the wave.", planThreadId, wave: waveNo, ...extra }, chiefThreadId);

// A plan worker's ready report must carry a Deviations heading.
export const READY = "Done.\n\n## Deviations from plan\nNone";
/** The newest worker row on a plan wave. */
export const workerOn = (state: State, planThreadId: string, waveNo: number) =>
  state.db.prepare(`SELECT * FROM managed_threads WHERE plan_thread_id=? AND plan_wave=? AND role='worker' ORDER BY rowid DESC`).get(planThreadId, waveNo) as any;
export const planWaves = (state: State, planThreadId: string) =>
  (state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planThreadId) as { plan_waves: string }).plan_waves;

// Contract: checkPlan accepts a plan iff it is an array, every chain tip is test: true, every test wave is a
// non-head tip whose parent is neither design nor test, and no wave is both. Regression: dropping any one rule
// (e.g. the tip check) lets a plan without a test wave through; the table pins each rule's own refusal.
// Existing checkPlan cases only cover plans without test waves, so none exercises these rules.
export const planWave = (n: number, extra: object = {}) => ({ body: n === 1 ? PLAN_FIXTURE : wave(n), ...extra });
/** Chief reviews `targetId`; its reviewer reports `verdict`. Returns the alert Chief received. */
export async function reviewed(state: State, chiefThreadId: string, targetId: string, verdict: "approve" | "request_changes", extra: object = {}) {
  await tool(state, "chief_review", { workerThreadId: targetId, ...extra }, chiefThreadId);
  const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer" && row.workerThreadId === targetId && row.state !== "complete").at(-1)!;
  await report(state, reviewer.threadId, {
    state: "ready", result: "The discount is still applied twice", verdict,
    findings: verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "The discount is applied twice", fix: "Apply it once" }],
  });
  return state.sent.at(-1).input[0].text as string;
}
export const readyIdle = async (state: State, threadId: string, result = READY) => { await report(state, threadId, { state: "ready", result }); setLive(state, threadId, "idle"); };

/** Two non-test waves make the plan's one advisor review a prerequisite of delegation. */
export const wavePaths = (state: State, planThreadId: string) => (JSON.parse(planWaves(state, planThreadId)) as { path: string }[]).map((entry) => entry.path);


/** A real ms boundary: verdict and row times are Date.now(), and a fix only counts when created strictly after the rejection. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 3));

/** Executes the `index`th chief_delegate call a refusal or alert text advertises (the route sweep): the text is the only source of its parameters. */
export async function followRoute(state: State, chiefThreadId: string, text: string, index = 0, mission = "Rerun the tests.") {
  const call = [...text.matchAll(/chief_delegate \(([^)]*)\)/g)][index];
  if (!call) throw new Error(`no chief_delegate route #${index} in: ${text}`);
  const params = Object.fromEntries(call[1]!.split(", ").map((pair) => { const [key, value] = pair.split(": "); return [key, key === "wave" ? Number(value) : value]; }));
  const before = new Set((await status(state)).threads.map((row) => row.threadId));
  await tool(state, "chief_delegate", { title: "Route", mission, ...params }, chiefThreadId);
  const created = (await status(state)).threads.filter((row) => !before.has(row.threadId));
  return { params, thread: created.at(-1)!.threadId as string };
}
export const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };

/** Chief + a [implementation, test] plan with wave 1 delegated, ready and idle. */
export async function readyImpl(state: State, wave1: object = {}) {
  const chief = await start(state);
  const planner = await plan(state, chief.threadId);
  await delegateWave(state, chief.threadId, planner.threadId, 1, wave1);
  const impl = workerOn(state, planner.threadId, 1);
  await report(state, impl.thread_id, { state: "ready", result: READY });
  setLive(state, impl.thread_id, "idle");
  return { chief, planner, impl: impl.thread_id as string };
}

/** The same plan with the tester delegated on wave 2 (still busy: the fake host starts it active). */
export async function withTester(state: State) {
  const ctx = await readyImpl(state);
  await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: ctx.impl });
  return { ...ctx, tester: workerOn(state, ctx.planner.threadId, 2).thread_id as string };
}

/** Plan [impl, test]; the test wave's tester T0 is rejected by a review and fixed by F, which is ready and idle: F owes a tester rerun. */
export async function fixedAfterRejection(state: State, wave1: object = {}) {
  const ctx = await readyImpl(state, wave1);
  await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: ctx.impl });
  const tester = workerOn(state, ctx.planner.threadId, 2).thread_id as string;
  await readyIdle(state, tester);
  await reviewed(state, ctx.chief.threadId, tester, "request_changes");
  await tick();
  await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: tester, kind: "worker" });
  const fix = workerOn(state, ctx.planner.threadId, 2).thread_id as string;
  await readyIdle(state, fix);
  await tick();
  return { ...ctx, oldTester: tester, fix };
}
export const review = (state: State, chief: { threadId: string }, workerThreadId: string, extra: object = {}) => tool(state, "chief_review", { workerThreadId, ...extra }, chief.threadId);
export const rerunRoute = (planner: { threadId: string }, wave: number, replaces: string) => `chief_delegate (planThreadId: ${planner.threadId}, wave: ${wave}, replaces: ${replaces}, kind: tester)`;
export const reviewerCount = async (state: State) => (await status(state)).threads.filter((row) => row.role === "reviewer").length;

/** An unplanned task rejected once and fixed by F (a persisted normal worker, kind NULL), ready and idle: F owes a tester rerun. */
export async function unplannedFix(state: State, first: object = {}) {
  const chief = await start(state);
  const worker = await delegate(state, chief.threadId, "Fix totals", first);
  await readyIdle(state, worker.threadId, "Done");
  await reviewed(state, chief.threadId, worker.threadId, "request_changes");
  await tick();
  const fix = (await delegate(state, chief.threadId, "Fix", { replaces: worker.threadId })).threadId;
  await readyIdle(state, fix, "Fixed");
  await tick();
  return { chief, first: worker.threadId, fix };
}
export const unplannedRoute = (replaces: string) => `chief_delegate (replaces: ${replaces}, kind: tester)`;

/** Two independent chains [1, 2 test] and [3, 4 test], every row ready and idle; one review rejects both, and both chains are fixed (FA on wave 2, FB on wave 4). */
export async function twoRejectedChains(state: State) {
  const chief = await start(state);
  const planner = await plan(state, chief.threadId, [planWave(1), TEST_WAVE(2), planWave(3, { dependsOn: [] }), TEST_WAVE(4, [3])]);
  await approvePlan(state, chief.threadId, planner.threadId);
  const ready = async (waveNo: number, extra: object) => {
    await delegateWave(state, chief.threadId, planner.threadId, waveNo, extra);
    const row = workerOn(state, planner.threadId, waveNo).thread_id as string;
    await readyIdle(state, row);
    return row;
  };
  const implA = await ready(1, { branch: "feature/a" });
  const testA = await ready(2, { replaces: implA });
  const implB = await ready(3, { branch: "feature/b" });
  const testB = await ready(4, { replaces: implB });
  await reviewed(state, chief.threadId, testA, "request_changes");
  await tick();
  const fixA = await ready(2, { replaces: testA, kind: "worker" });
  const fixB = await ready(4, { replaces: testB, kind: "worker" });
  await tick();
  return { chief, planner, fixA, fixB };
}

