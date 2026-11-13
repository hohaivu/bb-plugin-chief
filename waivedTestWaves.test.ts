import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { reviewBrief, type ReviewBriefInput } from "./src/review/reviewStart";
import { PLAN_FIXTURE, delegate, disposeAll, replaceText, setup, reviewContextOf, snapshotText, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { wave1Prompt } from "./test/reviewWave1";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("waived test waves, reviewer waivers and the branch push line", () => {
  const P = { projectId: "proj_1" };
  type State = Awaited<ReturnType<typeof setup>>;
  /** The shared setup leaves hosts.get and files.move unstubbed, which writing a plan file needs. */
  async function setupWithPlans() {
    const state = await setup();
    state.harness.sdk.stub("hosts.get", async () => ({ id: "host_storage", threadStorageRootPath: join(state.storageRoot, "thread-storage") }));
    state.harness.sdk.stub("files.move", async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => { await rename(sourcePath, destinationPath); return {}; });
    return state;
  }
  const call = (state: State, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, ...P });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stateOf = (state: State, id: string) => (state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(id) as { state: string }).state;
  const READY = "Done\n\n## Deviations from plan\nNone";
  const BLOCKED = { state: "blocked", result: "Tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" };
  const testWave = (n: number) => `# Wave ${n}\nRun the tests.\n\n## Contracts to verify\n- TESTWAVE${n} suite stays green`;

  async function planOf(state: State, chiefId: string, waves: { body: string; dependsOn?: number[]; test?: boolean }[]) {
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], { threadId: chiefId, ...P });
    const planner = (await status(state)).threads.find((row) => row.role === "planner" && row.chiefThreadId === chiefId)!;
    await call(state, "chief_report", { state: "ready", result: "Plan", plan: waves }, planner.threadId);
    return planner;
  }
  async function cli(state: State, chiefId: string, args: string[]) {
    const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], { threadId: chiefId, ...P });
    expect(result.exitCode, result.stderr).toBe(0);
    return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
  }
  const roster = async (state: State, chiefId: string) => String(await call(state, "chief_roster", {}, chiefId));
  const skip = (state: State, chiefId: string, planner: string, wave: number, reason: string) =>
    call(state, "chief_skip_tests", { planThreadId: planner, wave, reason }, chiefId);
  /** Plan [impl 1, test 2] with wave 1 ready and a tester delegated on wave 2. */
  async function withTester(state: State, chiefId: string) {
    const planner = await planOf(state, chiefId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    const impl = await cli(state, chiefId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    const tester = await cli(state, chiefId, ["--plan-thread", planner.threadId, "--wave", "2", "--replaces", impl]);
    return { planner, impl, tester };
  }

  const row = (state: State, id: string) => state.db.prepare(`SELECT state, last_report_state FROM managed_threads WHERE thread_id=?`).get(id) as { state: string; last_report_state: string };
  /** One more turn through the lifecycle boundary: the thread goes active, then idle; a report's state survives it. */
  async function turn(state: State, id: string) {
    for (const [status, event] of [["active", "thread.active"], ["idle", "thread.idle"]] as const) {
      state.live.set(id, { ...state.live.get(id)!, status });
      await state.harness.behavior.emitThreadEvent(event, { thread: state.live.get(id)!, lastAssistantText: "x" });
    }
  }

  // Contract: a delegated test wave Chief waived counts done whatever its tester's state (ready, idle after ready, idle after blocked, stopped after blocked), before any review; total stays waves.length.
  // Regression: progress stayed 1/2 ("wave 2 blocked") until an approving review. Also pins that the planner is neither complete nor absorbed on N/N alone.
  // The idle rows pin a managed row whose state is idle with the earlier report still recorded: counting only a ready or blocked state would miss them.
  test.each([
    ["ready", "ready", async () => {}, "ready", "ready"],
    ["ready, then idle", "ready", async (state: State, id: string) => { await turn(state, id); }, "idle", "ready"],
    ["blocked", "blocked", async () => {}, "blocked", "blocked"],
    ["blocked, then idle", "blocked", async (state: State, id: string) => { await turn(state, id); }, "idle", "blocked"],
    ["blocked, then stopped", "blocked", async (state: State, id: string, chiefId: string) => {
      state.live.set(id, { ...state.live.get(id)!, status: "active" });
      await call(state, "chief_stop", { threadId: id, reason: "Not worth more time" }, chiefId);
    }, "blocked", "blocked"],
  ])("a waived delegated test wave counts done once its tester is %s, before any review", async (_label, reported, settleTester, managed, lastReport) => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const { planner, tester } = await withTester(state, chief.threadId);
    await call(state, "chief_report", reported === "ready" ? { state: "ready", result: READY } : BLOCKED, tester);
    await settleTester(state, tester, chief.threadId);
    expect(row(state, tester)).toEqual({ state: managed, last_report_state: lastReport });
    expect(await roster(state, chief.threadId)).toContain(`waves: 1/2 done, wave 2 ${managed}`);

    await skip(state, chief.threadId, planner.threadId, 2, "Product bug tracked elsewhere");
    const waived = await roster(state, chief.threadId);
    expect(waived).toContain("waves: 2/2 done, wave 2 tests skipped");
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);
    // N/N alone neither completes nor absorbs the planner.
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("ready");
    await expect(call(state, "chief_complete", { threadId: tester }, chief.threadId)).rejects.toThrow(/Refusing to complete/);
    await call(state, "chief_complete", { threadId: tester, skipReview: "Waived tests, branch accepted as is" }, chief.threadId);
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("complete");
  });

  // Contract: an approved waived wave counts once. Preservation: it passes before the fix too; the mutation control adds both terms.
  test("an approving review of a waived test wave keeps 2/2, never 3/2", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const { planner, tester } = await withTester(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    await skip(state, chief.threadId, planner.threadId, 2, "Fixture waiver");
    await call(state, "chief_review", { workerThreadId: tester }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await call(state, "chief_report", { state: "ready", result: "Looks right", verdict: "approve", findings: [] }, reviewer.threadId);
    const after = await roster(state, chief.threadId);
    expect(after).toContain("waves: 2/2 done, wave 2 approved");
    expect(after).not.toContain("3/2");
  });

  // Contract: equivalence. A plan with no waived wave counts exactly as before: done is the waves behind the current one, plus one once approved.
  // Preservation: passes before the fix; the mutation control makes every final wave count as waived.
  test("an unwaived plan's progress runs 0/2, 1/2, then 2/2 only once approved", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    expect(await roster(state, chief.threadId)).toContain("waves: 0/2 done, wave 1 not delegated");
    const impl = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    expect(await roster(state, chief.threadId)).toContain("waves: 0/2 done, wave 1 ready");
    const tester = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "2", "--replaces", impl]);
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    expect(await roster(state, chief.threadId)).toContain("waves: 1/2 done, wave 2 ready");
    await call(state, "chief_review", { workerThreadId: tester }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await call(state, "chief_report", { state: "ready", result: "Looks right", verdict: "approve", findings: [] }, reviewer.threadId);
    expect(await roster(state, chief.threadId)).toContain("waves: 2/2 done, wave 2 approved");
  });

  // Contract: an undelegated waived wave counts done and stays in the total; the alert's M is the same total.
  // Regression: total dropped the absent wave (0/1), so the roster disagreed with "wave N of M".
  test("a test wave waived before delegation counts done and stays in the total", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    await skip(state, chief.threadId, planner.threadId, 2, "Docs only");
    expect(await roster(state, chief.threadId)).toContain("waves: 1/2 done, wave 1 not delegated");
    const impl = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    expect(state.spawned.at(-1).prompt).toContain("Wave 1 of 2");
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    expect(await roster(state, chief.threadId)).toContain("waves: 1/2 done, wave 1 ready");
    expect(state.sent.at(-1).input[0].text).toContain("All 2 waves are ready.");
  });

  // Contract: agreement. Two chains, one test wave waived after delegation and one before: the roster denominator equals the M of the wave line.
  test("with waived waves the progress denominator equals the plan's wave count", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [
      { body: PLAN_FIXTURE }, { body: testWave(2), test: true },
      { body: wave(3), dependsOn: [] }, { body: testWave(4), test: true, dependsOn: [3] },
    ]);
    // Two implementation waves need the plan's one advisor review before any delegation.
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan review", mission: "Review this plan before delegation" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await call(state, "chief_report", { state: "ready", result: "Sound plan", verdict: "approve" }, advisor.threadId);
    await skip(state, chief.threadId, planner.threadId, 4, "Second chain needs no tests");
    const impl1 = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl1);
    const tester = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "2", "--replaces", impl1]);
    expect(state.spawned.at(-1).prompt).toContain("Wave 2 of 4");
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    await skip(state, chief.threadId, planner.threadId, 2, "First chain waived after delegation");
    const text = await roster(state, chief.threadId);
    expect(text).toMatch(/waves: \d\/4 done/);
    expect(text).toContain("wave 2 of 4:");
    expect(text).toContain("wave 4 of 4:");
    expect(text).toContain("waves: 3/4 done, wave 2 tests skipped, wave 3 not delegated");
  });

  const reviewerSpawn = (state: State) => state.spawned.filter((entry) => String(entry.title).startsWith("Review · ")).at(-1)!.prompt as string;
  const reviewContext = async (state: State) => {
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    return reviewContextOf(state, reviewer.threadId);
  };
  const WAIVER_REASON = "R".repeat(500);
  const RULE = "are authorized omissions: their absence is not scope drift";
  const KEEP = "Every commit on the branch (including any a waived tester already pushed) and every unwaived wave's contracts stay fully under review.";

  // Contract: through chief_review, the reviewer gets Chief's waiver in review-context.md and the authorized-omission rule in its prompt,
  // never the waived wave's contracts; unwaived contracts and the plan file list stay. Regression: the reviewer was asked to verify contracts of tests that never ran.
  test.each([
    ["a tester ran, then Chief waived", true],
    ["Chief waived before any tester", false],
  ])("the reviewer gets the waiver in place of the waived wave's contracts when %s", async (_label, delegated) => {
    const state = await setupWithPlans();
    const chief = await start(state);
    let reviewed: string;
    let planner: { threadId: string };
    if (delegated) {
      const set = await withTester(state, chief.threadId);
      planner = set.planner;
      reviewed = set.tester;
      await call(state, "chief_report", { state: "ready", result: READY }, reviewed);
      await skip(state, chief.threadId, planner.threadId, 2, WAIVER_REASON);
    } else {
      planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
      await skip(state, chief.threadId, planner.threadId, 2, WAIVER_REASON);
      reviewed = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
      await call(state, "chief_report", { state: "ready", result: READY }, reviewed);
    }
    await call(state, "chief_review", { workerThreadId: reviewed }, chief.threadId);
    const prompt = reviewerSpawn(state);
    const context = await reviewContext(state);
    const path2 = join(state.storageRoot, "chief", "proj_1", planner.threadId, "plan-2.md");

    expect(context).toContain(`## Waived test waves\nWave 2 of 2: ${path2}: tests skipped by Chief: ${WAIVER_REASON}`);
    // Wave 1 removed the `## Context` bullet list; the waiver rule line (unchanged) still points the reviewer at the section.
    expect(prompt).not.toContain("- The test waves Chief waived, with Chief's reason for each.");
    expect(prompt).toContain("Chief waived the test waves listed under `## Waived test waves` in review-context.md (chief_skip_tests), each with its reason.");
    expect(prompt).toContain(RULE);
    expect(prompt).toContain(KEEP);
    expect(prompt).toContain("Totals stay non-negative");
    expect(prompt).not.toContain("TESTWAVE2");
    expect(prompt).toContain("Wave 1 of 2:\n- Totals stay non-negative");
    expect(prompt).not.toContain("Wave 2 of 2:\n");
    // The waived wave's file is still listed in the plan section.
    expect(context).toContain(`Wave 2 of 2: ${path2}`);
  });

  // Contract: with no waived wave the reviewer's prompt and context carry no waiver text and keep every wave's contracts in order.
  // Preservation: passes before the fix; the mutation control drops the waiverLines guard and fails the byte comparison.
  test("a plan with no waived wave gets every contract and no waiver text", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const { tester } = await withTester(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    await call(state, "chief_review", { workerThreadId: tester }, chief.threadId);
    const prompt = reviewerSpawn(state);
    const context = await reviewContext(state);
    expect(prompt).toContain("## Contracts to verify\nWave 1 of 2:\n- Totals stay non-negative\nWave 2 of 2:\n- TESTWAVE2 suite stays green\n");
    for (const text of [prompt, context]) {
      expect(text).not.toContain("Waived test waves");
      expect(text).not.toContain("Chief waived");
      expect(text).not.toContain("authorized omissions");
    }
    // Byte equivalence: the files were captured from chief_review at the pre-fix oracle (8f7e4d6) on these same inputs.
    const portable = (text: string) => text.replaceAll(state.storageRoot, "<storage>").replace(/review-(\d+)\/[0-9a-f]{8}\//g, "review-$1/<attempt>/");
    // The prompt is the oracle (the oracle file is untouched) plus wave 1's named edits; the context is unchanged. A plan with no feature flag has no native line;
    // every slice here is skipped (no checkout), so the test-audit rule stays.
    const baseContext = await snapshotText("review-no-waiver.context.txt");
    const expected = wave1Prompt(await snapshotText("review-no-waiver.prompt.txt"), baseContext, {
      native: "none", testAudit: true, contextPath: `<storage>/chief/proj_1/${tester}/review-1/<attempt>/review-context.md`,
      ownership: "none", // the slice is skipped, so the docs history is unknown; a tester is no Spec Writer
    });
    expect(portable(prompt)).toBe(expected);
    // The context quotes the tester's brief; wave 1 drops its empty `## Success criteria` / `## Constraints` sections ("None stated.") — one named edit on the retained base context.
    expect(portable(context)).toBe(replaceText(baseContext, "## Success criteria\n- None stated.\n\n## Constraints\n- None stated.\n\n", "", 1));
  });

  // Contract: reviewBrief without waiverLines (an older caller) renders what it rendered before, and an empty list changes nothing.
  // The snapshot files were captured at the pre-fix oracle; the mutation control drops the waiverLines guard.
  test("reviewBrief without waiverLines renders the pre-waiver prompt and context", async () => {
    const target = { threadId: "thr_w", title: "Fix totals", prUrl: "https://github.com/acme/shop/pull/8", branch: "feature/x", reportSeq: 1, hasResult: true, reportPath: "/r/report-1.md",
      head: { branch: "feature/x", sha: "abc123", base: "main" } };
    const input: ReviewBriefInput = {
      worker: { ...target, kind: null, brief: null, reported: "Done" },
      targets: [target],
      wavePaths: ["/p/plan-1.md", "/p/plan-2.md"],
      chain: [1, 2],
      contractLines: ["Wave 1 of 2:", "- Totals stay non-negative", "Wave 2 of 2:", "- Suite stays green"],
      recordedLines: ["npm test → exit 0"],
      previous: null,
      chiefThreadId: "thr_c",
    };
    const omitted = reviewBrief(input);
    expect(reviewBrief({ ...input, waiverLines: [] })).toEqual(omitted);
    // No contextPath: the prompt inlines the context. Defaults: native line without the reshape parts, test audit kept, and no slice entry: the docs history is unknown, so the ownership block stays.
    const baseContext = await snapshotText("review-brief-no-waiverlines.context.txt");
    const expected = `${wave1Prompt(await snapshotText("review-brief-no-waiverlines.prompt.txt"), baseContext, { native: "noReshape", testAudit: true, contextPath: null, ownership: "none" })}\n\n## review-context.md\n${baseContext}`;
    expect(omitted.prompt).toBe(expected);
    await expect(omitted.context).toMatchFileSnapshot("./test/fixtures/review-brief-no-waiverlines.context.txt");
  });

  // The brief keeps the dynamic values (the branch in the push command, the record name); the sync, rebase and no-force rules live in the role skills.
  const pushRules = (prompt: string, branch: string, record = "Local sync") => {
    expect(prompt).toContain(`Task branch: ${branch}. After loading your skills and before any other file read, sync and record \`${record}: <sha>\``);
    expect(prompt).toContain(`\`git push origin HEAD:${branch}\``);
  };

  // Contract (todo #743): every brief with a branch names the exact push refspec, so a worktree on its own bb/ branch still moves the named branch.
  // Regression: the brief said only "Check that branch out", and a tester pushed its bb/ branch instead.
  test.each([
    ["a fresh worker", "worker"],
    ["a fresh designer", "designer"],
  ])("%s with a branch gets the push refspec", async (_label, kind) => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId, "Fix totals", { branch: "feature/x", kind });
    pushRules(state.spawned.at(-1).prompt, "feature/x");
    expect(state.spawned.at(-1).environment.workspace.baseBranch).toEqual({ kind: "named", name: "feature/x" });
  });

  test("a tester on a new branch after the tested wave's PR merged gets the push refspec", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    const impl = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1", "--branch", "feature/x"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    await call(state, "chief_complete", { threadId: impl, skipReview: "Merged; tests follow on the same branch name" }, chief.threadId);
    await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "2", "--kind", "tester", "--branch", "feature/x"]);
    const spawn = state.spawned.at(-1);
    expect(spawn.environment.workspace).toMatchObject({ type: "managed-worktree", baseBranch: { kind: "named", name: "feature/x" } });
    expect(spawn.prompt).toContain("## Test work");
    pushRules(spawn.prompt, "feature/x", "Base commit");
  });

  test.each([
    ["a worker", undefined],
    ["a tester", "tester"],
  ])("a replaces: successor %s inherits the branch and the push refspec", async (_label, kind) => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId, "Fix totals", { branch: "feature/x" });
    await delegate(state, chief.threadId, "Next", { replaces: first.threadId, ...(kind ? { kind } : {}) });
    pushRules(state.spawned.at(-1).prompt, "feature/x", kind ? "Base commit" : "Local sync");
  });

  // Preservation: a brief with no branch has no push-target line; the mutation control makes the line unconditional.
  test("a brief with no branch has no push-target line", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    expect(state.spawned.at(-1).prompt).not.toContain("git push origin HEAD:");
    expect(state.spawned.at(-1).prompt).not.toContain("Never push any other branch");
  });

  const RUNS_TESTS = "not run: runs tests (a tester's)";
  const FULL_SUITE = "not run: full suite not asked for";
  const withVerify = async (state: State, chiefId: string, command: string, extra: string[]) => {
    const result = await state.harness.behavior.runCli(["delegate", "--title", "Check", "--mission", "Do it", "--verify", command, ...extra, "--json"], { threadId: chiefId, ...P });
    expect(result.exitCode, result.stderr).toBe(0);
    return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
  };
  const verifyBlock = (prompt: string, command: string) => expect(prompt).toContain(`## Verify command\n\`\`\`sh\n${command}\n\`\`\`\n`);

  // Contract: a test-running verifyCommand is accepted and only flagged in the brief, per role (a worker or designer must not run it; a tester must not run the full suite).
  // Preservation: the mutation control drops each instruction line.
  test.each([
    ["worker", ["--kind", "worker"], RUNS_TESTS, FULL_SUITE],
    ["designer", ["--kind", "designer"], RUNS_TESTS, FULL_SUITE],
  ])("a %s with a test-running verifyCommand is accepted and told not to run it", async (_role, extra, present, absent) => {
    const state = await setup();
    const chief = await start(state);
    await withVerify(state, chief.threadId, "npx vitest run", [...extra, "--unplanned-reason", "Bounded test fixture"]);
    const prompt: string = state.spawned.at(-1).prompt;
    verifyBlock(prompt, "npx vitest run");
    expect(prompt).toContain(present);
    expect(prompt).not.toContain(absent);
  });

  test.each([
    ["a filtered command", 'npx vitest run server.test.ts -t "totals"'],
    ["an unfiltered full-suite command", "npm test"],
  ])("a tester with %s gets the full-suite rule, not the worker's runs-tests line", async (_label, command) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix totals");
    await withVerify(state, chief.threadId, command, ["--replaces", worker.threadId, "--kind", "tester"]);
    const prompt: string = state.spawned.at(-1).prompt;
    verifyBlock(prompt, command);
    expect(prompt).toContain(FULL_SUITE);
    expect(prompt).not.toContain(RUNS_TESTS);
  });

  test("replaces: inherits the verifyCommand and the successor's own role decides the instruction", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await withVerify(state, chief.threadId, "npm run build", ["--unplanned-reason", "Bounded test fixture"]);
    // A tester replacing a worker inherits the worker's build command.
    const tester = await delegate(state, chief.threadId, "Test it", { replaces: worker, kind: "tester" });
    verifyBlock(state.spawned.at(-1).prompt, "npm run build");
    expect(state.spawned.at(-1).prompt).toContain(FULL_SUITE);
    // A worker replacing a tester inherits the tester's test command and must not run it.
    const tests = await withVerify(state, chief.threadId, "npx vitest run", ["--replaces", tester.threadId, "--kind", "tester"]);
    await delegate(state, chief.threadId, "Fix product", { replaces: tests, kind: "worker" });
    const prompt: string = state.spawned.at(-1).prompt;
    verifyBlock(prompt, "npx vitest run");
    expect(prompt).toContain(RUNS_TESTS);
    expect(prompt).not.toContain(FULL_SUITE);
  });
});
