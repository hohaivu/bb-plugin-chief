import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import plugin from "./server";
import { completeWorker, configurationContext, delegate, disposeAll, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { ATTACH_DEFINITION, acceptCoreRuleTrim, acceptPlanningLine, acceptRetestDelta, acceptSpecLaneWording, assertSpecLaneWording } from "./test/specLaneWording";
import { acceptReviewerToolDelta } from "./test/reviewerToolDelta";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// ---- Tool-call stability (plan thr_g9mqzq4cy9, wave 2): preload line, provider env, optional title ----
// Contract: tool-config oracle. The block below was run unchanged against base 7178582 to capture
// test/fixtures/tool-config-7178582.txt; only the storage root is normalized. It builds every role's configuration
// for providers codex and claude-code, planner and research on and off, plus Chief's worst case (a 32,000-char chief.md
// and a 5,000-char project name). Non-chief roles use the seeded-metadata path with fixed ids; Chief has a real row.
// <tool-config-oracle-fixture>
const toolConfigFixture = async () => {
  const entries: { key: string; tools: string[]; skills: string[]; instructions: string | null | undefined }[] = [];
  const catalog: Record<string, unknown> = {};
  const roots: string[] = [];
  const marker = "# Project rules marker";
  const cases = [
    { label: "short rules", rules: `${marker}\n- Keep rules small.`, name: "Asha", chiefOnly: false },
    { label: "worst case", rules: `${marker}\n${"- Project rule text.\n".repeat(1_600)}`.slice(0, 32_000), name: "N".repeat(5_000), chiefOnly: true },
  ];
  for (const { label, rules, name, chiefOnly } of cases) {
    const state = await setup({ rules });
    roots.push(state.storageRoot);
    const chief = await start(state);
    const lesson = state.db.prepare("INSERT INTO chief_lessons (project_id, text, source_thread_id, at, role) VALUES ('proj_1', ?, ?, ?, ?)");
    lesson.run("Lesson for every role.", chief.threadId, 1, null);
    lesson.run("Lesson for reviewers.", chief.threadId, 2, "reviewer");
    const seeded = (role: string, extra: object = {}) => ({ role, chiefThreadId: chief.threadId, ...extra });
    const roles: [string, string, object | undefined][] = [
      ["chief", chief.threadId, undefined],
      ...(chiefOnly ? [] : [
        ["worker", "thr_seed_worker", seeded("worker")],
        ["plan worker", "thr_seed_plan_worker", seeded("worker", { planThreadId: "thr_seed_plan" })],
        ["designer", "thr_seed_designer", seeded("worker", { kind: "designer" })],
        ["tester", "thr_seed_tester", seeded("worker", { kind: "tester" })],
        ["spec-writer", "thr_seed_spec_writer", seeded("worker", { kind: "spec-writer" })],
        ["reviewer", "thr_seed_reviewer", seeded("reviewer")],
        ["planner", "thr_seed_planner", seeded("planner")],
        ["researcher", "thr_seed_researcher", seeded("researcher")],
        ["advisor", "thr_seed_advisor", seeded("advisor")],
      ] as [string, string, object][]),
    ];
    for (const provider of ["codex", "claude-code"]) for (const planner of [true, false]) for (const research of [true, false]) {
      await state.harness.behavior.setSettings({ plannerEnabled: planner });
      await state.harness.behavior.callRpc("setResearchSettings", { enabled: research });
      for (const [role, id, pluginMetadata] of roles) {
        const base = configurationContext(id, "proj_1", name);
        const configured = await state.harness.behavior.resolveAgentConfiguration({ ...base, provider: { ...base.provider, id: provider }, ...(pluginMetadata ? { pluginMetadata } : {}) });
        for (const tool of configured.tools as any[]) {
          const definition = { description: tool.description, inputSchema: tool.inputSchema };
          if (JSON.stringify(catalog[tool.name] ?? definition) !== JSON.stringify(definition)) throw new Error(`${tool.name} differs between configurations`);
          catalog[tool.name] = definition;
        }
        entries.push({ key: `${label} | ${role} | ${provider} | planner ${planner} | research ${research}`, tools: configured.tools.map((tool: any) => tool.name), skills: configured.skills, instructions: configured.instructions });
      }
    }
  }
  return roots.reduce((text, root) => text.replaceAll(root, "<storage>"), JSON.stringify({ catalog, entries }, null, 1));
};
// </tool-config-oracle-fixture>

describe("tool-call stability", () => {
  type Entry = { key: string; tools: string[]; skills: string[]; instructions: string | null | undefined };
  type Definition = { description: string; inputSchema: { required?: string[]; properties: Record<string, { description?: string }> } };
  type Fixture = { catalog: Record<string, Definition>; entries: Entry[] };
  const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "tool-config-7178582.txt");
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

  // Contract: non-Claude preservation and Claude preservation, against base 7178582 through resolveAgentConfiguration.
  // Allowed differences: (a) title leaves `required` and gets a new description on chief_delegate/plan/consult/spawn;
  // (b) claude-code: the one preload line; (c) everything else, including every codex instruction, is identical; (e) chief_escalate
  // gains the optional boolean `merge` (tracker spec), the only schema change of that feature; (i) a plain Chief also gets chief_attach right after chief_coordinate (#213); (g) Chief's four trimmed core rules (acceptCoreRuleTrim);
  // (h) the SDK instruction cap moved from 4096 to 32768 (SDK 0.6.132), so a base text cut at 4096 is a prefix of the head text.
  // Regression: any stray change to tool selection or order, to a tool schema, to codex instructions or to claude instructions.
  test("tool-config oracle: head equals base 7178582 apart from the title schema, chief_escalate's optional merge field and the claude-code preload line", async () => {
    const base = JSON.parse(await readFile(snapshotPath, "utf8")) as Fixture;
    const full = await head();
    // Allowed difference (d): Chief alone gets chief_sync (PR 183). Checked here, then dropped so the rest still compares against base.
    expect(Object.keys(full.catalog)).toContain("chief_sync");
    for (const entry of full.entries) expect(entry.tools.includes("chief_sync"), entry.key).toBe(entry.key.includes("| chief |"));
    const now: Fixture = {
      catalog: Object.fromEntries(Object.entries(full.catalog).filter(([name]) => name !== "chief_sync")),
      entries: full.entries.map((entry) => ({ ...entry, tools: entry.tools.filter((name) => name !== "chief_sync") })),
    };
    // Allowed difference (e): chief_escalate gains the optional boolean `merge` (tracker spec). Checked here, then dropped so the rest still compares against base.
    const escalate = now.catalog["chief_escalate"]!;
    expect(escalate.inputSchema.properties.merge).toMatchObject({ type: "boolean" });
    expect(escalate.inputSchema.required ?? []).not.toContain("merge");
    delete escalate.inputSchema.properties.merge;
    // Allowed difference (f), Coordinator spec COORD-2/5/6/9: a plain Chief gains chief_coordinate (right after chief_spawn) and the coordinator skill;
    // chief_spawn gains the optional projectId; chief_escalate's threadId becomes optional with one more description sentence.
    // Each is checked exactly here, then dropped so the rest still compares against base.
    expect(now.catalog["chief_coordinate"]).toBeDefined();
    delete now.catalog["chief_coordinate"];
    // Allowed difference (i), #213: a plain Chief also gains chief_attach right after chief_coordinate; its definition is asserted in full, then dropped.
    expect(now.catalog["chief_attach"]).toEqual(ATTACH_DEFINITION);
    delete now.catalog["chief_attach"];
    for (const entry of now.entries) {
      const plainChief = entry.key.includes("| chief |");
      expect(entry.tools.includes("chief_coordinate"), entry.key).toBe(plainChief);
      expect(entry.tools.includes("chief_attach"), entry.key).toBe(plainChief);
      if (!plainChief) continue;
      expect(entry.tools[entry.tools.indexOf("chief_spawn") + 1], entry.key).toBe("chief_coordinate");
      expect(entry.tools[entry.tools.indexOf("chief_coordinate") + 1], entry.key).toBe("chief_attach");
      expect(entry.skills, entry.key).toEqual(["chief", "coordinator"]);
      entry.tools = entry.tools.filter((name) => name !== "chief_coordinate" && name !== "chief_attach");
      entry.skills = ["chief"];
    }
    const projectId = now.catalog["chief_spawn"]!.inputSchema.properties.projectId as { type?: string; description?: string };
    expect(projectId.description).toBe("Coordinator only: the project the new Chief works in. Defaults to your own project.");
    expect(now.catalog["chief_spawn"]!.inputSchema.required ?? []).not.toContain("projectId");
    delete now.catalog["chief_spawn"]!.inputSchema.properties.projectId;
    const ESCALATE_SENTENCE = " Omit threadId only when no managed thread concerns the request yet.";
    expect(base.catalog["chief_escalate"]!.inputSchema.required).toContain("threadId");
    expect(escalate.inputSchema.required).toEqual(base.catalog["chief_escalate"]!.inputSchema.required!.filter((field) => field !== "threadId"));
    escalate.inputSchema.required = base.catalog["chief_escalate"]!.inputSchema.required;
    expect(escalate.description.endsWith(ESCALATE_SENTENCE)).toBe(true);
    escalate.description = escalate.description.slice(0, -ESCALATE_SENTENCE.length);
    expect(now.entries.map((entry) => entry.key)).toEqual(base.entries.map((entry) => entry.key));
    expect(Object.keys(now.catalog)).toEqual(Object.keys(base.catalog));

    const titleTools = ["chief_delegate", "chief_plan", "chief_consult", "chief_spawn"];
    // Allowed difference (a): the full new text, checked per tool before the description is dropped for the remainder comparison.
    const MISSION_TITLE = "Exact concise title for the worker thread. Optional: defaults to the first line of mission, clipped to 160 characters.";
    const SPAWN_TITLE = "A literal task label, used in the new Chief's thread title. Optional: defaults to the first line of request, clipped to 160 characters.";
    for (const [name, definition] of Object.entries(now.catalog)) {
      // Plan 2 contract 6: the Spec Writer wording moved; asserted, then restored to base so the rest still compares.
      // Reviewer-prompt wave: chief_review's focus/acceptedGaps and chief_report's plan flags; asserted, then restored to base (before the wording restore below rewrites the plan text).
      acceptReviewerToolDelta(definition, base.catalog[name], name);
      acceptSpecLaneWording(definition, base.catalog[name], name);
      // Retest debt: chief_review gains the optional retestSkipped field and a description sentence; asserted, then restored to base.
      acceptRetestDelta(definition, base.catalog[name], name);
      if (!titleTools.includes(name)) { expect(definition, name).toEqual(base.catalog[name]); continue; }
      const old = structuredClone(base.catalog[name]!);
      const next = structuredClone(definition);
      expect(old.inputSchema.required, name).toContain("title");
      expect(next.inputSchema.required, name).not.toContain("title");
      expect(next.inputSchema.required, name).toContain(name === "chief_spawn" ? "request" : "mission");
      expect(next.inputSchema.properties.title!.description, name).toBe(name === "chief_spawn" ? SPAWN_TITLE : MISSION_TITLE);
      old.inputSchema.required = old.inputSchema.required!.filter((field) => field !== "title");
      delete old.inputSchema.properties.title!.description;
      delete next.inputSchema.properties.title!.description;
      expect(next, name).toEqual(old);
    }

    let cut = 0;
    const OLD_CAP = 4096;
    const NEW_CAP = 32768;
    now.entries.forEach((entry, index) => {
      const old = base.entries[index]!;
      expect(entry.tools, entry.key).toEqual(old.tools);
      expect(entry.skills, entry.key).toEqual(old.skills);
      expect(preloadLine(old), entry.key).toEqual([]);
      // Allowed differences (g) and (h): the core-rule trims and the planning line are undone with their own wording checks, so any other byte still fails.
      const accepted = (text: string) => (entry.key.includes("| chief |") && old.instructions ? acceptPlanningLine(acceptCoreRuleTrim(text, old.instructions), old.instructions) : text);
      const withoutPreload = (text: string) => text.split("\n").filter((line) => !line.includes("ToolSearch")).join("\n");
      const preloaded = entry.key.includes("| claude-code |") && entry.tools.length > 0;
      if (preloaded) {
        expect(preloadLine(entry), entry.key).toHaveLength(1);
        // Allowed differences (d), (f) and (i): the base snapshot predates chief_sync; a plain Chief's preload asks for chief_sync, chief_coordinate and chief_attach on top of it.
        if (entry.key.includes("| chief |")) expect(preloadLine(entry)[0], entry.key).toMatch(new RegExp(`max_results ${old.tools.length + 3}$`));
      }
      if (!entry.instructions || !old.instructions) { expect(entry.instructions, entry.key).toBe(old.instructions); return; }
      const restored = accepted(preloaded ? withoutPreload(entry.instructions) : entry.instructions);
      if (old.instructions.length < OLD_CAP) expect(restored, entry.key).toBe(old.instructions);
      else {
        // The base text was cut at the old cap and the head text at the new one: the base is a prefix of the head, so a cut that eats Chief's rules still fails.
        cut += 1;
        expect(old.instructions.length, entry.key).toBe(OLD_CAP);
        expect(entry.instructions.length, entry.key).toBe(NEW_CAP);
        expect(restored.startsWith(old.instructions), entry.key).toBe(true);
      }
    });
    // Only Chief's worst case reaches the cut, and it does so for every planner and research combination.
    expect(cut).toBeGreaterThan(0);
    expect(now.entries.filter((entry) => (entry.instructions ?? "").length === NEW_CAP).every((entry) => entry.key.startsWith("worst case | chief"))).toBe(true);
    expect(now.entries.every((entry) => (entry.instructions ?? "").length <= NEW_CAP)).toBe(true);
  });

  // Contract: no drift. The expected line is rebuilt from each entry's own configured tool names.
  // Regression: a hard-coded or stale tool list in the line, or a line built before the tools were chosen.
  // Plan 2 contract 6 (Chief-facing tool texts): the Spec Writer runs beside its worker in a side worktree and a side writer completes.
  // The tool-config oracle also checks this, but only after its other comparisons pass; this test stands alone.
  // Regression: a tool text again says the Spec Writer runs first, shares one worktree, or is never completed.
  test("Chief's tool descriptions describe the parallel Spec Writer side lane", async () => {
    const state = await setup();
    const chief = await start(state);
    const base = configurationContext(chief.threadId, "proj_1", "Asha");
    // Chief's tools, plus chief_report, which only a managed planner holds.
    const tools = [
      ...(await state.harness.behavior.resolveAgentConfiguration({ ...base, provider: { ...base.provider, id: "codex" } })).tools as any[],
      ...(await state.harness.behavior.resolveAgentConfiguration({ ...configurationContext("thr_seed_planner", "proj_1", "Asha"), provider: { ...base.provider, id: "codex" }, pluginMetadata: { role: "planner", chiefThreadId: chief.threadId } })).tools as any[],
    ];
    const catalog = Object.fromEntries(tools.map((tool) => [tool.name, { description: tool.description, inputSchema: tool.inputSchema }]));
    assertSpecLaneWording(catalog);
    expect(JSON.stringify(catalog)).not.toMatch(/Spec Writer runs first|runs its Spec Writer before|its worker runs first|before its worker|never completed|is never completed/);
    expect(catalog["chief_skip_specs"]!.description).toContain("once a Spec Writer was delegated on it");
  });

  test("the claude-code preload line follows configured.tools for every role, planner and research toggle", async () => {
    const entries = claudeEntries(await head()).filter((entry) => entry.tools.length);
    expect(entries.length).toBeGreaterThan(40);
    for (const entry of entries) {
      const [line] = preloadLine(entry);
      expect(preloadLine(entry), entry.key).toHaveLength(1);
      if (entry.key.includes("| chief |")) expect(line!.endsWith(`query "+chief", max_results ${entry.tools.length}`), entry.key).toBe(true);
      else expect(line!.endsWith(`select:${entry.tools.map(prefix).join(",")}`), entry.key).toBe(true);
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
        continue;
      }
      expect(at, entry.key).toBe(2);
      expect(after("# Project rules marker"), entry.key).toBeGreaterThan(at);
      expect(after("## Lessons from earlier review rounds"), entry.key).toBeGreaterThan(at);
      if (entry.key.includes("research true") && (entry.key.includes("| planner |") || entry.key.includes("| researcher |"))) {
        const research = after("Use chief_research");
        if (research !== -1) expect(research, entry.key).toBeGreaterThan(at);
      }
    }
    // The lines under test exist: a planner with research on has a research line, and a reviewer shows its review lessons.
    expect(entries.find((entry) => entry.key.includes("| planner | claude-code | planner true | research true"))!.instructions).toContain("Use chief_research");
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
    expect(instructions!.indexOf(`max_results ${tools.length}`)).toBeGreaterThan(-1);
    expect(instructions!.indexOf("ToolSearch")).toBeLessThan(instructions!.indexOf("Call chief_roster at the start of every turn"));
    for (const part of [
      "# Chief core rules (always apply)", "Call chief_roster at the start of every turn", "never poll managed threads",
      "chief_plan first", "delegate every wave it lists right away",
      "chief_research is optional.", "or the doubtful evidence to chief_review.",
      "Small, low-risk changes suit a skip.", "Chief never edits code",
    ]) expect(instructions).toContain(part);
    expect(instructions!.indexOf(marker)).toBeGreaterThan(coreEnd);
  });

  // Contract: env contribution, this plugin only. The host merges contributions from other plugins (account-pool also
  // contributes ENABLE_TOOL_SEARCH and wins when it is first); this test proves only what Chief itself contributes.
  // Chief rows (plain and child) keep deferral off; every other managed row contributes nothing so tool search stays on.
  // Regression: contributing for a non-Chief row, for unmanaged threads or another provider, dropping Chief's own `false`, or ever forcing `true`.
  test("Chief's own ENABLE_TOOL_SEARCH contribution: claude-code, Chief rows only (not the effective merged environment)", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = ctxOf(state, chief.threadId);
    const worker = await delegate(state, chief.threadId);
    const tester = await delegate(state, chief.threadId, "Tests for totals", { replaces: worker.threadId, kind: "tester" });
    const designer = await delegate(state, chief.threadId, "Design totals", { kind: "designer" });
    const specWriter = await delegate(state, chief.threadId, "Spec totals", { kind: "spec-writer" });
    await state.harness.behavior.runCli(["plan", "--title", "Rework", "--mission", "Propose"], opts);
    await state.harness.behavior.runCli(["consult", "--title", "Rework", "--mission", "Explore"], opts);
    await state.harness.behavior.callAgentTool("chief_review", { branch: "feature/x" }, opts);
    // Chief's chief_research spawns a real researcher row pinned to Chief's own provider and model.
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    await state.harness.behavior.callAgentTool("chief_research", { mode: "survey", question: "Who calls this?", items: ["a.ts"] }, opts);
    const spawned = await state.harness.behavior.callAgentTool("chief_spawn", { request: "Do the task", context: "Goal and evidence" }, opts);
    const child = /in thread (thr_\w+)/.exec(String(spawned))![1]!;
    const rows = (await status(state)).threads;
    expect([...new Set(rows.map((row) => row.role))].sort()).toEqual(["advisor", "chief", "planner", "researcher", "reviewer", "worker"]);
    const env = (providerId: string, threadId: string) => state.harness.behavior.resolveProviderEnv(providerId, { threadId, projectId: "proj_1", hostId: "host_1" });
    const chiefIds = new Set([chief.threadId, child]);
    expect(rows.filter((row) => row.role === "chief").map((row) => row.threadId).sort()).toEqual([...chiefIds].sort());
    for (const id of [worker.threadId, tester.threadId, designer.threadId, specWriter.threadId]) expect(rows.map((row) => row.threadId)).toContain(id);
    for (const { threadId } of rows) {
      const claude = await env("claude-code", threadId);
      if (chiefIds.has(threadId)) expect(claude, threadId).toEqual([expect.objectContaining({ name: "ENABLE_TOOL_SEARCH", value: "false" })]);
      else expect(claude, threadId).toEqual([]);
      expect(claude.some((entry) => entry.value === "true"), threadId).toBe(false);
      expect(await env("codex", threadId), threadId).toEqual([]);
    }
    expect(await env("claude-code", "thr_other")).toEqual([]);
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
  const titleTools: [string, string, (line: string) => string, (source: string, title?: string) => object][] = [
    ["chief_delegate", "worker thread", (line) => line, (mission, title) => ({ mission, unplannedReason: "Bounded test fixture", ...(title ? { title } : {}) })],
    ["chief_plan", "Plan ·", (line) => `Plan · ${line}`, (mission, title) => ({ mission, ...(title ? { title } : {}) })],
    ["chief_consult", "Consult ·", (line) => `Consult · ${line}`, (mission, title) => ({ mission, ...(title ? { title } : {}) })],
    ["chief_spawn", "Chief ·", (line) => `Chief · Asha · ${line}`, (request, title) => ({ request, context: "Goal and evidence", ...(title ? { title } : {}) })],
  ];
  describe.each(titleTools)("%s title default", (name, _shape, expected, params) => {
    test.each(titleCases)("%s", async (_label, source, line) => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      expect(line.length).toBeLessThanOrEqual(160);
      await state.harness.behavior.callAgentTool(name, params(source), ctxOf(state, chief.threadId));
      expect(state.spawned.at(-1).title).toBe(expected(line));
    });

    test("an explicit title is kept", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      await state.harness.behavior.callAgentTool(name, params("The mission line\nmore", "Explicit title"), ctxOf(state, chief.threadId));
      expect(state.spawned.at(-1).title).toBe(expected("Explicit title"));
    });
  });

  // Contract: title default on the CLI path, for delegate, plan and consult (spawn has no CLI command).
  test.each([
    ["delegate", ["--unplanned-reason", "Bounded test fixture"], (line: string) => line],
    ["plan", [], (line: string) => `Plan · ${line}`],
    ["consult", [], (line: string) => `Consult · ${line}`],
  ])("CLI %s without --title defaults it from the mission's first line", async (command, extra, expected) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = ctxOf(state, chief.threadId);
    const run = (title: string[], mission: string) => state.harness.behavior.runCli([command!, ...title, "--mission", mission, ...(extra as string[]), "--json"], opts);
    expect((await run([], "Fix totals\r\nSecond line")).exitCode).toBe(0);
    expect(state.spawned.at(-1).title).toBe(expected("Fix totals"));
    expect((await run([], `${FIRST_160}\nmore`)).exitCode).toBe(0);
    expect(state.spawned.at(-1).title).toBe(expected(FIRST_160));
    expect((await run([], `${FIRST_200}\nmore`)).exitCode).toBe(0);
    expect(state.spawned.at(-1).title).toBe(expected(`${FIRST_200.slice(0, 159)}…`));
    expect((await run(["--title", "Explicit title"], "Fix totals")).exitCode).toBe(0);
    expect(state.spawned.at(-1).title).toBe(expected("Explicit title"));
  });

  // Contract: strictness kept on all four schemas. The title default relaxes only a missing title.
  // Regression: a transform that clips or defaults an invalid explicit title, or one that loosens mission, request or the delegate refusal.
  describe.each(titleTools)("%s strictness", (name, _shape, _expected, params) => {
    const mission = name === "chief_spawn" ? "request" : "mission";
    test.each([["an empty title", ""], ["a whitespace-only title", "   "], ["a null title", null], ["a 161-character title", "t".repeat(161)]])("refuses %s", async (_label, title) => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const spawned = state.spawned.length;
      await expect(state.harness.behavior.callAgentTool(name, { ...params("Fix totals"), title }, ctxOf(state, chief.threadId))).rejects.toThrow(/arguments are invalid/);
      expect(state.spawned.length).toBe(spawned);
    });

    test("refuses a missing or empty " + mission, async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const { [mission]: _omitted, ...without } = params("Fix totals") as Record<string, unknown>;
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
});
