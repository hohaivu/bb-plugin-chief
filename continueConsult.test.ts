import { afterEach, describe, expect, test, vi } from "vitest";
import { CLOSE_OUT, REQUEST_CHANGES, chiefReview, configurationContext, delegate, disposeAll, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
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
    if (role === "reviewer") await chiefReview(state, chief.threadId, { workerThreadId: (await delegate(state, chief.threadId)).threadId });
    if (role === "advisor") await state.harness.behavior.runCli(["consult", "--title", "Rework checkout", "--mission", "Explore a fix for the discount bug"], opts);
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
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    expect(state.spawned.at(-1).prompt).toContain("file:line");
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

  test("consults a read-only advisor in the failing worker's worktree with its brief, verdicts, and branch", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "advisor",
      selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/fix-checkout-totals" });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals are off by the discount", ...REQUEST_CHANGES,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    await state.harness.behavior.callAgentTool("chief_consult", {
      title: "Fix checkout totals", mission: "Diagnose why the discount keeps failing review",
      workerThreadId: worker.threadId,
    }, { threadId: chief.threadId, projectId: "proj_1" });

    const spawned = state.spawned.at(-1);
    expect(spawned).toMatchObject({
      title: "Consult · Fix checkout totals",
      environment: { type: "reuse", environmentId: "env_worker" },
      pluginMetadata: { role: "advisor" },
      providerId: "codex",
    });
    expect(spawned.prompt).toBeDefined();
    expect(spawned.input).toBeUndefined();
    const prompt = spawned.prompt as string;
    expect(prompt).toContain("Remain advisory");
    expect(prompt).toContain("Correct and verify totals");
    expect(prompt).toContain("Regression passes");
    expect(prompt).toContain("Verdict: request_changes");
    expect(prompt).toContain("Totals are off by the discount");
    expect(prompt).toContain("feature/fix-checkout-totals");

    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(advisor.threadId));
    expect(configured.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(configured.skills).toEqual(["chief-worker", "chief-role-read-only"]);
  });

  test("consults without a worker in the project checkout, and only from Chief", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli(
      ["consult", "--title", "Rework checkout", "--mission", "Explore a fix for the discount bug"], opts,
    );
    expect(result.exitCode).toBe(0);
    expect(state.spawned.at(-1)).toMatchObject({ environment: { type: "project-default" } });

    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool(
      "chief_consult", { title: "Sneak one in", mission: "Not allowed" }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow(/active registered Chief/);

    const otherChief = await start(state, "proj_2");
    await expect(state.harness.behavior.callAgentTool(
      "chief_consult", { title: "Cross-chief", mission: "Not allowed", workerThreadId: worker.threadId },
      { threadId: otherChief.threadId, projectId: "proj_2" },
    )).rejects.toThrow("for this Chief");
  });

  test("hands an advisor's advice back to Chief and never auto-reviews it", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.runCli(
      ["consult", "--title", "Fix checkout totals", "--mission", "Diagnose the discount bug", "--worker", worker.threadId],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is applied before the tax rounds",
    }, { threadId: advisor.threadId, projectId: "proj_1" });

    const reported = state.sent.at(-1).input[0].text;
    expect(reported).toContain("Advisor report");
    expect(reported).toContain(`chief_delegate (replaces: ${worker.threadId})`);

    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(advisor.threadId)!,
      lastAssistantText: "advice given",
    });
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);
  });
});
