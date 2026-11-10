import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkPlan } from "./reportIntake";
import { managedSkills } from "./roles";
import { READY, type State, ctxOf, delegateWave, plan, planWave, planWaves, readyIdle, report, reviewed, rowOf, setLive, tool, wavePaths, workerOn } from "./test/testerHelpers";
import { PLAN_FIXTURE, TEST_WAVE, approvePlan, configurationContext, delegate, disposeAll, legacyWave, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  /** Chief + a [implementation, test] plan with wave 1 delegated, ready and idle. */
  async function readyImpl(state: State, wave1: object = {}) {
    const chief = await start(state);
    const planner = await plan(state, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1, wave1);
    const impl = workerOn(state, planner.threadId, 1);
    await report(state, impl.thread_id, { state: "ready", result: READY });
    setLive(state, impl.thread_id, "idle");
    return { chief, planner, impl: impl.thread_id as string };
  }

  /** The same plan with the tester delegated on wave 2 (still busy: the fake host starts it active). */
  async function withTester(state: State) {
    const ctx = await readyImpl(state);
    await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: ctx.impl });
    return { ...ctx, tester: workerOn(state, ctx.planner.threadId, 2).thread_id as string };
  }

  test.each<[string, string | unknown[], RegExp[]]>([
    ["accepts an implementation wave then its test wave", [planWave(1), planWave(2, { test: true })], []],
    ["accepts two chains that each end in a test wave", [planWave(1), planWave(2, { test: true }), planWave(3, { dependsOn: [] }), planWave(4, { dependsOn: [3], test: true })], []],
    ["refuses a string plan", PLAN_FIXTURE, [/plan needs at least two waves: implementation wave\(s\), then a test wave \(test: true\)/]],
    ["refuses a chain with no test tip", [planWave(1), planWave(2)], [/plan wave 2 ends a chain but is not test: true/]],
    ["refuses a test wave that starts a chain", [planWave(1, { test: true })], [/plan wave 1 is test: true but starts a chain/]],
    ["refuses a test wave in the middle of a chain", [planWave(1), planWave(2, { test: true }), planWave(3, { test: true })], [/plan wave 2 is test: true but a later wave builds on it/, /plan wave 3 is test: true but builds on test wave 2/]],
    ["refuses a test wave after a design wave", [planWave(1, { design: true }), planWave(2, { test: true })], [/plan wave 2 is test: true but builds on design wave 1/]],
    ["refuses a wave that is both design and test", [planWave(1), planWave(2, { design: true, test: true })], [/plan wave 2 is both design: true and test: true/]],
    ["refuses a non-boolean test", [planWave(1), planWave(2, { test: "yes" })], [/plan wave 2 test is "yes" \(string\); allowed true or false/]],
  ])("checkPlan %s", (_name, input, expected) => {
    const errors = checkPlan(input);
    if (!expected.length) expect(errors).toEqual([]);
    for (const pattern of expected) expect(errors.join("\n")).toMatch(pattern);
  });

  // Contract (absent waiver): chief_skip_tests on an undelegated test wave drops it from the graph, so the parent's
  // worker is the chain tip, the wave counts done but leaves the graph, delegating it is refused naming the reason, and completing the
  // parent absorbs the planner. Regression: the skipped wave stays pending (progress 0/2, planner never absorbed).
  // No existing test knows test waves or the waiver.
  test("chief_skip_tests on an undelegated test wave makes the implementation worker the chain tip", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state, { prUrl: "https://github.com/acme/shop/pull/8" });
    expect(state.sent.at(-1).input[0].text).toContain(
      `chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${impl}, kind: tester). To go without tests, record why: chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason).`);
    const before = JSON.parse(planWaves(state, planner.threadId));

    const text = await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, chief.threadId);
    expect(text).toContain(`Start the one review of the whole plan now: chief_review (workerThreadId: ${impl})`);
    const after = JSON.parse(planWaves(state, planner.threadId));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({ ...before[1], testsSkipped: "docs only" });

    const roster = String(await tool(state, "chief_roster", {}, chief.threadId));
    expect(roster).toContain("waves: 1/2 done, wave 1 ready");
    expect(roster).toContain("tests skipped: docs only");
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl })).rejects.toThrow("Wave 2's tests were skipped (docs only); nothing to delegate.");

    expect(String(await tool(state, "chief_inspect", { threadId: planner.threadId }, chief.threadId))).toContain("wave 2: tests skipped: docs only");

    await tool(state, "chief_complete", { threadId: impl, skipReview: "docs only change" }, chief.threadId);
    expect(rowOf(state, planner.threadId).state).toBe("complete");
    const comment = state.db.prepare(`SELECT body FROM forge_comments WHERE dedupe_key=?`).get(`complete:${impl}`) as { body: string };
    expect(comment.body).toContain("**Tests skipped (wave 2):** docs only");
  });

  // Contract (delegated waiver): once a tester on the test wave is idle, blocked or stopped, chief_skip_tests succeeds,
  // leaves that tester the branch owner with its row untouched, and its blocked report can still be completed with
  // skipReview. Regression: the waiver deletes/rewrites the tester, or refuses a blocked tester, so Chief cannot accept
  // failing tests it chose to waive.
  test.each([
    ["idle after a ready report", "ready", "idle"],
    ["idle after a blocked report", "blocked", "idle"],
    ["stopped after a blocked report", "blocked", "stopped"],
  ])("chief_skip_tests on a delegated test wave succeeds for a tester that is %s", async (_label, reportState, liveStatus) => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await report(state, tester, reportState === "ready" ? { state: "ready", result: READY } : { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
    setLive(state, tester, liveStatus);
    const rowBefore = rowOf(state, tester);
    const workersBefore = state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='worker'`).get();

    const text = await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "failures accepted" }, chief.threadId);
    expect(text).toBe(`Tests on wave 2 waived. ${tester} still owns the branch: review it — chief_review (workerThreadId: ${tester}) — or complete it without one — chief_complete (threadId: ${tester}, skipReview: your reason).`);
    expect(rowOf(state, tester)).toEqual(rowBefore);
    expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='worker'`).get()).toEqual(workersBefore);
    expect(JSON.parse(planWaves(state, planner.threadId))[1].testsSkipped).toBe("failures accepted");
    expect(workerOn(state, planner.threadId, 2).thread_id).toBe(tester);

    // The waived wave is never pending: a blocked or stopped tester's review is still admitted.
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).toContain("tests skipped: failures accepted");
    await reviewed(state, chief.threadId, tester, "approve");
    // A blocked report passes skipReview only because its test wave is waived.
    await tool(state, "chief_complete", { threadId: tester, skipReview: "waived" }, chief.threadId);
    expect(rowOf(state, tester).state).toBe("complete");
  });

  // Contract (delegated waiver refusals): a busy tester is still working and a complete one has nothing left to waive.
  test("chief_skip_tests refuses a busy tester and a complete tester", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    const skip = () => tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "no" }, chief.threadId);
    setLive(state, tester, "active");
    await expect(skip()).rejects.toThrow(`Wave 2's worker ${tester} is active: wait until it is idle, then waive.`);
    await report(state, tester, { state: "ready", result: READY });
    setLive(state, tester, "idle");
    await tool(state, "chief_complete", { threadId: tester, skipReview: "reviewed elsewhere" }, chief.threadId);
    await expect(skip()).rejects.toThrow(`Wave 2's worker ${tester} is complete: nothing left to waive.`);
    expect(JSON.parse(planWaves(state, planner.threadId))[1].testsSkipped).toBeUndefined();
  });

  // Contract (idempotency): a second identical chief_skip_tests returns the same text and leaves plan_waves
  // byte-identical. Regression: the second call rewrites the stored reason or reorders the wave fields.
  test.each([["an undelegated", false], ["a delegated", true]])("chief_skip_tests twice on %s test wave is a no-op", async (_label, delegated) => {
    const state = await setup();
    const { chief, planner, tester } = delegated ? await withTester(state) : { ...(await readyImpl(state)), tester: "" };
    if (delegated) { await report(state, tester, { state: "ready", result: READY }); setLive(state, tester, "idle"); }
    const skip = (reason: string) => tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason }, chief.threadId);
    const first = await skip("first reason");
    const stored = planWaves(state, planner.threadId);
    expect(await skip("first reason")).toBe(first);
    expect(await skip("a different reason")).toBe(first);
    expect(planWaves(state, planner.threadId)).toBe(stored);
  });

  // Contract (structural refusals): only this Chief's planner, only a test wave, and only once any required advisor
  // review is resolved. Regression: a refusal is dropped so Chief waives a non-test wave or another Chief's plan.
  test("chief_skip_tests refuses a non-test wave, another Chief's plan and an unreviewed plan", async () => {
    const state = await setup();
    const { chief, planner } = await readyImpl(state);
    const stored = planWaves(state, planner.threadId);
    await expect(tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 1, reason: "no" }, chief.threadId)).rejects.toThrow(`Wave 1 of planner ${planner.threadId} is not a test wave (test: true).`);
    const other = await start(state, "proj_2");
    await expect(tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "no" }, other.threadId)).rejects.toThrow(`No managed planner ${planner.threadId} for this Chief.`);

    const unreviewed = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)]);
    await expect(tool(state, "chief_skip_tests", { planThreadId: unreviewed.threadId, wave: 3, reason: "no" }, chief.threadId)).rejects.toThrow(`Plan ${unreviewed.threadId} has 2 implementation waves: get its one advisor review first`);
    expect(planWaves(state, planner.threadId)).toBe(stored);
    expect(JSON.parse(planWaves(state, unreviewed.threadId))[2].testsSkipped).toBeUndefined();
  });

  // Contract (#158 preserved): skipReview on a ready idle implementation worker whose test successor is undelegated is
  // accepted, and the sequence skipReview -> tester replaces: -> tester ready -> complete absorbs the planner.
  // Regression: a testing-related refusal on skipReview, or a tester that cannot continue a completed worker's branch,
  // breaks the review-skipped-then-test path. No existing test has a test wave to run it against.
  test("skipReview on the implementation, then a tester on its branch, completes the plan", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    expect(await tool(state, "chief_complete", { threadId: impl, skipReview: "small change" }, chief.threadId)).toContain("without a review (reason recorded)");
    expect(rowOf(state, planner.threadId).state).not.toBe("complete");

    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
    const tester = workerOn(state, planner.threadId, 2);
    expect(tester).toMatchObject({ kind: "tester", role: "worker", plan_wave: 2 });
    await report(state, tester.thread_id, { state: "ready", result: READY });
    setLive(state, tester.thread_id, "idle");
    await tool(state, "chief_complete", { threadId: tester.thread_id, skipReview: "tests are the evidence" }, chief.threadId);
    expect(rowOf(state, tester.thread_id).state).toBe("complete");
    expect(rowOf(state, planner.threadId).state).toBe("complete");
  });

  // Contract (#161): a tester with a branch and no replaces may start fresh once the tested wave's worker is complete;
  // before that, or without a branch, a test wave still must continue the tested worker's branch.
  // Regression: afterMerge accepted while the tested worker is still open, or ignoring the branch.
  test.each([
    ["accepts a branch once the tested wave's worker is complete", true, "tests/after-merge", null],
    ["refuses a branch while the tested wave's worker is not complete", false, "tests/after-merge", /Wave 2 is a test wave: it runs on wave 1's branch/],
    ["refuses a complete tested worker with no branch", true, undefined, /Wave 2 is a test wave: it runs on wave 1's branch/],
  ])("a tester with no replaces %s", async (_label, complete, branch, refusal) => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    if (complete) await tool(state, "chief_complete", { threadId: impl, skipReview: "merged" }, chief.threadId);
    const call = delegateWave(state, chief.threadId, planner.threadId, 2, { kind: "tester", ...(branch ? { branch } : {}) });
    if (refusal) { await expect(call).rejects.toThrow(refusal); return; }
    await call;
    expect(workerOn(state, planner.threadId, 2)).toMatchObject({ kind: "tester", branch, plan_wave: 2 });
  });

  // Contract (kinds): a test wave's first hand-off defaults to tester, which is a worker-role thread with the tester skill.
  // Regression: the default is lost (a plain worker is spawned on the test wave) or the tester loads no tester policy.
  test("a test wave's first hand-off with no kind spawns a tester worker whose kind loads the tester skill", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
    const tester = workerOn(state, planner.threadId, 2);
    expect(tester).toMatchObject({ role: "worker", kind: "tester" });
    expect(managedSkills("worker", "tester")).toEqual(["chief-worker", "chief-role-worker", "chief-role-tester"]);
    expect(managedSkills("worker", null)).toEqual(["chief-worker", "chief-role-worker"]);
    const chiefConfigured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(chiefConfigured.tools.map((entry: any) => entry.name)).toContain("chief_skip_tests");
  });

  // Contract (kind refusals on a new plan): designer and worker cannot take a test wave's first hand-off; a test wave
  // needs a replaces: of its parent; after a tester the kind must be named; tester only runs test waves.
  test.each<[string, (impl: string) => object, RegExp]>([
    ["a designer on a test wave", (impl) => ({ replaces: impl, kind: "designer" }), /Wave 2 is a test wave: a designer cannot run it/],
    ["a worker as the first hand-off of a test wave", (impl) => ({ replaces: impl, kind: "worker" }), /Wave 2 is a test wave: its first hand-off is kind: tester/],
    ["a test wave with no replaces", () => ({}), /Wave 2 is a test wave: it runs on wave 1's branch\. Delegate it as chief_delegate \(planThreadId: thr_\d+, wave: 2, replaces: thr_\d+, kind: tester\)/],
    ["a tester on an implementation wave of a new plan", (impl) => ({ replaces: impl, kind: "tester", wave: 1 }), /Wave 1 is not a test wave: a tester runs only this plan's test waves \(2\)/],
  ])("kind rules refuse %s", async (_label, extra, refusal) => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    const { wave: waveNo = 2, ...rest } = extra(impl) as { wave?: number };
    const rowsBefore = state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get();
    await expect(delegateWave(state, chief.threadId, planner.threadId, waveNo, rest)).rejects.toThrow(refusal);
    expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get()).toEqual(rowsBefore);
  });

  // Contract (explicit kind): replacing a tester, or a worker already on the test wave, must name worker or tester so a
  // product fix never lands on a tester by default.
  test("replacing a tester or a test-wave worker without a kind is refused until the kind is named", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await report(state, tester, { state: "ready", result: READY });
    setLive(state, tester, "idle");
    const explicit = "Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs/.";
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester })).rejects.toThrow(explicit);

    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2);
    expect(fix).toMatchObject({ kind: null, role: "worker" });
    await report(state, fix.thread_id, { state: "ready", result: READY });
    setLive(state, fix.thread_id, "idle");
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: fix.thread_id })).rejects.toThrow(explicit);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: fix.thread_id, kind: "tester" });
    expect(workerOn(state, planner.threadId, 2).kind).toBe("tester");
  });

  // Contract (explicit kind, unplanned): the same rule outside a plan, where the wave-based check does not apply —
  // replacing an unplanned tester without naming a kind is refused. Regression: the successor silently inherits
  // kind tester, so a product fix lands on a tester. The plan test above is also guarded by the wave rule and cannot catch it.
  test("replacing an unplanned tester without a kind is refused", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await readyIdle(state, worker.threadId, "Done");
    await tool(state, "chief_delegate", { title: "Tests", mission: "Test it", replaces: worker.threadId, kind: "tester" }, chief.threadId);
    const tester = (await status(state)).threads.filter((row) => row.role === "worker").at(-1)!;
    await readyIdle(state, tester.threadId, "Tested");
    await expect(tool(state, "chief_delegate", { title: "Fix", mission: "Fix it", replaces: tester.threadId }, chief.threadId))
      .rejects.toThrow("Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs/.");
  });

  // Contract (legacy plans): a plan persisted before test waves existed has no test marker; a tester runs on it only
  // with replaces:. Regression: the bootstrap is refused (the plan that introduced testers cannot be tested) or a
  // tester starts on a legacy plan with no worker to test.
  test("kind tester on a legacy plan (no test wave) needs replaces:", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    const legacy = JSON.parse(planWaves(state, planner.threadId)).map(({ test, ...rest }: any) => rest);
    state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
    // The store caches rows and reloads from the DB on its next write: a fresh ready report from the same worker is one.
    await report(state, impl, { state: "ready", result: `${READY} (re-reported)` });
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { kind: "tester" })).rejects.toThrow("kind: tester on a plan with no test wave needs replaces:");
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl, kind: "tester" });
    expect(workerOn(state, planner.threadId, 2)).toMatchObject({ kind: "tester", plan_wave: 2 });
  });

  // Contract (equivalence, server wiring only): legacyWaveGraph.test.ts owns graph/progress equivalence against bf73de5.
  // Here a persisted plan with no test fields behaves as before test waves existed — wave 2 is an
  // ordinary worker (no kind), the ready step offers no tester or waiver, and finishing the last wave absorbs the planner
  // with no testsSkipped. Regression: a missing `test` reads as an untested chain, so a tester is demanded or the
  // planner is never absorbed. No other test starts from a legacy plan.
  test("a legacy plan with no test fields keeps its pre-tester graph and progress", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    const legacy = JSON.parse(planWaves(state, planner.threadId)).map(({ test, ...rest }: any) => rest);
    state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
    await report(state, impl, { state: "ready", result: `${READY} (re-reported)` });
    const next = state.sent.at(-1).input[0].text;
    expect(next).toContain(`chief_delegate (planThreadId: ${planner.threadId}, wave: 2`);
    expect(next).not.toMatch(/tester|chief_skip_tests/);

    // The plan row is a pre-chain one: its wave 2 is a stacked worker of its own, which chief_delegate no longer builds.
    await legacyWave(state, chief.threadId, planner.threadId, 2, "feature/two");
    const last = workerOn(state, planner.threadId, 2);
    expect(last.kind).toBeNull();
    await readyIdle(state, last.thread_id);
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).toContain("waves: 1/2 done, wave 2 ready");
    await tool(state, "chief_complete", { threadId: impl, skipReview: "checked" }, chief.threadId);
    expect(rowOf(state, planner.threadId).state).not.toBe("complete");
    await tool(state, "chief_complete", { threadId: last.thread_id, skipReview: "checked" }, chief.threadId);
    expect(rowOf(state, planner.threadId).state).toBe("complete");
  });

  // Contract (plan-review trigger): only implementation waves count toward the advisor review — an implementation wave
  // plus its test wave is two waves but not reviewed, two implementation waves or a `complex` plan are. Regression:
  // the test wave counts, so every plan is reviewed (or, with the filter dropped, a plan is never reviewed).
  // The existing review-trigger tests use plans with no test wave.
  test.each<[string, object[], boolean, boolean]>([
    ["one implementation wave and its test wave", [planWave(1), TEST_WAVE(2)], false, false],
    ["two implementation waves and a test wave", [planWave(1), planWave(2), TEST_WAVE(3)], false, true],
    ["one implementation wave and its test wave, marked complex", [planWave(1), TEST_WAVE(2)], true, true],
  ])("plan review is required for %s", async (_label, waves, complex, required) => {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chief.threadId));
    const planner = (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    await report(state, planner.threadId, { state: "ready", result: "Waves written.", plan: waves, ...(complex ? { complex } : {}) });
    const attempt = delegateWave(state, chief.threadId, planner.threadId, 1);
    if (required) await expect(attempt).rejects.toThrow("get its one advisor review first");
    else await attempt;
  });

  test("kind tester on unplanned work needs replaces:", async () => {
    const state = await setup();
    const chief = await start(state);
    const call = (extra: object) => tool(state, "chief_delegate", { title: "Tests", mission: "Test it", unplannedReason: "Bounded", kind: "tester", ...extra }, chief.threadId);
    await expect(call({})).rejects.toThrow("kind: tester on unplanned work needs replaces: of the worker whose branch it tests.");
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "ready", result: "Done" });
    setLive(state, worker.threadId, "idle");
    await tool(state, "chief_delegate", { title: "Tests", mission: "Test it", replaces: worker.threadId, kind: "tester" }, chief.threadId);
    expect(state.db.prepare(`SELECT kind FROM managed_threads WHERE title='Tests' AND role='worker'`).get()).toEqual({ kind: "tester" });
  });

  // Contract (unplanned testsSkipped): unplanned work with no tester in its task chain cannot complete without a recorded
  // reason, whichever way it completes; the reason is stored apart from unplanned_reason and review_skipped and shown in
  // the roster, inspect and the completion comment. Regression: the refusal is dropped, or the reason is written to
  // another field or not shown.
  test.each([["skipReview", { skipReview: "no review" }], ["override", { override: "no approve" }]])(
    "completing unplanned work with %s and no tester is refused without testsSkipped and recorded with it", async (_label, how) => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId, "Fix totals", { prUrl: "https://github.com/acme/shop/pull/8" });
      await report(state, worker.threadId, { state: "ready", result: "Done" });
      setLive(state, worker.threadId, "idle");
      await expect(tool(state, "chief_complete", { threadId: worker.threadId, ...how }, chief.threadId)).rejects.toThrow(
        `No tester ran on this work: delegate one first — chief_delegate (replaces: ${worker.threadId}, kind: tester) — or pass testsSkipped: your reason.`);
      expect(rowOf(state, worker.threadId).state).toBe("ready");

      await tool(state, "chief_complete", { threadId: worker.threadId, ...how, testsSkipped: "typo, no behaviour" }, chief.threadId);
      const row = rowOf(state, worker.threadId);
      expect(row).toMatchObject({ state: "complete", tests_skipped: "typo, no behaviour", unplanned_reason: "Bounded test fixture" });
      expect(row.review_skipped).toBe(how.skipReview ?? null);
      expect(String(await tool(state, "chief_roster", { includeComplete: true }, chief.threadId))).toContain("tests skipped: typo, no behaviour");
      expect(String(await tool(state, "chief_inspect", { threadId: worker.threadId }, chief.threadId))).toContain("Tests skipped: typo, no behaviour");
      const comment = state.db.prepare(`SELECT body FROM forge_comments WHERE dedupe_key=?`).get(`complete:${worker.threadId}`) as { body: string };
      expect(comment.body).toContain("**Tests skipped:** typo, no behaviour");
    });

  test("completing unplanned work needs no testsSkipped when a tester is in its task chain", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "ready", result: "Done" });
    setLive(state, worker.threadId, "idle");
    const tester = await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
    await report(state, tester.threadId, { state: "ready", result: "Tested" });
    setLive(state, tester.threadId, "idle");
    await tool(state, "chief_complete", { threadId: tester.threadId, skipReview: "tests pass" }, chief.threadId);
    expect(rowOf(state, tester.threadId)).toMatchObject({ state: "complete", tests_skipped: null });
  });

  test("testsSkipped is refused on a worker whose plan has a test wave", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await expect(tool(state, "chief_complete", { threadId: impl, skipReview: "x", testsSkipped: "no tests" }, chief.threadId)).rejects.toThrow(
      `its plan has a test wave; go without it with chief_skip_tests (planThreadId: ${planner.threadId}, wave, reason), not testsSkipped.`);
    expect(rowOf(state, impl)).toMatchObject({ state: "ready", tests_skipped: null });
  });


  // Contract (routing): a reviewer's request_changes on a tester or test-wave target hands off with the kind named
  // (worker for product-code findings, tester for test-only ones) plus the mixed-findings sentence, in the single and
  // plan branches and at the consult rung. Regression: the bare `chief_delegate (replaces: T)` is back, so a product fix
  // lands on the tester by default (the server would then refuse it for lack of a kind). Existing routing tests only
  // use plain workers, whose line must stay unchanged.
  test.each([["a single unplanned tester", false], ["a plan's tester", true]])("request_changes on %s names kind: worker and kind: tester", async (_label, planned) => {
    const state = await setup();
    const { chief, planner, impl } = planned ? await readyImpl(state) : { chief: await start(state), planner: null, impl: "" };
    let target: string;
    if (planner) {
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
      target = workerOn(state, planner.threadId, 2).thread_id;
    } else {
      const worker = await delegate(state, chief.threadId);
      await readyIdle(state, worker.threadId, "Done");
      target = (await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId })).threadId;
    }
    await readyIdle(state, target, planned ? READY : "Tested");
    const alert = await reviewed(state, chief.threadId, target, "request_changes");
    expect(alert).toContain(`chief_delegate (replaces: ${target}, kind: worker) for product-code findings or chief_delegate (replaces: ${target}, kind: tester) for test-only findings`);
    expect(alert).toContain("Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests.");
  });

  test("a second request_changes on a plan's test wave reaches the consult rung with the kinds named", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await readyIdle(state, tester);
    await reviewed(state, chief.threadId, tester, "request_changes");
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2).thread_id;
    await readyIdle(state, fix);
    const alert = await reviewed(state, chief.threadId, fix, "request_changes");
    expect(alert).toContain("chief_consult");
    expect(alert).toContain(`chief_delegate (replaces: ${fix}, kind: worker) for product-code findings or chief_delegate (replaces: ${fix}, kind: tester) for test-only fin`);
  });

  // Contract (blocked tester): a tester that reports blocked is a test failure: the next call is a fresh worker for the
  // product code (kind: worker), with the waiver offered on a plan wave and testsSkipped when unplanned. Once the wave
  // is waived the blocked tester's line becomes the waived-wave line. Regression: the generic "Blocked: decide or
  // escalate" line returns, leaving Chief no route to the product fix.
  test.each([["a plan's tester", true], ["an unplanned tester", false]])("a blocked %s tells Chief to delegate kind: worker", async (_label, planned) => {
    const state = await setup();
    const blocked = { state: "blocked", result: "Tests fail", blocker: "Totals test fails", recommendation: "Fix the totals" };
    const { chief, planner, tester } = planned ? await withTester(state) : await (async () => {
      const chiefThread = await start(state);
      const worker = await delegate(state, chiefThread.threadId);
      await readyIdle(state, worker.threadId, "Done");
      const t = await delegate(state, chiefThread.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
      return { chief: chiefThread, planner: null, tester: t.threadId };
    })();
    await report(state, tester, blocked);
    setLive(state, tester, "idle");
    const alert = state.sent.at(-1).input[0].text as string;
    const head = `Tests failed: Totals test fails. Delegate a fresh worker to fix the product code: chief_delegate (replaces: ${tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester.`;
    expect(alert).toContain(head);
    if (planner) {
      expect(alert).toContain(`If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason).`);
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
      const roster = String(await tool(state, "chief_roster", {}, chief.threadId));
      expect(roster).toContain(`Tests on wave 2 waived. ${tester} still owns the branch`);
      expect(roster).not.toContain("Tests failed:");
    } else {
      expect(alert).toContain("If you judge the failures acceptable, complete it with testsSkipped (your reason).");
      expect(alert).not.toContain("chief_skip_tests");
    }
  });

  // Contract (retest): a worker that changed code on a test wave after the tests ran is told to rerun them before the
  // review; the line is dropped once a review covers that report, and a waiver also drops it. Regression: the review
  // is offered straight away (tests never rerun after a product fix), or the retest line never goes away.
  test("a worker fix on a test wave is told to rerun the tests until a review covers it", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await readyIdle(state, tester);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2).thread_id;
    await readyIdle(state, fix);
    const retest = `A worker changed code on test wave 2 after the tests ran: rerun them — chief_delegate (replaces: ${fix}, kind: tester) — then review. If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason) or start the review: chief_review (workerThreadId: ${fix}).`;
    expect(state.sent.at(-1).input[0].text).toContain(retest);
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).toContain(retest);

    await reviewed(state, chief.threadId, fix, "approve");
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).not.toContain("after the tests ran");
  });

  test("a tester's own ready report on a test wave is not asked to retest", async () => {
    const state = await setup();
    const { chief, tester } = await withTester(state);
    await readyIdle(state, tester);
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).not.toContain("after the tests ran");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_review (workerThreadId: ${tester})`);
  });

  // Contract (provenance, tester brief): the tester's brief lists every present wave file and contract of its chain as
  // its source of truth, and the approved design when the chain has one; unplanned, the head worker's brief.
  // Regression: the tester is briefed from the diff alone (no spec section), so its cases are derived from the code.
  test("a tester's brief lists its chain's plan files and contracts as the source of truth", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
    const [path1, path2] = wavePaths(state, planner.threadId);
    expect(state.spawned.at(-1).prompt).toContain(
      `## Source of truth for test cases\nRead each in full, with the docs they name. Derive every test case from these, never from the implementation.\nWave 1 of 2: ${path1}\n- Totals stay non-negative\nWave 2 of 2: ${path2}\n- Wave 2 keeps its invariant`);
  });

  test("a tester's brief on an approved design chain names the approval and the designer report", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE, design: true }, { body: wave(2) }, TEST_WAVE(3)]);
    await approvePlan(state, chief.threadId, planner.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1);
    const designer = workerOn(state, planner.threadId, 1);
    expect(designer.kind).toBe("designer");
    await readyIdle(state, designer.thread_id, `${READY}\nArtboards: Checkout`);
    await tool(state, "chief_owner_approval", { workerThreadId: designer.thread_id, approval: "Looks right, ship it" }, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: designer.thread_id });
    const implementer = workerOn(state, planner.threadId, 2).thread_id;
    await readyIdle(state, implementer);
    await delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: implementer });
    const prompt = state.spawned.at(-1).prompt as string;
    const reportPath = rowOf(state, designer.thread_id).report_path;
    expect(prompt).toContain(`Approved design: wave 1's artboards, owner's approval “Looks right, ship it”, designer report ${reportPath}`);
    for (const path of wavePaths(state, planner.threadId)) expect(prompt).toContain(path);
  });

  test("an unplanned tester's brief carries the replaced chain head's brief", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await readyIdle(state, worker.threadId, "Done");
    await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
    expect(state.spawned.at(-1).prompt).toMatch(/## Source of truth for test cases\nRead each in full[^\n]*\n[\s\S]*Correct and verify totals/);
  });

  // Contract (provenance, reviewer evidence): a whole-plan review whose targets are testers lists each target's earlier
  // workers with their report pointers — worker -> tester -> fix worker -> tester on one chain, worker -> tester on
  // the other — and tells the reviewer how to scope a tester. Regression: the reviewer sees only the tester's report and
  // cannot find the implementing worker's lint/build evidence or Deviations from plan.
  test("a whole-plan review of tester targets lists each chain's earlier workers", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId, [planWave(1), TEST_WAVE(2), planWave(3, { dependsOn: [] }), TEST_WAVE(4, [3])]);
    await approvePlan(state, chief.threadId, planner.threadId);
    // A result past the alert's summary limit is written to a report file; the others have only the inspect line.
    const LONG = `${READY}\n${"Lint and build clean. ".repeat(60)}`;
    const handOff = async (waveNo: number, extra: object, result = READY) => {
      await delegateWave(state, chief.threadId, planner.threadId, waveNo, extra);
      const row = workerOn(state, planner.threadId, waveNo);
      await readyIdle(state, row.thread_id, result);
      return row.thread_id as string;
    };
    const w1 = await handOff(1, { branch: "feature/a" }, LONG);
    const w3 = await handOff(3, { branch: "feature/b" });
    const t2 = await handOff(2, { replaces: w1 }, LONG);
    const fix = await handOff(2, { replaces: t2, kind: "worker" }, LONG);
    const t2b = await handOff(2, { replaces: fix, kind: "tester" });
    const t4 = await handOff(4, { replaces: w3 });

    await tool(state, "chief_review", { workerThreadId: t2b }, chief.threadId);
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
    const pointer = (kind: string, id: string) => {
      const file = rowOf(state, id).report_path as string | null;
      return `- ${kind} ${id}: ${file ? `Full report: ${file}; ` : ""}bb chief inspect ${id}`;
    };
    for (const id of [w1, t2, fix]) expect(rowOf(state, id).report_path).toBe(join(state.storageRoot, "chief", "proj_1", id, "report-1.md"));
    for (const id of [w3]) expect(rowOf(state, id).report_path).toBeNull();
    const section = (id: string) => context.split(`### Before worker ${id}\n`)[1]!.split(/\n###? /)[0]!;
    expect(section(t2b).trim().split("\n")).toEqual([pointer("worker", fix), pointer("tester", t2), pointer("worker", w1)]);
    expect(section(t4).trim().split("\n")).toEqual([pointer("worker", w3)]);
    expect(state.spawned.at(-1).prompt).toContain("A tester changes only tests, fixtures, test helpers and test config: check its commits since the Base commit its report names (git diff <base>..<head> --stat); a product-code change there is scope drift.");
  });

  // Contract (testing policy at the brief boundary): a worker's and a designer's spawn prompt forbids writing or running
  // tests; a tester's replaces that with the test-work section and the test-files-only limit; a reviewer is told a missing
  // test is never a finding against a worker or designer. Regression: a worker is briefed to test (or a tester is told
  // not to), so test work lands in product commits.
  test.each<[string, (previous: string) => object, boolean]>([
    ["worker", () => ({}), false],
    ["designer", () => ({ kind: "designer" }), false],
    ["tester", (previous) => ({ kind: "tester", replaces: previous }), true],
  ])("a %s's spawn prompt states the testing policy", async (_label, extra, tests) => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId, "Fix totals");
    await readyIdle(state, first.threadId, "Done");
    const worker = await delegate(state, chief.threadId, "Policy", extra(first.threadId));
    const prompt = state.spawned.at(-1).prompt as string;
    expect(prompt.includes("Never write, edit or run tests of any kind (unit, integration, end-to-end, screenshot or golden); a tester does.")).toBe(!tests);
    expect(prompt.includes("## Test work")).toBe(tests);
    expect(prompt.includes("Change only test files, fixtures, test helpers and test config; never product code.")).toBe(tests);
    await readyIdle(state, worker.threadId, "Done");
    await tool(state, "chief_review", { workerThreadId: worker.threadId }, chief.threadId);
    expect(state.spawned.at(-1).prompt).toContain("A missing test or test run is never a finding against a worker or designer: workers never test. Against a tester's work it is missing verification evidence.");
  });

  // Contract (provenance, single target): a review of one tester shows the earlier worker's recorded commands under its
  // report pointer, failures first, so the reviewer sees the implementer's lint/build evidence without opening the report.
  // Regression: a single-target review lists the pointer only (no commands) or drops the predecessor's commands.
  test("a single review of a tester shows the earlier worker's recorded commands under its pointer", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const command = (text: string, exitCode: number) => ({ type: "item/completed", seq: 1, data: { item: { type: "commandExecution", command: text, exitCode, status: exitCode ? "failed" : "completed" } } });
    state.seedEvents(worker.threadId, [command("npm run build", 0), command("npm run lint", 1)]);
    await readyIdle(state, worker.threadId, `Done\n${"Lint and build clean. ".repeat(60)}`);
    const tester = await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
    await readyIdle(state, tester.threadId, "Tested");
    await tool(state, "chief_review", { workerThreadId: tester.threadId }, chief.threadId);
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
    expect(context).toContain([
      "## Earlier workers on this branch",
      `- worker ${worker.threadId}: Full report: ${rowOf(state, worker.threadId).report_path}; bb chief inspect ${worker.threadId}`,
      "  Recorded (last 2 commands): 1 non-zero exit",
      "    npm run lint → exit 1",
      "    npm run build → exit 0",
    ].join("\n"));
  });
});
