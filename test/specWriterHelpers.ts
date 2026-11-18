import { expect, test } from "vitest";
import { READY, type State, delegateWave, plan, planWaves, readyIdle, report, rowOf, setLive, tool, workerOn } from "./testerHelpers";
import { approvePlan, start, wave } from "./harness";

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

/** Chief + a plan (default: one spec implementation wave). Nothing delegated. */
export async function specPlan(state: State, waves: object[] = [specImpl()], approve = false) {
  const chief = await start(state);
  const planner = await plan(state, chief.threadId, waves);
  // A plan with two or more implementation waves needs its one advisor review first.
  if (approve || waves.filter((entry: any) => !entry.design).length > 1) await approvePlan(state, chief.threadId, planner.threadId);
  return { chief, planner };
}
/** The newest implementation-lane row (worker, designer or a legacy writer that replaced one) and the newest side writer of a wave. */
export const ownerOn = (state: State, planThreadId: string, waveNo: number) =>
  state.db.prepare(`SELECT * FROM managed_threads WHERE plan_thread_id=? AND plan_wave=? AND role='worker' AND (kind IS NULL OR kind<>'spec-writer' OR replaces_thread_id IN (SELECT thread_id FROM managed_threads WHERE kind IS NULL OR kind<>'spec-writer')) ORDER BY rowid DESC`).get(planThreadId, waveNo) as any;
export const writerOn = (state: State, planThreadId: string, waveNo: number) =>
  state.db.prepare(`SELECT * FROM managed_threads WHERE plan_thread_id=? AND plan_wave=? AND kind='spec-writer' ORDER BY rowid DESC`).get(planThreadId, waveNo) as any;
/** Delegates wave `waveNo`'s Spec Writer beside its worker: a side-lane row in its own worktree. */
export const CHAIN = "feature/chain";
export const CHAIN_PR = "https://github.com/o/r/pull/7";
export const delegateWriter = async (state: State, chief: { threadId: string }, planThreadId: string, waveNo = 1, extra: object = {}) => {
  // A head wave's writer takes the chain's branch and PR from chief_forge_init; a later wave's comes from the chain's owner.
  const chain = waveNo === 1 ? { branch: CHAIN, prUrl: CHAIN_PR } : {};
  await delegateWave(state, chief.threadId, planThreadId, waveNo, { kind: "spec-writer", ...chain, ...extra });
  return writerOn(state, planThreadId, waveNo).thread_id as string;
};
/** specPlan with wave 1's worker delegated by the default call (still busy). */
export async function withWorker(state: State, waves?: object[], extra: object = {}) {
  const ctx = await specPlan(state, waves);
  await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR, ...extra });
  return { ...ctx, worker: ownerOn(state, ctx.planner.threadId, 1).thread_id as string };
}
/** specPlan with wave 1's Spec Writer delegated first (still busy); its worker has not started. */
export async function withWriter(state: State, waves?: object[], extra: object = {}) {
  const ctx = await specPlan(state, waves);
  return { ...ctx, writer: await delegateWriter(state, ctx.chief, ctx.planner.threadId, 1, extra) };
}
/** Wave 1's worker, then its Spec Writer beside it, both busy. */
export async function withBoth(state: State, waves?: object[]) {
  const ctx = await withWorker(state, waves);
  return { ...ctx, writer: await delegateWriter(state, ctx.chief, ctx.planner.threadId, 1) };
}
/** The whole parallel chain, every row ready and idle: wave 1's worker and Spec Writer. */
export async function fullChain(state: State, waves?: object[]) {
  const ctx = await withBoth(state, waves);
  await readyIdle(state, ctx.worker);
  await readyIdle(state, ctx.writer);
  return ctx;
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
// The oracle fixtures below were run unchanged against base 6d288a2 to capture test/fixtures/*-6d288a2.txt; only the storage
// root is normalized. On 6d288a2 the baseline heading is plain text, so `baseImpl` is a plain spec wave there.
export const BASELINE = "## Spec baseline\n- docs/specs/totals.md (new): totals.ts `computeTotal`";
/** A spec wave whose body names a new spec file's baseline. */
export const baseImpl = (n = 1, extra: object = {}) => ({ body: wave(n, `Build the totals.\n\n${SPEC_DELTA}\n\n${BASELINE}`) + NOT_DOING, spec: true, ...extra });

// ---- Docs work list world (wave 8 tests) ----
export const CHAIN_B = "feature/chain-b";
export const CHAIN_B_PR = "https://github.com/o/r/pull/8";
/** The `## Docs needed` text each row reports (undefined: the row reports none). */
export type DocsNotes = Partial<Record<"w1" | "w2" | "w3" | "w4" | "w5" | "w6" | "s1", string>>;
/** One plan, two chains whose Spec deltas name the same docs path. Chain A: wave 1 (spec), wave 2 (plain), wave 3 (spec), wave 4 (plain).
 * Chain B: wave 5 (spec), wave 6 (plain). Every row reported ready and idle except chain B's writer when `blockB` is set (it reports blocked last, idle; a string is its blocker text).
 * Wave 1's writer s1 owns waves 1-2, wave 3's s3 owns 3-4, wave 5's s5 owns 5-6. */
export async function docsChains(state: State, notes: DocsNotes = {}, blockB: boolean | string = false) {
  const waves = [specImpl(1), { body: wave(2) + NOT_DOING }, specImpl(3), { body: wave(4) + NOT_DOING }, specImpl(5, { dependsOn: [] }), { body: wave(6) + NOT_DOING }];
  const { chief, planner } = await specPlan(state, waves);
  const P = planner.threadId;
  const done = (id: string, note?: string) => readyIdle(state, id, note === undefined ? READY : `${READY}\n\n## Docs needed\n${note}`);
  const s1 = await delegateWriter(state, chief, P, 1);
  const firstWriterPrompt = state.spawned.at(-1).prompt as string;
  await delegateWave(state, chief.threadId, P, 1, { branch: CHAIN, prUrl: CHAIN_PR });
  const w1 = ownerOn(state, P, 1).thread_id as string;
  await done(w1, notes.w1);
  await delegateWave(state, chief.threadId, P, 2, { replaces: w1 });
  const w2 = ownerOn(state, P, 2).thread_id as string;
  await done(w2, notes.w2);
  await delegateWave(state, chief.threadId, P, 3, { replaces: w2 });
  const w3 = ownerOn(state, P, 3).thread_id as string;
  const s3 = await delegateWriter(state, chief, P, 3);
  await done(w3, notes.w3);
  await done(s1, notes.s1);
  await done(s3);
  await delegateWave(state, chief.threadId, P, 4, { replaces: w3 });
  const w4 = ownerOn(state, P, 4).thread_id as string;
  await done(w4, notes.w4);
  const chainB = { branch: CHAIN_B, prUrl: CHAIN_B_PR };
  await delegateWave(state, chief.threadId, P, 5, chainB);
  const w5 = ownerOn(state, P, 5).thread_id as string;
  const s5 = await delegateWriter(state, chief, P, 5, chainB);
  await done(w5, notes.w5);
  await done(s5);
  await delegateWave(state, chief.threadId, P, 6, { replaces: w5 });
  const w6 = ownerOn(state, P, 6).thread_id as string;
  await done(w6, notes.w6);
  if (blockB) await report(state, s5, { state: "blocked", result: "Cannot write the delta", blocker: typeof blockB === "string" ? blockB : "Delta names no domain", recommendation: "Re-plan" });
  return { chief, planner, P, s1, s3, s5, w1, w2, w3, w4, w5, w6, firstWriterPrompt };
}
/** The prompt of the thread the last chief_delegate spawned. */
export const lastPrompt = (state: State) => state.spawned.at(-1).prompt as string;
/** The `## Docs work list` section of a brief, heading line included, or "" when it has none. */
export const docsWorkList = (prompt: string) => {
  const at = prompt.indexOf("\n## Docs work list");
  return at < 0 ? "" : prompt.slice(at).split("\n## ").slice(0, 2).join("\n## ").trimEnd();
};
