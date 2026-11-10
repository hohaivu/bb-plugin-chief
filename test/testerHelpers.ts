import { test } from "vitest";
import { checkPlan } from "../reportIntake";
import { PLAN_FIXTURE, TEST_WAVE, setup, status, wave } from "./harness";

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
export async function reviewed(state: State, chiefThreadId: string, targetId: string, verdict: "approve" | "request_changes") {
  await tool(state, "chief_review", { workerThreadId: targetId }, chiefThreadId);
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

