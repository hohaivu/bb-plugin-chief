import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVE, NO_DEVIATIONS, PLAN_FIXTURE, REQUEST_CHANGES, TEST_WAVE, approvePlan, chiefReview, completeWorker, delegate, disposeAll, planFile, setup, start, status, waiveTests, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  async function failWith(state: Awaited<ReturnType<typeof setup>>, threadId: string, detail: string) {
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(threadId)! });
    state.seedEvents(threadId, [{ type: "provider/error", createdAt: Date.now(), data: { message: "Provider error", detail } }]);
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(threadId)!, error: null });
  }

  test("transient provider: usage limit alerts Chief once with a retry at the reset", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, `cpa API error (429): {"code":"model_cooldown","last_upstream_error":"usage_limit_reached: The usage limit has been reached","model":"gpt-6.1-sol","reset_seconds":2194,"reset_time":"36m34s"}`);
    expect(state.sent).toHaveLength(1);
    const text = state.sent[0].input[0].text;
    expect(state.sent[0].threadId).toBe(chief.threadId);
    expect(text).toContain("usage limit");
    expect(text).toContain("Usage limit resets at");
    expect(text).toContain(`bb thread retry ${worker.threadId} --send-at 38m`);
    expect(text).toContain("Do not spawn a replacement");
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(worker.threadId)!, error: null });
    expect(state.sent).toHaveLength(1);
  });

  test("transient provider: connection error alerts Chief with a short retry", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, "Connection error.");
    expect(state.sent).toHaveLength(1);
    const text = state.sent[0].input[0].text;
    expect(text).toContain(`bb thread retry ${worker.threadId} --send-at 2m`);
    expect(text).not.toContain("usage limit");
  });

  test("transient provider: a non-transient error alerts Chief to reroute, with no retry", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, "context window exceeded");
    expect(state.sent).toHaveLength(1);
    const text = state.sent[0].input[0].text;
    expect(text).toContain(`(${worker.threadId}) failed.`);
    expect(text).toMatch(/Provider error: .*context window exceeded/);
    expect(text).not.toContain("bb thread retry");
  });

  const MODEL_COOLDOWN = `cpa API error (429): {"code":"model_cooldown","model":"gpt-6-astra","reset_seconds":2194}`;
  /** Fails the thread on codex (model gpt-6-astra) with the given provider error. */
  async function coolDown(state: Awaited<ReturnType<typeof setup>>, threadId: string, detail: string) {
    state.live.set(threadId, { ...state.live.get(threadId)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    await failWith(state, threadId, detail);
  }
  const ISO = /cooling down until \d{4}-\d\d-\d\dT[\d:.]+Z/;

  test("cooldown: a per-model usage limit refuses chief_review on that model", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "reviewer", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: worker.threadId, projectId: "proj_1" });
    const sentBefore = state.sent.length;
    await coolDown(state, worker.threadId, MODEL_COOLDOWN);
    expect(state.sent.at(-1).input[0].text).toMatch(/work on codex\/gpt-6-astra is refused until \d{4}-/);
    expect(state.sent.length).toBe(sentBefore + 1);
    const spawnedBefore = state.spawned.length;
    await expect(state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts))
      .rejects.toThrow(/Provider codex model gpt-6-astra hit its usage limit/);
    await expect(state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts)).rejects.toThrow(ISO);
    expect(state.spawned).toHaveLength(spawnedBefore);
    // The refused call left nothing behind: once the cooldown expires, the review starts.
    state.db.prepare("UPDATE provider_cooldowns SET until_at=0").run();
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    expect(state.spawned).toHaveLength(spawnedBefore + 1);
  });

  test("cooldown: a model limit blocks delegate, plan, consult and branch review on that model until it expires", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "429 usage_limit_reached");
    expect(state.db.prepare("SELECT provider_id, model FROM provider_cooldowns").all()).toEqual([{ provider_id: "codex", model: "gpt-6-astra" }]);
    // No role pick: the spawn would run on the project default.
    state.setProjectDefaults({ providerId: "codex", model: "gpt-6-astra" });
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const spawnedBefore = state.spawned.length;
    const tools: [string, Record<string, unknown>][] = [
      ["chief_delegate", { title: "Next", mission: "Do it", unplannedReason: "Bounded test fixture" }],
      ["chief_plan", { title: "Rework", mission: "Propose" }],
      ["chief_consult", { title: "Diagnose", mission: "Explore" }],
      ["chief_review", { branch: "feature/x" }],
    ];
    const sectionRow = () => state.db.prepare("SELECT value FROM plugin_meta WHERE key='section_id'").get();
    for (const [tool, params] of tools) {
      // The gate runs before ensureSection: a refused call writes no section row.
      state.db.prepare("DELETE FROM plugin_meta WHERE key='section_id'").run();
      await expect(state.harness.behavior.callAgentTool(tool, params, opts)).rejects.toThrow(/Provider codex model gpt-6-astra hit its usage limit/);
      expect(sectionRow()).toBeUndefined();
    }
    expect(state.spawned).toHaveLength(spawnedBefore);
    state.db.prepare("UPDATE provider_cooldowns SET until_at=0").run();
    await state.harness.behavior.callAgentTool(...tools[0]!, opts);
    expect(state.spawned).toHaveLength(spawnedBefore + 1);
  });

  test("cooldown: a per-model cooldown leaves another model of the same provider alone", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "worker", selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, MODEL_COOLDOWN);
    await delegate(state, chief.threadId, "Second");
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
  });

  test("cooldown: a model_cooldown with no known model records nothing and blocks no other model", async () => {
    for (const execution of [undefined, {}]) {
      const state = await setup();
      await state.harness.behavior.callRpc("setRoleModel", {
        hostId: "host_1", role: "worker", selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" },
      });
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, providerId: "codex" });
      state.setThreadExecution(execution);
      await failWith(state, worker.threadId, MODEL_COOLDOWN);
      expect(state.db.prepare("SELECT * FROM provider_cooldowns").all()).toEqual([]);
      await delegate(state, chief.threadId, "Second");
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
    }
  });

  test("cooldown: a connection error records nothing, and no live cooldown costs no SDK read", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "Connection error.");
    expect(state.db.prepare("SELECT * FROM provider_cooldowns").all()).toEqual([]);
    await delegate(state, chief.threadId, "Second");
    expect(state.projectDefaultsReads()).toBe(0);
  });

  test("cooldown: an unknown provider records nothing and the alert still lands", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, providerId: "" });
    await failWith(state, worker.threadId, "429 usage_limit_reached");
    expect(state.db.prepare("SELECT * FROM provider_cooldowns").all()).toEqual([]);
    expect(state.sent.at(-1).input[0].text).not.toContain("is refused until");
  });

  /** A ready worker whose reviewer pick (codex/gpt-6-astra) is cooling down. */
  async function coolingReviewer() {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "reviewer", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: worker.threadId, projectId: "proj_1" });
    await coolDown(state, worker.threadId, MODEL_COOLDOWN);
    const review = () => state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" });
    return { state, chief, worker, review };
  }

  test("cooldown: a refused review leaves the previous reviewer not complete", async () => {
    const { state, worker, review } = await coolingReviewer();
    state.db.prepare("UPDATE provider_cooldowns SET until_at=0").run();
    await review();
    const first = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Changes", ...REQUEST_CHANGES }, { threadId: first.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed" }, { threadId: worker.threadId, projectId: "proj_1" });
    state.db.prepare("UPDATE provider_cooldowns SET until_at=?").run(Date.now() + 600_000);
    await expect(review()).rejects.toThrow(/hit its usage limit/);
    expect((state.db.prepare("SELECT state FROM managed_threads WHERE thread_id=?").get(first.threadId) as { state: string }).state).not.toBe("complete");
  });

  test("cooldown: worker, planner, advisor and branch review on a cooling project-default model are refused", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "429 usage_limit_reached");
    state.setProjectDefaults({ providerId: "codex", model: "gpt-6-astra" });
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    for (const [tool, params] of [
      ["chief_delegate", { title: "Next", mission: "Do it", unplannedReason: "Bounded test fixture" }],
      ["chief_plan", { title: "Rework", mission: "Propose" }],
      ["chief_consult", { title: "Diagnose", mission: "Explore" }],
      ["chief_review", { branch: "feature/x" }],
    ] as const) {
      await expect(state.harness.behavior.callAgentTool(tool, params, opts)).rejects.toThrow(/Provider codex model gpt-6-astra hit its usage limit/);
    }
  });

  describe("bb chief stats", () => {
    type State = Awaited<ReturnType<typeof setup>>;
    const stats = async (state: State, context: { threadId?: string; projectId?: string } = {}) => {
      const result = await state.harness.behavior.runCli(["stats", "--project", "proj_1", "--json"], context);
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout!);
    };
    const reviewThenVerdict = async (state: State, chiefId: string, workerId: string, verdict: "approve" | "request_changes") => {
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Ready${NO_DEVIATIONS}` }, { threadId: workerId, projectId: "proj_1" });
      const review = await chiefReview(state, chiefId, { workerThreadId: workerId });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...(verdict === "approve" ? APPROVE : REQUEST_CHANGES) }, { threadId: review.threadId, projectId: "proj_1" });
    };

    test("chief stats: an unplanned chain completes once; open and archived tasks count separately", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/x" });
      await reviewThenVerdict(state, chief.threadId, first.threadId, "request_changes");
      const fix = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: first.threadId });
      await reviewThenVerdict(state, chief.threadId, fix.threadId, "approve");
      await completeWorker(state, chief.threadId, fix.threadId, { skipReview: undefined });
      await delegate(state, chief.threadId, "Open task", { branch: "feature/open" });
      const archived = await delegate(state, chief.threadId, "Archived task", { branch: "feature/gone" });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(archived.threadId)! });

      const result = await stats(state);
      expect(result.tasks).toMatchObject({ total: 3, completed: 1, open: 1, dropped: 1 });
      const chain = result.perTask.find((task: any) => task.key === "branch:proj_1:feature/x");
      expect(chain).toMatchObject({ status: "completed", workers: 2, replacements: 1, requestChanges: 1 });
      expect(result.wallTimeMs.completed).toBe(1);
      expect(result.repairs.replacements).toBe(1);
    });

    test("chief stats: a branchless replaces chain is one task", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: first.threadId, projectId: "proj_1" });
      await delegate(state, chief.threadId, "Fix checkout totals", { replaces: first.threadId });
      const result = await stats(state);
      expect(result.tasks.total).toBe(1);
      expect(result.perTask[0]).toMatchObject({ workers: 2, replacements: 1 });
    });

    test("chief stats: wave hand-offs are not repairs, and a plan stopped before its final wave is dropped", async () => {
      const state = await setup();
      const chief = await start(state);
      const ctx = { threadId: chief.threadId, projectId: "proj_1" };
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctx);
      const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Two waves, then their tests.",
        plan: [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)],
      }, { threadId: planner.threadId, projectId: "proj_1" });
      await approvePlan(state, chief.threadId, planner.threadId);
      await waiveTests(state, chief.threadId, planner.threadId, [3]);
      const path1 = planFile(state, planner.threadId, 1);
      const path2 = planFile(state, planner.threadId, 2);
      const wave1 = JSON.parse((await state.harness.behavior.runCli(["delegate", "--title", "Wave 1", "--mission", `Implement ${path1}`, "--plan-thread", planner.threadId, "--wave", "1", "--json"], ctx)).stdout!);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 1 done${NO_DEVIATIONS}` }, { threadId: wave1.threadId, projectId: "proj_1" });
      expect((await stats(state)).tasks).toMatchObject({ total: 1, completed: 0, open: 1, dropped: 0 });
      await completeWorker(state, chief.threadId, wave1.threadId, { testsSkipped: undefined });
      expect((await stats(state)).tasks.dropped).toBe(1);

      const wave2 = JSON.parse((await state.harness.behavior.runCli(["delegate", "--title", "Wave 2", "--mission", `Implement ${path2}`, "--plan-thread", planner.threadId, "--wave", "2", "--replaces", wave1.threadId, "--json"], ctx)).stdout!);
      await reviewThenVerdict(state, chief.threadId, wave2.threadId, "approve");
      await completeWorker(state, chief.threadId, wave2.threadId, { testsSkipped: undefined, skipReview: undefined });
      const result = await stats(state);
      expect(result.tasks).toMatchObject({ total: 1, completed: 1, open: 0, dropped: 0 });
      expect(result.perTask[0]).toMatchObject({ waves: 2, replacements: 0 });
    });

    test("chief stats: a parallel plan completes only once every chain's tip is ready", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const ctx = { threadId: chief.threadId, projectId: "proj_1" };
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctx);
      const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Two independent waves.",
        plan: [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [] }, TEST_WAVE(3, [1]), TEST_WAVE(4, [2])],
      }, { threadId: planner.threadId, projectId: "proj_1" });
      await approvePlan(state, chief.threadId, planner.threadId);
      await waiveTests(state, chief.threadId, planner.threadId, [3, 4]);
      const delegateWave = async (n: number) => JSON.parse((await state.harness.behavior.runCli([
        "delegate", "--title", `Wave ${n}`, "--mission", "Do it", "--plan-thread", planner.threadId, "--wave", String(n), "--branch", `feature/w${n}`, "--json",
      ], ctx)).stdout!) as { threadId: string };
      const w1 = await delegateWave(1);
      const w2 = await delegateWave(2);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 2 done${NO_DEVIATIONS}` }, { threadId: w2.threadId, projectId: "proj_1" });
      await completeWorker(state, chief.threadId, w2.threadId, { testsSkipped: undefined });
      // Wave 2 is the last wave by number but wave 1's chain is still running.
      expect((await stats(state)).tasks.completed).toBe(0);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 1 done${NO_DEVIATIONS}` }, { threadId: w1.threadId, projectId: "proj_1" });
      await completeWorker(state, chief.threadId, w1.threadId, { testsSkipped: undefined });
      expect((await stats(state)).tasks).toMatchObject({ total: 1, completed: 1 });
    });

    test("chief stats: counts usage-limit, connection and non-transient failures once each", async () => {
      const state = await setup();
      const chief = await start(state);
      const a = await delegate(state, chief.threadId, "A");
      const b = await delegate(state, chief.threadId, "B");
      const c = await delegate(state, chief.threadId, "C");
      await failWith(state, a.threadId, "cpa API error (429): usage_limit_reached");
      await failWith(state, b.threadId, "Connection error.");
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(c.threadId)! });
      await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(c.threadId)!, error: null });
      await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(c.threadId)!, error: null });
      expect((await stats(state)).failures).toMatchObject({ usageLimit: 1, connection: 1, threadErrors: 1 });
    });

    test("chief stats: a busy rejection keeps its message and is counted", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await expect(state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
      )).rejects.toThrow(`Worker ${worker.threadId} is active; wait until it is idle before starting a review.`);
      expect((await stats(state)).failures.busyRejections).toBe(1);
    });

    test("chief stats: scoped like status, with text notes", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      const other = JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!);
      await delegate(state, other.threadId, "Other task");

      expect((await stats(state)).tasks.total).toBe(2);
      const own = await stats(state, { threadId: chief.threadId, projectId: "proj_1" });
      expect(own.tasks.total).toBe(1);
      expect(own.scope.chiefThreadId).toBe(chief.threadId);
      expect(typeof own.statsSince).toBe("number");
      expect((await stats(state, {})).scope.chiefThreadId).toBeNull();
      const byChief = JSON.parse((await state.harness.behavior.runCli(["stats", "--chief", other.threadId, "--json"])).stdout!);
      expect(byChief.perTask.map((task: any) => task.title)).toEqual(["Other task"]);

      expect((await state.harness.behavior.runCli(["stats"], { threadId: worker.threadId, projectId: "proj_1" })).exitCode).toBe(1);
      const text = (await state.harness.behavior.runCli(["stats", "--project", "proj_1"])).stdout!;
      expect(text).toContain("Tasks:");
      expect(text).toContain("Not measured:");

      // Review counts: one plan review covers two workers (two target rows per report) and counts as one event per report.
      // A branch-only reviewer covers no worker and has no task; it counts in the global totals only.
      const second = await delegate(state, chief.threadId, "Second task");
      const seedReviewer = (id: string, extra: Record<string, unknown>, covers: string[]) => {
        const row = { thread_id: id, role: "reviewer", project_id: "proj_1", chief_thread_id: chief.threadId, title: id, state: "ready", created_at: 1, updated_at: 1, ...extra };
        state.db.prepare(`INSERT INTO managed_threads (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
        for (const covered of covers) state.db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq) VALUES (?, ?, 1)`).run(id, covered);
        state.addLive(id, "proj_1");
      };
      seedReviewer("review_plan", { worker_thread_id: worker.threadId }, [worker.threadId, second.threadId]);
      seedReviewer("review_branch", { branch: "feature/orphan" }, []);
      // The thread store reloads its row cache on its next write; seeded rows are read after this report.
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: second.threadId, projectId: "proj_1" });
      const reviewer = (id: string) => ({ threadId: id, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fix it.", ...REQUEST_CHANGES }, reviewer("review_plan"));
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed.", ...APPROVE }, reviewer("review_plan"));
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fine.", ...APPROVE }, reviewer("review_branch"));
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM reviewer_verdicts WHERE reviewer_thread_id='review_plan'").get()).toEqual({ n: 4 });

      const reviewed = await stats(state, { threadId: chief.threadId, projectId: "proj_1" });
      // 2 events of the plan review + 1 of the branch-only reviewer, not 5 rows.
      expect(reviewed.verdicts).toEqual({ approve: 2, request_changes: 1 });
      expect(reviewed.repairs.requestChanges).toBe(1);
      // The plan review belongs to its first worker's task; the second task and the orphan reviewer add nothing per task.
      const perTask = (title: string) => reviewed.perTask.find((task: any) => task.title === title);
      expect(perTask("Fix checkout totals")).toMatchObject({ approvals: 1, requestChanges: 1 });
      expect(perTask("Second task")).toMatchObject({ approvals: 0, requestChanges: 0 });
      expect(reviewed.perTask.reduce((n: number, task: any) => n + task.approvals, 0)).toBe(1);
      expect(byChief.perTask.every((task: any) => task.approvals === 0 && task.requestChanges === 0)).toBe(true);
    });

    // Contract (PR #187): stats counts a legacy reviewer (no reviewer_verdicts rows, current verdict request_changes) as one event,
    // while the replacement gate still reads its carried reject_streak of 3. The two numbers answer different questions.
    test("chief stats: a legacy reviewer with a carried streak of 3 is one request_changes event, and still stops a replacement", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId, "Legacy task", { branch: "feature/legacy-streak" });
      state.db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at, worker_thread_id, verdict, reject_streak)
        VALUES ('legacy_review', 'reviewer', 'proj_1', ?, 'legacy_review', 'ready', 1, 1, ?, 'request_changes', 3)`).run(chief.threadId, worker.threadId);
      state.db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq) VALUES ('legacy_review', ?, 1)`).run(worker.threadId);
      state.addLive("legacy_review", "proj_1");
      // The thread store reloads its row cache on its next write.
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: worker.threadId, projectId: "proj_1" });

      expect(state.db.prepare("SELECT COUNT(*) AS n FROM reviewer_verdicts").get()).toEqual({ n: 0 });
      const result = await stats(state);
      expect(result.verdicts).toEqual({ approve: 0, request_changes: 1 });
      expect(result.perTask[0]).toMatchObject({ approvals: 0, requestChanges: 1 });
      await expect(state.harness.behavior.callAgentTool("chief_delegate", {
        title: "Repair", mission: "Fix the findings", replaces: worker.threadId,
      }, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow(`The reviewer has requested changes 3 times in a row on ${worker.threadId}. Do not delegate another round`);
    });

    // Contract (PR #187, preservation): the whole `bb chief stats` text and JSON, project-wide and per Chief, equal what pre-refactor
    // 512cfeb855abda0ae90df972121b977318e959d7 printed on this same fixture under a fixed clock. The oracle file was captured by running
    // this marked block against 512cfeb's server.ts, with the one marked comparison line swapped for a write. It also pins the fixture's
    // database hash, so a drifting fixture fails here instead of passing against a stale oracle.
    // Regression: stats counting a review event per target row, per carried streak or per replacement chain; a legacy reviewer counted
    // twice or dropped; or any other stats byte changing with the refactor.
    // <stats-oracle-fixture>
    const statsOracleRun = async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        let clock = Date.UTC(2026, 0, 1);
        const tick = (minutes: number) => vi.setSystemTime((clock += minutes * 60_000));
        tick(0);
        const state = await setup();
        const chief = await start(state);
        const other = JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!);
        const asWorker = (id: string) => ({ threadId: id, projectId: "proj_1" });
        const ready = (id: string) => state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Ready${NO_DEVIATIONS}` }, asWorker(id));
        tick(5);
        const taskA = await delegate(state, chief.threadId, "Task A", { branch: "feature/a" });
        tick(5);
        await ready(taskA.threadId);
        tick(5);
        const taskB = await delegate(state, chief.threadId, "Task B", { branch: "feature/b" });
        const taskA2 = await delegate(state, chief.threadId, "Task A", { replaces: taskA.threadId });
        const taskO = await delegate(state, other.threadId, "Other task", { branch: "feature/other" });
        // Reviewer rows: report_seq 1 targets for the ones that report; legacy rows carry a verdict and no history.
        const seed = (id: string, owner: string, extra: Record<string, unknown>, covers: string[]) => {
          const row = { thread_id: id, role: "reviewer", project_id: "proj_1", chief_thread_id: owner, title: id, state: "ready", created_at: clock, updated_at: clock, ...extra };
          state.db.prepare(`INSERT INTO managed_threads (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
          for (const covered of covers) state.db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq) VALUES (?, ?, 1)`).run(id, covered);
          state.addLive(id, "proj_1");
        };
        // Multi-target plan review: three reports, each covering Task A's worker and Task B's worker (two target rows per report).
        seed("review_plan", chief.threadId, { worker_thread_id: taskA.threadId }, [taskA.threadId, taskB.threadId]);
        // Legacy reviewers from before reviewer_verdicts: no history, a carried streak of 3, an approve, and a null verdict.
        seed("legacy_rc", chief.threadId, { worker_thread_id: taskB.threadId, verdict: "request_changes", reject_streak: 3 }, [taskB.threadId]);
        seed("legacy_approve", chief.threadId, { worker_thread_id: taskA2.threadId, verdict: "approve" }, [taskA2.threadId]);
        seed("legacy_null", chief.threadId, { worker_thread_id: taskA2.threadId, verdict: null }, [taskA2.threadId]);
        // Branch-only reviewers: no worker and no targets. One names Task A's branch (joins its task), one names no task's branch.
        seed("branch_task", chief.threadId, { branch: "feature/a" }, []);
        seed("branch_orphan", chief.threadId, { branch: "feature/orphan" }, []);
        // A reviewer of another Chief: counts project-wide, not in this Chief's scope.
        seed("other_review", other.threadId, { worker_thread_id: taskO.threadId }, [taskO.threadId]);
        tick(5);
        // The thread store reloads its row cache on its next write; the seeded rows are read after this report.
        await ready(taskB.threadId);
        const verdict = async (id: string, params: Record<string, unknown>) => {
          tick(10);
          await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...params }, asWorker(id));
        };
        await verdict("review_plan", REQUEST_CHANGES);
        await verdict("review_plan", APPROVE);
        await verdict("review_plan", APPROVE);
        await verdict("branch_task", APPROVE);
        // The regression flag lives on a reviewer's last request_changes: this reviewer's final report.
        await verdict("branch_task", { ...REQUEST_CHANGES, regression: true });
        await verdict("branch_orphan", APPROVE);
        await verdict("other_review", REQUEST_CHANGES);
        tick(10);
        await completeWorker(state, chief.threadId, taskA2.threadId);
        tick(1);
        // The fixture's own failure and stats cutoffs are stamped by SQLite's real clock at setup: pin them.
        state.db.prepare("UPDATE plugin_meta SET value=? WHERE key IN ('stats_since','failure_events_since')").run(String(Date.UTC(2026, 0, 1)));

        // The Coordinator migration appends two columns to managed_threads; the oracle hash predates them, so they are checked NULL and dropped.
        const table = (name: string) => (state.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Record<string, unknown>[]).map((row) => {
          if (name !== "managed_threads") return row;
          const { coordinator, coordinator_thread_id: coordinatorThreadId, ...legacy } = row;
          expect([coordinator ?? null, coordinatorThreadId ?? null]).toEqual([null, null]);
          return legacy;
        });
        // Only the random temp storage root (in report_path and verdict_path) is normalized.
        const fixtureHash = createHash("sha256").update(JSON.stringify(["managed_threads", "review_targets", "reviewer_verdicts", "plugin_meta"].map(table)).replaceAll(state.storageRoot, "<storage>")).digest("hex");
        const runs = [];
        for (const scope of [["--project", "proj_1"], ["--chief", chief.threadId], ["--chief", other.threadId]]) {
          for (const mode of [[], ["--json"]]) {
            const args = ["stats", ...scope, ...mode];
            const result = await state.harness.behavior.runCli(args);
            runs.push({ args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? null });
          }
        }
        return { state, fixtureHash, runs };
      } finally {
        vi.useRealTimers();
      }
    };
    // </stats-oracle-fixture>

    test("chief stats: text and JSON equal pre-refactor 512cfeb on a multi-target, multi-report, legacy, scoped and branch-only fixture", async () => {
      const { state, fixtureHash, runs } = await statsOracleRun();
      // The fixture really holds the cases: 3 plan reports x 2 targets, 2 branch_task reports, then 1 + 1 single reports, legacy rows with no history.
      const historyOf = (id: string) => state.db.prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT report_seq) AS events FROM reviewer_verdicts WHERE reviewer_thread_id=?").get(id);
      expect(historyOf("review_plan")).toEqual({ rows: 6, events: 3 });
      expect(historyOf("branch_task")).toEqual({ rows: 2, events: 2 });
      for (const legacy of ["legacy_rc", "legacy_approve", "legacy_null"]) expect(historyOf(legacy)).toEqual({ rows: 0, events: 0 });
      // Counts worked out from the contract, not from the code: plan 2+1, legacy 1 approve + 1 rc, branch_task 1+1, orphan 1, other chief 1 rc.
      const json = (index: number) => JSON.parse(runs[index]!.stdout!);
      expect(json(1).verdicts).toEqual({ approve: 5, request_changes: 4 });
      expect(json(3).verdicts).toEqual({ approve: 5, request_changes: 3 });
      expect(json(3).repairs).toMatchObject({ requestChanges: 3, regressions: 1 });
      expect(json(5).verdicts).toEqual({ approve: 0, request_changes: 1 });
      expect(runs.map((run) => run.exitCode)).toEqual([0, 0, 0, 0, 0, 0]);

      const actual = JSON.stringify({ fixtureHash, runs }, null, 2) + "\n";
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "chief-stats-512cfeb.json"), "utf8");
      expect(actual).toBe(oracle); // oracle-compare
    });
  });
});
