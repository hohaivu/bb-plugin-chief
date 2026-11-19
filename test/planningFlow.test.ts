import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PLAN_FIXTURE, chiefReview, nativeLines, configurationContext, delegate, disposeAll, execFileMock, ghHead, planFile, setup, start, status, wave } from "./harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);
// Tool names appear in this order (not necessarily adjacent): pins the call order, not the sentences around it.
const inOrder = (text: string, names: string[]) => names.reduce((from, name) => (from < 0 ? from : text.indexOf(name, from) < 0 ? -1 : text.indexOf(name, from) + name.length), 0) >= 0;
// Long lines of `source` that `text` repeats: a second copy of a rule in a spawn prompt is one that can drift.
const sharedLines = (text: string, source: string) => text.split("\n").filter((line) => line.length >= 60 && source.includes(line));
describe("Chief backend", () => {
  // Without planThreadId the pull request body is the reviewer's whole brief (06f4b0d), so the mission is required.
  const FORGE_PARAMS = { title: "Fix checkout totals", mission: "Correct and verify totals", successCriteria: "Regression passes" };

  test("hands Chief a forge script instead of the plumbing to reassemble", async () => {
    const state = await setup();
    const chief = await start(state);
    const script = await state.harness.behavior.callAgentTool(
      "chief_forge_init",
      FORGE_PARAMS,
      { threadId: chief.threadId, projectId: "proj_1" },
    ) as string;
    expect(script).toContain("TITLE='Fix checkout totals'");
    expect(script).toContain("BRANCH='feature/fix-checkout-totals'");
    expect(script).toContain("CHIEF_FORGE branch=%s");
    // A worker must never be able to open branches and pull requests of its own.
    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool(
      "chief_forge_init", { title: "Sneak one in" }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow(/active registered Chief/);
  });

  test("runs the forge pre-flight on the server and hands Chief the values", async () => {
    execFileMock.mockResolvedValue({ stdout: "noise\nCHIEF_FORGE branch=feature/x base=main issue_url=https://i/1 pr_url=https://p/2 forge=gh\n", stderr: "" });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const result = await state.harness.behavior.callAgentTool(
      "chief_forge_init", FORGE_PARAMS, { threadId: chief.threadId, projectId: "proj_1" },
    ) as string;
    expect(result).toContain("branch=feature/x");
    expect(result).toContain("https://p/2");
    expect(result).not.toContain("```sh");
    const [file, , options] = execFileMock.mock.calls.at(-1)!;
    expect(file).toBe("sh");
    expect(options.cwd).toBe("/repo/proj1");
    expect(options.env.PATH).toContain("/opt/homebrew/bin");
  });

  test.each([
    ["a rejected run", () => execFileMock.mockRejectedValue(new Error("boom")), "/repo/proj1"],
    ["no forge CLI on the server", () => execFileMock.mockResolvedValue({ stdout: "CHIEF_FORGE branch=feature/x base=main issue_url= pr_url= forge=\n", stderr: "" }), "/repo/proj1"],
    ["no project path", () => {}, undefined],
  ])("falls back to the forge script on %s", async (_name, arrange, projectPath) => {
    arrange();
    const state = await setup({ projectPath });
    const chief = await start(state);
    const result = await state.harness.behavior.callAgentTool(
      "chief_forge_init", FORGE_PARAMS, { threadId: chief.threadId, projectId: "proj_1" },
    ) as string;
    expect(result).toContain("```sh");
    expect(result).toContain("CHIEF_FORGE");
    if (!projectPath) expect(execFileMock.mock.calls.filter(([file]) => file === "sh")).toHaveLength(0);
  });

  test("keeps the delegation policy and project rules out of every spawn prompt", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"], opts,
    );
    const worker = await delegate(state, chief.threadId);
    const branchReview = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });

    // Both live in what bb.agents.configure puts into every turn: the chief skill
    // and the rules. A second copy in a spawn prompt is one that can drift.
    const chiefInstructions = (await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId))).instructions;
    for (const entry of state.spawned) {
      const text = (entry.prompt ?? entry.input?.[0]?.text ?? "") as string;
      expect(text).not.toContain("## Project rules");
      expect(sharedLines(text, chiefInstructions)).toEqual([]);
    }

    // The built-in rules are Chief's own; a managed thread would only be told to call tools it lacks.
    expect(chiefInstructions).toContain("# Chief operating rules");
    expect(chiefInstructions).toContain("# Chief core rules (always apply)");
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    for (const threadId of [worker.threadId, planner.threadId, branchReview.threadId]) {
      const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
      expect(configured.instructions).not.toContain("Chief operating rules");
      expect(configured.instructions).not.toContain("Chief core rules");
    }
  });

  test("does not repeat the planning instructions in the Chief spawn prompt", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const prompt = state.spawned[0].prompt as string;
    expect(prompt.indexOf("chief_plan")).toBeLessThan(prompt.indexOf("chief_forge_init"));
    const { instructions } = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    // The planning rules live in the instructions only: no long line of them repeats in the spawn prompt.
    expect(sharedLines(prompt, instructions)).toEqual([]);
    expect(inOrder(instructions, ["chief_plan", "chief_forge_init", "chief_delegate"])).toBe(true);
  });

  test("refuses chief_delegate with no plan or unplannedReason when planning is on", async () => {
    const state = await setup();
    const chief = await start(state);
    const refused = state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Fix checkout totals", mission: "Correct and verify totals",
    }, { threadId: chief.threadId, projectId: "proj_1" });
    await expect(refused).rejects.toThrow(/chief_plan first/);
    await expect(refused).rejects.toThrow(/unplannedReason/);
    expect(state.spawned).toHaveLength(1);

    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/chief_plan first/);
    expect(result.stderr).toMatch(/unplannedReason/);
  });

  test("unplannedReason spawns and shows the reason in roster and inspect", async () => {
    const state = await setup();
    const chief = await start(state);
    const delegateResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix a typo", "--mission", "Fix the typo in the README",
      "--unplanned-reason", "Typo fix", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(delegateResult.exitCode).toBe(0);
    const worker = JSON.parse(delegateResult.stdout!) as { threadId: string };

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(roster).toContain("unplanned: Typo fix");

    const inspected = String(await state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(inspected).toContain("Unplanned: Typo fix");
  });

  test("keeps planning off: plain delegate succeeds with no unplanned line", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: false });
    const chief = await start(state);
    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(roster).not.toContain("unplanned:");
  });

  test("replaces: an unplanned worker with no reason, and the fresh worker inherits it", async () => {
    const state = await setup();
    const chief = await start(state);
    const delegateResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix a typo", "--mission", "Fix the typo in the README",
      "--unplanned-reason", "Typo fix", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    const worker = JSON.parse(delegateResult.stdout!) as { threadId: string };
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Fixed",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });

    const replaceResult = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix a typo", "--mission", "One more typo",
      "--replaces", worker.threadId, "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(replaceResult.exitCode).toBe(0);

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(roster).toContain("unplanned: Typo fix");
  });

  test("unplannedReason combined with planThreadId is rejected", async () => {
    const state = await setup();
    const chief = await start(state);
    await expect(state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Fix checkout totals", mission: "Correct and verify totals",
      planThreadId: "thr_planner", wave: 1, unplannedReason: "Typo fix",
    } as any, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow(/cannot be combined/);
  });

  test("configure instructions mention the plan-forge-delegate order when planning is on", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(inOrder(configured.instructions, ["chief_research", "chief_plan", "chief_forge_init", "chief_delegate"])).toBe(true);
  });

  test("with research off the planner order line is the one without a design step", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
    const chief = await start(state);
    const { instructions } = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(inOrder(instructions, ["chief_plan", "chief_forge_init", "chief_delegate"])).toBe(true);
    expect(instructions).not.toContain("undesignedReason");
    expect(instructions).not.toContain("chief_research");
  });

  test("keeps planning off when the setting is turned off", async () => {
    const state = await setup();
    const chief = await start(state);
    const configuredDefault = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configuredDefault.tools.map((tool) => tool.name)).toContain("chief_plan");

    await state.harness.behavior.setSettings({ plannerEnabled: false });
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configured.tools.map((tool) => tool.name)).not.toContain("chief_plan");
    await expect(state.harness.behavior.callAgentTool("chief_plan", {
      title: "Rework checkout", mission: "Propose how to fix totals",
    }, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow(/Planning is off/);
    expect(state.spawned).toHaveLength(1);
  });

  test("does not double a role prefix Chief already typed", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.callAgentTool("chief_plan", {
      title: "Plan · X", mission: "Propose how to fix totals", undesignedReason: "small fix",
    }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(state.spawned.at(-1)?.title).toBe("Plan · X");
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Two waves", plan: [{ body: PLAN_FIXTURE }, { body: wave(2) }],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_consult", {
      planThreadId: planner.threadId, title: "Consult · X", mission: "Review the plan",
    }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(state.spawned.at(-1)?.title).toBe("Consult · X");
  });

  test("plans read-only in the project's own checkout and spends no worktree", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const plan = await state.harness.behavior.callAgentTool("chief_plan", {
      title: "Rework checkout", mission: "Propose how to fix totals", undesignedReason: "small fix",
    }, { threadId: chief.threadId, projectId: "proj_1" });

    const spawned = state.spawned.at(-1);
    expect(spawned).toMatchObject({
      title: "Plan · Rework checkout",
      sectionId: "sec_chief",
      visibility: "visible",
      // A plan reads code; only a worker earns a worktree.
      environment: { type: "project-default" },
    });
    // The planner opens on a plain prompt, not the provider's own /plan action.
    expect(spawned.input).toBeUndefined();
    expect(spawned.prompt).toContain("Propose how to fix totals");

    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    expect(planner.chiefThreadId).toBe(chief.threadId);
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configured.tools.map((tool) => tool.name)).toContain("chief_plan");
  });

  test("hands a finished plan back to Chief to delegate, and never auto-reviews it", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Change totals.ts", plan: [{ body: PLAN_FIXTURE }],
    }, { threadId: planner.threadId, projectId: "proj_1" });

    const reported = state.sent.at(-1).input[0].text;
    // Not "Worker report": Chief has to see which role spoke.
    expect(reported).toContain("Planner report");
    const planPath = planFile(state, planner.threadId, 1);
    expect(reported).toContain("Plan: 1 wave(s)");
    // The mirror succeeded: each plan file shows once, as an inline-vis line, and no `Wave n of N` path line repeats it.
    expect(reported).toContain(`::inline-vis{source="thread-storage" file="plans/${planner.threadId}/plan-1.md"}`);
    expect(reported).not.toContain("Wave 1 of 1:");
    expect(reported).not.toContain(planPath);
    const forgeCall = `chief_forge_init (planThreadId: ${planner.threadId}, wave: 1)`;
    expect(reported).toContain(forgeCall);
    expect(reported.indexOf(forgeCall)).toBeLessThan(reported.indexOf(`chief_delegate (planThreadId: ${planner.threadId}, wave: 1)`));
    expect(await readFile(planPath, "utf8")).toBe(`${PLAN_FIXTURE}\n`);

    // A plan is not work: going idle must not start a reviewer on it.
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(planner.threadId)!,
      lastAssistantText: "plan ready",
    });
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);

    // A planner that already reported is not nudged: chief_continue only steers a thread still working.
    const sentBefore = state.sent.length;
    const nudge = await state.harness.behavior.runCli(["continue", planner.threadId, "--instruction", "Name the test file"], { threadId: chief.threadId, projectId: "proj_1" });
    expect(nudge.exitCode).not.toBe(0);
    expect(state.sent).toHaveLength(sentBefore);
  });

  test("rejects a planner's ready report without plan", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const sentBefore = state.sent.length;

    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Change totals.ts, then cover it with a test",
    }, { threadId: planner.threadId, projectId: "proj_1" })).rejects.toThrow(/plan is missing; a planner's ready report requires the full plan body/);

    expect(state.sent.length).toBe(sentBefore);
  });

  test("rejects plan from a worker", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    const worker = (await status(state)).threads.find((row) => row.role === "worker")!;

    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Done", plan: [{ body: PLAN_FIXTURE }, { body: wave(2) }],
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow(/plan is only for a planner's ready report \(role is worker\)/);
  });

  test("a multi-wave plan writes one file per wave, persists the schedule, and alerts it without opening any plan file", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
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
        { body: wave(4) },
      ],
    }, { threadId: planner.threadId, projectId: "proj_1" });

    const path1 = planFile(state, planner.threadId, 1);
    const path2 = planFile(state, planner.threadId, 2);
    const path3 = planFile(state, planner.threadId, 3);
    const path4 = planFile(state, planner.threadId, 4);
    expect(await readFile(path1, "utf8")).toBe(`${PLAN_FIXTURE}\n`);
    expect(await readFile(path2, "utf8")).toBe(`${wave(2, "Migrate the data.")}\n`);
    expect(await readFile(path3, "utf8")).toBe(`${wave(3, "Wire up delegation.")}\n`);

    const reported = state.sent.at(-1).input[0].text;
    expect(reported).toContain("Plan: 4 wave(s)");
    expect(reported).not.toMatch(/Wave \d of 4:/);
    for (const path of [path1, path2, path3, path4]) expect(reported).not.toContain(path);
    // Mirrored into Chief's storage so Chief can echo inline-vis previews.
    expect(await readFile(join(state.storageRoot, chief.threadId, "plans", planner.threadId, "plan-2.md"), "utf8")).toBe(`${wave(2, "Migrate the data.")}\n`);
    expect(reported).toContain(`::inline-vis{source="thread-storage" file="plans/${planner.threadId}/plan-1.md"}`);
    expect(reported).not.toContain("chief_consult");
    expect(reported).toContain(`chief_forge_init (planThreadId: ${planner.threadId}, wave: 1)`);

    const persisted = state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planner.threadId) as { plan_waves: string };
    expect(JSON.parse(persisted.plan_waves)).toEqual([
      { path: path1, contracts: "- Totals stay non-negative", feature: false, reshape: false, title: "Plan" },
      { path: path2, contracts: "- Wave 2 keeps its invariant", feature: false, reshape: false, title: "Wave 2" },
      { path: path3, contracts: "- Wave 3 keeps its invariant", feature: false, reshape: false, title: "Wave 3" },
      { path: path4, contracts: "- Wave 4 keeps its invariant", feature: false, reshape: false, title: "Wave 4" },
    ]);
  });

  test("accepts a JSON-encoded wave array as a multi-wave plan", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready",
      result: "Two waves, JSON-encoded.",
      plan: JSON.stringify([
        { body: PLAN_FIXTURE },
        { body: wave(2, "Migrate the data.") },
        { body: wave(3) },
      ]),
    }, { threadId: planner.threadId, projectId: "proj_1" });

    const path1 = planFile(state, planner.threadId, 1);
    const path2 = planFile(state, planner.threadId, 2);
    const path3 = planFile(state, planner.threadId, 3);
    expect(await readFile(path1, "utf8")).toBe(`${PLAN_FIXTURE}\n`);
    expect(await readFile(path2, "utf8")).toBe(`${wave(2, "Migrate the data.")}\n`);
    await expect(readFile(join(dirname(path1), "plan.md"), "utf8")).rejects.toThrow();

    const reported = state.sent.at(-1).input[0].text;
    expect(reported).toContain("Plan: 3 wave(s)");

    const persisted = state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planner.threadId) as { plan_waves: string };
    expect(JSON.parse(persisted.plan_waves)).toEqual([
      { path: path1, contracts: "- Totals stay non-negative", feature: false, reshape: false, title: "Plan" },
      { path: path2, contracts: "- Wave 2 keeps its invariant", feature: false, reshape: false, title: "Wave 2" },
      { path: path3, contracts: "- Wave 3 keeps its invariant", feature: false, reshape: false, title: "Wave 3" },
    ]);
  });

  test("rejects a JSON-encoded wave array with an invalid wave", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;

    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready",
      result: "One bad wave, JSON-encoded.",
      plan: JSON.stringify([{ body: "" }]),
    }, { threadId: planner.threadId, projectId: "proj_1" })).rejects.toThrow(/plan wave 1 body is empty/);
  });

  test("every wave line survives the 3,000-char alert clip behind an 8-wave schedule and a near-limit result and recommendation", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const waves = Array.from({ length: 8 }, (_, index) => ({
      body: index === 0 ? PLAN_FIXTURE : wave(index + 1),
    }));

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready",
      result: "A".repeat(7_900),
      recommendation: "B".repeat(3_900),
      plan: waves,
    }, { threadId: planner.threadId, projectId: "proj_1" });

    const reported = state.sent.at(-1).input[0].text as string;
    expect(reported.length).toBeLessThanOrEqual(3_000);
    const lines = [...waves.keys()].map((index) => `::inline-vis{source="thread-storage" file="plans/${planner.threadId}/plan-${index + 1}.md"}`);
    for (const line of lines) expect(reported).toContain(line);
    expect(lines.map((line) => reported.indexOf(line))).toEqual([...lines.map((line) => reported.indexOf(line))].sort((a, b) => a - b));
    expect(reported).not.toMatch(/Wave \d of 8:/);
    expect(reported).not.toContain("chief_consult");
    expect(reported).toContain(planner.threadId);
    expect(reported).toContain(`chief_forge_init (planThreadId: ${planner.threadId}, wave: 1)`);
  });

  test("rejects a planner's ready report with more than 8 waves", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const tooManyWaves = Array.from({ length: 9 }, (_, index) => ({
      body: index === 0 ? PLAN_FIXTURE : wave(index + 1),
    }));

    const sentBefore = state.sent.length;

    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Nine waves", plan: tooManyWaves,
    }, { threadId: planner.threadId, projectId: "proj_1" })).rejects.toThrow("plan has 9 waves; max 8");
    expect(state.sent).toHaveLength(sentBefore);
  });

  test.each([
    ["rejects", "no wave has a What we're NOT doing section", [{ body: wave(1, "Do a thing.") }, { body: wave(2, "Do another thing.") }]],
    ["rejects", "What we're NOT doing appears only in prose", [{ body: wave(1, "We have not added a What we're NOT doing section to this plan.") }]],
    ["rejects", "What we are not doing follows a hash across a newline", [{ body: "# Plan\n#\nWhat we are not doing is documented elsewhere." }]],
    ["rejects", "a string plan's What we are not doing follows a hash across a newline", "# Plan\n#\nWhat we are not doing is documented elsewhere."],
    ["accepts", "What we are not doing is a markdown heading", [{ body: wave(1, "\n## What we are not doing\n- No extra scope.") }]],
  ])("%s a planner's ready report when %s", async (outcome, _name, plan) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const sentBefore = state.sent.length;

    const report = state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Scoped plan", plan,
    }, { threadId: planner.threadId, projectId: "proj_1" });

    if (outcome === "rejects") {
      await expect(report).rejects.toThrow(/NOT doing/);
      expect(state.sent).toHaveLength(sentBefore);
    } else {
      await report;
      expect(state.sent).toHaveLength(sentBefore + 1);
      expect(state.sent.at(-1).input[0].text).toContain(`chief_forge_init (planThreadId: ${planner.threadId}, wave: 1)`);
    }
  });

  test.each([
    ["rejects", "wave 2 has no Contracts to verify heading", [{ body: PLAN_FIXTURE }, { body: "# Wave 2\nWrite the code." }], /plan wave 2 lacks a "## Contracts to verify"/],
    ["rejects", "Contracts to verify is bold text", [{ body: "# Plan\n\n**Contracts to verify**\n- x\n\n## What we're NOT doing\n- x" }, { body: wave(2) }], /plan wave 1 lacks a "## Contracts to verify"/],
    ["rejects", "the Contracts to verify section is empty", [{ body: "# Plan\n\n## Contracts to verify\n\n## What we're NOT doing\n- x" }, { body: wave(2) }], /plan wave 1 lacks a "## Contracts to verify"/],
    ["accepts", "Contracts to verify is a ### heading", [{ body: "# Plan\n\n### Contracts to verify\n- x\n\n## What we're NOT doing\n- x" }], undefined],
  ])("%s a planner's ready report when %s", async (outcome, _name, plan, error) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const sentBefore = state.sent.length;

    const report = state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Scoped plan", plan,
    }, { threadId: planner.threadId, projectId: "proj_1" });
    if (outcome === "rejects") {
      await expect(report).rejects.toThrow(error!);
      expect(state.sent).toHaveLength(sentBefore);
    } else {
      await report;
      expect(state.sent).toHaveLength(sentBefore + 1);
    }
  });

  // Contract (wave 1, flag storage): an array plan stores each wave's feature and reshape as exact booleans (false by default); a raw string plan never reaches storage.
  // Catches: storing both flags false for every wave (a reported feature plan then loses its native-design check), swapping the two flags, or storing keys on a string plan.
  const plannerOf = async (state: Awaited<ReturnType<typeof setup>>, chiefId: string) => {
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"], { threadId: chiefId, projectId: "proj_1" });
    return (await status(state)).threads.find((row) => row.role === "planner")!;
  };
  const persistedWaves = (state: Awaited<ReturnType<typeof setup>>, plannerId: string) =>
    JSON.parse((state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(plannerId) as { plan_waves: string }).plan_waves);

  test("an array plan persists feature and reshape as booleans per wave, defaulting to false", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plannerOf(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Four waves",
      plan: [{ body: PLAN_FIXTURE, feature: true }, { body: wave(2), reshape: true }, { body: wave(3), feature: true, reshape: true }, { body: wave(4) }],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    expect(persistedWaves(state, planner.threadId)).toEqual([
      { path: planFile(state, planner.threadId, 1), contracts: "- Totals stay non-negative", feature: true, reshape: false, title: "Plan" },
      { path: planFile(state, planner.threadId, 2), contracts: "- Wave 2 keeps its invariant", feature: false, reshape: true, title: "Wave 2" },
      { path: planFile(state, planner.threadId, 3), contracts: "- Wave 3 keeps its invariant", feature: true, reshape: true, title: "Wave 3" },
      { path: planFile(state, planner.threadId, 4), contracts: "- Wave 4 keeps its invariant", feature: false, reshape: false, title: "Wave 4" },
    ]);
  });

  // A one-wave plan is valid: a raw string is one wave and a JSON-encoded array keeps its flags.
  test("a JSON-encoded array plan persists the same flags as an array, and a raw string plan stores one wave", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plannerOf(state, chief.threadId);
    const opts = { threadId: planner.threadId, projectId: "proj_1" };
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Two waves", plan: JSON.stringify([{ body: PLAN_FIXTURE, feature: true, reshape: true }, { body: wave(2) }]) }, opts);
    expect(persistedWaves(state, planner.threadId)).toMatchObject([{ feature: true, reshape: true }, { feature: false, reshape: false }]);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "One wave", plan: PLAN_FIXTURE }, opts);
    expect(persistedWaves(state, planner.threadId)).toEqual([{ path: join(dirname(planFile(state, planner.threadId, 1)), "plan.md"), contracts: "- Totals stay non-negative", title: "Plan" }]);
  });

  // The gate pins a pull request head, so the reviewed worker has a branch and a pull request the forge answers for.
  const FORGED = ["--branch", "feature/fix-checkout-totals", "--pr-url", "https://github.com/o/r/pull/7"];
  const forgeAnswers = () => execFileMock.mockResolvedValue({ stdout: ghHead("feature/fix-checkout-totals"), stderr: "" });

  // Contract (wave 1): the stored flags reach the reviewer: native-design line only for a feature wave, its reshape sentences only with a reshape wave, absent for explicit false.
  // The plan goes through the real report intake, the worker through delegation, and the prompt is the one chief_review launched.
  test.each([
    ["feature only", { feature: true }, "noReshape"],
    ["feature and reshape", { feature: true, reshape: true }, "full"],
    ["no flag on the wave (explicit false)", {}, null],
  ])("a plan wave with %s gives the reviewer the matching native-design line", async (_label, flags, line) => {
    forgeAnswers();
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const planner = await plannerOf(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Two waves", plan: [{ body: PLAN_FIXTURE, ...flags }] }, { threadId: planner.threadId, projectId: "proj_1" });
    const delegated = await state.harness.behavior.runCli(["delegate", "--title", "Fix checkout totals", "--mission", "Do it", "--plan-thread", planner.threadId, "--wave", "1", ...FORGED, "--json"], opts);
    const worker = JSON.parse(delegated.stdout!) as { threadId: string };
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done\n\n## Deviations from plan\nNone" }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    const prompt = state.spawned.filter((entry: any) => entry.title === "Review · Fix checkout totals").at(-1)!.prompt as string;
    const native = nativeLines();
    const lines = prompt.split("\n");
    // Exactly the expected native line renders, once; neither variant otherwise.
    for (const key of ["full", "noReshape"] as const) expect(lines.filter((l) => l === native[key])).toHaveLength(key === line ? 1 : 0);
  });

  test("a single-wave reviewer gets the Contracts to verify list even when the brief is clipped", async () => {
    forgeAnswers();
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"], opts);
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "One wave", plan: [{ body: PLAN_FIXTURE }],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    const delegated = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "M".repeat(5_000),
      "--plan-thread", planner.threadId, "--wave", "1", ...FORGED, "--json",
    ], opts);
    const worker = JSON.parse(delegated.stdout!) as { threadId: string };
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Wave 1 of 1 done.\n\n## Deviations from plan\nNone",
    }, { threadId: worker.threadId, projectId: "proj_1" });

    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    const reviewSpawn = state.spawned.filter((entry: any) => entry.title === "Review · Fix checkout totals").at(-1)!;
    expect(reviewSpawn.prompt).toContain("## Contracts to verify\n- Totals stay non-negative");
  });
});
