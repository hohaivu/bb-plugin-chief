import { afterEach, describe, expect, test, vi } from "vitest";
import { CLOSE_OUT, REQUEST_CHANGES, chiefReview, configurationContext, delegate, disposeAll, execFileMock, ghHead, planTwoWaves, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  const BRANCH = "feature/fix-checkout-totals";
  const PR = "https://github.com/acme/shop/pull/8";
  const as = (threadId: string) => ({ threadId, projectId: "proj_1" });
  /** A worker on a branch with a pull request, reported ready: what a review gate pins. gh answers the pull-request lookup. */
  async function readyWorker(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string) {
    execFileMock.mockImplementation(async (file: string, args: string[]) => ({ stdout: file === "gh" && args[0] === "pr" ? ghHead(BRANCH) : "" }));
    const worker = await delegate(state, chiefThreadId, "Fix checkout totals", { branch: BRANCH, prUrl: PR });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(worker.threadId));
    return worker;
  }
  /** A planner with a two-wave plan, then the advisor chief_consult starts over it. */
  async function planAdvisor(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string) {
    const { planner } = await planTwoWaves(state, chiefThreadId);
    await state.harness.behavior.callAgentTool("chief_consult", { planThreadId: planner.threadId, title: "Plan", mission: "Review this plan before delegation" }, as(chiefThreadId));
    return { planner, advisor: (await status(state)).threads.find((row) => row.role === "advisor")! };
  }

  test("steers a continuation with the instruction first", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.runCli(["continue", planner.threadId, "--instruction", "Name the test file"]);

    expect(state.sent.at(-1).mode).toBe("steer-if-active");
    const text = state.sent.at(-1).input[0].text as string;
    expect(text.startsWith("Name the test file")).toBe(true);
    expect(text.startsWith("Remain read-only")).toBe(false);
    // The read-only reminder still follows, unchanged in wording.
    expect(text).toContain("Remain read-only: do not create, modify, or delete any file the repository tracks, and do not commit or push. Submit the plan itself through chief_report's plan field, not as a file write. A worker implements the plan in its own worktree.");
  });

  test.each([
    ["planner", "fresh chief_plan"],
    ["reviewer", "fresh review with chief_review"],
    ["advisor", "fresh chief_consult"],
  ])("rejects an over-long %s instruction with a %s reroute", async (role, reroute) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    if (role === "planner") await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], opts);
    if (role === "reviewer") await chiefReview(state, chief.threadId, { workerThreadId: (await readyWorker(state, chief.threadId)).threadId });
    if (role === "advisor") await planAdvisor(state, chief.threadId);
    const target = (await status(state)).threads.find((row) => row.role === role)!;
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === target.threadId).length;
    const result = await state.harness.behavior.runCli(["continue", target.threadId, "--instruction", "x".repeat(7_995)]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(reroute);
    expect(state.sent.filter((entry: any) => entry.threadId === target.threadId)).toHaveLength(sentBefore);
  });

  test("refuses chief_continue on a worker that already reported ready", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === worker.threadId).length;

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "Keep going" }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore);
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).toBe("ready");

    const cliResult = await state.harness.behavior.runCli(["continue", worker.threadId, "--instruction", "Keep going"]);
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stderr).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore);
  });

  test("refuses chief_continue on a reviewer that already reported", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await readyWorker(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Tax is off", ...REQUEST_CHANGES,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    const before = state.db.prepare("SELECT state, verdict, regression, reject_streak, verdict_path FROM managed_threads WHERE thread_id=?").get(reviewer.threadId);
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === reviewer.threadId).length;

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: reviewer.threadId, instruction: "Look again" }, opts,
    )).rejects.toThrow("chief_review");
    const cliResult = await state.harness.behavior.runCli(["continue", reviewer.threadId, "--instruction", "Look again"]);
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stderr).toContain("chief_review");
    expect(state.sent.filter((entry: any) => entry.threadId === reviewer.threadId)).toHaveLength(sentBefore);
    expect(state.db.prepare("SELECT state, verdict, regression, reject_streak, verdict_path FROM managed_threads WHERE thread_id=?").get(reviewer.threadId)).toEqual(before);
    expect(before).toMatchObject({ state: "ready", verdict: "request_changes", verdict_path: expect.any(String) });
  });

  test("refuses chief_continue on a worker that already reported complete", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed", ...CLOSE_OUT }, opts);

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "Keep going" }, opts,
    )).rejects.toThrow(`chief_delegate (replaces: ${worker.threadId})`);
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).toBe("complete");
  });

  test("rejects a nudge over 500 characters but accepts one at the limit", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId);
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === worker.threadId).length;

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "x".repeat(501) }, opts,
    )).rejects.toThrow("instruction: Too big: expected string to have <=500 characters");
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore);

    await state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "x".repeat(500) }, opts,
    );
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore + 1);
  });

  test("chief_consult starts a read-only advisor over a plan, and it reports advice back to Chief without an auto-review", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "advisor",
      selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const { advisor } = await planAdvisor(state, chief.threadId);
    expect(state.spawned.at(-1)).toMatchObject({ pluginMetadata: { role: "advisor" }, providerId: "codex" });
    expect(state.spawned.at(-1).prompt).toContain("Remain advisory");
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(advisor.threadId));
    expect(configured.tools.map((tool) => tool.name)).toEqual(["chief_report"]);

    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "The plan is sound.", verdict: "approve" }, as(advisor.threadId));
    expect(state.sent.at(-1).input[0].text).toContain("Advisor report");
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(advisor.threadId)!, lastAssistantText: "advice given" });
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);
  });

  // Contract (plan-4/plan-5): chief_consult is for plans only; the worker consult mode is gone.
  // Regression: a consult over a worker (or over nothing) starts an advisor again.
  test("chief_consult is for plans only: no plan, or a worker in place of one, starts no advisor, and only Chief may call it", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = as(chief.threadId);
    const worker = await delegate(state, chief.threadId);
    const spawnedBefore = state.spawned.length;
    await expect(state.harness.behavior.callAgentTool("chief_consult", { title: "Totals", mission: "Why do totals go negative?" }, opts)).rejects.toThrow(/planThreadId/);
    await expect(state.harness.behavior.callAgentTool("chief_consult", { title: "Totals", mission: "Why do totals go negative?", workerThreadId: worker.threadId }, opts)).rejects.toThrow(/planThreadId/);
    await expect(state.harness.behavior.callAgentTool("chief_consult", { title: "Totals", mission: "Why?", planThreadId: worker.threadId }, opts)).rejects.toThrow();
    const cli = await state.harness.behavior.runCli(["consult", "--title", "Totals", "--mission", "Why do totals go negative?", "--worker", worker.threadId], opts);
    expect(cli.exitCode).toBe(1);
    await expect(state.harness.behavior.callAgentTool("chief_consult", { title: "Sneak", mission: "Not allowed", planThreadId: "thr_plan" }, as(worker.threadId))).rejects.toThrow(/active registered Chief/);
    expect(state.spawned).toHaveLength(spawnedBefore);
    expect((await status(state)).threads.some((row) => row.role === "advisor")).toBe(false);
  });

  // Contract (plan-4 step B7 and the redesign): replacement is never gated on a rejection count. W is not a gate target (B7
  // refuses replacing an open gate's target); it carries the request_changes history a pre-gate database left behind.
  // Regression: the removed consult and user-flag steps returning, so a replacement after repeated request_changes needs a consult or a user flag.
  test("chief_delegate (replaces: W, kind: worker) after request_changes verdicts is admitted with no consult and no user flag", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { branch: BRANCH });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, as(worker.threadId));
    state.db.prepare(`UPDATE managed_threads SET reject_streak=7 WHERE thread_id=?`).run(worker.threadId);
    for (let n = 0; n < 7; n += 1) {
      state.db.prepare(`INSERT INTO reviewer_verdicts (reviewer_thread_id, worker_thread_id, verdict, report_seq, at, head_sha, worker_report_seq) VALUES (?, ?, 'request_changes', ?, ?, ?, ?)`).run(`thr_old_${n}`, worker.threadId, n + 1, n, "a".repeat(40), 1);
    }
    const spawnedBefore = state.spawned.length;
    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix totals again", "--mission", "Do it differently", "--unplanned-reason", "Replacement fixture", "--replaces", worker.threadId, "--json",
    ], as(chief.threadId));
    expect(result.exitCode).toBe(0);
    expect(state.spawned).toHaveLength(spawnedBefore + 1);
    expect(state.spawned.at(-1).pluginMetadata).toMatchObject({ role: "worker" });
    expect((await status(state)).threads.some((row) => row.role === "advisor")).toBe(false);
  });
});
