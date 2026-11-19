import { afterEach, describe, expect, test, vi } from "vitest";
import { type State } from "./flowHelpers";
import { delegate, disposeAll, execFileMock, setup, start } from "./harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);
describe("cleanup worktree sharing", () => {
  // Contracts (plan chains, wave 2): chain tasks share one worktree, so of the cleanup jobs on one environment exactly one
  // owns each action (branch deletion, teardown-trouble alert, teardown-stuck alert); the rest end at storage, silent.
  describe("cleanup of jobs sharing one worktree", () => {
    const HOUR = 60 * 60_000;
    type Env = { phase: "destroyed" | "destroying" | "active"; trouble?: boolean };
    const envOf = ({ phase, trouble }: Env, environmentId: string) => ({
      id: environmentId, hostId: "host_1", workspaceProvisionType: "managed-worktree", isWorktree: true, branchName: "bb/shared",
      status: phase === "destroyed" ? "destroyed" : "ready",
      hostLifecycle: phase === "destroyed" ? "removed" : trouble ? "cleanup-failed" : "ready",
      lifecycle: { phase, teardown: trouble ? { status: "failed", message: "Needs recovery: git worktree remove failed" } : { status: "running" } },
    });
    /** `count` archived workers whose cleanup jobs wait at the teardown step on the one environment `env_shared` (a chain's worktree). */
    async function sharedJobs(state: State, count: number, reads: (call: number) => Env) {
      let call = 0;
      state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => envOf(reads(call++), environmentId));
      await state.harness.behavior.setSettings({ cleanupApproved: true });
      const chief = await start(state);
      const archivedAt = Date.now() - 2 * HOUR;
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = (await delegate(state, chief.threadId, `Chain wave ${i + 1}`)).threadId;
        ids.push(id);
        state.live.set(id, { ...state.live.get(id)!, archivedAt } as any);
        state.db.prepare(`INSERT INTO cleanup_jobs (thread_id, chief_thread_id, project_id, environment_id, branch, step, step_at, archived_at, created_at, updated_at)
          VALUES (?, ?, 'proj_1', 'env_shared', ?, 'teardown', ?, ?, ?, ?)`).run(id, chief.threadId, `bb/${id}`, archivedAt, archivedAt, 1_000 + i, 1_000 + i);
      }
      return ids;
    }
    const job = (state: State, id: string) => state.db.prepare(`SELECT step, outcome FROM cleanup_jobs WHERE thread_id=?`).get(id) as { step: string; outcome: string | null };
    const alerts = (state: State, kind: string) => state.db.prepare(`SELECT source_thread_id FROM alert_outbox WHERE dedupe_key LIKE ?`).all(`%:${kind}:alert`) as { source_thread_id: string }[];
    const claims = (state: State) => state.db.prepare(`SELECT action, thread_id FROM cleanup_environment_claims WHERE environment_id='env_shared' ORDER BY action`).all();

    test("three jobs on a destroyed environment: one owns the branch, the others end at storage with no alert", async () => {
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
      const state = await setup({ projectPath: "/repo/proj1" });
      state.harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
      const [first, second, third] = await sharedJobs(state, 3, () => ({ phase: "destroyed" }));
      await state.supervisorCycle();
      expect(job(state, first!)).toMatchObject({ step: "branch" });
      for (const id of [second!, third!]) expect(job(state, id)).toEqual({ step: "storage", outcome: `worktree shared: branch handled by ${first}` });
      expect(claims(state)).toEqual([{ action: "branch", thread_id: first }]);
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key LIKE '%cleanup-%'`).get()).toEqual({ n: 0 });
      // The next pass runs the owner's branch step: only its bb/ branch is looked up (and deleted), never the others'.
      await state.supervisorCycle();
      const branchCalls = execFileMock.mock.calls.map((call) => JSON.stringify(call[1])).filter((args) => args.includes("refs/heads/bb/"));
      expect(branchCalls.length).toBeGreaterThan(0);
      for (const args of branchCalls) expect(args).toContain(`refs/heads/bb/${first}`);
      expect(job(state, first!).step).toBe("storage");
    });

    test.each([["trouble", true], ["stuck", false]])("three jobs on an environment with teardown %s raise exactly one alert", async (kind, trouble) => {
      const state = await setup();
      const [first, second, third] = await sharedJobs(state, 3, () => ({ phase: "destroying", trouble }));
      await state.supervisorCycle();
      expect(alerts(state, `cleanup-teardown-${kind}`)).toEqual([{ source_thread_id: first }]);
      expect(job(state, first!)).toEqual({ step: "storage", outcome: trouble ? "branch kept: teardown trouble" : "branch kept: teardown stuck" });
      for (const id of [second!, third!]) expect(job(state, id)).toEqual({ step: "storage", outcome: `worktree shared: ${kind} handled by ${first}` });
      expect(claims(state)).toEqual([{ action: kind, thread_id: first }]);
    });

    test("a job that finds the environment in use claims nothing: a later job that finds it destroyed still owns the branch", async () => {
      const state = await setup();
      const [first, second] = await sharedJobs(state, 2, (call) => ({ phase: call === 0 ? "active" : "destroyed" }));
      await state.supervisorCycle();
      expect(job(state, first!)).toEqual({ step: "storage", outcome: "branch kept: environment in use" });
      expect(job(state, second!)).toMatchObject({ step: "branch" });
      expect(claims(state)).toEqual([{ action: "branch", thread_id: second }]);
    });

    test.each([
      ["destroyed", { phase: "destroyed" as const }, "branch", null],
      ["teardown trouble", { phase: "destroying" as const, trouble: true }, "storage", "cleanup-teardown-trouble"],
      ["teardown stuck", { phase: "destroying" as const }, "storage", "cleanup-teardown-stuck"],
    ])("a single job on its own worktree behaves as before shared claims: %s", async (_name, env, step, alert) => {
      const state = await setup();
      const [only] = await sharedJobs(state, 1, () => env);
      await state.supervisorCycle();
      expect(job(state, only!).step).toBe(step);
      expect(job(state, only!).outcome ?? "").not.toContain("worktree shared");
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key LIKE '%cleanup-teardown-%'`).get()).toEqual({ n: alert ? 1 : 0 });
      if (alert) expect(alerts(state, alert)).toEqual([{ source_thread_id: only }]);
    });
  });
});
