import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { RESEARCH_ONLY } from "./src/core/roles";
import { MIGRATIONS } from "./src/db/migrations";
import { configurationContext, delegate, disposals, elapse, disposeAll, execFileMock, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("chief_research", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const PICK = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" };
  const ask = (extra: Record<string, unknown> = {}) => ({ question: "Who calls this?", ...extra });
  const researcherSpawn = (state: State) => state.spawned.findLast((args) => args.pluginMetadata?.role === "researcher");
  const researcherRows = (state: State) => state.db.prepare("SELECT thread_id, chief_thread_id, role, brief, branch FROM managed_threads WHERE role='researcher'").all() as { thread_id: string; chief_thread_id: string; role: string; brief: string; branch: string | null }[];
  const callRows = (state: State) => state.db.prepare("SELECT caller_thread_id, role, mode, run_id, outcome FROM chief_research_calls ORDER BY id").all() as { caller_thread_id: string; role: string | null; mode: string | null; run_id: string | null; outcome: string }[];
  const setResearcherPick = (state: State, selection: object | null = PICK) => state.harness.behavior.callRpc("setRoleModel", { hostId: "host_1", role: "researcher", selection } as never);

  /** A Chief (or a thread of another role under it) in the first project. Chief's own model is codex/gpt-6-astra, to prove the researcher never inherits it. */
  async function roleThread(state: State, role: string) {
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    if (role === "chief") return chief.threadId;
    if (role === "worker") return (await delegate(state, chief.threadId)).threadId;
    if (role === "planner") await state.harness.behavior.runCli(["plan", "--title", "Rework", "--mission", "Propose"], opts);
    if (role === "reviewer") await state.harness.behavior.callAgentTool("chief_review", { branch: "feature/x" }, opts);
    if (role === "advisor") await state.harness.behavior.runCli(["consult", "--title", "Rework", "--mission", "Explore"], opts);
    if (role === "researcher") await state.harness.behavior.callAgentTool("chief_research", ask(), opts);
    return (await status(state)).threads.find((row) => row.role === role)!.threadId;
  }
  const call = (state: State, threadId: string, params: unknown) =>
    state.harness.behavior.callAgentTool("chief_research", params, { threadId, projectId: "proj_1" });

  test("an active Chief's call starts one researcher row with the brief, reports where it answers, and records one call row", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    const reply = await call(state, chief, ask()) as string;
    expect(reply).toMatch(/^Started researcher thread thr_\d+ \(Research · Who calls this\?\)\. It answers in your checkout and reports through chief_report; .* Do not poll: end your turn\./);
    const [row, ...more] = researcherRows(state);
    expect(more).toEqual([]);
    expect(row).toMatchObject({ role: "researcher", chief_thread_id: chief, branch: null });
    const spawn = researcherSpawn(state);
    expect(spawn.prompt).toBe(row!.brief);
    for (const part of [
      "## Question\nWho calls this?", RESEARCH_ONLY, "--parent-self", '--lifecycle-owner-thread "$BB_THREAD_ID"', '--environment "$BB_ENVIRONMENT_ID"',
      "at most 6 helper threads", "bb thread wait", "Helpers:", "chief_report", `Report to that Chief.`, `Chief thread ${chief}`,
    ]) expect(spawn.prompt).toContain(part);
    expect(spawn.environment).toEqual({ type: "reuse", environmentId: state.live.get(chief)!.environmentId });
    expect(callRows(state)).toEqual([{ caller_thread_id: chief, role: "chief", mode: null, run_id: null, outcome: "spawned" }]);
  });

  test("the brief and its helper command carry Chief's permission mode", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    await call(state, chief, ask());
    expect(researcherSpawn(state)).toMatchObject({ permissionMode: "auto" });
    expect(researcherSpawn(state).prompt).toContain("--permission-mode auto");
  });

  describe("model", () => {
    test("a usable researcher pick runs the thread on it and the helper command carries the same flags", async () => {
      const state = await setup();
      await setResearcherPick(state);
      await call(state, await roleThread(state, "chief"), ask());
      const spawn = researcherSpawn(state);
      expect(spawn).toMatchObject(PICK);
      expect(spawn.prompt).toContain("--provider codex --model gpt-6-astra --reasoning-level high");
      expect(spawn.prompt).not.toContain("pass no --provider or --model");
    });

    test.each([
      ["no pick", async (_state: State) => {}],
      ["a pick whose model left the catalog", async (state: State) => { await setResearcherPick(state, { ...PICK, model: "gone" }); }],
      // Only the removed per-mode picks exist: nothing reads them at runtime.
      ["only an investigate pick in the retired per-mode table", async (state: State) => {
        state.db.prepare("INSERT INTO research_mode_models (host_id, mode, provider_id, model, reasoning_level, updated_at) VALUES ('host_1', 'investigate', 'codex', 'gpt-6-astra', 'high', 1)").run();
      }],
    ])("%s: BB's default (empty execution), no model flags in the helper command, and Chief's own model is not inherited", async (_name, arrange) => {
      const state = await setup();
      await arrange(state);
      await call(state, await roleThread(state, "chief"), ask());
      const spawn = researcherSpawn(state);
      expect(spawn).not.toHaveProperty("providerId");
      expect(spawn).not.toHaveProperty("model");
      const spawnLine = (spawn.prompt as string).split("\n").find((line) => line.startsWith("- Spawn a helper with:"))!;
      expect(spawnLine).toContain("--parent-self");
      expect(spawnLine).not.toContain("--provider");
      expect(spawnLine).not.toContain("--model");
      expect(spawn.prompt).toContain("pass no --provider or --model");
    });

    test("a cooling researcher pick refuses before any spawn and leaves one error row", async () => {
      const state = await setup();
      await setResearcherPick(state);
      const chief = await roleThread(state, "chief");
      state.db.prepare("INSERT INTO provider_cooldowns (provider_id, model, until_at, reason, updated_at) VALUES ('codex', 'gpt-6-astra', ?, 'x', 0)").run(Date.now() + 600_000);
      await expect(call(state, chief, ask())).rejects.toThrow(/cooling down until \d{4}-/);
      expect(researcherSpawn(state)).toBeUndefined();
      expect(callRows(state)).toEqual([{ caller_thread_id: chief, role: "chief", mode: null, run_id: null, outcome: "error" }]);
    });

    test("a cooling model Chief itself runs on does not block a researcher on a different pick", async () => {
      const state = await setup();
      await setResearcherPick(state, { providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "high" });
      const chief = await roleThread(state, "chief");
      state.db.prepare("INSERT INTO provider_cooldowns (provider_id, model, until_at, reason, updated_at) VALUES ('codex', 'gpt-6-astra', ?, 'x', 0)").run(Date.now() + 600_000);
      await expect(call(state, chief, ask())).resolves.toContain("Started researcher thread");
    });
  });

  describe("provider pre-flight", () => {
    test("refuses a provider that is not installed or out of quota before any spawn, warns but starts when signed out, and fails open otherwise", async () => {
      let usage: (args: any) => unknown = () => ({});
      const state = await setup({ usageLimits: (args) => usage(args) });
      await setResearcherPick(state);
      const chief = await roleThread(state, "chief");
      usage = () => ({ codex: { status: "ok", windows: [{ label: "5h", usedPercent: 100, resetsAt: "2026-10-08T12:00:00Z" }] } });
      await expect(call(state, chief, ask())).rejects.toThrow(/out of quota \(5h window at 100%, resets 2026-10-08T12:00:00Z\).*Pick another researcher model/);
      usage = () => ({ codex: { status: "not_installed" } });
      await expect(call(state, chief, ask())).rejects.toThrow(/not_installed/);
      expect(researcherSpawn(state)).toBeUndefined();
      for (const status of ["unauthenticated", "expired"]) {
        usage = () => ({ codex: { status } });
        await call(state, chief, ask());
        expect(state.harness.logEntries.some((entry) => entry.level === "warn" && entry.message.includes(`codex reports ${status}`))).toBe(true);
      }
      usage = () => ({ codex: { status: "error", message: "x" } });
      await call(state, chief, ask());
      usage = () => { throw new Error("rpc down"); };
      await call(state, chief, ask());
      expect(state.spawned.filter((args) => args.pluginMetadata?.role === "researcher")).toHaveLength(4);
      expect(callRows(state).map((row) => row.outcome)).toEqual(["error", "error", "spawned", "spawned", "spawned", "spawned"]);
    });

    test.each([
      ["throws synchronously", { usageLimits: () => { throw new Error("rpc down"); } }],
      ["is absent on an older host", {}],
    ])("fails open when system.usageLimits %s", async (_case, system) => {
      const state = await setup({ system });
      await setResearcherPick(state);
      await call(state, await roleThread(state, "chief"), ask());
      expect(researcherSpawn(state)).toBeDefined();
    });

    test("an unpinned researcher (BB default) makes no usage check", async () => {
      const usageLimits = vi.fn(async () => ({}));
      const state = await setup({ usageLimits });
      await call(state, await roleThread(state, "chief"), ask());
      expect(usageLimits).not.toHaveBeenCalled();
    });
  });

  describe("environment", () => {
    const BRANCH = "feature/pr-head";

    test("with a branch it launches in a fresh managed worktree on it, records the branch, says so in the reply and puts the branch in no prompt", async () => {
      const state = await setup();
      const chief = await roleThread(state, "chief");
      const reply = await call(state, chief, ask({ branch: BRANCH })) as string;
      expect(reply).toContain(`It answers in a fresh worktree on branch ${BRANCH} and reports through chief_report`);
      const spawn = researcherSpawn(state);
      expect(spawn.environment).toEqual({ type: "host", hostId: expect.any(String), workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: BRANCH } } });
      expect(researcherRows(state)[0]!.branch).toBe(BRANCH);
    });

    test("without a branch it reuses Chief's environment and records no branch", async () => {
      const state = await setup();
      const chief = await roleThread(state, "chief");
      await call(state, chief, ask());
      expect(researcherSpawn(state).environment).toEqual({ type: "reuse", environmentId: state.live.get(chief)!.environmentId });
      expect(researcherRows(state)[0]!.branch).toBeNull();
    });

    test("a branch needs no reusable Chief environment, which a call without a branch does", async () => {
      const state = await setup();
      const chief = await roleThread(state, "chief");
      state.live.set(chief, { ...state.live.get(chief)!, environmentId: undefined } as any);
      await expect(call(state, chief, ask())).rejects.toThrow(/Chief's checkout cannot be shared with a researcher thread/);
      expect(researcherSpawn(state)).toBeUndefined();
      await expect(call(state, chief, ask({ branch: BRANCH }))).resolves.toContain("Started researcher thread");
      expect(researcherSpawn(state).environment.workspace.baseBranch).toEqual({ kind: "named", name: BRANCH });
    });
  });

  describe("who may call", () => {
    test.each(["planner", "worker", "advisor", "reviewer", "researcher"])("a %s is refused, nothing spawns, and the call row names the role", async (role) => {
      const state = await setup();
      const threadId = await roleThread(state, role);
      const spawned = state.spawned.length;
      const rows = callRows(state).length;
      await expect(call(state, threadId, ask())).rejects.toThrow(/available only to an active Chief/);
      await expect(call(state, threadId, ask({ branch: "feature/x" }))).rejects.toThrow(/available only to an active Chief/);
      expect(state.spawned).toHaveLength(spawned);
      expect(callRows(state).slice(rows)).toEqual(Array(2).fill({ caller_thread_id: threadId, role, mode: null, run_id: null, outcome: "error" }));
    });

    test("a planner's refusal points it at helper threads", async () => {
      const state = await setup();
      await expect(call(state, await roleThread(state, "planner"), ask())).rejects.toThrow(/helper threads/);
    });

    test("an unmanaged thread and a superseded Chief are refused", async () => {
      const state = await setup();
      state.addLive("thr_user", "proj_1");
      await expect(call(state, "thr_user", ask())).rejects.toThrow(/only to an active Chief/);
      const old = await roleThread(state, "chief");
      state.live.set(old, { ...state.live.get(old)!, archivedAt: Date.now() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(old)! });
      await expect(call(state, old, ask())).rejects.toThrow(/only to an active Chief/);
      expect(researcherSpawn(state)).toBeUndefined();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(callRows(state)).toEqual([
        { caller_thread_id: "thr_user", role: null, mode: null, run_id: null, outcome: "error" },
        { caller_thread_id: old, role: "chief", mode: null, run_id: null, outcome: "error" },
      ]);
    });

    test.each([{}, { question: "" }, { question: "x".repeat(4_001) }])("a malformed question %j is rejected before any row is written", async (params) => {
      const state = await setup();
      await expect(call(state, await roleThread(state, "chief"), params)).rejects.toThrow();
      expect(researcherSpawn(state)).toBeUndefined();
    });
  });

  describe("switch and settings", () => {
    test("the switch gates a Chief live, through settings and setResearchSettings, and answers only { enabled }", async () => {
      const state = await setup();
      const chief = await roleThread(state, "chief");
      const off = "chief_research is off: turn on the Researcher switch in Chief's plugin settings.";
      await state.harness.behavior.setSettings({ plannerEnabled: true, researchEnabled: false });
      await expect(call(state, chief, ask())).rejects.toThrow(off);
      await state.harness.behavior.setSettings({ plannerEnabled: true, researchEnabled: true });
      await expect(call(state, chief, ask())).resolves.toContain("Started researcher thread");
      expect(await state.harness.behavior.callRpc("setResearchSettings", { enabled: false })).toEqual({ enabled: false });
      await expect(call(state, chief, ask())).rejects.toThrow(off);
      expect(await state.harness.behavior.callRpc("setResearchSettings", { enabled: true })).toEqual({ enabled: true });
      expect(callRows(state).map((row) => row.outcome)).toEqual(["error", "spawned", "error"]);
    });

    test("is on by default with no stored values, and the retired cap and timeout patches are rejected", async () => {
      const state = await setup();
      expect(await state.harness.behavior.callRpc("setResearchSettings", {})).toEqual({ enabled: true });
      await expect(state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 100 } as never)).rejects.toThrow();
      await expect(state.harness.behavior.callRpc("setResearchSettings", { timeoutMinutes: { survey: 5 } } as never)).rejects.toThrow();
      await expect(state.harness.behavior.callRpc("setResearchSettings", { planner: { enabled: false } } as never)).rejects.toThrow();
    });

    test("the rpc contract has no setResearchModel", async () => {
      const state = await setup();
      await expect(state.harness.behavior.callRpc("setResearchModel" as never, { hostId: "host_1", mode: "survey", selection: PICK } as never)).rejects.toThrow();
    });
  });

  describe("configure", () => {
    const LINE = "Use chief_research for read-only research by a researcher thread.";
    test("Chief gets the tool, its line and the optional-research cue only while the switch is on", async () => {
      const state = await setup();
      const threadId = await roleThread(state, "chief");
      const configured = () => state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
      let config = await configured();
      expect(config.tools.map((tool) => tool.name)).toContain("chief_research");
      expect(config.instructions).toContain(LINE);
      expect(config.instructions).toContain("chief_research is optional.");
      await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
      config = await configured();
      expect(config.tools.map((tool) => tool.name)).not.toContain("chief_research");
      expect(config.instructions).not.toContain("chief_research");
      await state.harness.behavior.callRpc("setResearchSettings", { enabled: true });
      expect((await configured()).tools.map((tool) => tool.name)).toContain("chief_research");
    });

    test.each(["planner", "researcher", "worker", "advisor", "reviewer"])("a %s never gets chief_research or a research instruction line", async (role) => {
      const state = await setup();
      const config = await state.harness.behavior.resolveAgentConfiguration(configurationContext(await roleThread(state, role)));
      expect(config.tools.map((tool) => tool.name)).not.toContain("chief_research");
      expect(config.instructions).not.toContain("chief_research");
    });
  });

  describe("report and supervision", () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const alertsTo = (state: State, chief: string) => state.sent.filter((message) => message.threadId === chief).map((message) => message.input[0].text as string);

    // Contract (plan-1 step 5): a ready researcher report reaches Chief as the standard report alert whose Next line says research is advisory
    // and nothing is left to review or complete (the alert shows the action as its own line). Regression: the generic "Inspect live evidence ... review, complete" line (it sends Chief to review a researcher).
    test("a ready researcher report alerts Chief once with the advisory Next line", async () => {
      const state = await setup();
      const chief = await roleThread(state, "chief");
      const researcher = await roleThread(state, "researcher");
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Callers: a.ts, b.ts." }, { threadId: researcher, projectId: "proj_1" });
      const alerts = alertsTo(state, chief);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.split("\n")).toContain("Research is advisory: use its findings, check anything doubtful against the code, and note any failures or partial answers it reports. Nothing to review or complete.");
      expect(alerts[0]).toContain("Callers: a.ts, b.ts.");
      expect(alerts[0]).not.toContain("Inspect live evidence");
    });

    // Contract (plan-1 step 5, supervision): no unread, unreported or grace-period alert is raised for a researcher any more, however long it is idle
    // without reporting. Regression: a revived unreported-researcher timer or alert.
    test("an idle researcher that never reports raises no research-specific alert", async () => {
      const state = await setup();
      const chief = await roleThread(state, "chief");
      await roleThread(state, "researcher");
      for (let i = 0; i < 4; i++) {
        elapse(3 * 60 * 60 * 1000);
        await state.supervisorCycle();
      }
      await settle();
      expect(alertsTo(state, chief).filter((text) => /research-unreported|research-unread|unreported|unread/i.test(text))).toEqual([]);
    });

    // Contract (plan-1 step 5, sweep): the standard sweep completes a researcher that reported ready once its live status is idle. Regression: a ready
    // researcher row staying open in the roster, or a busy one being completed.
    test("the sweep completes a researcher that reported ready and leaves a busy one open", async () => {
      const state = await setup();
      await roleThread(state, "chief");
      const researcher = await roleThread(state, "researcher");
      const stateOf = () => (state.db.prepare("SELECT state FROM managed_threads WHERE thread_id=?").get(researcher) as { state: string }).state;
      state.live.set(researcher, { ...state.live.get(researcher)!, status: "active" });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Answer." }, { threadId: researcher, projectId: "proj_1" });
      await settle();
      expect(stateOf()).not.toBe("complete");
      state.live.set(researcher, { ...state.live.get(researcher)!, status: "idle" });
      await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(researcher)!, lastAssistantText: "done" });
      await settle();
      expect(stateOf()).toBe("complete");
    });
  });

  describe("researcher role model", () => {
    test("setRoleModel round-trips selections.researcher, a null clears it and it stays cleared, and a pick the catalog dropped is listed unusable", async () => {
      const state = await setup();
      const host = async () => ((await state.harness.behavior.callRpc("modelConfiguration", null)) as any).hosts[0];
      expect((await host()).selections.researcher).toBeNull();
      await setResearcherPick(state);
      expect((await host()).selections.researcher).toEqual(PICK);
      expect((await host()).unusable).toEqual([]);
      await setResearcherPick(state, { ...PICK, model: "gone" });
      expect((await host()).unusable).toEqual(["researcher"]);
      await setResearcherPick(state, null);
      expect((await host()).selections.researcher).toBeNull();
      expect((await host()).unusable).toEqual([]);
      state.db.prepare("INSERT INTO research_mode_models (host_id, mode, provider_id, model, reasoning_level, updated_at) VALUES ('host_1', 'investigate', 'codex', 'gpt-6-astra', 'high', 1)").run();
      expect((await host()).selections.researcher).toBeNull();
    });
  });

  test("migration copies the single research pick to every mode and drops research_model", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-research" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("research_mode_models"))));
    db.prepare(`INSERT INTO research_model (host_id, provider_id, model, reasoning_level, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run("host_1", "codex", "gpt-6-astra", "high", 1);

    bb.storage.migrate(db, MIGRATIONS);

    const copied = { host_id: "host_1", provider_id: "codex", model: "gpt-6-astra", reasoning_level: "high" };
    expect(db.prepare(`SELECT host_id, mode, provider_id, model, reasoning_level FROM research_mode_models ORDER BY mode`).all())
      .toEqual(["investigate", "review", "survey"].map((mode) => ({ ...copied, mode })));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='research_model'`).get()).toBeUndefined();
    expect(() => db.prepare(`INSERT INTO research_mode_models (host_id, mode, provider_id, model, reasoning_level, updated_at) VALUES ('h', 'bogus', 'p', 'm', 'high', 1)`).run()).toThrow();
  });

  // The SDK cuts configure() instructions at 32768 chars (the testing host slices the same way), and chief.md may be up to 32,000; the project name is also unbounded input.
  test.each([[5_000, 4], [32_000, 4], [5_000, 5_000]])("a %i-char chief.md and a %i-char project name only trim project rules: Chief's own instructions stay inside the 32768-char cut", async (size, nameLength) => {
    const marker = "# Project rules marker";
    const state = await setup({ rules: `${marker}\n${"- Project rule text.\n".repeat(Math.ceil(size / 21))}`.slice(0, size) });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const threadId = await roleThread(state, "chief");
    const { instructions } = await state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId, "proj_1", "N".repeat(nameLength)));
    // Only the 32,000-char chief.md reaches the SDK cap, so it still exercises the cut; the 5,000-char cases fit uncut.
    if (size === 32_000) expect(instructions!.length).toBe(32768);
    else expect(instructions!.length).toBeLessThanOrEqual(32768);
    const coreEnd = instructions!.indexOf("chief_escalate with the thread and the full request");
    expect(coreEnd).toBeGreaterThan(-1);
    for (const part of [
      "# Chief core rules (always apply)", "Call chief_roster at the start of every turn", "never poll managed threads",
      "chief_plan first", "delegate every wave it lists right away",
      "chief_research is optional.", "or the doubtful evidence to chief_review.",
      "Small, low-risk changes suit a skip.", "Chief never edits code",
    ]) expect(instructions).toContain(part);
    expect(instructions!.indexOf(marker)).toBeGreaterThan(coreEnd);
  });
});
