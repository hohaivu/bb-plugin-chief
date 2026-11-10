import { expect, test } from "vitest";
import { READY, type State, delegateWave, plan, planWaves, readyIdle, report, rowOf, setLive, tool, workerOn } from "./testerHelpers";
import { TEST_WAVE, approvePlan, start, wave } from "./harness";

export const SPEC_DELTA = "## Spec delta\n- docs/specs/totals.md: CHANGED totals never go negative";
/** An implementation wave that runs a Spec Writer before its worker. */
export const NOT_DOING = "\n\n## What we're NOT doing\n- x";
export const specImpl = (n = 1, extra: object = {}) => ({ body: wave(n, `Build the totals.\n\n${SPEC_DELTA}`) + NOT_DOING, spec: true, ...extra });
export const lastAlert = (state: State) => state.sent.at(-1).input[0].text as string;
export const roster = async (state: State, chiefThreadId: string) => String(await tool(state, "chief_roster", { includeComplete: true }, chiefThreadId));
export const skipSpecs = (state: State, chiefThreadId: string, planThreadId: string, reason = "docs are unchanged", waveNo = 1) =>
  tool(state, "chief_skip_specs", { planThreadId, wave: waveNo, reason }, chiefThreadId);
export const storedWave = (state: State, planThreadId: string, waveNo = 1) => JSON.parse(planWaves(state, planThreadId))[waveNo - 1];
export const swap = async (state: State, chief: { threadId: string }, planThreadId: string, waveNo: number, replaces: string, kind: string) => {
  await delegateWave(state, chief.threadId, planThreadId, waveNo, { replaces, kind });
  return workerOn(state, planThreadId, waveNo).thread_id as string;
};

/** Chief + a plan (default: spec implementation wave 1, then its test wave 2). Nothing delegated. */
export async function specPlan(state: State, waves: object[] = [specImpl(), TEST_WAVE(2)], approve = false) {
  const chief = await start(state);
  const planner = await plan(state, chief.threadId, waves);
  if (approve) await approvePlan(state, chief.threadId, planner.threadId);
  return { chief, planner };
}
/** specPlan with wave 1's Spec Writer delegated by the default call (still busy). */
export async function withWriter(state: State, waves?: object[], extra: object = {}) {
  const ctx = await specPlan(state, waves);
  await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 1, extra);
  return { ...ctx, writer: workerOn(state, ctx.planner.threadId, 1).thread_id as string };
}
/** The whole spec-first chain, every row ready and idle: Spec Writer, wave 1's worker, wave 2's tester. */
export async function fullChain(state: State, waves?: object[]) {
  const ctx = await withWriter(state, waves);
  await readyIdle(state, ctx.writer);
  const worker = await swap(state, ctx.chief, ctx.planner.threadId, 1, ctx.writer, "worker");
  await readyIdle(state, worker);
  const tester = await swap(state, ctx.chief, ctx.planner.threadId, 2, worker, "tester");
  await readyIdle(state, tester);
  return { ...ctx, worker, tester };
}

/** Puts wave 1's Spec Writer into `how`: ready (busy host), ready and idle, blocked and idle, idle with no report, or complete.
 * complete cannot be reached through the public calls (every route refuses it), so the row is forced and the store reloaded. */
export type WriterState = "ready" | "ready and idle" | "blocked" | "idle with no report" | "complete";
export async function putWriter(state: State, chiefThreadId: string, writer: string, how: WriterState) {
  if (how === "ready") await report(state, writer, { state: "ready", result: READY });
  if (how === "ready and idle") await readyIdle(state, writer);
  if (how === "blocked") {
    await report(state, writer, { state: "blocked", result: "Cannot write the delta", blocker: "Delta names no domain", recommendation: "Re-plan" });
    setLive(state, writer, "idle");
  }
  if (how === "idle with no report") {
    setLive(state, writer, "idle");
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(writer)!, lastAssistantText: "Stopped without a report" });
  }
  if (how === "complete") {
    await readyIdle(state, writer);
    state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id=?`).run(writer);
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, chiefThreadId);
  }
  expect(rowOf(state, writer).state).toBe({ ready: "ready", "ready and idle": "ready", blocked: "blocked", "idle with no report": "idle", complete: "complete" }[how]);
}
export const section = (prompt: string, heading: string) => (prompt.split(`\n## ${heading}\n`)[1] ?? "").split("\n## ")[0]!;
// ---- First-touch baseline specs (wave 2 tests) ----
// <baseline-oracle-begin>
// The oracle fixtures below were run unchanged against base 6d288a2 to capture __snapshots__/*-6d288a2.txt; only the storage
// root is normalized. On 6d288a2 the baseline heading is plain text, so `baseImpl` is a plain spec wave there.
export const BASELINE = "## Spec baseline\n- docs/specs/totals.md (new): totals.ts `computeTotal`";
/** A spec wave whose body names a new spec file's baseline. */
export const baseImpl = (n = 1, extra: object = {}) => ({ body: wave(n, `Build the totals.\n\n${SPEC_DELTA}\n\n${BASELINE}`) + NOT_DOING, spec: true, ...extra });
