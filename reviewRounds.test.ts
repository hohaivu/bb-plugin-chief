import { afterEach, describe, expect, test, vi } from "vitest";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APPROVE, PLAN_FIXTURE, REQUEST_CHANGES, chiefReview, completeWorker, configurationContext, delegate, disposeAll, elapse, execFileMock, ghHead, readyAction, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  const BRANCH = "feature/totals";
  const PR = "https://github.com/acme/shop/pull/8";
  const as = (threadId: string) => ({ threadId, projectId: "proj_1" });
  /** A worker on a branch with a pull request, reported ready: what the review gate pins. gh answers the pull-request lookup. */
  async function readyWorker(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, title = "Fix checkout totals", result = "Totals fixed and covered by a test", kind?: string) {
    execFileMock.mockImplementation(async (file: string, args: string[]) => ({ stdout: file === "gh" && args[0] === "pr" ? ghHead(BRANCH) : "" }));
    const worker = await delegate(state, chiefThreadId, title, { branch: BRANCH, prUrl: PR, kind });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result }, as(worker.threadId));
    return worker;
  }
  const spawnedAs = (state: Awaited<ReturnType<typeof setup>>, role: string) => state.spawned.filter((entry) => entry.pluginMetadata?.role === role || entry.pluginMetadata?.kind === role);

  test("supersedes an undelivered alert instead of re-delivering it after a newer report", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    const firstResult = await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "First report",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(firstResult).toContain("Report queued for Chief");
    expect(state.sent).toHaveLength(0);

    // A newer report lands before the failed one is ever retried.
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Second report",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].input[0].text).toContain("Second report");

    // The first attempt's alert is still sitting undelivered; a retry sweep must not
    // resurrect it now that Chief has already received what actually happened next.
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(1);
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("First report"))).toBe(false);
  });

  test("does not let an ordinary lifecycle alert evict a report still waiting for delivery", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    const result = await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Needs review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(result).toContain("Report queued for Chief");
    expect(state.sent).toHaveLength(0);

    // Generic lifecycle noise (a different alert "kind") must never evict the
    // still-undelivered report alert above.
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "idle result",
    });
    elapse(31_000);
    await state.supervisorCycle();
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("Needs review"))).toBe(true);
  });

  test("identical re-report in the same cycle sends once", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
  });

  test("retry does not re-send an alert BB already queued", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(0);
    const outboxRow = state.db.prepare(`SELECT message FROM alert_outbox WHERE dedupe_key LIKE ?`)
      .get(`${worker.threadId}:report:%`) as any;
    state.seedQueuedMessage(chief.threadId, outboxRow.message);
    elapse(31_000);
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(0);
    const delivered = state.db.prepare(`SELECT delivered_at FROM alert_outbox WHERE dedupe_key LIKE ?`)
      .get(`${worker.threadId}:report:%`) as any;
    expect(delivered.delivered_at).not.toBeNull();
  });

  test("self-woken turn after a report sends no idle alert", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done again",
    });
    expect(state.sent).toHaveLength(1);
  });

  test("sends no idle alert after a delivered planner or blocked-worker report", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Plan written", plan: [{ body: PLAN_FIXTURE }],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    const sentAfterPlan = state.sent.length;
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(planner.threadId)!,
      lastAssistantText: "done",
    });
    expect(state.sent).toHaveLength(sentAfterPlan);
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("is idle"))).toBe(false);

    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    const sentAfterBlocked = state.sent.length;
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    expect(state.sent).toHaveLength(sentAfterBlocked);
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("is idle"))).toBe(false);
  });

  test("requires canonical ready and complete report payloads", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "ready" }, { threadId: worker.threadId })).rejects.toThrow();
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "blocked", blocker: "Need scope" }, { threadId: worker.threadId })).rejects.toThrow();
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "complete", result: "done" }, { threadId: worker.threadId })).rejects.toThrow();
  });

  test("refuses completion while a thread is running", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    const denied = await state.harness.behavior.runCli(["complete", worker.threadId]);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("while it is active");
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    await completeWorker(state, chief.threadId, worker.threadId);
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)!.state).toBe("complete");
  });

  test("starts one reviewer once, and deduplicates concurrent requests", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await readyWorker(state, chief.threadId);
    const [first, second] = await Promise.all([
      chiefReview(state, chief.threadId, { workerThreadId: worker.threadId }),
      chiefReview(state, chief.threadId, { workerThreadId: worker.threadId }),
    ]);
    expect(first.threadId).toBe(second.threadId);
    expect(spawnedAs(state, "reviewer")).toHaveLength(1);
  });

  test("starts a review for a plain branch with no managed worker, on a fresh worktree based on it", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const parsed = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });
    expect(parsed.created).toBe(true);
    expect(parsed.title).toBe("Review · feature/legacy-fix");
    const spawnedReview = state.spawned.find((entry) => entry.title === "Review · feature/legacy-fix");
    expect(spawnedReview).toMatchObject({
      parentThreadId: chief.threadId,
      environment: {
        type: "host", hostId: "host_1",
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/legacy-fix" } },
      },
    });
    expect(spawnedReview.prompt).toContain("Remain review-only");
    expect(spawnedReview.prompt).toContain("feature/legacy-fix");
    // The CLI door is shut for every caller, the active Chief included: reviews start only through chief_review.
    const retired = await state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix"], opts);
    expect(retired.exitCode).toBe(1);
    expect(retired.stderr).toContain("bb chief review is retired");
  });

  test("returns the existing reviewer instead of duplicating one for the same branch", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const [first, second] = await Promise.all([
      chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" }),
      chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" }),
    ]);
    expect(first.threadId).toBe(second.threadId);
    expect(state.spawned.filter((entry) => entry.title === "Review · feature/legacy-fix")).toHaveLength(1);
    // A later, no-longer-in-flight call must also return the same reviewer, not spawn another.
    const third = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });
    expect(third.created).toBe(false);
    expect(state.spawned.filter((entry) => entry.title === "Review · feature/legacy-fix")).toHaveLength(1);
  });

  test.each([
    ["both a worker and a branch", true],
    ["neither a worker nor a branch/pull request", false],
  ])("rejects chief_review given %s", async (_name, both) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const params = both ? { workerThreadId: worker.threadId, branch: "feature/legacy-fix" } : {};
    await expect(state.harness.behavior.callAgentTool(
      "chief_review", params, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow("Give exactly one of workerThreadId, pullRequest, or branch.");
  });

  test("a branch reviewer's row records the branch, and reports through the same verdict contract as a worker's reviewer", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const { threadId: reviewerThreadId } = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });
    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, opts) as string;
    expect(roster).toContain("branch: feature/legacy-fix");
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Reviewed the branch", ...APPROVE,
    }, { threadId: reviewerThreadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: approve");
  });

  test("does not review a ready worker until Chief calls chief_review, and the reviewer gets a fresh worktree on the branch", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await readyWorker(state, chief.threadId);
    // The report itself already names the exact next call.
    expect(state.sent.at(-1).input[0].text).toContain(readyAction(worker.threadId));
    const sentBeforeIdle = state.sent.length;
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    // Idle alone spawns no reviewer and sends no extra alert.
    expect(spawnedAs(state, "reviewer")).toHaveLength(0);
    expect(state.sent).toHaveLength(sentBeforeIdle);

    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, as(chief.threadId));
    const review = spawnedAs(state, "reviewer");
    expect(review).toHaveLength(1);
    // Never the builder's own environment: a fresh managed worktree based on the worker's branch.
    expect(review[0].environment).toMatchObject({ type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: BRANCH } } });
    // A second chief_review call must not spawn a second reviewer.
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, as(chief.threadId));
    expect(spawnedAs(state, "reviewer")).toHaveLength(1);
  });

  test("keeps a busy reviewer instead of spawning a second one", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await readyWorker(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, as(chief.threadId));
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready again" }, as(worker.threadId));
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, as(chief.threadId));

    expect(spawnedAs(state, "reviewer")).toHaveLength(1);
  });

  test("a reviewer's rejection must be a verdict field, and reaches Chief and inspect", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await readyWorker(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, as(chief.threadId));
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

    // A rejection must be a field, not prose Chief has to parse back out.
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice",
    }, as(reviewer.threadId))).rejects.toThrow(/verdict/);

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice", ...REQUEST_CHANGES,
    }, as(reviewer.threadId));
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: request_changes");
    expect(JSON.stringify(await state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
    ))).toContain("Verdict: request_changes");
  });

  describe("designer kind", () => {
    const opts = (chiefThreadId: string) => ({ threadId: chiefThreadId, projectId: "proj_1" });
    const rowOf = (state: any, threadId: string) => state.db.prepare("SELECT role, kind FROM managed_threads WHERE thread_id=?").get(threadId);

    test("chief_delegate kind designer adds the design-work section; the role stays worker", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId, "Draw the checkout screen", { kind: "designer" });
      const prompt: string = state.spawned.at(-1).prompt;
      expect(prompt).toContain("## Design work");
      expect(prompt).toContain("paper-mcp-instructions");
      expect(prompt).toContain("finish_working_on_nodes");
      expect(rowOf(state, worker.threadId)).toEqual({ role: "worker", kind: "designer" });
      expect(state.spawned.at(-1).pluginMetadata.role).toBe("worker");
      const roster = JSON.stringify(await state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, opts(chief.threadId)));
      expect(roster).toContain("Kind: designer");
    });

    test("plain chief_delegate has no design-work section and no kind", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      expect(state.spawned.at(-1).prompt).not.toContain("## Design work");
      expect(rowOf(state, worker.threadId)).toEqual({ role: "worker", kind: null });
      expect(JSON.stringify(await state.harness.behavior.callAgentTool("chief_roster", {}, opts(chief.threadId)))).not.toContain("kind:");
    });

    test("replaces: keeps the designer kind; an explicit kind wins", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId, "Draw the checkout screen", { kind: "designer" });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Drawn" }, { threadId: first.threadId, projectId: "proj_1" });
      const second = await delegate(state, chief.threadId, "Draw the checkout screen", { replaces: first.threadId });
      expect(state.spawned.at(-1).prompt).toContain("## Design work");
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Drawn" }, { threadId: second.threadId, projectId: "proj_1" });
      const third = await delegate(state, chief.threadId, "Wire the checkout screen", { replaces: second.threadId, kind: "worker" });
      expect(state.spawned.at(-1).prompt).not.toContain("## Design work");
      expect(rowOf(state, third.threadId).kind).toBeNull();
    });

    test("reviewer of a designer gets the design check", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await readyWorker(state, chief.threadId, "Draw the checkout screen", "Drawn", "designer");
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts(chief.threadId));
      expect(spawnedAs(state, "reviewer")[0].prompt).toContain("This is design work (a Designer). Check it read-only against the brief's mode. Design tool: check the result with the tool's screenshots");
    });

  });

  describe("verdict file", () => {
    const reviewed = async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await readyWorker(state, chief.threadId, "Fix checkout totals", "Ready for review");
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, as(chief.threadId));
      const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
      const pathOf = () => (state.db.prepare("SELECT verdict_path FROM managed_threads WHERE thread_id=?").get(reviewer.threadId) as { verdict_path: string }).verdict_path;
      return { state, chief, worker, reviewer, pathOf };
    };
    const findings = `${"The discount is applied twice. ".repeat(80)}END-OF-FINDINGS`;

    test("persists a reviewer's full verdict to a file and names it in the alert and inspect", async () => {
      const { state, chief, worker, reviewer, pathOf } = await reviewed();
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, ...REQUEST_CHANGES, regression: true, recommendation: "Apply it once",
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      const path = pathOf();
      expect(path).toMatch(/verdict-1\.md$/);
      const file = await readFile(path, "utf8");
      expect(file).toContain(findings);
      expect(file).toContain("Verdict: request_changes\nRegression: yes");
      expect(file).toContain(`Reviewed worker: ${worker.threadId}`);
      expect(file).toContain("## Recommendation\n\nApply it once");
      const alert: string = state.sent.at(-1).input[0].text;
      expect(alert).toContain(`Verdict: request_changes\nVerdict file: ${path}`);
      expect(alert.indexOf("Verdict file:")).toBeLessThan(alert.indexOf("Result:"));
      expect(JSON.stringify(await state.harness.behavior.callAgentTool(
        "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
      ))).toContain(`Verdict file: ${path}`);
    });

    test("a failed verdict-file write does not fail the report", async () => {
      const { state, chief, reviewer } = await reviewed();
      // A plain file where the reviewer's artifact directory should be makes the write fail. The durable brief
      // (persistBrief) creates that directory in the background: wait for it, then remove it.
      await vi.waitFor(() => access(join(state.storageRoot, "chief", "proj_1", reviewer.threadId, "brief.md")));
      await rm(join(state.storageRoot, "chief", "proj_1", reviewer.threadId), { recursive: true, force: true });
      await mkdir(join(state.storageRoot, "chief", "proj_1"), { recursive: true });
      await writeFile(join(state.storageRoot, "chief", "proj_1", reviewer.threadId), "not a directory");
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, ...APPROVE,
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      expect(state.sent.at(-1).input[0].text).toContain("Verdict: approve");
      expect(state.sent.at(-1).input[0].text).not.toContain("Verdict file:");
      expect(JSON.stringify(await state.harness.behavior.callAgentTool(
        "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
      ))).not.toContain("Verdict file:");
    });
  });

  test("keeps reviewers read-only however the continuation is phrased", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await readyWorker(state, chief.threadId);
    const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    // The removed --allow-edits flag must not resurface as an unreviewed edit path.
    await state.harness.behavior.runCli(["continue", review.threadId, "--instruction", "Fix it yourself", "--allow-edits"]);
    const text = state.sent.filter((entry: any) => entry.threadId === review.threadId).at(-1).input[0].text;
    expect(text).toContain("Remain review-only");
    expect(text).not.toContain("edits are allowed");
    const chiefTools = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(JSON.stringify(chiefTools.tools.find((tool: any) => tool.name === "chief_continue"))).not.toContain("allowEdits");
  });

});
