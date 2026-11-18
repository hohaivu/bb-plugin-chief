import { afterEach, describe, expect, test, vi } from "vitest";
import { delegateWave, forgeAnswers, openGate, readyIdle, readyImpl, refusal, report, rowOf, setLive, tool, PR_URL } from "./test/testerHelpers";
import { delegate, disposeAll, setup, start } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// The tester role after the review gate: the gate starts its one tester itself, so Chief delegates a tester only for evidence.
describe("tester role", () => {
  // Contract (plan-5 gate admission): once a review gate pinned its targets, a tester cannot replace a target or the gate's own
  // tester; both refusals name the gate's one fix run (kind: worker). Regression: Chief starts a second test writer beside the gate.
  test("a tester replacing a gate target or the gate tester is refused and routed to the gate's fix run", async () => {
    const state = await setup();
    forgeAnswers();
    const { chief, planner, impl } = await readyImpl(state, { branch: "feature/x", prUrl: PR_URL });
    const gate = await openGate(state, chief.threadId, impl);
    const rows = () => (state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get() as { n: number }).n;
    const before = rows();
    expect(await refusal(delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: impl, kind: "tester" }))).toContain(`The review gate pinned ${impl}; fixes go through the gate's fix run.`);
    expect(await refusal(delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: gate.tester_thread_id, kind: "tester" }))).toContain(`replaces: ${gate.tester_thread_id}, kind: worker`);
    expect(rows()).toBe(before);
  });

  // Contract: skipReview completes a ready implementation with no gate, and a one-wave plan completes with it.
  test("skipReview on the only implementation wave completes the plan", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    expect(await tool(state, "chief_complete", { threadId: impl, skipReview: "small change" }, chief.threadId)).toContain("without a review (reason recorded)");
    expect(rowOf(state, impl).state).toBe("complete");
    expect(rowOf(state, planner.threadId).state).toBe("complete");
  });

  // Contract: chief_continue answers a blocked worker in place (same thread, same worktree); a completed row is refused with its replace route.
  test("chief_continue answers a blocked worker in place and refuses a ready one", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = (await delegate(state, chief.threadId)).threadId;
    await report(state, worker, { state: "blocked", result: "Command denied", blocker: "git push is denied", recommendation: "Allow it" });
    setLive(state, worker, "idle");
    const sent = state.sent.length;
    await tool(state, "chief_continue", { threadId: worker, instruction: "Run git push once." }, chief.threadId);
    expect(state.sent).toHaveLength(sent + 1);
    expect(state.sent.at(-1)).toMatchObject({ threadId: worker });
    expect(JSON.stringify(state.sent.at(-1).input)).toContain("Run git push once.");

    const done = (await delegate(state, chief.threadId, "Other work")).threadId;
    await readyIdle(state, done, "Done");
    await expect(tool(state, "chief_continue", { threadId: done, instruction: "More" }, chief.threadId)).rejects.toThrow(`chief_delegate (replaces: ${done}`);
  });
});
