import { afterEach, describe, expect, test, vi } from "vitest";
import { readyIdle, tool } from "./test/testerHelpers";
import { HEAD_SHA, disposeAll, execFileMock, reviewContextOf, setup, start } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  describe("Spec Writer role", () => {
    // A host lookup that never answers does not hold chief_review (#177): the impact slice's 30 s deadline covers its own
    // lookup, and the gate launches with the skip reason in review-context.md. Regression: a host lookup without a deadline holds the call forever (no reviewer).
    test("review attempt: a pending host lookup skips the impact slice, and chief_review still launches the gate", async () => {
      const PR = "https://github.com/acme/shop/pull/8";
      let held = false;
      let lookups = 0;
      const state = await setup({
        projectPath: "/oracle/checkout",
        system: { usageLimits: async () => ({}), config: () => held && ++lookups === 2 ? new Promise(() => {}) : Promise.resolve({ primaryHostId: "host_1" }) },
      });
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: HEAD_SHA, baseRefName: "main" }), stderr: "" };
        return { stdout: "", stderr: "" };
      });
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", branch: "feature/x", prUrl: PR }, chief);
      const w1 = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, w1);
      held = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        let settled = false;
        const call = tool(state, "chief_review", { workerThreadId: w1 }, chief).finally(() => { settled = true; });
        const step = async (seconds: number) => {
          for (let i = 0; i < seconds; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await new Promise((resolve) => setImmediate(resolve));
          }
        };
        await step(60);
        const reply = await call;
        expect(settled).toBe(true);
        expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'`).get()).toEqual({ n: 1 });
        expect(reply).toContain("Started reviewer");
        const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer'`).get() as any).thread_id as string;
        expect(await reviewContextOf(state, reviewer)).toMatch(/## Impact slice\nSkipped: /);
      } finally { vi.useRealTimers(); }
    }, 120_000);

    // Handler contract: chief_review is Chief-only. The review attempt module no longer guards its caller, so the real
    // handler's requireChiefCaller is the only refusal. Regression: dropping or moving that guard lets a worker (or an
    // unregistered thread) start a reviewer.
    test("review attempt: chief_review is refused for a managed worker and an unregistered caller, with no reviewer started", async () => {
      const state = await setup();
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture" }, chief);
      const w1 = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, w1);
      const spawnedBefore = state.spawned.length;
      const asCaller = (threadId: string) => state.harness.behavior.callAgentTool("chief_review", { workerThreadId: w1 }, { threadId, projectId: "proj_1" });
      await expect(asCaller(w1)).rejects.toThrow("chief_review is for the active Chief only: a managed worker reports ready with chief_report, and Chief starts the review.");
      await expect(asCaller("thr_unregistered")).rejects.toThrow("chief_review is for the active Chief only: ask the active Chief to start it.");
      expect(state.spawned).toHaveLength(spawnedBefore);
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'`).get()).toEqual({ n: 0 });
    });
  });
});
