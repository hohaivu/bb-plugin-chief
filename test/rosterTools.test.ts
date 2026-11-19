import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import plugin from "../server";
import { APPROVE, CLOSE_OUT, REQUEST_CHANGES, approvePlan, completeWorker, configurationContext, delegate, disposeAll, planTwoWaves, setup, start, status, wave } from "./harness";
import { forgeAnswers, forged, startGate } from "./gateForge";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
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
    // The complete (unclipped) entry of worker 0, read while the roster is still small: the template every retained entry must equal.
    const entry = (line: string) => line.replaceAll(/\bthr_\d+\b/g, "<id>").replaceAll(/Worker \d+/g, "<title>");
    let complete = "";
    for (let i = 0; i < 60; i += 1) {
      const worker = await delegate(state, chief.threadId, `Worker ${i}`);
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Done",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      if (i === 0) {
        const small = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
        complete = entry(small.split("\n").find((line) => line.startsWith("- worker “Worker 0”"))!);
      }
    }
    expect(complete).toContain("chief_review");

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
      expect(line).toContain(`chief_review (workerThreadId: ${id})`);
      // Never cut after the call: the entry is the complete one, id and title aside.
      expect(entry(line)).toBe(complete);
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

  describe("other-Chief todo collapse", () => {
    const HIDDEN = (n: number, ids: string) => `- ${n} other-Chief todo${n === 1 ? "" : "s"} (${ids}) hidden`;
    const scenario = async () => {
      const state = await setup();
      const a = await start(state);
      const b = (await state.harness.behavior.callRpc("create", { projectId: "proj_1" }) as { threadId: string }).threadId;
      // The Pending block alone: the roster text goes on with the thread table after it.
      const roster = async (threadId: string, params: object = {}) => {
        const lines = String(await state.harness.behavior.callAgentTool("chief_roster", params, { threadId, projectId: "proj_1" })).split("\n");
        const end = lines.findIndex((line, index) => index > 0 && !/^(- |Other Chiefs' todos)/.test(line));
        return lines.slice(0, end < 0 ? lines.length : end).join("\n");
      };
      return { state, a: a.threadId, b, roster };
    };

    test("another live Chief's todos, waiting ones included, fold into one count line; the viewer's own todos stay in full", async () => {
      const { a, b, roster } = await scenario();
      await roster(b, { todo: { text: "Mine" } });
      await roster(a, { todo: { text: "Alpha" } });
      await roster(a, { todo: { text: "Bravo", after: "user signs" } });
      await roster(b, { todo: { text: "Own waiting", after: "PR #9 merges" } });
      const text = await roster(b);
      // #1 Mine (b), #2 Alpha (a), #3 Bravo waiting (a), #4 Own waiting (b)
      const lines = text.split("\n");
      expect(lines.slice(0, 2)).toEqual(["Pending:", "- todo #1: Mine"]);
      expect(lines[2]!.startsWith("- 1 waiting todo (#4) hidden")).toBe(true);
      expect(lines[3]!.startsWith(HIDDEN(2, "#2, #3"))).toBe(true);
      expect(lines).toHaveLength(4);
      expect(text).not.toContain("Alpha");
      expect(text).not.toContain("Bravo");
      expect(text).not.toContain("Other Chiefs' todos");
    });

    test("an ended Chief's todo and an unowned todo fold into the same line; with no foreign todo there is no line", async () => {
      const { state, a, b, roster } = await scenario();
      expect(await roster(b)).toBe("Pending: none.");
      await roster(a, { todo: { text: "Ended one" } });
      await roster(a, { todo: { text: "Unowned one" } });
      state.db.prepare("UPDATE chief_todos SET chief_thread_id=NULL WHERE id=2").run();
      // Archiving Chief A hands its todos to the live Chief B, so give todo #1 back to the ended A afterwards.
      state.live.set(a, { ...state.live.get(a)!, archivedAt: Date.now() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(a)! });
      await state.supervisorCycle();
      state.db.prepare("UPDATE chief_todos SET chief_thread_id=? WHERE id=1").run(a);
      const text = await roster(b);
      expect(text.startsWith(`Pending:\n${HIDDEN(2, "#1, #2")}`)).toBe(true);
      expect(text.split("\n")).toHaveLength(2);
      const full = await roster(b, { includeOthers: true });
      expect(full).toContain(`- todo #1 (ended Chief ${a}): Ended one`);
      expect(full).toContain("- todo #2 (unowned): Unowned one");
      expect(full).not.toContain("other-Chief todo");
    });

    test("includeOthers: true equals the uncollapsed output, with and without includeWaiting; false equals the default; closed todos are not counted", async () => {
      const { a, b, roster } = await scenario();
      await roster(a, { todo: { text: "Alpha" } });
      await roster(a, { todo: { text: "Bravo", after: "user signs" } });
      await roster(a, { todo: { text: "Gone" } });
      await roster(a, { todo: { id: 3, state: "done" } });
      await roster(b, { todo: { text: "Mine" } });
      expect(await roster(b, { includeOthers: false })).toBe(await roster(b));
      expect(await roster(b)).toContain(HIDDEN(2, "#1, #2"));
      const others = (await roster(b, { includeOthers: true })).split("\n");
      expect(others.slice(0, 2)).toEqual(["Pending:", "- todo #4: Mine"]);
      expect(others[2]!.startsWith("Other Chiefs' todos")).toBe(true);
      expect(others[3]).toBe(`- todo #1 (Chief ${a}): Alpha`);
      expect(others[4]!.startsWith("- 1 waiting other-Chief todo (#2) hidden")).toBe(true);
      expect(others).toHaveLength(5);
      const othersWaiting = (await roster(b, { includeOthers: true, includeWaiting: true })).split("\n");
      expect(othersWaiting.slice(0, 2)).toEqual(["Pending:", "- todo #4: Mine"]);
      expect(othersWaiting[2]!.startsWith("Other Chiefs' todos")).toBe(true);
      expect(othersWaiting.slice(3)).toEqual([`- todo #1 (Chief ${a}): Alpha`, `- todo #2 (Chief ${a}): Bravo (after: user signs)`]);
      expect(await roster(b, { includeComplete: true })).toContain(HIDDEN(2, "#1, #2"));
    });

    test("bb chief status still lists every Chief's todo in full", async () => {
      const { state, a, b, roster } = await scenario();
      await roster(a, { todo: { text: "Alpha" } });
      await roster(b, { todo: { text: "Bravo", after: "user signs" } });
      const cli = (await state.harness.behavior.runCli(["status", "--project", "proj_1"])).stdout!;
      expect(cli).toContain(`- todo #1 (Chief ${a}): Alpha`);
      expect(cli).toContain(`- todo #2 (Chief ${b}): Bravo (after: user signs)`);
      expect(cli).not.toContain("other-Chief todo");
    });

    test("the collapse line keeps the 6000-character roster cap: many foreign todos stay one short line", async () => {
      const { a, b, roster } = await scenario();
      for (let i = 0; i < 60; i += 1) await roster(a, { todo: { text: `Todo ${i} ${"x".repeat(200)}` } });
      const text = await roster(b);
      expect(text.length).toBeLessThan(1_000);
      expect(text.split("\n").filter((line) => line.includes("other-Chief todos"))).toHaveLength(1);
      expect((await roster(b, { includeOthers: true })).length).toBeLessThanOrEqual(6_000);
      expect((await roster(b, { includeOthers: true })).length).toBeGreaterThan(1_000);
    });
  });

  test("chief todos are project-scoped and survive a replacement Chief", async () => {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.callAgentTool("chief_roster", { todo: { text: "Ship docs" } }, { threadId: chief.threadId, projectId: "proj_1" });
    const replacement = await state.harness.behavior.callRpc("create", { projectId: "proj_1" }) as { threadId: string };
    const replacementOpts = { threadId: replacement.threadId, projectId: "proj_1" };
    const othersLines = String(await state.harness.behavior.callAgentTool(
      "chief_roster", { includeOthers: true }, replacementOpts,
    )).split("\n");
    const header = othersLines.findIndex((line) => line.startsWith("Other Chiefs' todos"));
    expect(header).toBeGreaterThanOrEqual(0);
    expect(othersLines[header + 1]).toBe(`- todo #1 (Chief ${chief.threadId}): Ship docs`);
    // By default the same todo is one count line, with neither its text nor the section header.
    const collapsedDefault = String(await state.harness.behavior.callAgentTool("chief_roster", {}, replacementOpts));
    expect(collapsedDefault.startsWith("Pending:\n- 1 other-Chief todo (#1) hidden")).toBe(true);
    expect(collapsedDefault).not.toContain("Ship docs");

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
    forgeAnswers(state);
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };

    const worker = await delegate(state, chief.threadId, "Fix checkout totals", forged());
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    const workerAlert = state.sent.at(-1).input[0].text as string;
    const workerAction = `chief_review (workerThreadId: ${worker.threadId})`;
    expect(workerAlert).toContain(workerAction);
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("Pending:");
    expect(roster.split("\n").find((line) => line.startsWith(`- worker “Fix checkout totals” (${worker.threadId}): `))).toContain(workerAction);

    // With the gate open the worker stays in Pending and names the busy sides (gateDecision wait).
    const { reviewerId } = await startGate(state, chief.threadId, worker.threadId);
    const workerLine = () => roster.split("\n").find((line) => line.startsWith(`- worker “Fix checkout totals” (${worker.threadId}): `));
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(workerLine()).toContain(reviewerId);

    // The approve passes the gate: the alert and the roster name the same completion.
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Looks correct", ...APPROVE }, { threadId: reviewerId!, projectId: "proj_1" });
    const passAction = `chief_complete (threadId: ${worker.threadId})`;
    expect(state.sent.at(-1).input[0].text).toContain(passAction);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(workerLine()).toContain(passAction);

    // Once Chief completes the worker, nothing keeps advertising it.
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed" }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster.startsWith("Pending: none.")).toBe(true);
  });

  test("the Pending block shows a blocked worker and a rejected review the same way its alert does", async () => {
    const state = await setup();
    forgeAnswers(state);
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };

    const blockedWorker = await delegate(state, chief.threadId, "Blocked work");
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing staging credentials", recommendation: "Ask the user",
    }, { threadId: blockedWorker.threadId, projectId: "proj_1" });
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster.split("\n").find((line) => line.startsWith(`- worker “Blocked work” (${blockedWorker.threadId}): `))).toContain("Missing staging credentials");

    const worker = await delegate(state, chief.threadId, "Fix checkout totals", forged());
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    const { reviewerId } = await startGate(state, chief.threadId, worker.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Off by one in the discount calc", ...REQUEST_CHANGES,
    }, { threadId: reviewerId!, projectId: "proj_1" });
    // A blocking code finding makes gateDecision fix: the one fix run replaces the gate's first target.
    const fixAction = `chief_delegate (replaces: ${worker.threadId}, kind: worker)`;
    expect(state.sent.at(-1).input[0].text).toContain(fixAction);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster.split("\n").find((line) => line.includes(`(${worker.threadId}): `))).toContain(fixAction);
  });

  test("the Pending block tells Chief to delegate a planner's wave 1 until it is delegated", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const { planner } = await planTwoWaves(state, chief.threadId);

    // A two-wave plan needs no review: Pending tells Chief to delegate wave 1 at once.
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain("chief_consult");
    const plannerLine = roster.split("\n").find((line) => line.startsWith(`- planner “Plan · Rework checkout” (${planner.threadId}): `));
    expect(plannerLine).toContain(`chief_forge_init (planThreadId: ${planner.threadId}, wave: 1)`);
    expect(plannerLine).toContain(`chief_delegate (planThreadId: ${planner.threadId}, wave: 1)`);

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
    await approvePlan(state, chief.threadId, planner.threadId);

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
    expect(configuredChief.instructions).toContain("# Chief core rules (always apply)");
    const configuredWorker = await state.harness.behavior.resolveAgentConfiguration(configurationContext(worker.threadId));
    expect(configuredWorker.instructions).not.toContain("# Chief core rules (always apply)");
  });

  test("selects supervisor and reporting tools only for the matching roles", async () => {
    const state = await setup();
    const chiefId = (await start(state)).threadId;
    const workerId = (await delegate(state, chiefId)).threadId;
    const chief = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chiefId));
    const worker = await state.harness.behavior.resolveAgentConfiguration(configurationContext(workerId));
    const ordinary = await state.harness.behavior.resolveAgentConfiguration(configurationContext("thr_other"));
    expect(chief.tools.map((tool) => tool.name)).toEqual(["chief_forge_init", "chief_delegate", "chief_plan", "chief_spawn", "chief_coordinate", "chief_attach", "chief_consult", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete", "chief_owner_approval", "chief_skip_specs", "chief_escalate", "chief_sync", "chief_research"]);
    expect(chief.skills).toEqual([]);
    expect(chief.instructions).toContain("# Chief procedure");
    expect(worker.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(worker.skills).toEqual([]);
    expect(worker.instructions).not.toContain("# Chief procedure");
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
    forgeAnswers(state);
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", forged());
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: worker.threadId, projectId: "proj_1" });
    const { reviewerId } = await startGate(state, chief.threadId, worker.threadId);
    // insertThread only runs after threads.spawn resolves, so the tool set for a
    // brand-new thread's first turn cannot depend on that row already existing —
    // it has to come from what was seeded into pluginMetadata at spawn time.
    expect(state.spawned[Number(reviewerId!.slice("thr_".length)) - 1].pluginMetadata).toEqual({ role: "reviewer", chiefThreadId: chief.threadId });

    const resolved = await state.harness.behavior.resolveAgentConfiguration({
      ...configurationContext("thr_not_yet_persisted"),
      pluginMetadata: { role: "reviewer", chiefThreadId: chief.threadId },
    });
    expect(resolved.tools.map((tool: any) => tool.name)).toContain("chief_report");
    expect(resolved.skills).toEqual([]);
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

  // Contract (plan-1 step 10): `bb chief stats` research counts a Chief `spawned` row as a call AND a success; an `error` row is a call only;
  // historical non-Chief rows count as before (succeeded/partial succeed, error does not). Regression: skipping `spawned` rows reports 0/N for a
  // Chief that started researchers, or dropping the historical outcomes.
  test("research stats count Chief spawned rows as calls and successes and keep historical rows as before", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    for (const question of ["Who calls this?", "Where is it stored?"]) await state.harness.behavior.callAgentTool("chief_research", { question, design: false }, opts);
    const row = state.db.prepare(`INSERT INTO chief_research_calls (caller_thread_id, role, mode, run_id, outcome, started_at, ended_at) VALUES (?, ?, ?, NULL, ?, 1, 2)`);
    row.run(chief.threadId, "chief", null, "error");
    row.run(chief.threadId, "planner", "survey", "succeeded");
    row.run(chief.threadId, "planner", "survey", "partial");
    row.run(chief.threadId, "planner", "survey", "error");
    const result = await state.harness.behavior.runCli(["stats", "--project", "proj_1", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!).research).toEqual([
      { role: "chief", mode: null, calls: 3, succeeded: 2 },
      { role: "planner", mode: "survey", calls: 3, succeeded: 2 },
    ]);
  });

  // Regression (review thr_qcg8bngpwt): a fresh researcher start records mode=null, and the text CLI rendered it as "chief resume 1/1".
  // A normal start is not a resumed run; the text must call it "calls".
  test("stats text labels a fresh chief_research start as calls, never resume", async () => {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.callAgentTool("chief_research", { question: "Who calls this?", design: false }, { threadId: chief.threadId, projectId: "proj_1" });
    const result = await state.harness.behavior.runCli(["stats", "--project", "proj_1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Research: chief calls 1/1 succeeded");
    expect(result.stdout).not.toContain("resume");
  });
});
