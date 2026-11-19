import { afterEach, describe, expect, test, vi } from "vitest";
import { plan, planWave } from "./test/testerHelpers";
import { delegate, disposeAll, execFileMock, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contract (header badge, `role` rpc): the badge asks which role a thread has. A designer or spec-writer is a worker row
// whose kind names it; a worker row without a kind is "worker"; every other managed role answers its own role; a legacy tester kind answers "worker"; a thread with no
// managed row answers null. Regression: answering the row's role for a kind-bearing worker makes the badge read "Worker".
describe("role rpc", () => {
  const roleOf = async (state: Awaited<ReturnType<typeof setup>>, threadId: string) =>
    ((await state.harness.behavior.callRpc("role", { threadId })) as { role: string | null }).role;

  test.each(["designer", "spec-writer"])("a %s worker row answers its kind", async (kind) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, `${kind} work`, { kind });
    expect(await roleOf(state, worker.threadId)).toBe(kind);
  });

  test("an old kind=tester worker row reads as worker", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.db.prepare(`UPDATE managed_threads SET kind='tester' WHERE thread_id=?`).run(worker.threadId);
    expect(await roleOf(state, worker.threadId)).toBe("worker");
  });

  test("a worker row without a kind answers worker, and chief answers chief", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    expect(await roleOf(state, worker.threadId)).toBe("worker");
    expect(await roleOf(state, chief.threadId)).toBe("chief");
  });

  test("planner, reviewer, advisor and researcher rows answer their own role", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    execFileMock.mockImplementation(async (_file: string, args: string[]) => ({
      stdout: JSON.stringify(args[1] === "run" ? { runId: "wfr_1" } : { status: "succeeded", result: { rows: [], table: "| Item | Finding | Evidence |" } }),
      stderr: "",
    }));
    const planner = await plan(state, chief.threadId, [planWave(1), planWave(2)]);
    await state.harness.behavior.callAgentTool("chief_review", { branch: "feature/x" }, opts);
    await state.harness.behavior.callAgentTool("chief_consult", { planThreadId: planner.threadId, title: "Advice", mission: "Explore" }, opts);
    await state.harness.behavior.callAgentTool("chief_research", { mode: "survey", question: "Who calls this?", design: false, items: ["a.ts"] }, opts);

    const threads = (await status(state)).threads;
    for (const role of ["planner", "reviewer", "advisor", "researcher"]) {
      const row = threads.find((thread: { role: string }) => thread.role === role)!;
      expect(await roleOf(state, row.threadId), role).toBe(role);
    }
  });

  test("a thread with no managed row answers null", async () => {
    const state = await setup();
    await start(state);
    expect(await roleOf(state, "thr_unmanaged")).toBeNull();
  });
});
