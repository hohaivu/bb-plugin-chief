import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import { checkPlan } from "./src/report/reportIntake";
import { managedSkills } from "./src/core/roles";
import { READY, type State, ctxOf, delegateWave, fixedAfterRejection, followRoute, plan, planWave, planWaves, readyIdle, readyImpl, refusal, report, reviewed, review, reviewerCount, rerunRoute, rowOf, setLive, tick, tool, twoRejectedChains, unplannedFix, unplannedRoute, wavePaths, withTester, workerOn } from "./test/testerHelpers";
import { PLAN_FIXTURE, TEST_WAVE, approvePlan, configurationContext, delegate, disposals, disposeAll, legacyWave, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
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
    ["a tester on an implementation wave of a new plan", (impl) => ({ replaces: impl, kind: "tester", wave: 1 }), /Wave 1 is not a test wave: a tester runs only its chain's test waves \(2\)/],
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

  // Contract (plan-review trigger): only implementation waves (neither design nor test) count toward the advisor review — an
  // implementation wave plus a design wave and/or its test wave is not reviewed; two implementation waves or a `complex` plan are.
  // A refusal names the same implementation-wave count: never "has 1 implementation waves". Regression: a test wave or a
  // design wave counts, so every plan is reviewed (or, with the filter dropped, a plan is never reviewed), or the refusal
  // count and the trigger use different predicates. The existing review-trigger tests use plans with no test wave.
  test.each<[string, object[], boolean, string | null]>([
    ["one implementation wave and its test wave", [planWave(1), TEST_WAVE(2)], false, null],
    ["a design wave, one implementation wave and its test wave", [planWave(1, { design: true }), planWave(2), TEST_WAVE(3)], false, null],
    ["two implementation waves and a test wave", [planWave(1), planWave(2), TEST_WAVE(3)], false, "has 2 implementation waves"],
    ["a design wave, two implementation waves and a test wave", [planWave(1, { design: true }), planWave(2), planWave(3), TEST_WAVE(4)], false, "has 2 implementation waves"],
    ["one implementation wave and its test wave, marked complex", [planWave(1), TEST_WAVE(2)], true, "is marked complex"],
    ["a design wave, one implementation wave and its test wave, marked complex", [planWave(1, { design: true }), planWave(2), TEST_WAVE(3)], true, "is marked complex"],
  ])("plan review is required for %s", async (_label, waves, complex, refusal) => {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chief.threadId));
    const planner = (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    await report(state, planner.threadId, { state: "ready", result: "Waves written.", plan: waves, ...(complex ? { complex } : {}) });
    const attempt = delegateWave(state, chief.threadId, planner.threadId, 1);
    if (refusal) {
      await expect(attempt).rejects.toThrow(`Plan ${planner.threadId} ${refusal}: get its one advisor review first`);
      expect(rowOf(state, planner.threadId).plan_review).toBe("required");
    } else {
      await attempt;
      expect(rowOf(state, planner.threadId).plan_review).toBeNull();
      await expect(tool(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan" }, chief.threadId)).rejects.toThrow(
        "Only a plan with more than one implementation wave (design and test waves do not count), or a complex plan, gets an advisor review");
    }
  });

  // Contract (plan-review trigger, revision): a revision of a plan is never reviewed, even with two implementation waves
  // and `complex`. Regression: the `replaces_thread_id` term is dropped from the trigger.
  test("a revision of a plan is never reviewed, with two implementation waves and complex", async () => {
    const state = await setup();
    const chief = await start(state);
    const original = await plan(state, chief.threadId, [planWave(1), planWave(2), TEST_WAVE(3)]);
    expect(rowOf(state, original.threadId).plan_review).toBe("required");
    await tool(state, "chief_consult", { planThreadId: original.threadId, title: "Plan", mission: "Review this plan before delegation" }, chief.threadId);
    const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
    await report(state, advisor.threadId, { state: "ready", result: "Split the waves differently.", verdict: "request_changes" });
    expect(rowOf(state, original.threadId).plan_review).toBe("changes");
    await tool(state, "chief_plan", { title: "Revise", mission: "Propose again", revises: original.threadId }, chief.threadId);
    const revision = (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    expect(revision.threadId).not.toBe(original.threadId);
    await report(state, revision.threadId, { state: "ready", result: "Waves rewritten.", plan: [planWave(1), planWave(2), TEST_WAVE(3)], complex: true });
    expect(rowOf(state, revision.threadId).plan_review).toBeNull();
    await delegateWave(state, chief.threadId, revision.threadId, 1);
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
    // The fix owes a tester rerun before its review: the rerun is the row the second rejection lands on.
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: fix, kind: "tester" });
    const rerun = workerOn(state, planner.threadId, 2).thread_id;
    await readyIdle(state, rerun);
    const alert = await reviewed(state, chief.threadId, rerun, "request_changes");
    expect(alert).toContain("chief_consult");
    expect(alert).toContain(`chief_delegate (replaces: ${rerun}, kind: worker) for product-code findings or chief_delegate (replaces: ${rerun}, kind: tester) for test-only fin`);
  });

  // Retest debt contract (ladder): at the consult and stop rungs only the exact tester hand-off the review refusal renders is admitted
  // without a consult or userApprovedRound; a worker replacement of the same fix, and a tester replacing another row, still meet the
  // ladder. Regression: the exemption keyed on kind alone lets any tester through, or is not applied and the rerun route is unreachable.
  test.each([[2, "Call chief_consult"], [3, "escalate to the user with both positions"]] as const)("at a streak of %i the exact retest hand-off is admitted; a worker replacement still meets the ladder", async (streak, ladder) => {
    const state = await setup();
    const { chief, fix } = await unplannedFix(state);
    const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer' ORDER BY rowid DESC`).get() as { thread_id: string }).thread_id;
    state.db.prepare(`UPDATE managed_threads SET reject_streak=? WHERE thread_id=?`).run(streak, reviewer);
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, chief.threadId);
    const message = await refusal(review(state, chief, fix));
    expect(message).toContain(`rerun the tests — ${unplannedRoute(fix)}`);
    const rows = (await status(state)).threads.length;
    await expect(tool(state, "chief_delegate", { title: "Fix", mission: "Fix again", replaces: fix, kind: "worker", unplannedReason: "again" }, chief.threadId)).rejects.toThrow(ladder);
    expect((await status(state)).threads.length).toBe(rows);
    const followed = await followRoute(state, chief.threadId, message);
    expect(rowOf(state, followed.thread)).toMatchObject({ kind: "tester", replaces_thread_id: fix });
  });

  // Retest debt contract (migration, storage): retest_skipped is the last appended migration entry; a database one entry behind gains
  // a NULL column and keeps its rows, and a fresh one has it. Regression: the column is added out of order or not at all, so the
  // waiver write throws on an upgraded database.
  test("the retest_skipped column exists on a fresh database and is added NULL to one a migration behind", () => {
    const columns = (db: any) => (db.prepare(`PRAGMA table_info(managed_threads)`).all() as { name: string }[]).map((column) => column.name);
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-retest-migration" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, -1));
    expect(columns(db)).not.toContain("retest_skipped");
    db.prepare(`INSERT INTO managed_threads (thread_id, role, state, project_id, title, created_at, updated_at) VALUES ('old', 'worker', 'ready', 'p', 't', 1, 1)`).run();
    bb.storage.migrate(db, MIGRATIONS);
    expect(columns(db)).toContain("retest_skipped");
    expect(db.prepare(`SELECT retest_skipped FROM managed_threads WHERE thread_id='old'`).get()).toEqual({ retest_skipped: null });
  });

  // Retest debt contract (exemptions): a fix owes a rerun only when the chain's newest verdict is a rejection and no review covers the
  // fix. Regression: debt read from "a worker row exists after any review" refuses an approved chain's follow-up, or a fix whose
  // report an (waived) review already covers.
  test("no rerun is owed when the newest verdict is an approve, or once a review covers the fix", async () => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId, "Totals");
    await readyIdle(state, first.threadId, "Done");
    await reviewed(state, chief.threadId, first.threadId, "approve");
    await tick();
    const followUp = (await delegate(state, chief.threadId, "Follow-up", { replaces: first.threadId })).threadId;
    await readyIdle(state, followUp, "More");
    expect(await review(state, chief, followUp)).toMatch(/^Started “Review/);

    const rejected = await unplannedFix(state);
    await review(state, rejected.chief, rejected.fix, { retestSkipped: "docs only" });
    expect(await review(state, rejected.chief, rejected.fix)).toMatch(/^Using existing “Review/);
  });

  // Retest debt contract (waiver, public chief_review): the waiver writes the fix's retest_skipped and refreshes the row cache, and the
  // review then starts for that same fix, whatever pull request or branch it has. Regression: the reviewable-head check compares the
  // refreshed row cache's object with the one read before the waiver write, so a plan worker with no pull request head and no branch is
  // refused as unreadable only when waived.
  test("a waived review of a plan fix with no branch or pull request head starts", async () => {
    const state = await setup();
    const { chief, fix } = await fixedAfterRejection(state);
    expect(rowOf(state, fix)).toMatchObject({ branch: null, pr_url: null });
    expect(await review(state, chief, fix, { retestSkipped: "tests unaffected" })).toMatch(/^Started “Review/);
    expect(rowOf(state, fix).retest_skipped).toBe("tests unaffected");
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

  // ---- Retest debt: after a rejection, a code fix owes a tester that reported ready before chief_review (wave 3) ----
  // Contract (fresh-ready milestone, planned chain): a fix after a rejection owes a tester created AFTER it that reported ready. A tester
  // created before the fix never pays, and a tester that is busy, blocked or idle without a report leaves the review refused (a plan's
  // unready wave is refused first: the order pending > retest); ready, busy or idle, admits it. The refusal's route is executed through
  // the real chief_delegate (route sweep). Regression: the debt is paid by tester creation instead of its ready report, or by a pre-fix tester.
  // Existing coverage: nothing refuses a review for retest debt.
  test.each<[string, (state: State, tester: string) => Promise<void>, RegExp, boolean]>([
    ["busy", async () => {}, /^One review covers the whole plan once every wave is ready; wave\(s\) 2 of 2 are not ready yet\./, false],
    ["blocked", async (state, tester) => { await report(state, tester, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product" }); setLive(state, tester, "idle"); }, /^One review covers the whole plan once every wave is ready; wave\(s\) 2 of 2 are not ready yet\./, false],
    ["idle without a report", async (state, tester) => { setLive(state, tester, "idle"); await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(tester)!, lastAssistantText: "Stopped without a report" }); }, /^One review covers the whole plan once every wave is ready; wave\(s\) 2 of 2 are not ready yet\./, false],
    ["ready on a busy host", async (state, tester) => { await report(state, tester, { state: "ready", result: READY }); }, /^$/, true],
    ["ready and idle", async (state, tester) => { await readyIdle(state, tester); }, /^$/, true],
  ])("a rerun tester that is %s", async (label, put, refusalText, admitted) => {
    const state = await setup();
    const { chief, planner, oldTester, fix } = await fixedAfterRejection(state);
    // T0 reported ready but was created before the fix: it pays nothing.
    expect(rowOf(state, oldTester).last_report_state).toBe("ready");
    const first = await refusal(review(state, chief, fix));
    expect(first).toBe(`Review refused: ${fix} changed code after the review's rejection and no tester started after it has reported ready: rerun the tests — ${rerunRoute(planner, 2, fix)}. To review without the rerun, record why: chief_review (workerThreadId: ${fix}, retestSkipped: "<reason>") — it waives every rerun listed here.`);
    expect(await reviewerCount(state)).toBe(1);

    const { params, thread: tester } = await followRoute(state, chief.threadId, first);
    expect(params).toEqual({ planThreadId: planner.threadId, wave: 2, replaces: fix, kind: "tester" });
    expect(rowOf(state, tester)).toMatchObject({ kind: "tester", plan_wave: 2, replaces_thread_id: fix });
    await put(state, tester);
    if (admitted) {
      await review(state, chief, tester);
      expect(await reviewerCount(state)).toBe(2);
      return;
    }
    expect(await refusal(review(state, chief, tester))).toMatch(refusalText);
    expect(await reviewerCount(state)).toBe(1);
    // A fresh tester that reports ready pays the debt, whatever became of the one that did not.
    if (label !== "busy") {
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "tester" });
      const next = workerOn(state, planner.threadId, 2).thread_id as string;
      await readyIdle(state, next);
      await review(state, chief, next);
      expect(await reviewerCount(state)).toBe(2);
    }
  });

  // Contract (unplanned chain, through the real chief_delegate): a normal worker (kind NULL) that replaces a rejected row is a fix and owes a
  // tester. A tester that is busy is waited for (no second tester); blocked or idle without a report is replaced; ready pays the debt and its
  // review is admitted. Every advertised route is executed. Regression: busy testers are replaced (two testers race), or a blocked/idle one pays.
  // Existing coverage: no unplanned test reviews a fix before a tester reported.
  test("an unplanned fix owes a ready tester: busy waits, blocked or idle without a report is replaced, ready is admitted", async () => {
    const state = await setup();
    const { chief, fix } = await unplannedFix(state);
    expect(rowOf(state, fix).kind).toBeNull();
    const owed = await refusal(review(state, chief, fix));
    expect(owed).toBe(`Review refused: ${fix} changed code after the review's rejection and no tester started after it has reported ready: rerun the tests — ${unplannedRoute(fix)}. To review without the rerun, record why: chief_review (workerThreadId: ${fix}, retestSkipped: "<reason>") — it waives every rerun listed here.`);
    // The fix's own ready alert shows the same debt, not the plain review.
    expect(state.sent.some((sent) => String(sent.input[0].text).includes(`chief_review (workerThreadId: ${fix}, retestSkipped: "<reason>")`))).toBe(true);

    const first = await followRoute(state, chief.threadId, owed);
    expect(first.params).toEqual({ replaces: fix, kind: "tester" });
    setLive(state, first.thread, "active");
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(first.thread)! });
    expect(rowOf(state, first.thread).state).toBe("active");
    const busy = await refusal(review(state, chief, fix));
    expect(busy).toContain(`Tester ${first.thread} (active) is rerunning the tests after ${fix}: wait for its ready report.`);
    expect(busy).not.toContain(unplannedRoute(fix));

    await report(state, first.thread, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product" });
    setLive(state, first.thread, "idle");
    const blocked = await refusal(review(state, chief, fix));
    expect(blocked).toContain(`rerun the tests — ${unplannedRoute(first.thread)}. Or, if ${first.thread}'s blocked report shows a product bug, fix it first — chief_delegate (replaces: ${first.thread}, kind: worker).`);
    const second = await followRoute(state, chief.threadId, blocked, 0);
    expect(second.params).toEqual({ replaces: first.thread, kind: "tester" });

    setLive(state, second.thread, "idle");
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(second.thread)!, lastAssistantText: "Stopped without a report" });
    const idle = await refusal(review(state, chief, fix));
    expect(idle).toContain(`rerun the tests — ${unplannedRoute(second.thread)}.`);
    const third = await followRoute(state, chief.threadId, idle, 0);
    expect(third.params).toEqual({ replaces: second.thread, kind: "tester" });

    await readyIdle(state, third.thread, "Tested");
    await review(state, chief, third.thread);
    expect(await reviewerCount(state)).toBe(2);
  });

  // Contract (aggregation): the debts of every chain of a plan are read together, whichever tip asks for the review. Both fixes owe a rerun
  // and the one refusal lists both routes; paying one chain leaves the other listed, and the refused tip's own chain is not what is named.
  // The ready alert of a row whose plan still owes a rerun never offers the plain review. Regression: only the asking tip's chain is read, so
  // the plan's one review starts while another chain's fix was never retested.
  // Existing coverage: the plan's one review is tested only on chains with no rejection.
  test("the debts of two chains are listed together; paying one leaves the other, named by the paid chain's own tip", async () => {
    const state = await setup();
    const { chief, planner, fixA, fixB } = await twoRejectedChains(state);
    const routeA = rerunRoute(planner, 2, fixA);
    const routeB = rerunRoute(planner, 4, fixB);
    const both = await refusal(review(state, chief, fixA));
    expect(both).toContain(`${fixA} changed code after the review's rejection and no tester started after it has reported ready: rerun the tests — ${routeA}.`);
    expect(both).toContain(`${fixB} changed code after the review's rejection and no tester started after it has reported ready: rerun the tests — ${routeB}.`);
    expect(both.match(/retestSkipped/g)).toHaveLength(1);
    // The ready alert of each fix names the waiver, never the plain call.
    const alertOf = (id: string) => state.sent.map((sent) => String(sent.input[0].text)).filter((text) => text.includes(id)).at(-1)!;
    expect(alertOf(fixA)).not.toContain(`chief_review (workerThreadId: ${fixA})`);

    // Chain A is paid: asking from A's tip, the refusal names only chain B's route.
    const testerA = await followRoute(state, chief.threadId, both, 0);
    expect(testerA.params).toEqual({ planThreadId: planner.threadId, wave: 2, replaces: fixA, kind: "tester" });
    await readyIdle(state, testerA.thread);
    const onlyB = await refusal(review(state, chief, testerA.thread));
    expect(onlyB).toContain(routeB);
    expect(onlyB).not.toContain(routeA);
    expect(onlyB).not.toContain(`${fixA} changed code`);
    expect(alertOf(testerA.thread)).not.toContain(`chief_review (workerThreadId: ${testerA.thread})`);
    expect(await reviewerCount(state)).toBe(1);

    // Chain B's route is executed through the real owner; both chains paid, the review starts.
    const testerB = await followRoute(state, chief.threadId, onlyB, 0);
    expect(testerB.params).toEqual({ planThreadId: planner.threadId, wave: 4, replaces: fixB, kind: "tester" });
    await readyIdle(state, testerB.thread);
    await review(state, chief, testerA.thread);
    expect(await reviewerCount(state)).toBe(2);
  });

  // Contract (retestSkipped waiver): chief_review with retestSkipped records Chief's reason on EVERY fix whose rerun was owed (one batch), starts
  // the review, hands the reviewer the clipped reason under "## Waived test waves", and shows it in the roster, inspect and the Completed comment
  // (right after tests_skipped). Regression: the reason is stored on one fix only, is not shown to the reviewer, or is stored before a refusal.
  // Existing coverage: chief_skip_tests waivers only (waivedTestWaves); retestSkipped is new.
  test("retestSkipped waives every owed rerun, starts the review and shows the reason to the reviewer, roster and inspect", async () => {
    const state = await setup();
    const { chief, fixA, fixB } = await twoRejectedChains(state);
    const stored = "Reran by hand: the totals suite is green in CI";
    await review(state, chief, fixA, { retestSkipped: stored });
    expect(await reviewerCount(state)).toBe(2);
    expect(rowOf(state, fixA).retest_skipped).toBe(stored);
    expect(rowOf(state, fixB).retest_skipped).toBe(stored);
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
    expect(context).toContain(`## Waived test waves\nRetest after fix ${fixA} waived by Chief: ${stored}\nRetest after fix ${fixB} waived by Chief: ${stored}`);
    expect(state.spawned.at(-1).prompt).toContain("(chief_review retestSkipped)");
    const roster = String(await tool(state, "chief_roster", {}, chief.threadId));
    expect(roster).toContain(`retest skipped: ${stored}`);
    expect(String(await tool(state, "chief_inspect", { threadId: fixA }, chief.threadId))).toContain(`Retest skipped: ${stored}`);
  });

  // Contract (retestSkipped clip): the stored reason is the schema-capped text and the reviewer's line clips at 500 characters. Regression: an over-long
  // reason reaches the reviewer's brief uncut, or the schema accepts text longer than the clip.
  test("retestSkipped is capped at 500 characters", async () => {
    const state = await setup();
    const { chief, fix } = await fixedAfterRejection(state, { branch: "feature/a" });
    await expect(review(state, chief, fix, { retestSkipped: "R".repeat(501) })).rejects.toThrow();
    expect(rowOf(state, fix).retest_skipped).toBeNull();
    await review(state, chief, fix, { retestSkipped: "R".repeat(500) });
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
    expect(context).toContain(`Retest after fix ${fix} waived by Chief: ${"R".repeat(500)}`);
  });

  // Contract (retestSkipped Completed comment order): the Retest skipped line follows tests_skipped directly. Regression: it is placed elsewhere or dropped.
  test("the Completed comment puts Retest skipped right after Tests skipped", async () => {
    const state = await setup();
    const { chief, fix } = await unplannedFix(state, { prUrl: "https://github.com/acme/shop/pull/8" });
    await review(state, chief, fix, { retestSkipped: "Verified by hand" });
    await tool(state, "chief_complete", { threadId: fix, override: "no approve", testsSkipped: "typo, no behaviour" }, chief.threadId);
    const comment = state.db.prepare(`SELECT body FROM forge_comments WHERE dedupe_key=?`).get(`complete:${fix}`) as { body: string };
    expect(comment.body).toContain("**Tests skipped:** typo, no behaviour\n**Retest skipped:** Verified by hand");
  });

  // Contract (retestSkipped refusals): it is valid only with workerThreadId; refused with nothing stored when no rerun is owed; refused with nothing stored
  // when another refusal applies (a plan's unready wave). Regression: the reason is stored before the refusal, or a review with no debt accepts it.
  test("retestSkipped is refused with a branch, with no rerun owed and with another refusal, storing nothing", async () => {
    const state = await setup();
    const unplanned = await start(state);
    const worker = await delegate(state, unplanned.threadId);
    await readyIdle(state, worker.threadId, "Done");
    await expect(tool(state, "chief_review", { branch: "feature/a", retestSkipped: "r" }, unplanned.threadId)).rejects.toThrow("retestSkipped is valid only with workerThreadId.");
    await expect(review(state, unplanned, worker.threadId, { retestSkipped: "r" })).rejects.toThrow("No tester rerun is owed on this review; drop retestSkipped.");
    expect(rowOf(state, worker.threadId).retest_skipped).toBeNull();
    expect(await reviewerCount(state)).toBe(0);

    const { chief, fix, planner } = await fixedAfterRejection(state, { branch: "feature/a" });
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: fix, kind: "tester" });
    const busy = workerOn(state, planner.threadId, 2).thread_id as string;
    await expect(review(state, chief, busy, { retestSkipped: "r" })).rejects.toThrow(/wave\(s\) 2 of 2 are not ready yet/);
    expect(rowOf(state, fix).retest_skipped).toBeNull();
    expect(rowOf(state, busy).retest_skipped).toBeNull();
  });

  // Contract (chief_skip_tests waiver is not a debt): a test wave Chief waived (before delegation: absent; or after a tester row exists) leaves the
  // fix after a rejection owing nothing, so its review starts and the Completed comment still carries the same "Tests skipped (wave N)" line.
  // Regression: a waived chain keeps owing a rerun for a wave Chief declared untestable, or the waiver line changes.
  const waivedFix = async (state: State, chief: { threadId: string }, fix: string) => {
    await review(state, chief, fix);
    expect(await reviewerCount(state)).toBeGreaterThanOrEqual(2);
    expect(rowOf(state, fix).retest_skipped).toBeNull();
    await tool(state, "chief_complete", { threadId: fix, override: "no approve" }, chief.threadId);
    const comment = state.db.prepare(`SELECT body FROM forge_comments WHERE dedupe_key=?`).get(`complete:${fix}`) as { body: string };
    expect(comment.body.split("\n").filter((line) => line.includes("Tests skipped"))).toEqual(["**Tests skipped (wave 2):** docs only"]);
    expect(comment.body).not.toContain("Retest skipped");
  };
  test("a fix after a rejection owes no rerun when the test wave was waived before delegation", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state, { prUrl: "https://github.com/acme/shop/pull/8" });
    await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, chief.threadId);
    await reviewed(state, chief.threadId, impl, "request_changes");
    await tick();
    await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: impl, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 1).thread_id as string;
    await readyIdle(state, fix);
    await waivedFix(state, chief, fix);
  });
  test("a fix after a rejection owes no rerun when the test wave was waived after its rows exist", async () => {
    const state = await setup();
    const { chief, planner, fix } = await fixedAfterRejection(state, { prUrl: "https://github.com/acme/shop/pull/8" });
    expect(await refusal(review(state, chief, fix))).toContain("rerun the tests");
    await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, chief.threadId);
    await waivedFix(state, chief, fix);
  });

  // Contract (mixed legacy chain, through the real owners): a legacy chain with no test wave beside a chain with one owes a rerun on both; the legacy
  // chain's route names its fix wave and the real chief_delegate admits a tester there (a plan-wide check would refuse it, the plan has a test wave).
  // Regression: the refusal omits the legacy chain, its route is refused by admission, or paying one chain pays the other.
  // Existing coverage: planLifecycle owns the admission rule on stubs; nothing runs it from a retest refusal.
  test("a legacy no-test chain and a test chain both owe a rerun and both routes are admitted", async () => {
    const state = await setup();
    const { chief, planner, fixA, fixB } = await twoRejectedChains(state);
    const legacy = JSON.parse(planWaves(state, planner.threadId)).map((entry: any, index: number) => { if (index === 3) delete entry.test; return entry; });
    state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
    await report(state, fixB, { state: "ready", result: `${READY} (re-reported)` });
    const both = await refusal(review(state, chief, fixA));
    expect(both).toContain(rerunRoute(planner, 2, fixA));
    expect(both).toContain(rerunRoute(planner, 4, fixB));
    const legacyTester = await followRoute(state, chief.threadId, both, 1);
    expect(legacyTester.params).toEqual({ planThreadId: planner.threadId, wave: 4, replaces: fixB, kind: "tester" });
    await readyIdle(state, legacyTester.thread);
    const onlyA = await refusal(review(state, chief, fixA));
    expect(onlyA).toContain(rerunRoute(planner, 2, fixA));
    expect(onlyA).not.toContain(`${fixB} changed code`);
    const testerA = await followRoute(state, chief.threadId, onlyA, 0);
    await readyIdle(state, testerA.thread);
    await review(state, chief, testerA.thread);
    expect(await reviewerCount(state)).toBe(2);
  });

  // Contract (advisory kept): with no reviewer verdict anywhere in the chain, a product fix after a blocked tester is the existing advisory
  // retest line, never the enforced debt: its alert has no retestSkipped waiver and chief_review is not refused for retest. Regression: the
  // debt gate reads a blocked tester as a rejection, so a first review is refused before any reviewer spoke.
  test("a code fix after a blocked tester with no verdict keeps the advisory retest line and its review is not refused", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await report(state, tester, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product" });
    setLive(state, tester, "idle");
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2).thread_id as string;
    await readyIdle(state, fix);
    const alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain(`A worker changed code on test wave 2 after the tests ran: rerun them — chief_delegate (replaces: ${fix}, kind: tester) — then review.`);
    expect(alert).not.toContain("Review refused");
    await review(state, chief, fix);
    expect(await reviewerCount(state)).toBe(1);
    expect(rowOf(state, fix).retest_skipped).toBeNull();
  });

  // Contract (legacy stacked chain, case 4): a fix on an earlier wave while the stacked later waves (each on its own branch) are still live is not owed a direct tester
  // (the owner is not on the test wave or its parent): the review of the chain tip says to restack first, and the restack refusal of the fix
  // still wins over retest. Following the restack routes through the real startWorker ends in a tester created after the fix; when it reports
  // ready the debt is paid and the review starts. Regression: the route names the earlier-wave fix as a direct tester, or the restacked tester
  // does not pay the debt. Seeded rows stand for the legacy shape (real hand-offs complete the replaced row and share one branch, so only seeds keep W2 live, each wave on its own branch).
  test("a legacy fix on an earlier wave is restacked first; the restacked tester pays the debt", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId, [planWave(1), planWave(2), TEST_WAVE(3)]);
    await approvePlan(state, chief.threadId, planner.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/legacy-a" });
    const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
    await readyIdle(state, w1);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1 });
    const w2 = workerOn(state, planner.threadId, 2).thread_id as string;
    state.db.prepare(`UPDATE managed_threads SET branch='feature/legacy-b' WHERE thread_id=?`).run(w2);
    await readyIdle(state, w2);
    await delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: w2, kind: "tester" });
    const t3 = workerOn(state, planner.threadId, 3).thread_id as string;
    state.db.prepare(`UPDATE managed_threads SET branch='feature/legacy-c' WHERE thread_id=?`).run(t3);
    await readyIdle(state, t3);
    await reviewed(state, chief.threadId, t3, "request_changes");
    await tick();
    // The legacy fix F1 on wave 1 replaces W1 while W2 and T3 stay live on top of it.
    const { threadId: f1 } = await legacyWave(state, chief.threadId, planner.threadId, 1, "feature/legacy-a2");
    state.db.prepare(`UPDATE managed_threads SET kind=NULL, replaces_thread_id=? WHERE thread_id=?`).run(w1, f1);
    state.db.prepare(`UPDATE managed_threads SET state='ready' WHERE thread_id=?`).run(w2);
    await readyIdle(state, f1);

    // The restack refusal of the fix's own wave wins over the retest debt.
    const restack = await refusal(review(state, chief, f1));
    expect(restack).toContain(`Wave 1 of 3: no review runs between waves. Wave 2 is stacked on it and still builds on the old head: restack it first — chief_delegate (replaces: ${w2}).`);
    expect(restack).not.toContain("retestSkipped");
    // The tip's refusal is the retest debt with no direct tester route: nothing is named that admission would refuse.
    const tip = await refusal(review(state, chief, t3));
    expect(tip).toBe(`Review refused: Restack the chain first; its restacked tester reruns the tests. To review without the rerun, record why: chief_review (workerThreadId: ${t3}, retestSkipped: "<reason>") — it waives every rerun listed here.`);
    expect(tip).not.toContain("chief_delegate");
    expect(await reviewerCount(state)).toBe(1);

    // Restack wave 2, then the test wave: each advertised route runs through the real startWorker.
    const w2b = await followRoute(state, chief.threadId, restack);
    expect(w2b.params).toEqual({ replaces: w2 });
    await readyIdle(state, w2b.thread);
    const next = await refusal(review(state, chief, w2b.thread));
    expect(next).toContain(`restack it first — chief_delegate (replaces: ${t3}, kind: tester).`);
    const t3b = await followRoute(state, chief.threadId, next);
    expect(t3b.params).toEqual({ replaces: t3, kind: "tester" });
    expect(rowOf(state, t3b.thread)).toMatchObject({ kind: "tester", plan_wave: 3 });
    // A busy restacked tester has not paid yet.
    expect(await refusal(review(state, chief, t3b.thread))).toMatch(/^One review covers the whole plan once every wave is ready; wave\(s\) 3 of 3 are not ready yet\./);
    await readyIdle(state, t3b.thread);
    await review(state, chief, t3b.thread);
    expect(await reviewerCount(state)).toBe(2);
  });
});
