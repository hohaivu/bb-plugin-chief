import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { RESEARCH_SCRIPTS } from "./server";
import { MIGRATIONS } from "./src/db/migrations";
import { chiefReview, configurationContext, delegate, disposals, disposeAll, execFileMock, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("chief_research", () => {
  type Run = { status: string; result?: unknown; resultOmitted?: boolean; error?: unknown };
  /** Routes `bb workflows <sub>` calls; run/status/history/stop each take a handler. */
  function workflowsCli(handlers: { run?: () => any; status?: () => Run; history?: () => any; stop?: () => any } = {}) {
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      const handler = (handlers as any)[args[1]!];
      if (!handler) throw new Error(`unexpected bb workflows ${args[1]}`);
      return { stdout: JSON.stringify(await handler()), stderr: "" };
    });
  }
  const calls = (sub: string) => execFileMock.mock.calls.filter((call) => call[1][1] === sub);
  const sentArgs = () => JSON.parse(calls("run")[0]![1][calls("run")[0]![1].indexOf("--args") + 1]);
  const done = { status: "succeeded", result: { rows: [], table: "| Item | Finding | Evidence |" } };
  const survey = (extra: Record<string, unknown> = {}) => ({ mode: "survey", question: "Who calls this?", items: ["a.ts"], ...extra });

  async function roleThread(state: Awaited<ReturnType<typeof setup>>, role: string, failClosed = false) {
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    // Chief's chief_research spawns a researcher pinned to Chief's own provider and model (7a15988); without both it fails closed.
    if (!failClosed) {
      state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, providerId: "codex" });
      state.setThreadExecution({ model: "gpt-6-astra" });
    }
    if (role === "chief") return chief.threadId;
    if (role === "worker") return (await delegate(state, chief.threadId)).threadId;
    if (role === "planner") await state.harness.behavior.runCli(["plan", "--title", "Rework", "--mission", "Propose"], opts);
    if (role === "reviewer") await state.harness.behavior.callAgentTool("chief_review", { branch: "feature/x" }, opts);
    if (role === "advisor") await state.harness.behavior.runCli(["consult", "--title", "Rework", "--mission", "Explore"], opts);
    return (await status(state)).threads.find((row) => row.role === role)!.threadId;
  }
  const call = (state: Awaited<ReturnType<typeof setup>>, threadId: string, params: unknown, signal?: AbortSignal) =>
    state.harness.behavior.callAgentTool("chief_research", params, { threadId, projectId: "proj_1", ...(signal ? { signal } : {}) });

  test("cooldown: refuses a fresh run on the caller's cooling model, but never a runId resume", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const chief = await roleThread(state, "chief");
    state.live.set(chief, { ...state.live.get(chief)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    state.db.prepare("INSERT INTO provider_cooldowns (provider_id, model, until_at, reason, updated_at) VALUES ('codex', 'gpt-6-astra', ?, 'x', 0)").run(Date.now() + 600_000);
    await expect(call(state, chief, survey())).rejects.toThrow(/cooling down until \d{4}-/);
    expect(calls("run")).toHaveLength(0);
    expect(await call(state, chief, { mode: "survey", runId: "wfr_1" })).toContain("status: succeeded");
  });

  test.each(["worker", "advisor", "reviewer"])("rejects a %s caller", async (role) => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    await expect(call(state, await roleThread(state, role), survey())).rejects.toThrow(/not available to a managed/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("rejects an unmanaged thread, a superseded Chief, and any caller asking for the removed review mode", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    state.addLive("thr_user", "proj_1");
    await expect(call(state, "thr_user", survey())).rejects.toThrow(/only in an active Chief/);
    const planner = await roleThread(state, "planner");
    await expect(call(state, planner, survey({ mode: "review", concerns: ["x"] }))).rejects.toThrow(/expected one of "survey"\|"investigate"/);
    const old = (await status(state)).threads.find((row) => row.role === "chief")!.threadId;
    state.live.set(old, { ...state.live.get(old)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(old)! });
    await expect(call(state, old, survey())).rejects.toThrow(/only in an active Chief/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("runs the workflows CLI as the calling planner", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const planner = await roleThread(state, "planner");
    const reply = await call(state, planner, survey());
    expect(reply).toContain("| Item | Finding | Evidence |");
    const [file, args, options] = calls("run")[0]!;
    expect(file).toBe(process.env.BB_CLI ?? "bb");
    expect(args.slice(0, 3)).toEqual(["workflows", "run", "--script"]);
    expect(args.at(-1)).toBe("--json");
    expect(options.env).toMatchObject({ BB_THREAD_ID: planner, BB_PROJECT_ID: "proj_1" });
    expect(options.env.PATH).toContain("/opt/homebrew/bin");
    expect(options.timeout).toBe(30_000);
  });

  test("switches gate live, through settings and setResearchSettings", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const planner = await roleThread(state, "planner");
    const chief = (await status(state)).threads.find((row) => row.role === "chief" && row.state !== "archived")!.threadId;
    const off = "chief_research is off in Chief settings → Chief researcher.";
    await state.harness.behavior.setSettings({ plannerEnabled: true, researchEnabled: false });
    for (const threadId of [chief, planner]) await expect(call(state, threadId, survey())).rejects.toThrow(off);
    await state.harness.behavior.setSettings({ plannerEnabled: true, researchEnabled: true });
    await expect(call(state, planner, survey())).resolves.toContain("wfr_1");
    expect(await state.harness.behavior.callRpc("setResearchSettings", { enabled: false })).toEqual({ enabled: false, maxAgentCalls: 24, timeoutMinutes: { survey: 10, investigate: 10 } });
    for (const threadId of [chief, planner]) await expect(call(state, threadId, survey())).rejects.toThrow(off);
    expect(await state.harness.behavior.callRpc("setResearchSettings", { enabled: true })).toEqual({ enabled: true, maxAgentCalls: 24, timeoutMinutes: { survey: 10, investigate: 10 } });
    await expect(call(state, chief, survey())).resolves.toContain("Started researcher thread");
    await expect(state.harness.behavior.callRpc("setResearchSettings", { planner: { enabled: false } })).rejects.toThrow();
  });

  test("is on by default with no stored values, for Chief and planners", async () => {
    const state = await setup();
    const config = await state.harness.behavior.callRpc("researchConfiguration", null) as any;
    expect(config.settings).toEqual({ enabled: true, maxAgentCalls: 24, timeoutMinutes: { survey: 10, investigate: 10 } });
    for (const role of ["chief", "planner"]) {
      const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(await roleThread(state, role)));
      expect(configured.tools.map((tool) => tool.name)).toContain("chief_research");
    }
  });

  test("enforces one agent-call cap for every role before starting", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const planner = await roleThread(state, "planner");
    const chief = (await status(state)).threads.find((row) => row.role === "chief")!.threadId;
    const items = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    await expect(call(state, chief, survey({ items, verify: false }))).rejects.toThrow(/needs 25 agent calls; the limit is 24/);
    await expect(call(state, planner, survey({ items, verify: false }))).rejects.toThrow(/limit is 24/);
    expect(calls("run")).toHaveLength(0);
    await expect(call(state, planner, survey({ items: items.slice(0, 23) }))).resolves.toContain("wfr_1");
    expect(sentArgs()).toMatchObject({ cap: 24, batchSize: 1, verify: true });
    await state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 100 });
    await expect(call(state, planner, survey({ items }))).resolves.toContain("wfr_1");
    await expect(state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 0 })).rejects.toThrow();
    await expect(state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 101 })).rejects.toThrow();
  });

  test("stores one model per machine and mode, and flags one the catalog dropped", async () => {
    const state = await setup();
    const triple = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" };
    const none = { survey: null, investigate: null };
    const host = async () => (await state.harness.behavior.callRpc("researchConfiguration", null) as any).hosts[0];
    expect(await host()).toMatchObject({ selections: none, unusable: [] });
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "survey", selection: triple });
    expect(await host()).toMatchObject({ selections: { ...none, survey: triple }, unusable: [] });
    await expect(state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", selection: triple })).rejects.toThrow();
    await expect(state.harness.behavior.callRpc("setResearchModel", {
      hostId: "host_1", mode: "survey", selection: { providerId: "codex", model: "gpt-6-astra" },
    })).rejects.toThrow();
    await expect(state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "review", selection: triple })).rejects.toThrow();
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "investigate", selection: triple });
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "survey", selection: { ...triple, model: "gone" } });
    expect((await host()).unusable).toEqual(["survey"]);
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "survey", selection: null });
    expect(await host()).toMatchObject({ selections: { ...none, investigate: triple }, unusable: [] });
  });

  test("resolves stage models: override, then the machine's pick for the mode, else inherit", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const planner = await roleThread(state, "planner");
    const chief = (await status(state)).threads.find((row) => row.role === "chief" && row.state !== "archived")!.threadId;
    await call(state, planner, survey());
    expect(sentArgs().models).toEqual({});
    await state.harness.behavior.callRpc("setResearchModel", {
      hostId: "host_1", mode: "survey", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const stored = { provider: "codex", model: "gpt-6-astra", reasoningLevel: "high" };
    execFileMock.mockClear();
    await call(state, planner, survey());
    expect(sentArgs().models).toEqual({ scan: stored, verify: stored, combine: stored });
    // Chief runs no workflow itself: its researcher thread is pinned to the mode's pick instead of Chief's own model.
    await call(state, chief, survey());
    expect(state.spawned.findLast((args) => args.pluginMetadata?.role === "researcher")).toMatchObject({ providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" });
    execFileMock.mockClear();
    await call(state, planner, { mode: "investigate", question: "Why?", questions: ["a"] });
    expect(sentArgs().models).toEqual({});
    execFileMock.mockClear();
    const override = { provider: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" };
    await call(state, planner, survey({ models: { scan: override } }));
    expect(sentArgs().models).toEqual({ scan: override, verify: stored, combine: stored });
    await expect(call(state, planner, survey({ models: { scan: { provider: "codex", model: "x" } } }))).rejects.toThrow();
  });

  test("drops a Researcher pick or override whose provider cannot run the caller's permission mode", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const planner = await roleThread(state, "planner");
    const antigravity = { provider: "acp-antigravity", model: "gemini-3-pro", reasoningLevel: "high" };
    await state.harness.behavior.callRpc("setResearchModel", {
      hostId: "host_1", mode: "survey", selection: { providerId: "acp-antigravity", model: "gemini-3-pro", reasoningLevel: "high" },
    });
    const note = `cannot run in this thread's permission mode "auto"`;
    expect(await call(state, planner, survey())).toContain(note);
    expect(sentArgs().models).toEqual({});

    state.setCallerPermissionMode("full");
    execFileMock.mockClear();
    expect(await call(state, planner, survey())).not.toContain("permission mode");
    expect(sentArgs().models).toEqual({ scan: antigravity, verify: antigravity, combine: antigravity });

    state.setCallerPermissionMode("auto");
    await state.harness.behavior.callRpc("setResearchModel", {
      hostId: "host_1", mode: "survey", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const stored = { provider: "codex", model: "gpt-6-astra", reasoningLevel: "high" };
    execFileMock.mockClear();
    expect(await call(state, planner, survey({ models: { scan: antigravity } }))).toContain("scan override acp-antigravity/gemini-3-pro");
    expect(sentArgs().models).toEqual({ scan: stored, verify: stored, combine: stored });
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

  test("waits each mode's own timeout, capped at 150 s, and rejects one out of range", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "running" }) });
    expect(await state.harness.behavior.callRpc("setResearchSettings", { timeoutMinutes: { survey: 2 } }))
      .toMatchObject({ timeoutMinutes: { survey: 2, investigate: 10 } });
    for (const bad of [{ survey: 0 }, { survey: 61 }, { bogus: 5 }]) {
      await expect(state.harness.behavior.callRpc("setResearchSettings", { timeoutMinutes: bad })).rejects.toThrow();
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      let surveySettled = false;
      const surveyed = call(state, planner, survey()).finally(() => { surveySettled = true; });
      await vi.advanceTimersByTimeAsync(119_000);
      expect(surveySettled).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await surveyed).toContain("Still running");
      let investigateSettled = false;
      const investigated = call(state, planner, { mode: "investigate", question: "Why?", questions: ["a?"] }).finally(() => { investigateSettled = true; });
      await vi.advanceTimersByTimeAsync(149_000);
      expect(investigateSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await investigated).toContain("Still running");
    } finally {
      vi.useRealTimers();
    }
  });

  test("falls back to history, parsed as JSON Lines, when the result was omitted", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", resultOmitted: true }) });
    const routed = execFileMock.getMockImplementation()!;
    execFileMock.mockImplementation(async (file: string, args: string[], options: any) => args[1] === "history"
      ? { stdout: [
        { type: "run", logVersion: 1, result: { table: "| from history |" } },
        { type: "call", callIndex: 0 },
        { type: "page", nextCursor: null },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n", stderr: "" }
      : routed(file, args, options));
    expect(await call(state, planner, survey())).toContain("| from history |");
    expect(calls("history")[0]![1]).toEqual(["workflows", "history", "wfr_1", "--cursor", "0", "--limit", "1", "--json"]);
  });

  test("waits through running, stops at the wait cap, and resumes by runId without starting a run", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    let polls = 0;
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => (++polls < 3 ? { status: "running" } : done) });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const reply = call(state, planner, survey());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await reply).toContain("| Item | Finding | Evidence |");
      expect(polls).toBe(3);

      workflowsCli({ run: () => ({ runId: "wfr_2" }), status: () => ({ status: "running" }) });
      const capped = call(state, planner, survey());
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(await capped).toBe("Still running. Call chief_research again with runId: wfr_2 to keep waiting.");
    } finally {
      vi.useRealTimers();
    }
    execFileMock.mockClear();
    workflowsCli({ status: () => done });
    expect(await call(state, planner, survey({ runId: "wfr_2" }))).toContain("runId: wfr_2");
    expect(calls("run")).toHaveLength(0);
  });

  test("abort stops the run and rethrows", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "running" }), stop: () => ({ ok: true }) });
    const controller = new AbortController();
    const reply = call(state, planner, survey(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("cancelled"));
    await expect(reply).rejects.toThrow("cancelled");
    expect(calls("stop")[0]![1].slice(0, 3)).toEqual(["workflows", "stop", "wfr_1"]);
  });

  test("abort during a failing status call still stops the run", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    const controller = new AbortController();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => { controller.abort(new Error("cancelled")); throw new Error("killed"); }, stop: () => ({ ok: true }) });
    // The status read retries and the stop confirms with 1 s sleeps; fake timers keep them off the wall clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const settled = expect(call(state, planner, survey(), controller.signal)).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(10_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(calls("stop")[0]![1].slice(0, 3)).toEqual(["workflows", "stop", "wfr_1"]);
  });

  test("abort during the last poll before the deadline stops the run", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    const controller = new AbortController();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => { if (Date.now() >= deadline) controller.abort(new Error("cancelled")); return { status: "running" }; }, stop: () => ({ ok: true }) });
    let deadline = Infinity;
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      deadline = Date.now() + 150_000;
      const reply = call(state, planner, survey(), controller.signal);
      const settled = expect(reply).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(calls("stop")[0]![1].slice(0, 3)).toEqual(["workflows", "stop", "wfr_1"]);
  });

  test("hands the script back when the server cannot start it, and says check it yourself when status fails", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    execFileMock.mockRejectedValue(Object.assign(new Error("spawn bb ENOENT"), { stdout: "" }));
    const reply = await call(state, planner, survey()) as string;
    expect(reply).toContain("spawn bb ENOENT");
    expect(reply).toContain("call bb_workflow_run with exactly this script and args");
    expect(reply).toContain("export const meta = {");
    expect(reply).toContain('"question":"Who calls this?"');
    expect(await call(state, planner, survey({ runId: "wfr_9" }))).toBe(
      "Could not read workflow wfr_9 from the plugin server. Check it yourself with `bb workflows status wfr_9`.",
    );
  });

  test("validates per mode and accepts a bare runId resume", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    await expect(call(state, chief, { mode: "investigate", question: "Why?" })).rejects.toThrow(/questions/);
    await expect(call(state, chief, { mode: "survey", question: "Who?" })).rejects.toThrow(/items/);
    await expect(call(state, chief, { question: "Who?" })).rejects.toThrow(/mode/);
    workflowsCli({ status: () => done });
    expect(await call(state, chief, { runId: "wfr_7" })).toContain("runId: wfr_7");
    expect(calls("run")).toHaveLength(0);
  });

  test("starts survey and investigate with their scripts and args", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", result: { rows: [], table: "No rows." } }) });
    expect(await call(state, planner, survey({ batchSize: 2 }))).toContain("No rows.");
    const runArgs = () => calls("run").at(-1)![1];
    expect(runArgs()[3]).toContain('name: "chief-research-survey"');
    expect(JSON.parse(runArgs()[5])).toMatchObject({ question: "Who calls this?", items: ["a.ts"], batchSize: 2, verify: true, cap: 24 });

    const combine = { provider: "codex", model: "gpt-6-astra", reasoningLevel: "high" };
    workflowsCli({ run: () => ({ runId: "wfr_2" }), status: () => ({ status: "succeeded", result: { answers: [], brief: "## Confirmed" } }) });
    expect(await call(state, planner, { mode: "investigate", question: "Why?", questions: ["a?", "b?"], models: { combine } })).toContain("## Confirmed");
    expect(runArgs()[3]).toContain('name: "chief-research-investigate"');
    expect(JSON.parse(runArgs()[5])).toMatchObject({ questions: ["a?", "b?"], models: { combine } });

    await state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 2 });
    await expect(call(state, planner, { mode: "investigate", question: "Why?", questions: ["a?", "b?"] })).rejects.toThrow(/needs 3 agent calls.*limit is 2/);
  });

  test("Chief's chief_research spawns a researcher child pinned to its model and runs no workflow itself", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const chief = await roleThread(state, "chief");
    const reply = await call(state, chief, survey()) as string;
    expect(reply).toMatch(/^Started researcher thread thr_\d+ \(Research · survey · Who calls this\?\)/);
    expect(execFileMock).not.toHaveBeenCalled();
    const spawn = state.spawned.findLast((args) => args.pluginMetadata?.role === "researcher");
    expect(spawn).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
    expect(spawn.prompt).toContain('"question":"Who calls this?"');
  });

  test("Chief's chief_research fails closed when its own provider and model cannot be read", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const chief = await roleThread(state, "chief", true);
    await expect(call(state, chief, survey())).rejects.toThrow(/Chief's own provider and model could not be read/);
    expect(state.spawned.some((args) => args.pluginMetadata?.role === "researcher")).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test.each(["chief", "planner"])("configure gives a %s chief_research and its line only while on", async (role) => {
    const state = await setup();
    const threadId = await roleThread(state, role);
    const configured = () => state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
    const modes = "survey, investigate";
    let config = await configured();
    expect(config.tools.map((tool) => tool.name)).toContain("chief_research");
    expect(config.instructions).toContain(`Use chief_research (modes: ${modes})`);
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
    config = await configured();
    expect(config.tools.map((tool) => tool.name)).not.toContain("chief_research");
    expect(config.instructions).not.toContain("chief_research");
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: true });
    expect((await configured()).tools.map((tool) => tool.name)).toContain("chief_research");
  });

  test.each(["worker", "advisor", "reviewer"])("configure never gives a %s chief_research", async (role) => {
    const state = await setup();
    const config = await state.harness.behavior.resolveAgentConfiguration(configurationContext(await roleThread(state, role)));
    expect(config.tools.map((tool) => tool.name)).not.toContain("chief_research");
    expect(config.instructions).not.toContain("chief_research");
  });

  test("the planner spawn prompt mentions chief_research only while on, a reviewer's never", async () => {
    const state = await setup();
    await roleThread(state, "planner");
    await roleThread(state, "reviewer");
    const prompt = (role: string) => state.spawned.findLast((args) => args.pluginMetadata?.role === role).prompt as string;
    expect(prompt("planner")).toContain("use chief_research");
    expect(prompt("reviewer")).not.toContain("chief_research");
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
    const chief = (await status(state)).threads.find((row) => row.role === "chief" && row.state !== "archived")!.threadId;
    await state.harness.behavior.runCli(["plan", "--title", "Again", "--mission", "Propose"], { threadId: chief, projectId: "proj_1" });
    await chiefReview(state, chief, { branch: "feature/y" });
    expect(prompt("planner")).not.toContain("chief_research");
    expect(prompt("reviewer")).not.toContain("chief_research");
  });

  /** Runs a research script the way the workflow runtime does: parallel() turns a thrown agent into null. */
  async function runScript(mode: keyof typeof RESEARCH_SCRIPTS, args: Record<string, unknown>, agent: (prompt: string, opts: any) => unknown) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const logs: string[] = [];
    const parallel = (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((thunk) => thunk().catch(() => null)));
    const fn = new AsyncFunction("args", "agent", "parallel", "log", "budget", RESEARCH_SCRIPTS[mode].replace(/^export /, ""));
    const result = await fn({ preamble: "P", cap: 24, verify: true, ...args }, async (prompt: string, opts: any) => agent(prompt, opts), parallel, (line: string) => logs.push(line), () => ({ maxAgentCalls: 100 }));
    return { result, logs };
  }
  const row = (item: string) => ({ item, finding: "f", evidence: "e" });

  test("survey keeps scan rows unverified when verify throws, and lists missed batches", async () => {
    const { result, logs } = await runScript("survey", { question: "Q", items: ["a", "b", "c"], batchSize: 1 }, (prompt, opts) => {
      if (opts.phase === "Verify") throw new Error("Workflow worker failed");
      if (prompt.includes("- c")) throw new Error("Workflow worker failed");
      return { rows: [row(prompt.includes("- a") ? "a" : "b")] };
    });
    expect(result.rows).toHaveLength(2);
    expect(result.verified).toBe(false);
    expect(result.missed).toEqual(["c"]);
    expect(result.table.split("\n")[0]).toContain("UNVERIFIED");
    expect(result.table.split("\n")[0]).toContain("No result for: c");
    expect(result.failures).toEqual(["Scan: 1 of 3 batches failed", "Verify: Workflow worker failed"]);
    expect(logs.some((line) => line.includes("Verify failed"))).toBe(true);
  });

  test("survey counts rows verify dropped", async () => {
    const { result } = await runScript("survey", { question: "Q", items: ["a", "b", "c"], batchSize: 3 }, (_prompt, opts) =>
      opts.phase === "Verify" ? { rows: [row("a")] } : { rows: [row("a"), row("b"), row("c")] });
    expect(result).toMatchObject({ verified: true, dropped: 2, failures: [] });
    expect(result.table).toContain("kept 1, dropped 2");
  });

  test("investigate builds the brief itself when combine throws", async () => {
    const { result } = await runScript("investigate", { question: "Why?", questions: ["a?", "b?"] }, (prompt, opts) => {
      if (opts.phase === "Combine") throw new Error("quota");
      return prompt.includes("Question: a?") ? { answer: "yes", evidence: "x.ts:1", confirmed: true } : { answer: "maybe", evidence: "", confirmed: false };
    });
    expect(result.brief).toContain("Combine failed (quota)");
    expect(result.brief).toContain("## Confirmed\n- **a?** yes (x.ts:1)");
    expect(result.brief).toContain("## Unconfirmed\n- **b?** maybe");
    expect(result.failures).toEqual(["Combine: quota"]);
  });

  test("names failed agent calls and the first worker's output, only when something failed", async () => {
    const state = await setup();
    const planner = await roleThread(state, "planner");
    const history = () => [
      { type: "run", logVersion: 1 },
      { type: "call", status: "failed", phase: "Verify", childThreadId: "thr_w" },
      { type: "call", status: "succeeded", phase: "Scan", childThreadId: "thr_s" },
    ];
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "failed", error: "Workflow worker failed" }), history });
    let reply = await call(state, planner, survey());
    expect(reply).toContain("Failed agent calls: Verify ×1. First failure (Verify, thread thr_w): last output from thr_w");
    expect(calls("history")[0]![1]).toEqual(["workflows", "history", "wfr_1", "--cursor", "0", "--limit", "100", "--json"]);

    workflowsCli({ run: () => ({ runId: "wfr_2" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: ["Verify: x"] } }), history });
    reply = await call(state, planner, survey());
    expect(reply).toContain("status: partial\nFailed agent calls: Verify ×1");

    execFileMock.mockClear();
    workflowsCli({ run: () => ({ runId: "wfr_3" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: [] } }), history });
    expect(await call(state, planner, survey())).toContain("status: succeeded");
    expect(calls("history")).toHaveLength(0);
  });

  test.each([
    ["survey", { question: "Q", items: ["a", "b"], batchSize: 1 }, "Verify"],
    ["investigate", { question: "Q", questions: ["a?", "b?"] }, "Combine"],
  ] as const)("%s fails without %s when every scan failed", async (mode, args, later) => {
    const phases: string[] = [];
    await expect(runScript(mode, args, (_prompt, opts) => { phases.push(opts.phase); throw new Error("usage limit"); })).rejects.toThrow(/All .* failed/);
    expect(phases).not.toContain(later);
  });

  test("pre-flight refuses a provider that is not installed or out of quota, warns but starts when signed out, and fails open otherwise", async () => {
    let usage: (args: any) => unknown = () => ({});
    const state = await setup({ usageLimits: (args) => usage(args) });
    const planner = await roleThread(state, "planner");
    const provider = state.live.get(planner)!.providerId;
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: [] } }) });
    usage = () => ({ [provider]: { status: "ok", windows: [{ label: "5h", usedPercent: 100, resetsAt: "2026-10-08T12:00:00Z" }] } });
    await expect(call(state, planner, survey())).rejects.toThrow(/out of quota \(5h window at 100%, resets 2026-10-08T12:00:00Z\)/);
    usage = () => ({ [provider]: { status: "not_installed" } });
    await expect(call(state, planner, survey())).rejects.toThrow(/not_installed/);
    expect(calls("run")).toHaveLength(0);
    for (const status of ["unauthenticated", "expired"]) {
      usage = () => ({ [provider]: { status } });
      await call(state, planner, survey());
      expect(state.harness.logEntries.some((entry) => entry.level === "warn" && entry.message.includes(`${provider} reports ${status}`))).toBe(true);
    }
    expect(calls("run")).toHaveLength(2);
    usage = () => ({ [provider]: { status: "error", message: "x" } });
    await call(state, planner, survey());
    usage = () => { throw new Error("rpc down"); };
    await call(state, planner, survey());
    expect(calls("run")).toHaveLength(4);
  });

  test.each([
    ["throws synchronously", { usageLimits: () => { throw new Error("rpc down"); } }],
    ["is absent on an older host", {}],
  ])("pre-flight fails open when system.usageLimits %s", async (_case, system) => {
    const state = await setup({ system });
    const planner = await roleThread(state, "planner");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: [] } }) });
    await call(state, planner, survey());
    expect(calls("run")).toHaveLength(1);
  });

  test("configure gives Chief the optional-research cue only while on", async () => {
    const state = await setup();
    const threadId = await roleThread(state, "chief");
    const configured = () => state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
    const on = (await configured()).instructions;
    expect(on).toContain("chief_research is optional.");
    expect(on).toContain("do not rerun the same fan-out");
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
    const off = (await configured()).instructions;
    expect(off).not.toContain("chief_research is optional.");
    expect(off).not.toContain("do not rerun the same fan-out");
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
