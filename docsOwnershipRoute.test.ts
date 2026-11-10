import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { disposeAll, setup } from "./test/harness";
import { type State, delegateWave, planWave, readyIdle, refusal, review, reviewed, rowOf, tick, tool, workerOn } from "./test/testerHelpers";
import { skipSpecs, specPlan, swap, withBoth } from "./test/specWriterHelpers";
import { TEST_WAVE } from "./test/harness";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts C10 and C11 (plan wave 1, "Only the Spec Writer edits docs/ everywhere"), through chief_delegate -> admitDelegation -> startWorker and the
// completion tool: a Spec Writer that replaces the chain's current implementation row is admitted on every non-design wave, runs in the owner's own
// environment, is implementation lane (it cannot complete alone) and is no retest fix. The admission matrix itself is pinned in planLifecycle.test.ts.
describe("an implementation-lane Spec Writer on any wave", () => {
  const CASES: [string, (state: State) => Promise<{ chief: { threadId: string }; planner: { threadId: string }; owner: string; wave: number }>][] = [
    ["a non-spec wave", async (state) => {
      const { chief, planner } = await specPlan(state, [planWave(1), TEST_WAVE(2)]);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      return { chief, planner, owner: workerOn(state, planner.threadId, 1).thread_id as string, wave: 1 };
    }],
    ["a spec wave Chief bypassed", async (state) => {
      const { chief, planner } = await specPlan(state);
      await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      return { chief, planner, owner: workerOn(state, planner.threadId, 1).thread_id as string, wave: 1 };
    }],
    ["a test wave", async (state) => {
      const { chief, planner } = await specPlan(state, [planWave(1), TEST_WAVE(2)]);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      const worker = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, worker);
      return { chief, planner, owner: await swap(state, chief, planner.threadId, 2, worker, "tester"), wave: 2 };
    }],
    ["a spec wave whose prior is the worker, with its side-lane writer still live", async (state) => {
      const { chief, planner, worker } = await withBoth(state);
      return { chief, planner, owner: worker, wave: 1 };
    }],
  ];

  test.each(CASES)("%s: admitted in the owner's environment and never completes alone", async (_label, build) => {
    const state = await setup();
    const { chief, planner, owner, wave } = await build(state);
    await readyIdle(state, owner);
    await delegateWave(state, chief.threadId, planner.threadId, wave, { replaces: owner, kind: "spec-writer" });
    const docs = state.spawned.at(-1);
    const row = state.db.prepare(`SELECT * FROM managed_threads WHERE kind='spec-writer' AND replaces_thread_id=?`).get(owner) as any;
    expect(row).toMatchObject({ role: "worker", plan_wave: wave });
    // The owner's worktree is reused: one environment, one branch, no second checkout beside a live side writer.
    expect(docs.environment).toEqual({ type: "reuse", environmentId: state.live.get(owner)!.environmentId });
    expect(state.live.get(row.thread_id)!.environmentId).toBe(state.live.get(owner)!.environmentId);
    expect(row.branch).toBe(rowOf(state, owner).branch);

    await readyIdle(state, row.thread_id);
    const message = await refusal(tool(state, "chief_complete", { threadId: row.thread_id, skipReview: "docs only" }, chief.threadId));
    expect(message).toMatch(new RegExp(`^Refusing to complete ${row.thread_id}: a Spec Writer's docs need (their worker|a test rerun) — chief_delegate \\(`));
    expect(rowOf(state, row.thread_id).state).toBe("ready");
  });

  test("a docs repair after a rejection is no retest fix: its review is not refused for a tester rerun", async () => {
    const state = await setup();
    const { chief, planner } = await specPlan(state, [planWave(1), TEST_WAVE(2)]);
    await delegateWave(state, chief.threadId, planner.threadId, 1);
    const worker = workerOn(state, planner.threadId, 1).thread_id as string;
    await readyIdle(state, worker);
    const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
    await readyIdle(state, tester);
    await reviewed(state, chief.threadId, tester, "request_changes");
    await tick();
    const docs = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
    await readyIdle(state, docs);
    await tick();
    expect(await review(state, chief, docs)).toMatch(/^Started “Review · Wave 2”/);
  });
});
