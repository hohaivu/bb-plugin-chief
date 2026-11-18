import { afterEach, describe, expect, test, vi } from "vitest";
import { type PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { approvePlan, completeWorker, configurationContext, delegate, disposeAll, planTwoWaves, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { CHIEF_HOST_ORDER, toolConfigFixture } from "./test/toolConfigFixture";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

describe("tool-call stability", () => {
  type Entry = { key: string; tools: string[]; skills: string[]; instructions: string | null | undefined };
  type Definition = { description: string; inputSchema: { required?: string[]; properties: Record<string, { description?: string }> } };
  type Fixture = { catalog: Record<string, Definition>; entries: Entry[] };
  let headFixture: Promise<Fixture> | undefined;
  const head = () => headFixture ??= toolConfigFixture().then((text) => JSON.parse(text) as Fixture);
  const preloadLine = (entry: Entry) => (entry.instructions ?? "").split("\n").filter((line) => line.includes("ToolSearch"));
  const claudeEntries = (fixture: Fixture) => fixture.entries.filter((entry) => entry.key.includes("| claude-code |"));
  const prefix = (name: string) => `mcp__bb-bridge__${name}`;
  type State = Awaited<ReturnType<typeof setup>>;
  const ctxOf = (state: State, chiefThreadId: string) => ({ threadId: chiefThreadId, projectId: state.live.get(chiefThreadId)!.projectId });
  const claudeContext = (threadId: string, name?: string): PluginAgentConfigurationContext => {
    const base = configurationContext(threadId, "proj_1", name);
    return { ...base, provider: { ...base.provider, id: "claude-code" } };
  };

  test("the claude-code preload line follows configured.tools for every role, planner and research toggle", async () => {
    const entries = claudeEntries(await head()).filter((entry) => entry.tools.length);
    expect(entries.length).toBeGreaterThan(40);
    for (const entry of entries) {
      const [line] = preloadLine(entry);
      expect(preloadLine(entry), entry.key).toHaveLength(1);
      if (entry.key.includes("| chief |")) {
        // Chief: the host's selected order (pinned), each name once, the same set as the returned tools; the SDK's registration order is not asserted.
        const names = line!.split("ToolSearch call: select:")[1]!.split(",");
        expect(new Set(names).size, entry.key).toBe(names.length);
        expect([...names].sort(), entry.key).toEqual(entry.tools.map(prefix).sort());
        expect(names, entry.key).toEqual(CHIEF_HOST_ORDER.filter((name) => entry.tools.includes(name)).map(prefix));
        expect(line, entry.key).not.toMatch(/\+chief|max_results/);
      } else expect(line!.endsWith(`select:${entry.tools.map(prefix).join(",")}`), entry.key).toBe(true);
    }
    // The toggles reach the tool list, so the comparison above is not vacuous.
    const chiefTools = entries.filter((entry) => entry.key.startsWith("short rules | chief")).map((entry) => entry.tools.length);
    expect(new Set(chiefTools).size).toBeGreaterThan(2);
    expect(entries.find((entry) => entry.key.startsWith("short rules | plan worker"))!.tools).toContain("chief_log");
    expect(entries.find((entry) => entry.key.startsWith("short rules | worker"))!.tools).not.toContain("chief_log");
  });

  // Contract: line position. Managed roles: before research, project rules and lessons (third line). Chief: right after the
  // first line, before the roster instruction.
  test("the preload line comes before research, project rules and lessons, and before Chief's roster instruction", async () => {
    const entries = claudeEntries(await head()).filter((entry) => entry.key.startsWith("short rules") && entry.tools.length);
    for (const entry of entries) {
      const lines = entry.instructions!.split("\n");
      const at = lines.findIndex((line) => line.includes("ToolSearch"));
      const after = (text: string) => lines.findIndex((line) => line.includes(text));
      if (entry.key.includes("| chief |")) {
        expect(at, entry.key).toBe(1);
        expect(at, entry.key).toBeLessThan(after("Call chief_roster at the start of every turn"));
        if (entry.key.includes("research true")) expect(after("Use chief_research"), entry.key).toBeGreaterThan(at);
        continue;
      }
      expect(at, entry.key).toBe(2);
      expect(after("# Project rules marker"), entry.key).toBeGreaterThan(at);
      expect(after("## Lessons from earlier review rounds"), entry.key).toBeGreaterThan(at);
      // A planner and a researcher have no chief_research and no research line, whatever the switch says.
      if (entry.key.includes("| planner |") || entry.key.includes("| researcher |")) expect(entry.instructions, entry.key).not.toContain("chief_research");
    }
    // The lines under test exist: Chief with research on has its research line after the preload line, and a reviewer shows its review lessons.
    expect(entries.find((entry) => entry.key.includes("| chief | claude-code | planner true | research true"))!.instructions).toContain("Use chief_research");
    expect(entries.some((entry) => entry.key.includes("| planner | claude-code | planner true | research true"))).toBe(true);
    expect(entries.find((entry) => entry.key.includes("| reviewer |"))!.instructions).toContain("## Review lessons");
  });

  // Contract: never emitted for non-Claude providers.
  test("no codex configuration carries a ToolSearch line", async () => {
    const codex = (await head()).entries.filter((entry) => entry.key.includes("| codex |") && entry.tools.length);
    expect(codex.length).toBeGreaterThan(40);
    for (const entry of codex) expect(entry.instructions, entry.key).not.toContain("ToolSearch");
  });

  // Contract: never emitted where meaningless. Real rows reach complete, archived and deleted through the real flows.
  // Regression: a line (or tools) for a finished thread, or for a thread with no role.
  test.each(["complete", "archived", "deleted"] as const)("a %s row and a role-less thread get no tools and no preload line on claude-code", async (finished) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const live = () => ({ ...state.live.get(worker.threadId)!, status: "idle" as const });
    const before = await state.harness.behavior.resolveAgentConfiguration(claudeContext(worker.threadId));
    expect(before.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(before.instructions).toContain("ToolSearch");
    if (finished === "complete") await completeWorker(state, chief.threadId, worker.threadId);
    else if (finished === "archived") await state.harness.behavior.emitThreadEvent("thread.archived", { thread: { ...live(), archivedAt: 1 } });
    else await state.harness.behavior.emitThreadEvent("thread.deleted", { thread: { ...live(), deletedAt: 1 } });
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)!.state).toBe(finished);
    const after = await state.harness.behavior.resolveAgentConfiguration(claudeContext(worker.threadId));
    expect(after.tools).toEqual([]);
    expect(after.skills).toEqual([]);
    expect(after.instructions ?? "").not.toContain("ToolSearch");
    const roleless = await state.harness.behavior.resolveAgentConfiguration(claudeContext("thr_other"));
    expect(roleless.tools).toEqual([]);
    expect(roleless.instructions ?? "").not.toContain("ToolSearch");
  });

  // Contract: Chief budget on claude-code. Same worst-case inputs as the oracle above, against the SDK cap of 32768.
  // Regression: the preload line pushes a core rule past the cut, or pushes project rules ahead of the core.
  test.each([[5_000, 4], [32_000, 4], [5_000, 5_000]])("claude-code: a %i-char chief.md and a %i-char project name keep the preload line and Chief's core rules inside the 32768-char cut", async (size, nameLength) => {
    const marker = "# Project rules marker";
    const state = await setup({ rules: `${marker}\n${"- Project rule text.\n".repeat(Math.ceil(size / 21))}`.slice(0, size) });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: true });
    const chief = await start(state);
    const { instructions, tools } = await state.harness.behavior.resolveAgentConfiguration(claudeContext(chief.threadId, "N".repeat(nameLength)));
    expect(tools.map((tool) => tool.name)).toContain("chief_plan");
    expect(tools.map((tool) => tool.name)).toContain("chief_research");
    // Only the 32,000-char chief.md reaches the SDK cap, so it still exercises the cut; the 5,000-char cases fit uncut.
    if (size === 32_000) expect(instructions!.length).toBe(32768);
    else expect(instructions!.length).toBeLessThanOrEqual(32768);
    const coreEnd = instructions!.indexOf("chief_escalate with the thread and the full request");
    expect(coreEnd).toBeGreaterThan(-1);
    expect(instructions!.indexOf(`ToolSearch call: select:${CHIEF_HOST_ORDER.filter((name) => tools.some((tool) => tool.name === name)).map(prefix).join(",")}`)).toBeGreaterThan(-1);
    expect(instructions).not.toMatch(/\+chief|max_results/);
    expect(instructions!.indexOf("ToolSearch")).toBeLessThan(instructions!.indexOf("Call chief_roster at the start of every turn"));
    for (const part of [
      "# Chief core rules (always apply)", "Call chief_roster at the start of every turn", "never poll managed threads",
      "chief_plan first", "delegate every wave it lists right away",
      "chief_research is optional.", "or the doubtful evidence to chief_review.",
      "Small, low-risk changes suit a skip.", "Chief never edits code",
    ]) expect(instructions).toContain(part);
    expect(instructions!.indexOf(marker)).toBeGreaterThan(coreEnd);
  });

  // Contract (docs/specs/tool-call-stability.md, "No Provider Environment"): the plugin registers no experimental_contributeEnv handler, so it contributes no provider
  // environment for any thread. The host merges contributions from other plugins (account-pool contributes ENABLE_TOOL_SEARCH); this test proves only what this plugin contributes.
  // Regression: a contribution again for a Chief row, a managed row, an unmanaged thread, a thread with no id, a thread still seeded before insertThread, or another provider; or ever forcing `true`.
  test("the plugin contributes no provider environment for any role, unmanaged thread, missing thread id, seeded pre-insertThread thread or provider", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = ctxOf(state, chief.threadId);
    const worker = await delegate(state, chief.threadId);
    const tester = await delegate(state, chief.threadId, "Tests for totals", { replaces: worker.threadId, kind: "tester" });
    const designer = await delegate(state, chief.threadId, "Design totals", { kind: "designer" });
    const specWriter = await delegate(state, chief.threadId, "Spec totals", { kind: "spec-writer" });
    // A two-wave plan with its one advisor review: the planner and advisor rows.
    const { planner } = await planTwoWaves(state, chief.threadId);
    await approvePlan(state, chief.threadId, planner.threadId);
    await state.harness.behavior.callAgentTool("chief_review", { branch: "feature/x" }, opts);
    // Chief's chief_research spawns a real researcher row pinned to Chief's own provider and model.
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    await state.harness.behavior.callAgentTool("chief_research", { question: "Who calls this?", design: false }, opts);
    const spawned = await state.harness.behavior.callAgentTool("chief_spawn", { request: "Do the task", context: "Goal and evidence" }, opts);
    const child = /in thread (thr_\w+)/.exec(String(spawned))![1]!;
    const rows = (await status(state)).threads;
    expect([...new Set(rows.map((row) => row.role))].sort()).toEqual(["advisor", "chief", "planner", "researcher", "reviewer", "worker"]);
    const env = (providerId: string, threadId: string) => state.harness.behavior.resolveProviderEnv(providerId, { threadId, projectId: "proj_1", hostId: "host_1" });
    const chiefIds = new Set([chief.threadId, child]);
    expect(rows.filter((row) => row.role === "chief").map((row) => row.threadId).sort()).toEqual([...chiefIds].sort());
    for (const id of [worker.threadId, tester.threadId, designer.threadId, specWriter.threadId]) expect(rows.map((row) => row.threadId)).toContain(id);
    // A thread seeded as a Chief by this plugin whose row insertThread has not written yet.
    state.addLive("thr_seeded_chief", "proj_1", "Chief · seeded", "chief");
    state.seedPluginMetadata("thr_seeded_chief", { role: "chief" });
    expect(rows.map((row) => row.threadId)).not.toContain("thr_seeded_chief");
    for (const threadId of [...rows.map((row) => row.threadId), "thr_seeded_chief", "thr_other"]) {
      for (const providerId of ["claude-code", "codex", "other-provider"]) expect(await env(providerId, threadId), `${providerId} ${threadId}`).toEqual([]);
    }
    for (const providerId of ["claude-code", "codex"]) expect(await state.harness.behavior.resolveProviderEnv(providerId, { projectId: "proj_1", hostId: "host_1" } as any), providerId).toEqual([]);
  });

  // Contract: title default on the tool path. Each tool names its thread differently; the default line is the same.
  // Regression: the whole mission (or a CR) in the title, no clip at 160, or an explicit title replaced by the default.
  const FIRST_160 = `${"a".repeat(80)} ${"b".repeat(79)}`;
  const FIRST_200 = `${"a".repeat(100)} ${"b".repeat(99)}`;
  const titleCases: [string, string, string][] = [
    ["its first line", "Fix totals", "Fix totals"],
    ["line 1 of a multi-line source", "Fix totals\nSecond line\nThird line", "Fix totals"],
    ["a CRLF line ending trimmed", "Fix totals\r\nSecond line", "Fix totals"],
    ["a 160-character first line kept", `${FIRST_160}\nmore`, FIRST_160],
    ["a 200-character first line clipped to 160 with an ellipsis", `${FIRST_200}\nmore`, `${FIRST_200.slice(0, 159)}…`],
  ];
  const titleTools: [string, string, (line: string) => string, (source: string, title?: string, planThreadId?: string) => object][] = [
    ["chief_delegate", "worker thread", (line) => line, (mission, title) => ({ mission, unplannedReason: "Bounded test fixture", ...(title ? { title } : {}) })],
    ["chief_plan", "Plan ·", (line) => `Plan · ${line}`, (mission, title) => ({ mission, undesignedReason: "small fix", ...(title ? { title } : {}) })],
    ["chief_consult", "Consult ·", (line) => `Consult · ${line}`, (mission, title, planThreadId) => ({ mission, planThreadId, ...(title ? { title } : {}) })],
    ["chief_spawn", "Chief ·", (line) => `Chief · Asha · ${line}`, (request, title) => ({ request, context: "Goal and evidence", ...(title ? { title } : {}) })],
  ];
  // chief_consult reviews a plan only: it needs a two-wave plan, whose planner it names.
  const planFor = async (state: State, name: string, chiefThreadId: string) => (name === "chief_consult" ? (await planTwoWaves(state, chiefThreadId)).planner.threadId : undefined);
  describe.each(titleTools)("%s title default", (name, _shape, expected, params) => {
    test.each(titleCases)("%s", async (_label, source, line) => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      expect(line.length).toBeLessThanOrEqual(160);
      await state.harness.behavior.callAgentTool(name, params(source, undefined, await planFor(state, name, chief.threadId)), ctxOf(state, chief.threadId));
      expect(state.spawned.at(-1).title).toBe(expected(line));
    });

    test("an explicit title is kept", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      await state.harness.behavior.callAgentTool(name, params("The mission line\nmore", "Explicit title", await planFor(state, name, chief.threadId)), ctxOf(state, chief.threadId));
      expect(state.spawned.at(-1).title).toBe(expected("Explicit title"));
    });
  });

  // Contract: title default on the CLI path, for delegate, plan and consult (spawn has no CLI command).
  test.each([
    ["delegate", ["--unplanned-reason", "Bounded test fixture"], (line: string) => line],
    ["plan", ["--undesigned-reason", "small fix"], (line: string) => `Plan · ${line}`],
    ["consult", [], (line: string) => `Consult · ${line}`],
  ])("CLI %s without --title defaults it from the mission's first line", async (command, extra, expected) => {
    // One state per call: a plan gets its one advisor review, so a second consult on the same plan is refused.
    const attempt = async (title: string[], mission: string, spawnedTitle: string) => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const plan = command === "consult" ? ["--plan-thread", (await planTwoWaves(state, chief.threadId)).planner.threadId] : [];
      const run = await state.harness.behavior.runCli([command!, ...title, "--mission", mission, ...(extra as string[]), ...plan, "--json"], ctxOf(state, chief.threadId));
      expect(run.exitCode, run.stderr).toBe(0);
      expect(state.spawned.at(-1).title).toBe(spawnedTitle);
    };
    await attempt([], "Fix totals\r\nSecond line", expected("Fix totals"));
    await attempt([], `${FIRST_160}\nmore`, expected(FIRST_160));
    await attempt([], `${FIRST_200}\nmore`, expected(`${FIRST_200.slice(0, 159)}…`));
    await attempt(["--title", "Explicit title"], "Fix totals", expected("Explicit title"));
  });

  // Contract: strictness kept on all four schemas. The title default relaxes only a missing title.
  // Regression: a transform that clips or defaults an invalid explicit title, or one that loosens mission, request or the delegate refusal.
  describe.each(titleTools)("%s strictness", (name, _shape, _expected, params) => {
    const mission = name === "chief_spawn" ? "request" : "mission";
    test.each([["an empty title", ""], ["a whitespace-only title", "   "], ["a null title", null], ["a 161-character title", "t".repeat(161)]])("refuses %s", async (_label, title) => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const input = params("Fix totals", undefined, await planFor(state, name, chief.threadId));
      const spawned = state.spawned.length;
      await expect(state.harness.behavior.callAgentTool(name, { ...input, title }, ctxOf(state, chief.threadId))).rejects.toThrow(/arguments are invalid/);
      expect(state.spawned.length).toBe(spawned);
    });

    test("refuses a missing or empty " + mission, async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const { [mission]: _omitted, ...without } = params("Fix totals", undefined, await planFor(state, name, chief.threadId)) as Record<string, unknown>;
      for (const input of [without, { ...without, [mission]: "   " }, { ...without, title: "Explicit title" }]) {
        await expect(state.harness.behavior.callAgentTool(name, input, ctxOf(state, chief.threadId))).rejects.toThrow(/arguments are invalid/);
      }
    });

    test("advertises title as optional and " + mission + " as required", async () => {
      const { catalog } = await head();
      expect(catalog[name]!.inputSchema.required).not.toContain("title");
      expect(catalog[name]!.inputSchema.required).toContain(mission);
    });
  });

  test("chief_delegate still refuses unplannedReason combined with planThreadId, and chief_forge_init still requires its title", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = ctxOf(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_delegate", { mission: "Fix totals", unplannedReason: "Bounded", planThreadId: "thr_plan", wave: 1 }, opts)).rejects.toThrow(/unplannedReason cannot be combined with planThreadId/);
    await expect(state.harness.behavior.callAgentTool("chief_forge_init", { mission: "Correct and verify totals", successCriteria: "Regression passes" }, opts)).rejects.toThrow(/arguments are invalid/);
    expect((await head()).catalog.chief_forge_init!.inputSchema.required).toContain("title");
  });

  // Contract (plan-1 steps 6-7, plan-2 step 3): the test-skip tool and CLI command are gone; the review gate's tools remain with their documented params.
  // Regression: chief_skip_tests is registered again for any role or provider, or `skip-tests` is a CLI command again.
  test("the tool surface has no chief_skip_tests and no skip-tests command; the gate tools keep their documented params", async () => {
    const { catalog, entries } = await head();
    expect(Object.keys(catalog)).not.toContain("chief_skip_tests");
    for (const entry of entries) expect(entry.tools, entry.key).not.toContain("chief_skip_tests");
    for (const name of ["chief_review", "chief_complete", "chief_delegate", "chief_consult"]) expect(Object.keys(catalog), name).toContain(name);
    const fields = (name: string) => Object.keys(catalog[name]!.inputSchema.properties);
    expect(fields("chief_complete")).toEqual(expect.arrayContaining(["threadId", "skipReview", "override"]));
    expect(fields("chief_review")).toEqual(expect.arrayContaining(["workerThreadId", "focus", "acceptedGaps"]));
    expect(fields("chief_consult")).toContain("planThreadId");
    expect(catalog["chief_consult"]!.inputSchema.required).toContain("planThreadId");
    const state = await setup();
    const chief = await start(state);
    const opts = ctxOf(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_skip_tests", { planThreadId: "thr_x", wave: 2, reason: "r" }, opts)).rejects.toThrow(/no agent tool "chief_skip_tests"/);
    const cli = await state.harness.behavior.runCli(["skip-tests", "--plan-thread", "thr_x", "--wave", "2", "--reason", "r"], opts);
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toContain("Unknown command “skip-tests”");
  });

  // Contract (plan-4 step F): chief_complete accepts override (a reason, no gate needed) and skipReview.
  // Regression: either param is refused or ignored.
  test.each(["override", "skipReview"] as const)("chief_complete accepts %s on a ready worker", async (field) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done\n\n## Deviations from plan\nNone" }, { threadId: worker.threadId, projectId: "proj_1" });
    const text = await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, [field]: "reviewed elsewhere" }, ctxOf(state, chief.threadId)) as string;
    expect(text).toMatch(/^Marked “Fix checkout totals” complete/);
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)!.state).toBe("complete");
  });
});
