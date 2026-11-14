import { afterEach, describe, expect, test, vi } from "vitest";
import { PLAN_LINE_NEW, PLAN_LINE_OLD } from "./test/reviewWave1";
import { readFile } from "node:fs/promises";
import { NO_DEVIATIONS, PLAN_FIXTURE, REQUEST_CHANGES, TEST_WAVE, approvePlan, completeWorker, delegate, disposeAll, legacyWave, planFile, planTwoWaves, setup, start, status, waiveTests, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { expectLoadLine } from "./test/loadLine";
import { ctxOf, rowOf, tool, report } from "./test/testerHelpers";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  test("spawns each role on the model picked for its machine", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "chief",
      selection: { providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "high" },
    });
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "worker",
      selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" });

    expect(state.spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "high" });
    expect(state.spawned[1]).toMatchObject({ providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" });
    // The reviewer has no selection of its own and stays on the BB default.
    expect(state.spawned[2]).not.toHaveProperty("providerId");
  });

  test("falls back to the BB default when a picked model left the machine's catalog", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "chief",
      selection: { providerId: "codex", model: "gpt-5-retired", reasoningLevel: "high" },
    });
    await start(state);
    expect(state.spawned[0]).not.toHaveProperty("providerId");
    expect(state.spawned[0]).not.toHaveProperty("model");

    // Settings must admit the pick is dead rather than showing a model no spawn uses.
    const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(configuration.hosts[0]!.unusable).toEqual(["chief"]);
  });

  test("keeps a picked model whose reasoning level is no longer supported, at the model's own default", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "chief",
      selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "high" },
    });
    await start(state);
    expect(state.spawned[0]).toMatchObject({ providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" });
  });

  test("reports each machine's scanned fallback and stored selections", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "worker",
      selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(configuration.hosts).toEqual([{
      hostId: "host_1",
      hostName: "Local",
      connected: true,
      error: null,
      fallback: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "medium" },
      selections: {
        chief: null,
        planner: null,
        worker: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
        reviewer: null,
        advisor: null,
        designer: null,
        "spec-writer": null,
        tester: null,
      },
      unusable: [],
    }]);

    await state.harness.behavior.callRpc("setRoleModel", { hostId: "host_1", role: "worker", selection: null });
    const cleared = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(cleared.hosts[0]!.selections.worker).toBeNull();
  });

  test("scans a machine's provider once no matter how many roles picked it", async () => {
    const state = await setup();
    for (const role of ["chief", "planner", "worker", "reviewer"]) {
      await state.harness.behavior.callRpc("setRoleModel", {
        hostId: "host_1", role,
        selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
      });
    }
    state.catalogReads.length = 0;
    await state.harness.behavior.callRpc("modelConfiguration", null);
    // Three roles and the picker's own seed share one provider: one catalog read.
    expect(state.catalogReads).toEqual(["codex"]);
  });

  test("bases the worker's worktree on the task branch Chief created", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId, "Fix checkout totals", {
      branch: "feature/fix-checkout-totals",
      issueUrl: "https://github.com/acme/shop/issues/7",
      prUrl: "https://github.com/acme/shop/pull/8",
    });
    expect(state.spawned[1].environment.workspace).toEqual({
      type: "managed-worktree",
      baseBranch: { kind: "named", name: "feature/fix-checkout-totals" },
    });
    // The brief keeps the dynamic values: the branch in the sync and push commands, the issue and the pull request. The forge
    // rule, the full-read rule and the report split live in the skills the load line orders loaded.
    const prompt: string = state.spawned[1].prompt;
    expect(prompt).toContain("Task branch: feature/fix-checkout-totals.");
    expect(prompt).toContain("`git push origin HEAD:feature/fix-checkout-totals`");
    expect(prompt).toContain("Tracking issue: https://github.com/acme/shop/issues/7");
    expect(prompt).toContain("Draft pull request: https://github.com/acme/shop/pull/8");
    expectLoadLine(prompt, "worker");
  });

  test("keeps the project default base when a delegation names no branch", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    expect(state.spawned[1].environment.workspace).toEqual({
      type: "managed-worktree",
      baseBranch: { kind: "default" },
    });
    expect(state.spawned[1].prompt).not.toContain("## Git workflow");
  });

  test("refuses a second live worker on a branch another one already holds", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/fix-checkout-totals" });

    // A second worktree cannot check the branch out, so this has to fail here, not in git.
    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals again", "--mission", "Correct and verify totals",
      "--branch", "feature/fix-checkout-totals", "--unplanned-reason", "Bounded test fixture", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already carries the active worker");
    expect(state.spawned).toHaveLength(2);

    // Once that worker is complete the branch is free again.
    await completeWorker(state, chief.threadId, worker.threadId, { result: "Landed" });
    await delegate(state, chief.threadId, "Fix checkout totals follow-up", { branch: "feature/fix-checkout-totals" });
    expect(state.spawned).toHaveLength(3);
  });

  test("hands a repair round to a fresh worker in the same worktree", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", {
      branch: "feature/fix-checkout-totals",
      prUrl: "https://github.com/acme/shop/pull/8",
    });
    const ready = async (threadId: string, result: string, extra: object = {}) => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result,
      }, { threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: threadId, ...extra }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    await ready(worker.threadId, "Totals fixed");
    const reviewer1 = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals are off by the discount", ...REQUEST_CHANGES,
    }, { threadId: reviewer1.threadId, projectId: "proj_1" });

    const replaceResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Fix the discount bug the reviewer found",
      "--criteria", "Regression passes",
      "--replaces", worker.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(replaceResult.exitCode).toBe(0);
    const freshWorker = JSON.parse(replaceResult.stdout!) as { threadId: string };

    const freshWorkerSpawn = state.spawned.at(-1);
    expect(freshWorkerSpawn.environment).toEqual({ type: "reuse", environmentId: "env_worker" });
    expect(freshWorkerSpawn.prompt).toContain("Review findings to fix");
    expect(freshWorkerSpawn.prompt).toContain("- totals.ts:1 — Totals go negative.");
    expect(freshWorkerSpawn.prompt).toContain("Task branch: feature/fix-checkout-totals.");

    const rows = (await status(state)).threads;
    expect(rows.find((row) => row.threadId === worker.threadId)?.state).toBe("complete");
    expect(rows.find((row) => row.threadId === reviewer1.threadId)?.workerThreadId).toBe(freshWorker.threadId);
    const freshWorkerRow = state.db.prepare(`SELECT branch, pr_url FROM managed_threads WHERE thread_id=?`).get(freshWorker.threadId) as any;
    expect(freshWorkerRow.branch).toBe("feature/fix-checkout-totals");
    expect(freshWorkerRow.pr_url).toBe("https://github.com/acme/shop/pull/8");

    // A fresh reviewer for the fresh worker, carrying reviewer1's verdict forward.
    await ready(freshWorker.threadId, "Discount fixed", { retestSkipped: "unplanned chain, no tester" });
    const reviewer2 = (await status(state)).threads.find((row) => row.role === "reviewer" && row.state !== "complete")!;
    expect(reviewer2.threadId).not.toBe(reviewer1.threadId);
    expect(state.spawned.at(-1).prompt).toContain("Check each finding of the previous review");

    // Second straight rejection across the fresh worker and fresh reviewers: consult before another round.
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Still off by a cent", ...REQUEST_CHANGES,
    }, { threadId: reviewer2.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain("still requires changes after 2 consecutive rounds");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_consult (workerThreadId: ${freshWorker.threadId}) now, before any further delegation`);
    expect(state.sent.at(-1).input[0].text).toContain(`chief_delegate (replaces: ${freshWorker.threadId})`);
    expect(state.sent.at(-1).input[0].text).toContain("escalate to the user");
  });

  test("refuses to replace a busy worker or another Chief's worker", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);

    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await expect(state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Fix checkout totals", mission: "Patch the fix", replaces: worker.threadId,
    }, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow("wait until it is idle");
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });

    const otherChief = await state.harness.behavior.callRpc("create", { projectId: "proj_1" }) as { threadId: string };
    await expect(state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Fix checkout totals", mission: "Patch the fix", replaces: worker.threadId,
    }, { threadId: otherChief.threadId, projectId: "proj_1" })).rejects.toThrow("for this Chief");

    // Neither refusal spawned a replacement worker.
    expect(state.spawned.filter((entry) => entry.title === "Fix checkout totals")).toHaveLength(1);
  });

  test("keeps one active worker per branch around a replacement", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/fix-checkout-totals" });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });

    const replaceResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Patch the remaining bug",
      "--criteria", "Regression passes",
      "--replaces", worker.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(replaceResult.exitCode).toBe(0);
    const freshWorker = JSON.parse(replaceResult.stdout!) as { threadId: string };

    // Plain delegation onto the same branch is still refused: the fresh worker holds it now.
    const collision = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals again", "--mission", "Correct and verify totals",
      "--branch", "feature/fix-checkout-totals", "--unplanned-reason", "Bounded test fixture", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(collision.exitCode).toBe(1);
    expect(collision.stderr).toContain("already carries the active worker");

    // Replacing again with a different branch is refused too: replaces carries the prior branch.
    const mismatchedBranch = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Patch the remaining bug",
      "--branch", "feature/other", "--replaces", freshWorker.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(mismatchedBranch.exitCode).toBe(1);
    expect(mismatchedBranch.stderr).toContain("carries branch feature/fix-checkout-totals");
  });

  test("replaces: prefers an explicit issueUrl/prUrl over the prior worker's, and inherits when omitted", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", {
      issueUrl: "https://github.com/acme/shop/issues/7",
      prUrl: "https://github.com/acme/shop/pull/8",
    });

    // Explicit issueUrl/prUrl on the replaces: call override the prior worker's.
    const overrideResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Patch the remaining bug",
      "--replaces", worker.threadId,
      "--issue-url", "https://github.com/acme/shop/issues/9",
      "--pr-url", "https://github.com/acme/shop/pull/10",
      "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(overrideResult.exitCode).toBe(0);
    const overrideWorker = JSON.parse(overrideResult.stdout!) as { threadId: string };
    expect(state.spawned.at(-1).prompt).toContain("https://github.com/acme/shop/issues/9");
    expect(state.spawned.at(-1).prompt).toContain("https://github.com/acme/shop/pull/10");
    expect(state.spawned.at(-1).prompt).not.toContain("https://github.com/acme/shop/issues/7");
    expect(state.spawned.at(-1).prompt).not.toContain("https://github.com/acme/shop/pull/8");
    const overrideRow = state.db.prepare(`SELECT issue_url, pr_url FROM managed_threads WHERE thread_id=?`).get(overrideWorker.threadId) as any;
    expect(overrideRow.issue_url).toBe("https://github.com/acme/shop/issues/9");
    expect(overrideRow.pr_url).toBe("https://github.com/acme/shop/pull/10");

    // Omitting issueUrl/prUrl on a further replaces: call inherits the prior worker's.
    const inheritResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Patch the remaining bug again",
      "--replaces", overrideWorker.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(inheritResult.exitCode).toBe(0);
    const inheritedWorker = JSON.parse(inheritResult.stdout!) as { threadId: string };
    expect(state.spawned.at(-1).prompt).toContain("https://github.com/acme/shop/issues/9");
    expect(state.spawned.at(-1).prompt).toContain("https://github.com/acme/shop/pull/10");
    const inheritedRow = state.db.prepare(`SELECT issue_url, pr_url FROM managed_threads WHERE thread_id=?`).get(inheritedWorker.threadId) as any;
    expect(inheritedRow.issue_url).toBe("https://github.com/acme/shop/issues/9");
    expect(inheritedRow.pr_url).toBe("https://github.com/acme/shop/pull/10");
  });

  test("a wave delegation takes its plan file from the schedule, and stores the link", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner, path1 } = await planTwoWaves(state, chief.threadId);

    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Wave 1 work", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "1", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);
    const worker = JSON.parse(result.stdout!) as { threadId: string };

    expect(state.spawned.at(-1).prompt).toContain(`Plan file (wave 1 of 2): ${path1}`);
    expect(state.spawned.at(-1).prompt).toContain('Wave 1 of 2. Implement only this wave\'s plan file. Name "Wave 1 of 2" in your ready result.');
    expect(state.spawned.at(-1).prompt).toContain("No review runs after this wave.");
    expect(state.spawned.at(-1).prompt).toContain(`## Contracts to verify\nRead the \`## Contracts to verify\` section of your plan file (Plan file (wave 1 of 2): ${path1}) in full: it is your checklist. Keep every item.`);
    expect(state.spawned.at(-1).prompt).not.toContain("- Totals stay non-negative");

    const row = state.db.prepare(`SELECT plan_thread_id, plan_wave FROM managed_threads WHERE thread_id=?`).get(worker.threadId) as any;
    expect(row).toEqual({ plan_thread_id: planner.threadId, plan_wave: 1 });
  });

  test("delegate ignores a stray tier from an older Chief", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix a typo", "--mission", "Fix the typo in the README",
      "--tier", "junior", "--unplanned-reason", "Typo fix", "--json",
    ], opts);
    expect(result.exitCode).toBe(0);
    await state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Fix another typo", mission: "Fix the other typo", tier: "senior", unplannedReason: "Typo fix",
    } as any, opts);
    expect(state.spawned.slice(1).map((spawn) => spawn.pluginMetadata?.role)).toEqual(["worker", "worker"]);
    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain("Tier split");
  });

  test("a planner report whose waves still carry tier is accepted without persisting it", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "One wave.", plan: [{ tier: "senior", body: PLAN_FIXTURE }, TEST_WAVE(2)],
    } as any, { threadId: planner.threadId, projectId: "proj_1" });
    const row = state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planner.threadId) as any;
    expect(JSON.parse(row.plan_waves)).toEqual([
      { path: planFile(state, planner.threadId, 1), contracts: "- Totals stay non-negative", feature: false, reshape: false, title: "Plan" },
      { path: planFile(state, planner.threadId, 2), contracts: "- Wave 2 keeps its invariant", test: true, feature: false, reshape: false, title: "Wave 2" },
    ]);
  });

  test("rejects an out-of-range wave", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);

    await expect(state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Wave 5 work", mission: "Correct and verify totals",
      planThreadId: planner.threadId, wave: 5,
    }, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow(/out of range/);
  });

  test("rejects delegating from another Chief's planner", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    const otherChief = await state.harness.behavior.callRpc("create", { projectId: "proj_1" }) as { threadId: string };

    await expect(state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Wave 1 work", mission: "Correct and verify totals",
      planThreadId: planner.threadId, wave: 1,
    }, { threadId: otherChief.threadId, projectId: "proj_1" })).rejects.toThrow(/No managed planner/);
  });

  test("replaces: with no explicit wave inherits the prior worker's plan link", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner, path1 } = await planTwoWaves(state, chief.threadId);

    const first = await state.harness.behavior.runCli([
      "delegate", "--title", "Wave 1 work", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "1", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    const worker = JSON.parse(first.stdout!) as { threadId: string };

    const replaceResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Wave 1 work", "--mission", "Fix what the reviewer found",
      "--replaces", worker.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(replaceResult.exitCode).toBe(0);
    const freshWorker = JSON.parse(replaceResult.stdout!) as { threadId: string };

    expect(state.spawned.at(-1).prompt).toContain(`Plan file (wave 1 of 2): ${path1}`);
    expect(state.spawned.at(-1).prompt).toContain(`## Contracts to verify\nRead the \`## Contracts to verify\` section of your plan file (Plan file (wave 1 of 2): ${path1}) in full`);
    expect(state.spawned.at(-1).prompt).not.toContain("- Totals stay non-negative");
    const freshRow = state.db.prepare(`SELECT plan_thread_id, plan_wave FROM managed_threads WHERE thread_id=?`).get(freshWorker.threadId) as any;
    expect(freshRow).toEqual({ plan_thread_id: planner.threadId, plan_wave: 1 });
  });

  test("rejects replaces: with unplannedReason when the inherited plan link is not overridden", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);

    const first = await state.harness.behavior.runCli([
      "delegate", "--title", "Wave 1 work", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "1", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    const worker = JSON.parse(first.stdout!) as { threadId: string };
    const spawnedBefore = state.spawned.length;
    const rowBefore = state.db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(worker.threadId);

    const replaceResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Wave 1 work", "--mission", "Fix what the reviewer found",
      "--replaces", worker.threadId, "--unplanned-reason", "Bounded test fixture", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(replaceResult.exitCode).toBe(1);
    expect(replaceResult.stderr).toMatch(/cannot be combined/);
    expect(state.spawned).toHaveLength(spawnedBefore);
    expect(state.db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(worker.threadId)).toEqual(rowBefore);
  });

  test("a 3-wave run delegates wave to wave with no review, then reviews the whole branch and carries wave 3 through a fix", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready",
      result: "Three waves: schema, migration, then delegation.",
      plan: [
        { body: PLAN_FIXTURE },
        { body: wave(2, "Migrate the data.") },
        { body: wave(3, "Wire up delegation.") },
        TEST_WAVE(4),
      ],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    await approvePlan(state, chief.threadId, planner.threadId);
    await waiveTests(state, chief.threadId, planner.threadId, [4]);
    const path1 = planFile(state, planner.threadId, 1);
    const path2 = planFile(state, planner.threadId, 2);
    const path3 = planFile(state, planner.threadId, 3);

    const w1Result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "1",
      "--branch", "feature/fix-checkout-totals", "--pr-url", "https://github.com/acme/shop/pull/8", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    const worker1 = JSON.parse(w1Result.stdout!) as { threadId: string };

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 1 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: worker1.threadId, projectId: "proj_1" });
    let alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain(`chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${worker1.threadId})`);
    expect(alert).toContain(path2);
    expect(alert).not.toContain("chief_review");
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);

    const w2Result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "2", "--replaces", worker1.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    const worker2 = JSON.parse(w2Result.stdout!) as { threadId: string };

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 2 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: worker2.threadId, projectId: "proj_1" });
    alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain(`chief_delegate (planThreadId: ${planner.threadId}, wave: 3, replaces: ${worker2.threadId})`);
    expect(alert).toContain(path3);
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);

    const w3Result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "3", "--replaces", worker2.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    const worker3 = JSON.parse(w3Result.stdout!) as { threadId: string };

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 3 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: worker3.threadId, projectId: "proj_1" });
    alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain(`chief_review (workerThreadId: ${worker3.threadId})`);

    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker3.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewSpawn = state.spawned.filter((entry: any) => entry.title === "Review · Fix checkout totals").at(-1)!;
    expect(reviewSpawn.prompt).toContain(PLAN_LINE_NEW(false));
    expect(reviewSpawn.prompt).not.toContain(PLAN_LINE_OLD.whole);
    expect(reviewSpawn.prompt).toContain("## Contracts to verify\nWave 1 of 4:\n- Totals stay non-negative\nWave 2 of 4:\n- Wave 2 keeps its invariant\nWave 3 of 4:\n- Wave 3 keeps its invariant");
    expect(reviewSpawn.prompt).toContain("An unmet item means request_changes");

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The migration double-counts a refund", verdict: "request_changes",
      findings: [{ file: "totals.ts", line: 3, severity: "blocking", message: "The migration double-counts a refund", fix: "Count it once" }],
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain(`chief_delegate (replaces: ${worker3.threadId})`);

    const fixResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Fix the refund double-count the reviewer found",
      "--replaces", worker3.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    const fixWorker = JSON.parse(fixResult.stdout!) as { threadId: string };
    // The fix worker inherits wave 3/3 and the same branch/PR without being told again.
    const fixRow = state.db.prepare(`SELECT plan_thread_id, plan_wave, branch, pr_url FROM managed_threads WHERE thread_id=?`).get(fixWorker.threadId) as any;
    expect(fixRow).toEqual({
      plan_thread_id: planner.threadId, plan_wave: 3,
      branch: "feature/fix-checkout-totals", pr_url: "https://github.com/acme/shop/pull/8",
    });

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Refund double-count fixed${NO_DEVIATIONS}`,
    }, { threadId: fixWorker.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain(`chief_review (workerThreadId: ${fixWorker.threadId})`);

    // The old reviewer row was re-pointed to fixWorker by `replaces:` without resetting
    // its state, but it already reported (not busy), so the roster still recommends
    // review for fixWorker — matching the alert above.
    const roster = String(await state.harness.behavior.callAgentTool(
      "chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" },
    ));
    expect(roster).toContain(`(${fixWorker.threadId}): `);
    expect(roster).toContain(`waves are ready. Start the one review of the whole plan now: chief_review (workerThreadId: ${fixWorker.threadId})`);
  });

  test("persists dependsOn and lists every independent head wave for parallel delegation", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Two parallel chains.",
      plan: [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [] }, { body: wave(3), dependsOn: [1] }, TEST_WAVE(4, [2]), TEST_WAVE(5, [3])],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    const row = state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planner.threadId) as { plan_waves: string };
    expect(JSON.parse(row.plan_waves).map((w: any) => w.dependsOn)).toEqual([undefined, [], [1], [2], [3]]);
    // Three implementation waves need their one advisor review before any is delegated; its approval releases the heads.
    await approvePlan(state, chief.threadId, planner.threadId);
    const alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain("Delegate waves 1, 2 now, in parallel");
    expect(alert).toContain(`(planThreadId: ${planner.threadId}, wave: N)`);
  });

  test.each([
    ["forward", [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [3] }, { body: wave(3) }], /earlier wave/],
    ["self", [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [2] }], /earlier wave/],
    ["on wave 1", [{ body: PLAN_FIXTURE, dependsOn: [1] }, { body: wave(2) }], /wave 1 depends on nothing/],
    ["two items", [{ body: PLAN_FIXTURE }, { body: wave(2) }, { body: wave(3), dependsOn: [1, 2] }], /./],
    ["a fork", [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [1] }, { body: wave(3), dependsOn: [1] }], /both build on wave 1/],
  ])("rejects dependsOn that is %s before writing or sending anything", async (_label, plan, error) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const sentBefore = state.sent.length;
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Bad graph.", plan,
    }, { threadId: planner.threadId, projectId: "proj_1" })).rejects.toThrow(error);
    expect(state.sent).toHaveLength(sentBefore);
    await expect(readFile(planFile(state, planner.threadId, 1), "utf8")).rejects.toThrow();
  });

  const stackedPlanner = async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    return { state, chief, planner };
  };

  test.each([
    ["zero", [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [], stackOn: 0 }, TEST_WAVE(4, [3])], /plan wave 3 stackOn is 0, not an earlier wave/],
    ["negative", [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [], stackOn: -1 }, TEST_WAVE(4, [3])], /plan wave 3 stackOn is -1, not an earlier wave/],
    ["not an integer", [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [], stackOn: 1.5 }, TEST_WAVE(4, [3])], /arguments are invalid: plan/],
    ["its own wave", [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [], stackOn: 3 }, TEST_WAVE(4, [3])], /plan wave 3 stackOn is 3, not an earlier wave/],
    ["a later wave", [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [], stackOn: 4 }, TEST_WAVE(4, [3])], /plan wave 3 stackOn is 4, not an earlier wave/],
    ["on wave 1", [{ body: PLAN_FIXTURE, stackOn: 1 }, TEST_WAVE(2, [1])], /plan wave 1 stackOn is 1.*wave 1 stacks on nothing/],
    ["on a wave that is not a chain head", [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [] }, { body: wave(4), dependsOn: [3], stackOn: 1 }, TEST_WAVE(5, [4])], /plan wave 4 stackOn is 1, but wave 4 is not a chain head/],
    ["a test wave", [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [], stackOn: 2 }, TEST_WAVE(4, [3])], /plan wave 3 stackOn is 2, test wave 2/],
    ["a design wave", [{ body: PLAN_FIXTURE, design: true }, { body: wave(2), dependsOn: [1] }, TEST_WAVE(3, [2]), { body: wave(4), dependsOn: [], stackOn: 1 }, TEST_WAVE(5, [4])], /plan wave 4 stackOn is 1, design wave 1/],
  ])("rejects stackOn that is %s before writing or sending anything", async (_label, plan, error) => {
    const { state, planner } = await stackedPlanner();
    const sentBefore = state.sent.length;
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Bad stack.", plan,
    }, { threadId: planner.threadId, projectId: "proj_1" })).rejects.toThrow(error);
    expect(state.sent).toHaveLength(sentBefore);
    await expect(readFile(planFile(state, planner.threadId, 1), "utf8")).rejects.toThrow();
  });

  test("persists a valid stackOn into plan_waves", async () => {
    const { state, planner } = await stackedPlanner();
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "A stacked chain.",
      plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2, [1]), { body: wave(3), dependsOn: [], stackOn: 1 }, TEST_WAVE(4, [3])],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    const row = state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planner.threadId) as { plan_waves: string };
    expect(JSON.parse(row.plan_waves).map((w: any) => w.stackOn)).toEqual([undefined, undefined, 1, undefined]);
  });

  test("parallel independent waves review once per branch only after every wave is ready", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], opts);
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Two independent waves.",
      plan: [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [] }, TEST_WAVE(3, [1]), TEST_WAVE(4, [2])],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    await approvePlan(state, chief.threadId, planner.threadId);
    await waiveTests(state, chief.threadId, planner.threadId, [3, 4]);
    const path1 = planFile(state, planner.threadId, 1);
    const path2 = planFile(state, planner.threadId, 2);
    const delegateWave = async (n: number, branch: string) => JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", `Wave ${n} work`, "--mission", "Do it",
      "--plan-thread", planner.threadId, "--wave", String(n), "--branch", branch, "--json",
    ], opts)).stdout!) as { threadId: string };
    const w1 = await delegateWave(1, "feature/a");
    const w2 = await delegateWave(2, "feature/b");
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 2/4 done, wave 1 starting, wave 2 starting");
    expect(roster).toContain(`: ${path2} (independent)`);
    expect(state.spawned.at(-1).prompt).toContain("This wave heads its own chain: it has its own branch, PR and worktree from the default base; do not build on another chain's branch.");

    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 1 done${NO_DEVIATIONS}` }, { threadId: w1.threadId, projectId: "proj_1" });
    let alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain("the one review of the whole plan waits until wave(s) 2 are ready");
    expect(alert).not.toContain("chief_review");
    expect(alert).not.toContain("chief_delegate");
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain(`(${w1.threadId}):`);

    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 2 done${NO_DEVIATIONS}` }, { threadId: w2.threadId, projectId: "proj_1" });
    alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain("Start the one review of the whole plan now: chief_review (workerThreadId: ");
    expect(alert).toContain(`${w1.threadId} (feature/a)`);
    expect(alert).toContain(`${w2.threadId} (feature/b)`);

    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: w1.threadId }, opts);
    const reviewSpawn = state.spawned.filter((entry: any) => entry.title === "Review · Wave 1 work").at(-1)!;
    expect(reviewSpawn.prompt).toContain(PLAN_LINE_NEW(false));
    expect(reviewSpawn.prompt).not.toContain(PLAN_LINE_OLD.wholeMany);

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Both branches fine", verdict: "approve", findings: [] }, { threadId: reviewer.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: w1.threadId, result: "Landed" }, opts);
    expect(state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(planner.threadId)).toEqual({ state: "ready" });
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: w2.threadId, result: "Landed" }, opts);
    await vi.waitFor(() => expect(state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(planner.threadId)).toEqual({ state: "complete" }));
  });

  test("a replaced head wave holds the other tip's review until its new worker is ready", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], opts);
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Two independent waves.",
      plan: [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [] }, TEST_WAVE(3, [1]), TEST_WAVE(4, [2])],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    await approvePlan(state, chief.threadId, planner.threadId);
    await waiveTests(state, chief.threadId, planner.threadId, [3, 4]);
    const delegate = async (args: string[]) => JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Wave work", "--mission", "Do it", "--plan-thread", planner.threadId, ...args, "--json",
    ], opts)).stdout!) as { threadId: string };
    const w1 = await delegate(["--wave", "1", "--branch", "feature/a"]);
    const w2 = await delegate(["--wave", "2", "--branch", "feature/b"]);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 1 done${NO_DEVIATIONS}` }, { threadId: w1.threadId, projectId: "proj_1" });
    const w1b = await delegate(["--wave", "1", "--replaces", w1.threadId]);

    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 2 done${NO_DEVIATIONS}` }, { threadId: w2.threadId, projectId: "proj_1" });
    const alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain("the one review of the whole plan waits until wave(s) 1 are ready");
    expect(alert).not.toContain("chief_review");
    expect(alert).not.toContain(w1b.threadId);
  });

  test.each([
    ["legacy", [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)]],
    ["explicit dependsOn", [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [1] }, TEST_WAVE(3, [2])]],
  ])("a single-chain %s plan holds the one whole-plan review while wave 1 is still active", async (_label, plan) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], opts);
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Two waves.", plan }, { threadId: planner.threadId, projectId: "proj_1" });
    await approvePlan(state, chief.threadId, planner.threadId);
    await waiveTests(state, chief.threadId, planner.threadId, [3]);
    // Rows of a plan written before chains shared a branch: wave 2 is stacked on wave 1's own branch, wave 1 still active.
    await legacyWave(state, chief.threadId, planner.threadId, 1, "feature/a");
    const w2 = await legacyWave(state, chief.threadId, planner.threadId, 2, "feature/b");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 2 done${NO_DEVIATIONS}` }, { threadId: w2.threadId, projectId: "proj_1" });
    const alert = state.sent.at(-1).input[0].text as string;
    expect(alert).toContain("the one review of the whole plan waits until wave(s) 1 are ready");
    expect(alert).not.toContain("chief_review");
  });

  test("walks a 3-wave run through final review, updating the wave line at each stage", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      opts,
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready",
      result: "Three waves: schema, migration, then delegation.",
      plan: [
        { body: PLAN_FIXTURE },
        { body: wave(2, "Migrate the data.") },
        { body: wave(3, "Wire up delegation.") },
        TEST_WAVE(4),
      ],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    await approvePlan(state, chief.threadId, planner.threadId);
    await waiveTests(state, chief.threadId, planner.threadId, [4]);

    const w1 = JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "1", "--json",
    ], opts)).stdout!) as { threadId: string };
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 1/4 done, wave 1 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 1 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w1.threadId, projectId: "proj_1" });
    const w2 = JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "2", "--replaces", w1.threadId, "--json",
    ], opts)).stdout!) as { threadId: string };
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 2/4 done, wave 2 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 2 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w2.threadId, projectId: "proj_1" });
    const w3 = JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "3", "--replaces", w2.threadId, "--json",
    ], opts)).stdout!) as { threadId: string };
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 3/4 done, wave 3 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 3 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w3.threadId, projectId: "proj_1" });
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 3/4 done, wave 3 ready");

    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: w3.threadId }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 3/4 done, wave 3 in review");

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", verdict: "approve", findings: [],
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 4/4 done, wave 3 approved");
  });

  test("keeps the Git workflow section and the pull request link when only a pull request was created", async () => {
    const state = await setup();
    const chief = await start(state);
    // Branch creation can fail after the draft PR exists; the section and the link still reach the worker (the forge rule is in its skill).
    await delegate(state, chief.threadId, "Fix checkout totals", { prUrl: "https://github.com/acme/shop/pull/8" });
    expect(state.spawned[1].prompt).toContain("## Git workflow");
    expect(state.spawned[1].prompt).toContain("Draft pull request: https://github.com/acme/shop/pull/8");
    expect(state.spawned[1].prompt).not.toContain("Task branch:");
  });

  test("records the branch and forge links on the thread and shows them in the roster and inspect", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", {
      branch: "feature/fix-checkout-totals",
      issueUrl: "https://github.com/acme/shop/issues/7",
      prUrl: "https://github.com/acme/shop/pull/8",
    });

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(roster).toContain("branch: feature/fix-checkout-totals");
    expect(roster).toContain("issue: https://github.com/acme/shop/issues/7");
    expect(roster).toContain("pr: https://github.com/acme/shop/pull/8");

    const detail = String(await state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(detail).toContain("Branch: feature/fix-checkout-totals");
    expect(detail).toContain("Issue: https://github.com/acme/shop/issues/7");
    expect(detail).toContain("Pull request: https://github.com/acme/shop/pull/8");
  });

  test("refuses to adopt a managed worker, keeping its branch and forge links intact", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", {
      branch: "feature/fix-checkout-totals",
      issueUrl: "https://github.com/acme/shop/issues/7",
      prUrl: "https://github.com/acme/shop/pull/8",
    });

    const result = await state.harness.behavior.runCli(["adopt", "--thread", worker.threadId, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already a managed worker");

    // The row has to survive intact: an open draft PR hangs off these links.
    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(roster).toContain("branch: feature/fix-checkout-totals");
    expect(roster).toContain("pr: https://github.com/acme/shop/pull/8");
    expect(roster).toContain("worker | ");
  });

  test("stops a stuck worker and hands its worktree to a fresh worker", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/fix-checkout-totals" });
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });

    const text = await state.harness.behavior.callAgentTool("chief_stop", {
      threadId: worker.threadId, reason: "looping on the same failing test",
    }, { threadId: chief.threadId, projectId: "proj_1" }) as string;
    expect(state.stopped).toEqual([worker.threadId]);
    expect(text).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(text).toContain(`chief_consult (workerThreadId: ${worker.threadId})`);
    const blockedRow = state.db.prepare(`SELECT state, blocker FROM managed_threads WHERE thread_id=?`).get(worker.threadId) as any;
    expect(blockedRow.state).toBe("blocked");
    expect(blockedRow.blocker).toContain("Stopped by Chief: looping");

    const replaceResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Patch the remaining bug",
      "--criteria", "Regression passes",
      "--replaces", worker.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(replaceResult.exitCode).toBe(0);
    expect(state.spawned.at(-1).environment).toEqual({ type: "reuse", environmentId: "env_worker" });
    const oldRow = state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(worker.threadId) as any;
    expect(oldRow.state).toBe("complete");
  });

  test("refuses to stop from a worker, another Chief, or a thread that is not running", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);

    await expect(state.harness.behavior.callAgentTool("chief_stop", {
      threadId: worker.threadId,
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow("active registered Chief");

    const otherChief = await state.harness.behavior.callRpc("create", { projectId: "proj_1" }) as { threadId: string };
    await expect(state.harness.behavior.callAgentTool("chief_stop", {
      threadId: worker.threadId,
    }, { threadId: otherChief.threadId, projectId: "proj_1" })).rejects.toThrow("for this Chief");

    await expect(state.harness.behavior.callAgentTool("chief_stop", {
      threadId: worker.threadId,
    }, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow("nothing to stop");

    expect(state.stopped).toEqual([]);
  });

  test("bb chief stop interrupts a running thread and prints its reroute steps", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });

    const result = await state.harness.behavior.runCli(
      ["stop", worker.threadId, "--reason", "stuck"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`replaces: ${worker.threadId}`);

    const missing = await state.harness.behavior.runCli(["stop"], { threadId: chief.threadId, projectId: "proj_1" });
    expect(missing.exitCode).toBe(1);
  });

  // Contracts (stacked-branch worktrees, wave 1): a planner, advisor or plan advisor started on a branch gets a fresh managed worktree on it and records it.
  describe("read-only roles started on a branch", () => {
    const BRANCH = "feature/pr-head";
    const BRANCH_ENV = { type: "host", hostId: expect.any(String), workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: BRANCH } } };
    const twoWaves = () => [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)];
    const lastPlanner = async (state: Awaited<ReturnType<typeof setup>>) => (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    /** A Chief and a plan with two implementation waves, started on `branch` when given; ready, so it owes its one review. */
    async function branchPlan(branch?: string) {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      await tool(state, "chief_plan", { title: "Rework checkout", mission: "Propose how to fix totals", ...(branch ? { branch } : {}) }, chief.threadId);
      const planner = await lastPlanner(state);
      await report(state, planner.threadId, { state: "ready", result: "Two waves.", plan: twoWaves() });
      return { state, chief, planner };
    }
    const consultPlan = (state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, planThreadId: string, extra: object = {}) =>
      tool(state, "chief_consult", { planThreadId, title: "Plan", mission: "Review this plan before delegation", ...extra }, chiefThreadId);

    test("chief_plan with a branch launches in a fresh managed worktree on it, never Chief's environment or the project default, and records the branch", async () => {
      const { state, planner } = await branchPlan(BRANCH);
      expect(state.spawned.at(-1).environment).toEqual(BRANCH_ENV);
      expect(rowOf(state, planner.threadId).branch).toBe(BRANCH);
    });

    test("chief_plan without a branch keeps the project-default environment and records no branch", async () => {
      const { state, planner } = await branchPlan();
      expect(state.spawned.at(-1).environment).toEqual({ type: "project-default" });
      expect(rowOf(state, planner.threadId).branch).toBeNull();
    });

    test("chief_consult with a branch and no worker launches the advisor on it; with no branch it keeps the project default", async () => {
      const state = await setup();
      const chief = await start(state);
      await tool(state, "chief_consult", { title: "Advice", mission: "Diagnose the stack", branch: BRANCH }, chief.threadId);
      const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
      expect(state.spawned.at(-1).environment).toEqual(BRANCH_ENV);
      expect(rowOf(state, advisor.threadId).branch).toBe(BRANCH);
      await tool(state, "chief_consult", { title: "Advice 2", mission: "Diagnose again" }, chief.threadId);
      expect(state.spawned.at(-1).environment).toEqual({ type: "project-default" });
      expect(rowOf(state, (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!.threadId).branch).toBeNull();
    });

    test("chief_consult with both workerThreadId and branch is refused before any thread is spawned", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      const spawned = state.spawned.length;
      await expect(tool(state, "chief_consult", { title: "Advice", mission: "Diagnose", workerThreadId: worker.threadId, branch: BRANCH }, chief.threadId)).rejects.toThrow();
      expect(state.spawned).toHaveLength(spawned);
      expect((await status(state)).threads.filter((row) => row.role === "advisor")).toHaveLength(0);
    });

    test("a plan revision with no branch inherits the branch of the plan it revises; an explicit branch wins", async () => {
      const { state, chief, planner } = await branchPlan(BRANCH);
      await consultPlan(state, chief.threadId, planner.threadId);
      const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
      await report(state, advisor.threadId, { state: "ready", result: "Split the waves differently.", verdict: "request_changes" });
      await tool(state, "chief_plan", { title: "Revise", mission: "Propose again", revises: planner.threadId }, chief.threadId);
      const revision = await lastPlanner(state);
      expect(revision.threadId).not.toBe(planner.threadId);
      expect(state.spawned.at(-1).environment).toEqual(BRANCH_ENV);
      expect(rowOf(state, revision.threadId).branch).toBe(BRANCH);
    });

    test("a revision of a plan with no branch records no branch, and an explicit branch on it wins", async () => {
      for (const explicit of [undefined, "feature/other"]) {
        const { state, chief, planner } = await branchPlan();
        await consultPlan(state, chief.threadId, planner.threadId);
        const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
        await report(state, advisor.threadId, { state: "ready", result: "Split the waves differently.", verdict: "request_changes" });
        await tool(state, "chief_plan", { title: "Revise", mission: "Propose again", revises: planner.threadId, ...(explicit ? { branch: explicit } : {}) }, chief.threadId);
        const revision = await lastPlanner(state);
        expect(rowOf(state, revision.threadId).branch).toBe(explicit ?? null);
        expect(state.spawned.at(-1).environment).toEqual(explicit ? { ...BRANCH_ENV, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: explicit } } } : { type: "project-default" });
      }
    });

    test("a plan consult with no branch uses its planner's branch, a given branch wins, and a planner with no branch keeps the project default", async () => {
      const on = await branchPlan(BRANCH);
      await consultPlan(on.state, on.chief.threadId, on.planner.threadId);
      expect(on.state.spawned.at(-1).environment).toEqual(BRANCH_ENV);
      expect(rowOf(on.state, (await status(on.state)).threads.filter((row) => row.role === "advisor").at(-1)!.threadId).branch).toBe(BRANCH);

      const given = await branchPlan(BRANCH);
      await consultPlan(given.state, given.chief.threadId, given.planner.threadId, { branch: "feature/other" });
      expect(given.state.spawned.at(-1).environment.workspace.baseBranch).toEqual({ kind: "named", name: "feature/other" });

      const off = await branchPlan();
      await consultPlan(off.state, off.chief.threadId, off.planner.threadId);
      expect(off.state.spawned.at(-1).environment).toEqual({ type: "project-default" });
    });

    test("bb chief plan --branch and bb chief consult --branch pass the branch through, and both usage lines list --branch", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const ctx = ctxOf(state, chief.threadId);
      const planned = await state.harness.behavior.runCli(["plan", "--title", "Rework", "--mission", "Propose", "--branch", BRANCH], ctx);
      expect(planned.exitCode).toBe(0);
      expect(state.spawned.at(-1).environment).toEqual(BRANCH_ENV);
      const consulted = await state.harness.behavior.runCli(["consult", "--title", "Advice", "--mission", "Diagnose", "--branch", BRANCH], ctx);
      expect(consulted.exitCode).toBe(0);
      expect(state.spawned.at(-1).environment).toEqual(BRANCH_ENV);
      const usage = (await state.harness.behavior.runCli(["help"], ctx)).stdout!;
      expect(usage).toMatch(/bb chief plan [^\n]*\[--branch feature\/…\]/);
      expect(usage).toMatch(/bb chief consult [^\n]*\[--branch feature\/…\]/);
    });
  });
});
