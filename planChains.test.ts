import { afterEach, describe, expect, test, vi } from "vitest";
import { READY, type State, ctxOf, delegateWave, plan, readyIdle, report, rowOf, tool, workerOn } from "./test/testerHelpers";
import { TEST_WAVE, approvePlan, disposeAll, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  // Contracts (plan chains, wave 1): a plan chain has one branch, one pull request and one worker worktree, opened by
  // chief_forge_init on its head only and continued with chief_delegate (replaces:). Independent heads get their own.
  describe("plan chains", () => {
    const PR_A = "https://github.com/o/r/pull/1";
    const PR_B = "https://github.com/o/r/pull/2";
    const withContracts = (n: number, contracts: string) => `# Wave ${n}\nDo the work.\n\n## Contracts to verify\n- ${contracts}\n\n## What we're NOT doing\n- x`;
    /** An approved plan with the given waves; its ready result is `summary`. */
    async function chainPlan(state: State, chiefThreadId: string, waves: object[], summary = "Plan summary.") {
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chiefThreadId));
      const planner = (await status(state)).threads.filter((row) => row.role === "planner" && row.chiefThreadId === chiefThreadId).at(-1)!;
      await report(state, planner.threadId, { state: "ready", result: summary, plan: waves });
      await approvePlan(state, chiefThreadId, planner.threadId);
      return planner;
    }
    const linear = (long = "Wave 1 keeps its invariant") => [{ body: withContracts(1, long) }, { body: wave(2) }, TEST_WAVE(3)];
    const forge = (state: State, chiefThreadId: string, planThreadId: string, waveNo: number) =>
      tool(state, "chief_forge_init", { title: `Wave ${waveNo} work`, planThreadId, wave: waveNo }, chiefThreadId) as Promise<string>;
    const envOf = (state: State, threadId: string) => state.live.get(threadId)!.environmentId;
    const freshSpawns = (state: State) => state.spawned.filter((args) => args.environment?.type === "host").length;

    test("forge_init on a 3-wave chain head puts one section per chain wave in the pull request body, clipped, and says one pull request per chain in the issue", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, linear("a".repeat(3_000)), "S".repeat(3_000));
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 3, reason: "docs only" }, chief.threadId);
      const script = await forge(state, chief.threadId, planner.threadId, 1);
      expect(script).toContain("Plan — chain of waves 1, 2, 3 of 3");
      expect(script.match(/<summary>Wave \d of 3/g)).toHaveLength(3);
      expect(script.match(/Tests skipped: docs only/g)).toHaveLength(1);
      // Each contract is clipped at 2,000 characters (the last is the ellipsis) and the plan summary at 1,500.
      const contract = script.match(/### Contracts to verify\n(a[^\n]*|- a[^\n]*)\n/)![1]!;
      expect(contract).toHaveLength(2_000);
      expect(contract.endsWith("…")).toBe(true);
      const summary = script.match(/\(planner [^)]*\)<\/summary>\n\n(S+…?)\n<\/details>/)![1]!;
      expect(summary).toHaveLength(1_500);
      expect(summary.endsWith("…")).toBe(true);
      expect(script).toContain("ISSUE_BODY='Chief tracks this plan here: one comment per task outcome, one pull request per chain.");
    });

    test("an unplanned forge_init body is the title line plus the mission sections, as before chains", async () => {
      const state = await setup();
      const chief = await start(state);
      const script = await tool(state, "chief_forge_init", { title: "Fix checkout totals", mission: "Correct and verify totals", successCriteria: "Regression passes", constraints: "No refactors" }, chief.threadId) as string;
      const body = "Tracking work for Fix checkout totals.\n\n## Mission\nCorrect and verify totals\n## Success criteria\nRegression passes\n## Constraints\nNo refactors";
      expect(script).toContain(`\nBODY='${body}'\n`);
      expect(script).toContain(`\nISSUE_BODY='${body}'\n`);
      expect(script).not.toContain("<details>");
    });

    test("forge_init is refused on a wave that continues a chain, naming the head, and on a head whose chain already has a worker, naming the latest", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, linear());
      for (const n of [2, 3]) {
        await expect(forge(state, chief.threadId, planner.threadId, n)).rejects.toThrow(
          new RegExp(`Wave ${n} is not a chain head: it continues the chain of waves 1, 2, 3.*head wave 1 only.*replaces: <the chain's latest worker>`));
      }
      await forge(state, chief.threadId, planner.threadId, 1);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/chain", prUrl: PR_A });
      const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
      await expect(forge(state, chief.threadId, planner.threadId, 1)).rejects.toThrow(
        `Wave 1's chain already has worker ${w1} on branch feature/chain with pull request ${PR_A}: a chain has one branch and one pull request. Continue it with chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${w1}).`);
      // A fresh delegation on the started head is refused the same way, before a thread is spawned.
      const spawned = state.spawned.length;
      await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/second" })).rejects.toThrow(`replaces: ${w1}`);
      expect(state.spawned).toHaveLength(spawned);
      // Once wave 2 continues the chain, the refusal names the newest worker, not wave 1's.
      await readyIdle(state, w1);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1 });
      const w2 = workerOn(state, planner.threadId, 2).thread_id as string;
      await expect(forge(state, chief.threadId, planner.threadId, 1)).rejects.toThrow(`replaces: ${w2}).`);
    });

    test("a linear plan of N waves runs on one branch, one pull request and one worker worktree", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, [{ body: withContracts(1, "ok") }, { body: wave(2) }, { body: wave(3) }, TEST_WAVE(4)]);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/chain", prUrl: PR_A, issueUrl: "https://github.com/o/r/issues/9" });
      const workers = [workerOn(state, planner.threadId, 1).thread_id as string];
      for (const n of [2, 3]) {
        await readyIdle(state, workers.at(-1)!);
        await delegateWave(state, chief.threadId, planner.threadId, n, { replaces: workers.at(-1) });
        workers.push(workerOn(state, planner.threadId, n).thread_id);
      }
      const rows = workers.map((id) => rowOf(state, id));
      expect(new Set(rows.map((row) => row.branch))).toEqual(new Set(["feature/chain"]));
      expect(new Set(rows.map((row) => row.pr_url))).toEqual(new Set([PR_A]));
      expect(new Set(rows.map((row) => row.issue_url))).toEqual(new Set(["https://github.com/o/r/issues/9"]));
      expect(new Set(workers.map((id) => envOf(state, id))).size).toBe(1);
      // Only the head asks for a fresh worktree; each later wave reuses the prior worker's environment.
      expect(freshSpawns(state)).toBe(1);
      expect(state.spawned.slice(-2).map((args) => args.environment)).toEqual(Array(2).fill({ type: "reuse", environmentId: envOf(state, workers[0]) }));
    });

    test("two independent heads each get their own branch, pull request and worktree; a replacement across chains is refused before any spawn", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, [{ body: withContracts(1, "ok") }, TEST_WAVE(2), { body: wave(3), dependsOn: [] }, TEST_WAVE(4, [3])]);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a", prUrl: PR_A });
      const a = workerOn(state, planner.threadId, 1).thread_id as string;
      await forge(state, chief.threadId, planner.threadId, 3);
      const spawned = state.spawned.length;
      await expect(delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: a })).rejects.toThrow(/another chain/);
      expect(state.spawned).toHaveLength(spawned);
      await delegateWave(state, chief.threadId, planner.threadId, 3, { branch: "feature/b", prUrl: PR_B });
      const b = workerOn(state, planner.threadId, 3).thread_id as string;
      expect(envOf(state, b)).not.toBe(envOf(state, a));
      expect(rowOf(state, b)).toMatchObject({ branch: "feature/b", pr_url: PR_B });
      expect(rowOf(state, a)).toMatchObject({ branch: "feature/a", pr_url: PR_A });
      expect(freshSpawns(state)).toBe(2);
    });

    test("a replacement keeps its prior's branch and pull request: a different one is refused before any spawn, the same or none is accepted, and a null prior takes the given prUrl", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, linear());
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/chain", prUrl: PR_A });
      const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, w1);
      const spawned = state.spawned.length;
      await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1, prUrl: PR_B })).rejects.toThrow(
        `replaces: ${w1} carries pull request ${PR_A}; pass no prUrl or the same one. A plan chain has one pull request.`);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1, branch: "feature/other" })).rejects.toThrow(
        `replaces: ${w1} carries branch feature/chain; pass no --branch or the same one.`);
      expect(state.spawned).toHaveLength(spawned);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1, prUrl: PR_A, branch: "feature/chain" });
      const w2 = workerOn(state, planner.threadId, 2).thread_id as string;
      expect(rowOf(state, w2)).toMatchObject({ branch: "feature/chain", pr_url: PR_A });

      // A chain whose head had no pull request yet: the replacement's prUrl fills it in.
      const second = await chainPlan(state, chief.threadId, linear());
      await delegateWave(state, chief.threadId, second.threadId, 1, { branch: "feature/second" });
      const head = workerOn(state, second.threadId, 1).thread_id as string;
      expect(rowOf(state, head).pr_url).toBeNull();
      await readyIdle(state, head);
      await delegateWave(state, chief.threadId, second.threadId, 2, { replaces: head, prUrl: PR_B });
      expect(rowOf(state, workerOn(state, second.threadId, 2).thread_id).pr_url).toBe(PR_B);
    });

    // Contracts (stacked-branch worktrees, wave 2): a head with stackOn: k builds on wave k's chain. Its base is fixed by the plan, and it starts once wave k's worker is ready.
    describe("stacked chains", () => {
      const STACKED = () => [{ body: withContracts(1, "ok") }, TEST_WAVE(2), { body: wave(3), dependsOn: [], stackOn: 1 }, TEST_WAVE(4, [3])];
      /** An approved stacked plan; wave 1 is delegated on feature/a when `delegateParent`. */
      async function stackedPlan(state: State, chiefThreadId: string, delegateParent = true) {
        const planner = await chainPlan(state, chiefThreadId, STACKED());
        if (delegateParent) await delegateWave(state, chiefThreadId, planner.threadId, 1, { branch: "feature/a", prUrl: PR_A });
        return planner;
      }
      const baseLine = (script: string) => script.match(/^BASE=(.*)$/m)![1];

      test("forge_init on a stacked head is refused until wave k's worker is ready, with text that never offers an explicit base, also for an equal explicit base", async () => {
        const state = await setup();
        const chief = await start(state);
        const planner = await stackedPlan(state, chief.threadId, false);
        const refusal = async (extra: object = {}) => {
          const error = await tool(state, "chief_forge_init", { title: "Wave 3 work", planThreadId: planner.threadId, wave: 3, ...extra }, chief.threadId).then(() => null, (e: Error) => e.message);
          expect(error).toMatch(/^Wave 3 is stacked: /);
          expect(error).not.toMatch(/\bbase\b/);
        };
        await refusal();
        await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a", prUrl: PR_A });
        const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
        await refusal();
        await refusal({ base: "feature/a" });
        await report(state, w1, { state: "blocked", blocker: "stuck", recommendation: "re-plan the remaining scope" });
        await refusal();
        await readyIdle(state, w1);
        expect(baseLine(await forge(state, chief.threadId, planner.threadId, 3))).toBe("'feature/a'");
      });

      test("forge_init on a launchable stacked head cuts from the plan base, accepts the equal explicit base and refuses a different one, and the body lists the chain's own waves", async () => {
        const state = await setup();
        const chief = await start(state);
        const planner = await stackedPlan(state, chief.threadId);
        await readyIdle(state, workerOn(state, planner.threadId, 1).thread_id);
        const script = await forge(state, chief.threadId, planner.threadId, 3);
        expect(baseLine(script)).toBe("'feature/a'");
        expect(script).toContain("Plan — chain of waves 3, 4 of 4");
        const equal = await tool(state, "chief_forge_init", { title: "Wave 3 work", planThreadId: planner.threadId, wave: 3, base: "feature/a" }, chief.threadId) as string;
        expect(baseLine(equal)).toBe("'feature/a'");
        const error = await tool(state, "chief_forge_init", { title: "Wave 3 work", planThreadId: planner.threadId, wave: 3, base: "develop" }, chief.threadId).then(() => null, (e: Error) => e.message);
        expect(error).toContain("feature/a");
        expect(error).not.toContain("develop'");
      });

      test("an unstacked head, an unplanned task and a plan without stackOn or branch keep a free explicit base and no base by default", async () => {
        const state = await setup();
        const chief = await start(state);
        const planner = await stackedPlan(state, chief.threadId, false);
        expect(baseLine(await forge(state, chief.threadId, planner.threadId, 1))).toBe("''");
        const free = await tool(state, "chief_forge_init", { title: "Wave 1 work", planThreadId: planner.threadId, wave: 1, base: "develop" }, chief.threadId) as string;
        expect(baseLine(free)).toBe("'develop'");
        const unplanned = await tool(state, "chief_forge_init", { title: "Fix totals", mission: "Correct totals", base: "release/1" }, chief.threadId) as string;
        expect(baseLine(unplanned)).toBe("'release/1'");
        expect(baseLine(await tool(state, "chief_forge_init", { title: "Fix totals", mission: "Correct totals" }, chief.threadId) as string)).toBe("''");
      });

      test("chief_delegate on a stacked head without a branch is refused before any spawn, and with the forged branch it launches with the stack sentence in the brief", async () => {
        const state = await setup();
        const chief = await start(state);
        const planner = await stackedPlan(state, chief.threadId);
        const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
        // Waiting: refused whatever the branch.
        const spawned = state.spawned.length;
        await expect(delegateWave(state, chief.threadId, planner.threadId, 3, { branch: "feature/b" })).rejects.toThrow(/^Wave 3 is stacked: /);
        await readyIdle(state, w1);
        await expect(delegateWave(state, chief.threadId, planner.threadId, 3)).rejects.toThrow(
          `Wave 3 stacks on feature/a: run chief_forge_init (planThreadId: ${planner.threadId}, wave: 3) and pass its branch.`);
        expect(state.spawned).toHaveLength(spawned);
        await forge(state, chief.threadId, planner.threadId, 3);
        await delegateWave(state, chief.threadId, planner.threadId, 3, { branch: "feature/b" });
        const launch = state.spawned.at(-1);
        expect(launch.prompt).toContain("This wave heads its own chain, stacked on feature/a: its branch and PR are based on feature/a; do not rebase onto the default branch.");
        expect(launch.prompt).not.toContain("from the default base");
        expect(launch.environment.workspace.baseBranch).toEqual({ kind: "named", name: "feature/b" });
        expect(rowOf(state, workerOn(state, planner.threadId, 3).thread_id)).toMatchObject({ branch: "feature/b", plan_wave: 3 });
      });

      test("the planner's next action lists a waiting stacked head even when no other head is undelegated, and the parent worker's ready action names it once it can launch", async () => {
        const state = await setup();
        const chief = await start(state);
        const planner = await stackedPlan(state, chief.threadId, false);
        const rosterOf = async () => String(await tool(state, "chief_roster", {}, chief.threadId));
        // Both heads are undelegated, but wave 3 waits: only wave 1 is listed to delegate.
        const first = await rosterOf();
        expect(first).toContain("Delegate wave 1 now");
        expect(first).toContain("Waves 3 are stacked and start once their parent wave is ready.");
        expect(first).toContain("(stacked on wave 1)");
        await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a", prUrl: PR_A });
        const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
        const second = await rosterOf();
        expect(second).toContain("Waves 3 are stacked and start once their parent wave is ready.");
        expect(second).not.toContain("Delegate wave");
        await report(state, w1, { state: "ready", result: READY });
        const alert = state.sent.at(-1).input[0].text as string;
        expect(alert).toContain(`Wave 3 is stacked on this chain: run chief_forge_init (planThreadId: ${planner.threadId}, wave: 3), then chief_delegate (planThreadId: ${planner.threadId}, wave: 3).`);
      });
    });
  });
});
