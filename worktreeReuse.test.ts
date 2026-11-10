import { afterEach, describe, expect, test, vi } from "vitest";
import { type State, plan, readyIdle, report, setLive, tool } from "./test/testerHelpers";
import { APPROVE, delegate, disposeAll, execFileMock, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
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

  // Contracts (reviewer reuse, wave 2): repeated pinned review rounds of one task review in one worktree, checked out
  // detached at each round's pinned commit; a reviewer whose worktree is gone, busy or not a worktree is never reused.
  describe("reviewer worktree reuse across rounds", () => {
    const PR = "https://github.com/acme/shop/pull/8";
    const shaOf = (round: number) => String(round).repeat(40);
    type Mode = { destroyed?: boolean; removed?: boolean; notWorktree?: boolean; unreadable?: boolean };
    async function setupRounds(mode: Mode = {}) {
      const state = await setup({ projectPath: "/oracle/checkout", system: { usageLimits: async () => ({}), config: async () => ({ primaryHostId: "host_1" }) } });
      let sha = shaOf(1);
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: sha, baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
        if (mode.unreadable) throw new Error("host unreachable");
        return {
          id: environmentId, hostId: "host_1", workspaceProvisionType: "managed-worktree", isWorktree: !mode.notWorktree,
          status: mode.destroyed ? "destroyed" : "ready", hostLifecycle: mode.removed ? "removed" : "ready", lifecycle: { phase: "idle" },
        };
      });
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", prUrl: PR }, chief);
      const worker = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, worker);
      /** One review round at `round`'s pinned commit, approved; returns its reviewer and how it was launched. */
      const round = async (n: number) => {
        sha = shaOf(n);
        await tool(state, "chief_review", { workerThreadId: worker }, chief);
        const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const { environment, prompt } = state.spawned.at(-1);
        await report(state, reviewer, { state: "ready", result: "Looks right", ...APPROVE });
        return { reviewer, environment, prompt: String(prompt) };
      };
      return { state, round, worker, chief };
    }
    const fresh = { type: "host", workspace: { type: "managed-worktree" } };

    test("four pinned rounds review in one worktree, each checked out detached at its own pinned commit", async () => {
      const { state, round } = await setupRounds();
      const rounds = [await round(1), await round(2), await round(3), await round(4)];
      expect(rounds[0]!.environment).toMatchObject(fresh);
      const first = state.live.get(rounds[0]!.reviewer)!.environmentId;
      for (const [index, entry] of rounds.slice(1).entries()) {
        expect(entry.environment).toEqual({ type: "reuse", environmentId: first });
        expect(entry.prompt).toContain(`git checkout --detach ${shaOf(index + 2)}`);
      }
      expect(new Set(rounds.map((entry) => state.live.get(entry.reviewer)!.environmentId))).toEqual(new Set([first]));
      expect(state.spawned.filter((args) => args.environment?.type === "host" && args.title?.startsWith("Review"))).toHaveLength(1);
    });

    test.each<[string, Mode, (state: State, reviewer: string) => void]>([
      ["its worktree is destroyed", { destroyed: true }, () => {}],
      ["its worktree is removed from the host", { removed: true }, () => {}],
      ["its environment is not a worktree", { notWorktree: true }, () => {}],
      ["its environment cannot be read", { unreadable: true }, () => {}],
      ["the reviewer thread is archived", {}, (state, id) => state.live.set(id, { ...state.live.get(id)!, archivedAt: Date.now() } as any)],
      ["the reviewer thread is deleted", {}, (state, id) => state.live.set(id, { ...state.live.get(id)!, deletedAt: Date.now() } as any)],
      ["the reviewer thread is still active", {}, (state, id) => setLive(state, id, "active")],
    ])("round 2 starts a fresh worktree when the earlier reviewer's worktree cannot be reused: %s", async (_name, mode, arrange) => {
      const { state, round } = await setupRounds(mode);
      const first = await round(1);
      arrange(state, first.reviewer);
      const second = await round(2);
      expect(second.environment).toMatchObject(fresh);
    });

    // Contract (wave 2.3): a reusableEnvironment lookup that never settles times out (CLEANUP_READ_MS = 15 s per bb read) and
    // round 2 still launches a fresh worktree. Mutation caught: dropping bounded() from either read in the server adapter
    // hangs chief_review forever on a host that never answers.
    test.each([
      ["the earlier reviewer's thread lookup", "threads.get"],
      ["the earlier reviewer's environment lookup", "environments.get"],
    ] as const)("round 2 completes on a fresh worktree after %s never settles", async (_name, hungRead) => {
      const { state, round, worker, chief } = await setupRounds();
      const first = await round(1);
      let pendingCalls = 0;
      const never = () => { pendingCalls += 1; return new Promise<never>(() => {}); };
      if (hungRead === "threads.get") {
        state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
          if (threadId === first.reviewer) return never();
          const thread = state.live.get(threadId);
          if (!thread) throw new Error("not found");
          return thread;
        });
      } else {
        state.harness.sdk.stub("environments.get", async () => never());
      }
      const spawnedBefore = state.spawned.length;
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: shaOf(2), baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        let settled = false;
        const review = tool(state, "chief_review", { workerThreadId: worker }, chief).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(14_000);
        expect(pendingCalls).toBe(1);
        expect(settled).toBe(false);
        expect(state.spawned).toHaveLength(spawnedBefore);
        await vi.advanceTimersByTimeAsync(1_500);
        await review;
      } finally {
        vi.useRealTimers();
      }
      expect(state.spawned).toHaveLength(spawnedBefore + 1);
      expect(state.spawned.at(-1).environment).toMatchObject(fresh);
      expect(String(state.spawned.at(-1).prompt)).toContain(`git checkout --detach ${shaOf(2)}`);
    });
  });
});
