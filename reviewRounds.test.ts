import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APPROVE, PLAN_FIXTURE, REQUEST_CHANGES, TEST_WAVE, chiefReview, completeWorker, configurationContext, delegate, disposeAll, elapse, latestReviewContext, reviewContextOf, rowOf, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { expectLoadLine } from "./test/loadLine";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
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
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Plan written", plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2)],
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

  test("waits for an idle worker, starts a read-only review, and deduplicates concurrent requests", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await expect(chiefReview(state, chief.threadId, { workerThreadId: worker.threadId })).rejects.toThrow("is active; wait until it is idle before starting a review.");
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    const [first, second] = await Promise.all([
      chiefReview(state, chief.threadId, { workerThreadId: worker.threadId }),
      chiefReview(state, chief.threadId, { workerThreadId: worker.threadId }),
    ]);
    expect(first.threadId).toBe(second.threadId);
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
    expect(state.spawned.at(-1).prompt).toContain("Remain review-only");
    // The reviewer confirms the automated criteria ran instead of taking the worker's word for it.
    expect(state.spawned.at(-1).prompt).toContain("Confirm the automated criteria actually ran with their exit status; list the manual criteria that still need a human to confirm.");
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

  test("does not review a ready worker until Chief calls chief_review", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed and covered by a test",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    // The report itself already names the exact next call.
    expect(state.sent.at(-1).input[0].text).toContain(`chief_review (workerThreadId: ${worker.threadId})`);
    const sentBeforeIdle = state.sent.length;
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    // Idle alone spawns no reviewer and sends no extra alert.
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(0);
    expect(state.sent).toHaveLength(sentBeforeIdle);

    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const review = state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals");
    expect(review).toHaveLength(1);
    expect(review[0].environment).toEqual({ type: "reuse", environmentId: "env_worker" });
    // A second chief_review call must not spawn a second reviewer.
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
  });

  test("keeps a busy reviewer instead of spawning a second one", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready again",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );

    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
  });

  test("starts a fresh reviewer after the worker fixes what it found", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const ready = async (extra: object = {}) => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Ready for review",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId, ...extra }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    await ready();
    const firstReviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals are off by the discount", ...REQUEST_CHANGES,
    }, { threadId: firstReviewer.threadId, projectId: "proj_1" });
    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });

    await ready({ retestSkipped: "unplanned chain, no tester" });

    // A fresh reviewer, not the finished one asked to re-check — but its verdict
    // and pointer travel forward so the fresh reviewer can pick up where it left off.
    const reviewSpawns = state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals");
    expect(reviewSpawns).toHaveLength(2);
    for (const entry of reviewSpawns) {
      expect(entry.environment).toEqual({ type: "reuse", environmentId: "env_worker" });
    }
    expect((await status(state)).threads.find((row) => row.threadId === firstReviewer.threadId)?.state).toBe("complete");
    const secondReviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await reviewContextOf(state, secondReviewer.threadId);
    expect(context).toContain(`## The previous review (${firstReviewer.threadId})`);
    expect(context).toContain("Totals are off by the discount");
    expect(context).toContain("Verdict: request_changes");
    expect(reviewSpawns[1].prompt).toContain("Check each finding of the previous review");
    expect(state.sent.filter((entry) => entry.threadId === firstReviewer.threadId)
      .some((entry) => entry.input[0].text.includes("Re-check"))).toBe(false);
    // The fix owes a tester rerun, so the worker's ready report names the rerun and the waiver, not the plain review; chief_review itself sends no alert.
    expect(state.sent.at(-1).input[0].text).toContain(`chief_review (workerThreadId: ${worker.threadId}, retestSkipped: "<reason>")`);
  });

  test("dedups the worker's pending review even when the report and reviewer turnaround share a millisecond", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");

    // Freeze the clock across the worker's report, the reviewer spawn, and the
    // reviewer's own report: comparing updated_at would find them all equal and
    // wrongly still recommend a review, since nothing in that comparison could
    // tell the two reports apart. The report_seq tie has to do it instead.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
      const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Looks correct", ...APPROVE,
      }, { threadId: reviewer.threadId, projectId: "proj_1" });

      const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
      expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("picks the newest reviewer round even when both rounds share a millisecond", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    const workerOpts = { threadId: worker.threadId, projectId: "proj_1" };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    try {
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, workerOpts);
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
      const first = (await status(state)).threads.find((row) => row.role === "reviewer")!;
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fix it", ...REQUEST_CHANGES }, { threadId: first.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_complete", { threadId: first.threadId, result: "Round 1" }, opts);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed" }, workerOpts);
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
      const second = (await status(state)).threads.find((row) => row.role === "reviewer" && row.threadId !== first.threadId)!;
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Good", ...APPROVE }, { threadId: second.threadId, projectId: "proj_1" });

      const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
      expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("does not bring back a spurious review once its reviewer is completed directly", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", ...APPROVE,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    // Complete the reviewer thread directly, not the worker — its row's state
    // moves to complete, which a state-filtered lookup would then skip, wrongly
    // making the worker look unreviewed again.
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: reviewer.threadId, result: "Reviewed" }, opts);

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);
  });

  test("routes on a reviewer's structured verdict and names a pair that stops converging", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const ready = async (extra: object = {}) => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Ready for review",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId, ...extra }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    await ready();
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

    // A rejection must be a field, not prose Chief has to parse back out.
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice",
    }, { threadId: reviewer.threadId, projectId: "proj_1" })).rejects.toThrow(/verdict/);

    const reject = async (reviewerThreadId: string) => state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice", ...REQUEST_CHANGES,
    }, { threadId: reviewerThreadId, projectId: "proj_1" });
    await reject(reviewer.threadId);
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: request_changes");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.at(-1).input[0].text).not.toContain("consecutive rounds");
    expect(state.sent.at(-1).input[0].text).not.toContain("chief_consult");
    expect(JSON.stringify(await state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
    ))).toContain("Verdict: request_changes");

    // Second round on the same objection: the fix cycle spawns a fresh reviewer,
    // which carries the reject_streak forward — Chief is told to escalate, not to
    // fund a third round.
    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await ready({ retestSkipped: "unplanned chain, no tester" });
    const secondReviewer = (await status(state)).threads.find((row) => row.role === "reviewer" && row.state !== "complete")!;
    expect(secondReviewer.threadId).not.toBe(reviewer.threadId);
    await reject(secondReviewer.threadId);
    expect(state.sent.at(-1).input[0].text).toContain("still requires changes after 2 consecutive rounds");
    expect(state.sent.at(-1).input[0].text).toContain(`Call chief_consult (workerThreadId: ${worker.threadId}) now, before any further delegation`);
    expect(state.sent.at(-1).input[0].text).toContain(`hand its advice to one fresh worker with chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.at(-1).input[0].text).toContain("If that review still requires changes, stop and escalate to the user.");
    expect(state.sent.at(-1).input[0].text).not.toContain("Before starting another worker round");
  });

  test("tester model: a kind tester spawn uses the Tester pick when set, else the Worker pick", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "worker", selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const unset = await delegate(state, chief.threadId, "Test unset", { kind: "tester", replaces: worker.threadId });
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });

    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "tester", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    await delegate(state, chief.threadId, "Test set", { kind: "tester", replaces: unset.threadId });
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
    // The Tester pick is not the Worker pick: a plain worker stays on the Worker model.
    await delegate(state, chief.threadId, "Plain work");
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });

    const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(configuration.hosts[0]!.selections.tester).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
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
      const worker = await delegate(state, chief.threadId, "Draw the checkout screen", { kind: "designer" });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Drawn" }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts(chief.threadId));
      expect(state.spawned.at(-1).prompt).toContain("This is design work (a Designer). Check it read-only against the brief's mode. Design tool: check the result with the tool's screenshots");
    });
  });

  describe("verdict file", () => {
    const reviewed = async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" });
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

    test("hands a replacement worker the reviewer's verdict file", async () => {
      const { state, chief, worker, reviewer, pathOf } = await reviewed();
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, ...REQUEST_CHANGES,
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
      const prompt: string = state.spawned.at(-1).prompt;
      expect(prompt).toContain(`Verdict file: ${pathOf()}`);
      expect(prompt).toContain("Totals go negative.");
      expectLoadLine(prompt, "worker");
    });

    test("a failed verdict-file write does not fail the report", async () => {
      const { state, chief, reviewer } = await reviewed();
      // A plain file where the reviewer's artifact directory should be makes the write fail. The durable brief
      // (persistBrief) already created that directory, so remove it first.
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

  test("does not misfire the not-converging escalation on a phase's first rejection", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const ready = async (result: string) => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result,
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    const verdict = (reviewerThreadId: string, value: "approve" | "request_changes") =>
      state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Phase reviewed", ...(value === "approve" ? APPROVE : REQUEST_CHANGES),
      }, { threadId: reviewerThreadId, projectId: "proj_1" });
    const latestReviewer = async () => (await status(state)).threads.find((row) => row.role === "reviewer" && row.state !== "complete")!;

    // Phase 1 approved, then phase 2's fresh reviewer approves again — active_cycle
    // must not read as prior disagreement just because it is climbing.
    await ready("Phase 1 implemented");
    await verdict((await latestReviewer()).threadId, "approve");

    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await ready("Phase 2 implemented");
    await verdict((await latestReviewer()).threadId, "approve");

    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await ready("Phase 3 implemented");

    // Phase 3's very first rejection must not read as two rounds of disagreement.
    await verdict((await latestReviewer()).threadId, "request_changes");
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: request_changes");
    expect(state.sent.at(-1).input[0].text).not.toContain("consecutive rounds");
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(3);
  });

  test("routes a first rejection that reports a regression straight to a fresh worker", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "This broke the tax calculation", ...REQUEST_CHANGES, regression: true,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    const text = state.sent.at(-1).input[0].text as string;
    expect(text).toContain("introduced a new problem");
    expect(text).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(text).not.toContain("chief_consult (workerThreadId");
    expect(text).not.toContain("consecutive rounds");
    const consultAction = `The reviewer requires changes. The reviewer reports this change introduced a new problem; make the fix's brief name it. Hand the fix to a fresh worker with chief_delegate (replaces: ${worker.threadId}); its findings are attached automatically. Escalate if the disagreement is a genuine decision.`;
    expect(text).toContain(consultAction);

    // The roster must recommend the exact same next step, not a second inline wording.
    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(roster).toContain(`: ${consultAction}`);
  });

  test.each([
    ["tells Chief to complete work its reviewer approved", {}],
    ["ignores a regression flag on an approval", { regression: true }],
  ])("%s", async (_name, extra) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks good", ...APPROVE, ...extra,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    const text = state.sent.at(-1).input[0].text as string;
    expect(text).toContain("Verdict: approve");
    expect(text).toContain(`The reviewer approves. chief_complete (threadId: ${worker.threadId}); it marks the pull request ready.`);
    expect(text).not.toContain("chief_consult");
  });

  test("hands the reviewer the brief and report the work was judged against", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed and covered by a test",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    // Without the brief the reviewer scores the change against a standard nobody set.
    const context = await latestReviewContext(state);
    expect(context).toContain("Correct and verify totals");
    expect(context).toContain("Regression passes");
    expect(context).toContain("Totals fixed and covered by a test");
    expect(context).toContain(`bb chief inspect ${worker.threadId}`);
  });

  test("keeps a plan file path in the reviewer's brief excerpt behind a long-but-valid mission", async () => {
    const state = await setup();
    const chief = await start(state);
    // A long mission alone can push "## Context" — where a plan file path now lives,
    // since ## Context is assembled last in the stored brief — past a tail-only clip
    // of the reviewer's brief excerpt.
    const mission = "Correct and verify totals. ".repeat(300);
    const planPath = "/Users/example/.bb/thread-storage/thr_plan123/plan.md";
    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", mission,
      "--context", `Plan file: ${planPath}`, "--unplanned-reason", "Bounded test fixture", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);
    const worker = JSON.parse(result.stdout!) as { threadId: string };

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed and covered by a test",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );

    const context = await latestReviewContext(state);
    expect(context).toContain(planPath);
    // The head of the mission survives the same clip, alongside the tail.
    expect(context).toContain("Correct and verify totals.");
  });

  test("clips the worker's result in first and fresh reviewer prompts", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const longResult = "r".repeat(5_000);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: longResult,
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );

    const context = await latestReviewContext(state);
    const resultLine = context.split("## What the worker reported")[1]!.split("\n")[1]!;
    expect(resultLine.length).toBeLessThanOrEqual(300);
    expect(context).toContain(`bb chief inspect ${worker.threadId}`);

    // The fresh reviewer spawned after a fix clips the worker's new result the same way.
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Found an issue", ...REQUEST_CHANGES,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: longResult,
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId, retestSkipped: "unplanned chain, no tester" }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const freshContext = await latestReviewContext(state);
    const freshResultLine = freshContext.split("## What the worker reported")[1]!.split("\n")[1]!;
    expect(freshResultLine.length).toBeLessThanOrEqual(300);
    expect(freshContext).toContain(`bb chief inspect ${worker.threadId}`);
  });

  test("keeps reviewers read-only however the continuation is phrased", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
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
