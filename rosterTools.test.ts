import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import plugin from "./server";
import { APPROVE, CLOSE_OUT, REQUEST_CHANGES, chiefReview, completeWorker, configurationContext, delegate, disposeAll, planTwoWaves, readyAction, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  test("enforces agent-tool authorization at execution time", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Unauthorized", mission: "Must not start",
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow("active registered Chief");
    await completeWorker(state, chief.threadId, worker.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "late report",
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow("can no longer report");
  });

  test("inspect shows persisted result and live output", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready evidence" }, { threadId: worker.threadId });
    const inspected = await state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, { threadId: chief.threadId });
    expect(JSON.stringify(inspected)).toContain("Ready evidence");
    expect(JSON.stringify(inspected)).toContain(`last output from ${worker.threadId}`);
  });

  test("bounds roster and inspect output", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const longResult = "r".repeat(8_000);
    const worker = await delegate(state, chief.threadId, "First worker");
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: longResult,
    }, { threadId: worker.threadId, projectId: "proj_1" });

    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, opts) as string;
    const resultLine = roster.split("\n").find((line) => line.trim().startsWith("result:"))!;
    expect(resultLine.replace(/^\s*/, "").length).toBeLessThanOrEqual("result: ".length + 300);

    const inspected = await state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, opts) as string;
    const inspectLine = String(inspected).split("\n").find((line) => line.startsWith("Result:"))!;
    expect(inspectLine.length).toBeLessThanOrEqual("Result: ".length + 1_500);

    // The rest report a short result: only the total row count, not each one's
    // result text, is what needs to threaten the 6,000-char roster cap here.
    // An unplanned ready worker's Pending line now carries the "delegate a tester" clause, so fewer rows fill the cap.
    let lastTitle = "First worker";
    for (let i = 0; i < 11; i += 1) {
      lastTitle = `Worker ${i}`;
      const extra = await delegate(state, chief.threadId, lastTitle);
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Done",
      }, { threadId: extra.threadId, projectId: "proj_1" });
    }

    const bigRoster = await state.harness.behavior.callAgentTool("chief_roster", {}, opts) as string;
    expect(bigRoster.length).toBeLessThanOrEqual(6_000);
    expect(bigRoster.indexOf(lastTitle)).toBeLessThan(bigRoster.indexOf("First worker"));
    // The Pending block is built first and survives the cap even behind 12 rows of detail.
    expect(bigRoster.startsWith("Pending:")).toBe(true);
    expect(bigRoster).toContain(`“${lastTitle}”`);
  });

  test("clips an overflowing Pending block by whole lines, never mid-action", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };

    // Each ready-but-unreviewed worker contributes one full pending line; enough
    // of them push the Pending block itself (not just the whole roster) past
    // 6,000 characters, so the block's own clip has to kick in.
    for (let i = 0; i < 60; i += 1) {
      const worker = await delegate(state, chief.threadId, `Worker ${i}`);
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Done",
      }, { threadId: worker.threadId, projectId: "proj_1" });
    }

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    // The rest of the roster (row details) is clipped too, so find the pending block's own end by
    // its "…and N more pending" suffix instead of searching for what follows it.
    const suffixMatch = roster.match(/^…and \d+ more pending$/m);
    expect(suffixMatch).not.toBeNull();
    const pendingBlock = roster.slice(0, suffixMatch!.index! + suffixMatch![0].length);
    expect(pendingBlock.length).toBeLessThanOrEqual(6_000);
    const lines = pendingBlock.split("\n");
    expect(lines[0]).toBe("Pending:");
    // Whole-line clipping, never a mid-action cut: every kept line is a complete,
    // unclipped pending entry, and the block ends with how many got dropped.
    for (const line of lines.slice(1, -1)) {
      const id = /^- worker “Worker \d+” \((thr_\d+)\): /.exec(line)?.[1];
      expect(id).toBeDefined();
      expect(line.endsWith(`: ${readyAction(id!)}`)).toBe(true);
    }
    expect(lines.at(-1)).toBe(suffixMatch![0]);
  });

  test("chief_roster prints Pending: none. when nothing is pending", async () => {
    const state = await setup();
    const chief = await start(state);
    const roster = String(await state.harness.behavior.callAgentTool(
      "chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" },
    ));
    expect(roster.startsWith("Pending: none.")).toBe(true);
  });

  test("chief_roster todos add, update, and close in the shared Pending block", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const roster = async (params: object) => String(await state.harness.behavior.callAgentTool("chief_roster", params, opts));

    const added = await roster({ todo: { text: "Rebase onto main", after: "PR #42 merges" } });
    expect(added.startsWith("Pending:\n- 1 waiting todo (#1) hidden")).toBe(true);
    expect(await roster({ includeWaiting: true })).toContain("- todo #1: Rebase onto main (after: PR #42 merges)");
    const cli = await state.harness.behavior.runCli(["status", "--project", "proj_1"]);
    // The operator shell has no viewing Chief, so the todo carries its owner.
    expect(cli.stdout).toContain(`- todo #1 (Chief ${chief.threadId}): Rebase onto main (after: PR #42 merges)`);

    expect(await roster({ todo: { id: 1, text: "Rebase onto #43", after: "" } })).toContain("- todo #1: Rebase onto #43");
    await roster({ todo: { id: 1, state: "done" } });
    expect(await roster({})).not.toContain("todo #1");
    expect(await roster({ includeComplete: true })).toContain("- todo #1 [done]: Rebase onto #43");

    await expect(roster({ todo: { after: "later" } })).rejects.toThrow("needs text");
    await expect(roster({ todo: { id: 99, state: "done" } })).rejects.toThrow("No todo #99");
  });

  test("chief_roster collapses todos waiting on an after: condition into one line", async () => {
    const state = await setup();
    const chief = await start(state);
    const roster = async (params: object) => String(await state.harness.behavior.callAgentTool("chief_roster", params, { threadId: chief.threadId, projectId: "proj_1" }));
    await roster({ todo: { text: "Alpha" } });
    await roster({ todo: { text: "Bravo", after: "user signs" } });
    const collapsed = await roster({ todo: { text: "Charlie", after: "PR #42 merges" } });
    expect(collapsed).toContain("- todo #1: Alpha");
    expect(collapsed).not.toContain("Bravo");
    expect(collapsed).not.toContain("Charlie");
    expect(collapsed.split("\n").filter((line) => line.startsWith("- 2 waiting todos (#2, #3) hidden"))).toHaveLength(1);
    const full = await roster({ includeWaiting: true });
    for (const line of ["- todo #1: Alpha", "- todo #2: Bravo (after: user signs)", "- todo #3: Charlie (after: PR #42 merges)"]) expect(full).toContain(line);
    expect(full).not.toContain("waiting todos");
    const onlyWaiting = await roster({ todo: { id: 1, state: "done" } });
    expect(onlyWaiting.startsWith("Pending:\n- 2 waiting todos")).toBe(true);
  });

  test("chief todos are project-scoped and survive a replacement Chief", async () => {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.callAgentTool("chief_roster", { todo: { text: "Ship docs" } }, { threadId: chief.threadId, projectId: "proj_1" });
    const replacement = await state.harness.behavior.callRpc("create", { projectId: "proj_1" }) as { threadId: string };
    expect(String(await state.harness.behavior.callAgentTool(
      "chief_roster", {}, { threadId: replacement.threadId, projectId: "proj_1" },
    ))).toContain(`Other Chiefs' todos (not your work; act on one only when the user asks):\n- todo #1 (Chief ${chief.threadId}): Ship docs`);

    const other = await start(state, "proj_2");
    const otherOpts = { threadId: other.threadId, projectId: "proj_2" };
    expect(String(await state.harness.behavior.callAgentTool("chief_roster", {}, otherOpts))).not.toContain("todo #1");
    await expect(state.harness.behavior.callAgentTool("chief_roster", { todo: { id: 1, state: "done" } }, otherOpts)).rejects.toThrow("No todo #1");

    const worker = await delegate(state, replacement.threadId, "Fix checkout totals");
    await expect(state.harness.behavior.callAgentTool(
      "chief_roster", { todo: { text: "Sneaky" } }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow("requires an active registered Chief");
  });

  test("the roster's Pending block uses the same wording as the lifecycle alert", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };

    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    const workerAlert = state.sent.at(-1).input[0].text as string;
    const workerAction = readyAction(worker.threadId);
    // The alert clips an action over 400 characters (the full text is in its report file's Next line); the roster carries it whole.
    expect(workerAlert).toContain(workerAction.slice(0, 300));
    expect(await readFile(join(state.storageRoot, "chief", "proj_1", worker.threadId, "report-1.md"), "utf8")).toContain(`Next: ${workerAction}`);
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("Pending:");
    expect(roster).toContain(`- worker “Fix checkout totals” (${worker.threadId}): ${workerAction}`);

    // Once the review is actually in flight, the worker drops out of Pending.
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", ...APPROVE,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    const reviewAlert = state.sent.at(-1).input[0].text as string;
    const approveAction = `The reviewer approves. chief_complete (threadId: ${worker.threadId}); it marks the pull request ready. Nits listed with an approve are optional: start no worker round for them alone.`;
    expect(reviewAlert).toContain(approveAction);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain(`- reviewer “Review · Fix checkout totals” (${reviewer.threadId}): ${approveAction}`);

    // Once Chief completes the worker, the approved reviewer must not keep advertising it.
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed", ...CLOSE_OUT }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster.startsWith("Pending: none.")).toBe(true);
  });

  test("the Pending block shows a blocked worker and a rejected review the same way its alert does", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };

    const blockedWorker = await delegate(state, chief.threadId, "Blocked work");
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing staging credentials", recommendation: "Ask the user",
    }, { threadId: blockedWorker.threadId, projectId: "proj_1" });
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain(`- worker “Blocked work” (${blockedWorker.threadId}): Blocked: Missing staging credentials — decide or escalate to the user.`);

    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Off by one in the discount calc", ...REQUEST_CHANGES,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    const reviewAlert = state.sent.at(-1).input[0].text as string;
    const fixAction = `The reviewer requires changes. Hand the fix to a fresh worker with chief_delegate (replaces: ${worker.threadId}); its findings are attached automatically. Escalate if the disagreement is a genuine decision.`;
    expect(reviewAlert).toContain(fixAction);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain(`- reviewer “Review · Fix checkout totals” (${reviewer.threadId}): ${fixAction}`);
  });

  test("the Pending block tells Chief to delegate a planner's wave 1 until it is delegated", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const { planner } = await planTwoWaves(state, chief.threadId);

    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain(`- planner “Plan · Rework checkout” (${planner.threadId}): Delegate wave 1 now: run chief_forge_init (planThreadId: ${planner.threadId}, wave: 1), then chief_delegate (planThreadId: ${planner.threadId}, wave: 1). The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.`);

    await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "1", "--json",
    ], opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain(`- planner “Plan · Rework checkout”`);
  });

  test("shows the wave schedule and progress on both the planner and its delegated worker", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const { planner, path1, path2 } = await planTwoWaves(state, chief.threadId);

    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Wave 1 work", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "1", "--json",
    ], opts);
    const worker = JSON.parse(result.stdout!) as { threadId: string };

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 0/2 done, wave 1 starting");
    expect(roster).toContain(`wave 1 of 2: ${path1}`);
    expect(roster).toContain(`wave 2 of 2: ${path2}`);
    expect(roster).toContain(`wave: 1 of 2 (plan ${planner.threadId})`);
    expect(roster).toContain(worker.threadId);
  });

  test("shows the same Pending block on the CLI status command as on chief_roster", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    const pendingLine = roster.split("\n").find((line) => line.startsWith("- worker"))!;
    const cli = await state.harness.behavior.runCli(["status", "--project", "proj_1"], opts);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain(pendingLine);
  });

  test("adds the roster instruction to every Chief turn but not a worker's", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const configuredChief = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configuredChief.instructions).toContain("Call chief_roster at the start of every turn, and again after any compaction");
    expect(configuredChief.instructions).toContain("never poll managed threads");
    const configuredWorker = await state.harness.behavior.resolveAgentConfiguration(configurationContext(worker.threadId));
    expect(configuredWorker.instructions).not.toContain("Call chief_roster at the start of every turn");
    expect(configuredWorker.instructions).not.toContain("never poll managed threads");
  });

  test("selects supervisor and reporting tools only for the matching roles", async () => {
    const state = await setup();
    const chiefId = (await start(state)).threadId;
    const workerId = (await delegate(state, chiefId)).threadId;
    const chief = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chiefId));
    const worker = await state.harness.behavior.resolveAgentConfiguration(configurationContext(workerId));
    const ordinary = await state.harness.behavior.resolveAgentConfiguration(configurationContext("thr_other"));
    expect(chief.tools.map((tool) => tool.name)).toEqual(["chief_forge_init", "chief_delegate", "chief_plan", "chief_spawn", "chief_coordinate", "chief_attach", "chief_consult", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete", "chief_owner_approval", "chief_skip_tests", "chief_skip_specs", "chief_escalate", "chief_sync", "chief_research"]);
    expect(chief.skills).toEqual(["chief", "coordinator"]);
    expect(worker.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(worker.skills).toEqual(["chief-worker", "chief-role-worker"]);
    for (const tool of [...chief.tools, ...worker.tools] as any[]) {
      expect(tool.presentation?.label, tool.name).toMatchObject({ pending: expect.any(String), completed: expect.any(String) });
    }
    expect(ordinary.tools).toEqual([]);
  });

  test("ignores pluginMetadata seeded by a thread this plugin never spawned", async () => {
    const state = await setup();
    // pluginMetadata is writable by any API client, another plugin, or the thread's
    // own agent, so a thread claiming role: "chief" there must not be trusted unless
    // origin.pluginId proves this plugin actually spawned it.
    const spoofed = await state.harness.behavior.resolveAgentConfiguration({
      ...configurationContext("thr_spoofed"),
      origin: { kind: null, pluginId: "some-other-plugin" },
      pluginMetadata: { role: "chief" },
    });
    expect(spoofed.tools).toEqual([]);
    expect(spoofed.skills).toEqual([]);
  });

  test("exposes chief_report to a reviewer even before its row is persisted", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    // insertThread only runs after threads.spawn resolves, so the tool set for a
    // brand-new thread's first turn cannot depend on that row already existing —
    // it has to come from what was seeded into pluginMetadata at spawn time.
    expect(state.spawned.at(-1).pluginMetadata).toEqual({ role: "reviewer", chiefThreadId: chief.threadId });

    const resolved = await state.harness.behavior.resolveAgentConfiguration({
      ...configurationContext("thr_not_yet_persisted"),
      pluginMetadata: { role: "reviewer", chiefThreadId: chief.threadId },
    });
    expect(resolved.tools.map((tool: any) => tool.name)).toContain("chief_report");
    expect(resolved.skills).toEqual(["chief-worker", "chief-role-reviewer"]);
  });

  test("persists a reviewer's verdict even if chief_report races the row insert", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    // Simulate the same race the test above exercises for tool exposure, but this
    // time actually call chief_report while managed_threads has no row for it yet.
    state.addLive("thr_racing_insert", "proj_1", "Review · totals fix", "chief");
    state.seedPluginMetadata("thr_racing_insert", { role: "reviewer", chiefThreadId: chief.threadId });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Confirmed against the regression test", ...APPROVE,
    }, { threadId: "thr_racing_insert", projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: approve");

    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" });
    expect(roster).toContain("thr_racing_insert");
    expect(roster).toContain("verdict: approve");
  });

  test("refuses to self-heal chief_report for a thread this plugin never spawned", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    // Same race as above, but originPluginId does not attribute this thread to us,
    // so the pluginMetadata it claims must not be trusted to insert a managed row.
    state.addLive("thr_untrusted_insert", "proj_1", "Review · totals fix", "some-other-plugin");
    state.seedPluginMetadata("thr_untrusted_insert", { role: "reviewer", chiefThreadId: chief.threadId });
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Should not land", verdict: "approve",
    }, { threadId: "thr_untrusted_insert", projectId: "proj_1" })).rejects.toThrow("available only in managed");
  });
});
