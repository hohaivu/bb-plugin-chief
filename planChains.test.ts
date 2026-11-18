import { afterEach, describe, expect, test, vi } from "vitest";
import { READY, type State, ctxOf, delegateWave, followRoute, plan, readyIdle, readyImpl, refusal, report, rerunRoute, review, reviewed, reviewerCount, rowOf, setLive, tick, tool, workerOn } from "./test/testerHelpers";
import { BLANK_ROW_RESULT, COMPLETE_RESULT, CUT_RESULT, METADATA_ONLY_RESULT, MISSING_FIELDS_RESULT, NORMAL_MODE, PIPES_ONLY_RESULT, TESTED } from "./test/receiptFixtures";
import { TEST_WAVE, approvePlan, delegate, disposeAll, setup, start, status, wave } from "./test/harness";
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

// Contracts (docs/specs/plan-chains.md "Retest Debt"): the tester route of a retest hand-off (the review refusal and the fix's ready alert) offers an evidence-only
// rerun only when the newest READY tester of the chain has a complete receipt, naming that tester and its Tested commit; otherwise it says normal Tester mode.
// Debt discharge is unchanged: a ready tester of either mode created after the fix pays, a blocked one does not.
// Regression: a legacy, cut or older receipt offers evidence mode (a partial packet could pass the debt gate); the option names the wrong tester; a blocked
// evidence tester pays the debt or is not named as `replaces`.
describe("retest receipt option", () => {
  const WAIVER = (fix: string) => ` To review without the rerun, record why: chief_review (workerThreadId: ${fix}, retestSkipped: "<reason>") — it waives every rerun listed here.`;
  const OPTION = (tester: string, args: string) => ` Its prior tester ${tester} has a complete receipt (Tested commit ${TESTED}): if no test needs to change, rerun evidence-only instead — chief_delegate (${args}, kind: tester, evidenceOnly: true) with \`Expected head: <branch tip after the fix and any intended fold>\` in the mission.`;
  const argsOf = (planner: { threadId: string }, replaces: string) => `planThreadId: ${planner.threadId}, wave: 2, replaces: ${replaces}`;

  /** Plan [impl, test]: wave 2 testers T1, T2, ... each replace the one before and report `results`; a review rejects the last, and a worker fix F is ready and idle: F owes a rerun. */
  async function rejectedChain(state: State, results: string[]) {
    const ctx = await readyImpl(state);
    const ids: string[] = [];
    for (const [index, result] of results.entries()) {
      await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: ids.at(-1) ?? ctx.impl, ...(index ? { kind: "tester" } : {}) });
      ids.push(workerOn(state, ctx.planner.threadId, 2).thread_id as string);
      await readyIdle(state, ids.at(-1)!, result);
    }
    await reviewed(state, ctx.chief.threadId, ids.at(-1)!, "request_changes");
    await tick();
    await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: ids.at(-1), kind: "worker" });
    const fix = workerOn(state, ctx.planner.threadId, 2).thread_id as string;
    await readyIdle(state, fix);
    await tick();
    return { ...ctx, ids, fix };
  }

  // The newest ready tester decides; an older complete receipt is never used when the newest has none.
  test.each<[string, string[], number | null]>([
    ["a complete receipt", [COMPLETE_RESULT], 0],
    ["a legacy report (no receipt)", [READY], null],
    ["a cut receipt", [CUT_RESULT], null],
    ["a receipt whose only pipes are Coverage metadata", [METADATA_ONLY_RESULT], null],
    ["a receipt whose command row is pipes only", [PIPES_ONLY_RESULT], null],
    ["a receipt whose command row is blank", [BLANK_ROW_RESULT], null],
    ["a receipt whose command row lacks its exit statuses", [MISSING_FIELDS_RESULT], null],
    ["a legacy newest tester over an older complete receipt", [COMPLETE_RESULT, READY], null],
    ["a complete newest tester over an older legacy report", [READY, COMPLETE_RESULT], 1],
  ])("retest refusal and ready alert with %s", async (_label, results, owner) => {
    const state = await setup();
    const { planner, chief, ids, fix } = await rejectedChain(state, results);
    const args = argsOf(planner, fix);
    const offered = owner === null ? NORMAL_MODE : OPTION(ids[owner]!, args);
    const route = `rerun the tests — ${rerunRoute(planner, 2, fix)}.${offered}${WAIVER(fix)}`;
    expect(await refusal(review(state, chief, fix))).toBe(`Review refused: ${fix} changed code after the review's rejection and no tester started after it has reported ready: ${route}`);
    // The fix's own ready alert renders the same debt line.
    const alerts = state.sent.map((sent) => String(sent.input[0].text));
    expect(alerts.some((text) => text.includes(`A code fix after the review's rejection owes a tester rerun before the next review. ${fix} changed code after the review's rejection and no tester started after it has reported ready: ${route}`))).toBe(true);
    if (owner === null) expect(alerts.at(-1)).not.toContain("evidenceOnly: true");
  });

  // Contract (pre-review advisory): a worker fix on a test wave after the tests ran gets the same option, built from the fix's own `replaces:` call.
  test.each<[string, string, boolean]>([["a complete receipt", COMPLETE_RESULT, true], ["a cut receipt", CUT_RESULT, false]])("retest ready alert of a worker fix on a test wave with %s", async (_label, result, offered) => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
    const tester = workerOn(state, planner.threadId, 2).thread_id as string;
    await readyIdle(state, tester, result);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2).thread_id as string;
    await readyIdle(state, fix);
    const option = offered ? OPTION(tester, `replaces: ${fix}`) : NORMAL_MODE;
    expect(state.sent.at(-1).input[0].text).toContain(`A worker changed code on test wave 2 after the tests ran: rerun them — chief_delegate (replaces: ${fix}, kind: tester) — then review.${option} If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason) or start the review: chief_review (workerThreadId: ${fix}).`);
  });

  // Debt through the real chief_delegate (unplanned chain: the planned review refusal puts the unready-wave refusal before the retest one): the advertised evidence
  // call is admitted; a blocked evidence tester pays nothing and the route then names it as `replaces` (the receipt option still names the last READY tester);
  // a fresh normal tester replacing it that reports ready pays.
  test("retest debt: a blocked evidence tester keeps it owed and is named as replaces; a fresh normal tester that reports ready pays it", async () => {
    const state = await setup();
    const chief = await start(state);
    const work = (await delegate(state, chief.threadId, "Fix totals")).threadId;
    await readyIdle(state, work, "Done");
    const first = (await delegate(state, chief.threadId, "Test", { replaces: work, kind: "tester" })).threadId;
    await readyIdle(state, first, COMPLETE_RESULT);
    await reviewed(state, chief.threadId, first, "request_changes");
    await tick();
    const fix = (await delegate(state, chief.threadId, "Fix", { replaces: first, kind: "worker" })).threadId;
    await readyIdle(state, fix, "Fixed");
    await tick();

    const owedFirst = await refusal(review(state, chief, fix));
    const call = [...owedFirst.matchAll(/chief_delegate \(([^)]*)\)/g)].map((match) => match[1]);
    expect(call[1]).toBe(`replaces: ${fix}, kind: tester, evidenceOnly: true`);
    expect(owedFirst).toContain(`rerun the tests — chief_delegate (replaces: ${fix}, kind: tester).${OPTION(first, `replaces: ${fix}`)}`);
    await tool(state, "chief_delegate", { title: "Evidence rerun", mission: "Rerun the suites. Expected head: 1111111aaaa", replaces: fix, kind: "tester", evidenceOnly: true }, chief.threadId);
    const evidence = (state.db.prepare(`SELECT thread_id FROM managed_threads ORDER BY rowid DESC LIMIT 1`).get() as { thread_id: string }).thread_id;
    expect(state.spawned.at(-1).prompt).toContain("## Evidence work");
    await report(state, evidence, { state: "blocked", result: "HEAD is not Expected head", blocker: "Pin mismatch", recommendation: "Replace with a normal tester" });
    setLive(state, evidence, "idle");

    const owed = await refusal(review(state, chief, fix));
    expect(owed).toContain(`rerun the tests — chief_delegate (replaces: ${evidence}, kind: tester). Or, if ${evidence}'s blocked report shows a product bug, fix it first — chief_delegate (replaces: ${evidence}, kind: worker).${OPTION(first, `replaces: ${evidence}`)}`);
    expect(await reviewerCount(state)).toBe(1);

    const normal = await followRoute(state, chief.threadId, owed, 0);
    expect(normal.params).toEqual({ replaces: evidence, kind: "tester" });
    expect(state.spawned.at(-1).prompt).toContain("## Test work");
    await readyIdle(state, normal.thread, "Tested");
    await review(state, chief, normal.thread);
    expect(await reviewerCount(state)).toBe(2);
  });

  test("retest debt: a ready evidence tester created after the fix pays it", async () => {
    const state = await setup();
    const { chief, planner, fix } = await rejectedChain(state, [COMPLETE_RESULT]);
    await tool(state, "chief_delegate", { title: "Evidence rerun", mission: "Rerun the suites. Expected head: 1111111aaaa", planThreadId: planner.threadId, wave: 2, replaces: fix, kind: "tester", evidenceOnly: true }, chief.threadId);
    const evidence = workerOn(state, planner.threadId, 2).thread_id as string;
    expect(rowOf(state, evidence)).toMatchObject({ kind: "tester", replaces_thread_id: fix });
    await readyIdle(state, evidence, COMPLETE_RESULT);
    await review(state, chief, evidence);
    expect(await reviewerCount(state)).toBe(2);
  });
});
