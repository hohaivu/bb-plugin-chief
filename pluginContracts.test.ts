import { afterEach, describe, expect, test, vi } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { MIGRATIONS } from "./src/db/migrations";
import { AGENT_SKILL_IDS, HEAD_SHA, chiefReview, completeWorker, delegate, disposals, disposeAll, execFileMock, ghHead, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("Chief backend", () => {
  test("the full migration chain keeps a pre-v1 worker model pick", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief", agentSkillIds: AGENT_SKILL_IDS });
    const db = bb.storage.database();
    db.exec(`CREATE TABLE chief_models (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','worker','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`);
    db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("host_1", "worker", "codex", "gpt-6-astra", "high", Date.now());

    await plugin(bb);
    disposals.push(() => harness.lifecycle.dispose());

    const rewritten = db.prepare(`SELECT provider_id, model, reasoning_level FROM chief_models WHERE host_id=? AND role=?`).get("host_1", "worker");
    expect(rewritten).toEqual({ provider_id: "codex", model: "gpt-6-astra", reasoning_level: "high" });
    expect(db.prepare(`SELECT * FROM chief_models WHERE role IN ('junior','senior')`).all()).toEqual([]);
  });

  test("migration carries senior picks over as worker and drops junior picks", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-worker" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("chief_models_v5"))));
    const insert = db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run("host_1", "junior", "codex", "gpt-6-mini", "low", 1);
    insert.run("host_1", "senior", "codex", "gpt-6-astra", "high", 2);
    insert.run("host_2", "junior", "codex", "gpt-6-mini", "low", 3);

    bb.storage.migrate(db, MIGRATIONS);

    expect(db.prepare(`SELECT host_id, role, provider_id, model, reasoning_level FROM chief_models ORDER BY host_id, role`).all())
      .toEqual([{ host_id: "host_1", role: "worker", provider_id: "codex", model: "gpt-6-astra", reasoning_level: "high" }]);
    expect(() => insert.run("host_1", "junior", "codex", "gpt-6-mini", "low", 4)).toThrow();
  });

  test("chief_models_v7 migration keeps every model row and accepts a tester pick", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-tester" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("chief_models_v7"))));
    const insert = db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
    expect(() => insert.run("host_1", "tester", "codex", "gpt-6-mini", "low", 0)).toThrow();
    const roles = ["chief", "planner", "worker", "reviewer", "advisor", "designer"];
    roles.forEach((role, i) => insert.run("host_1", role, "codex", `model-${role}`, "high", i + 1));
    insert.run("host_2", "worker", "claude-code", "claude-opus-5", "medium", 99);
    const before = db.prepare(`SELECT * FROM chief_models ORDER BY host_id, role`).all();

    bb.storage.migrate(db, MIGRATIONS);

    expect(db.prepare(`SELECT * FROM chief_models ORDER BY host_id, role`).all()).toEqual(before);
    expect(() => insert.run("host_1", "tester", "codex", "gpt-6-mini", "low", 100)).not.toThrow();
    expect(() => insert.run("host_1", "junior", "codex", "gpt-6-mini", "low", 101)).toThrow();
  });

  test("explains a machine with no signed-in provider instead of offering a model", async () => {
    const state = await setup({ providerAvailable: false });
    const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
    // claude-code is still available, so the scan falls through to it.
    expect(configuration.hosts[0]!.fallback).toEqual({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" });

    const disconnected = await setup({ hostStatus: "disconnected" });
    const offline = await disconnected.harness.behavior.callRpc("modelConfiguration", null);
    expect(offline.hosts[0]).toMatchObject({ connected: false, fallback: null });
    expect(offline.hosts[0]!.error).toContain("disconnected");
  });

  test("imports only public SDK surfaces", async () => {
    // sonner is a host-provided runtime slot; scripts/ is dev tooling the build does not ship.
    const result = await experimental_scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), { allow: [/^vitest$/, /^react$/, /^sonner$/, /^@testing-library\/react$/] });
    // better-sqlite3 is a devDependency that test files use to build real db fixtures (agyHistory.test.ts); product code still may not import it.
    expect(result.violations.filter((v) => !v.file.startsWith("scripts/") && !(v.specifier === "better-sqlite3" && /\.test\.tsx?$/.test(v.file)))).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });

  test("bounds a hung forge CLI with a timeout, falling back to the raw reference as a branch instead of hanging", async () => {
    const seenOptions: any[] = [];
    execFileMock.mockImplementation((_file: string, _args: string[], options: any) => {
      seenOptions.push(options);
      return Promise.reject(Object.assign(new Error("terminated"), { signal: "SIGTERM", killed: true }));
    });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    expect((await chiefReview(state, chief.threadId, { pullRequest: "42" })).title).toBe("Review · 42");
    // Assert on recorded options after the await: an assertion inside the mock itself
    // would throw into resolvePullRequestBranch's own catch, producing the same
    // null-fallback the test expects either way, masking a missing timeout.
    expect(seenOptions.length).toBeGreaterThan(0);
    for (const options of seenOptions) expect(options?.timeout).toBeGreaterThan(0);
  });

  test("resolves an explicit GitHub PR URL through gh without inspecting the project's own remote", async () => {
    execFileMock.mockImplementation((file: string, args: string[]) => {
      if (file === "git") return Promise.resolve({ stdout: "git@gitlab.example.com:acme/widgets.git\n", stderr: "" });
      if (file === "gh") { expect(args).toContain("pr"); return Promise.resolve({ stdout: ghHead("feature/from-github"), stderr: "" }); }
      return Promise.reject(new Error(`unexpected CLI ${file}`));
    });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    expect((await chiefReview(state, chief.threadId, { pullRequest: "https://github.com/acme/widgets/pull/7" })).title).toBe("Review · feature/from-github");
    expect(execFileMock).not.toHaveBeenCalledWith("git", expect.anything(), expect.anything());
  });

  test("resolves a bare PR number's forge from the target project's own checkout, not the plugin process's cwd", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], options: any) => {
      expect(options.cwd).toBe("/repo/proj1");
      if (file === "git") return Promise.resolve({ stdout: "git@github.com:acme/widgets.git\n", stderr: "" });
      if (file === "gh") return Promise.resolve({ stdout: ghHead("feature/bare-number"), stderr: "" });
      return Promise.reject(new Error(`unexpected CLI ${file}`));
    });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    expect((await chiefReview(state, chief.threadId, { pullRequest: "42" })).title).toBe("Review · feature/bare-number");
  });

  test("resolves an owner/repo#number reference's forge as gitlab from the project's own remote", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], options: any) => {
      expect(options.cwd).toBe("/repo/proj1");
      if (file === "git") return Promise.resolve({ stdout: "git@gitlab.example.com:acme/widgets.git\n", stderr: "" });
      if (file === "glab") return Promise.resolve({ stdout: JSON.stringify({ source_branch: "feature/from-gitlab", sha: HEAD_SHA, target_branch: "main" }), stderr: "" });
      return Promise.reject(new Error(`unexpected CLI ${file}`));
    });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    expect((await chiefReview(state, chief.threadId, { pullRequest: "acme/widgets#9" })).title).toBe("Review · feature/from-gitlab");
  });

  test("a completed worker stays complete through later turns and reconciles", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await completeWorker(state, chief.threadId, worker.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)!.state).toBe("complete");
  });

  test("two concurrent delegations cannot share one branch", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const call = (title: string) => state.harness.behavior.callAgentTool("chief_delegate", {
      title, mission: "Correct totals", branch: "feature/shared", unplannedReason: "Bounded test fixture",
    }, opts);
    const results = await Promise.allSettled([call("First"), call("Second")]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason))
      .toContain("already carries the active worker");
  });

  test("the CLI refuses a managed thread's lifecycle commands; --json never eats a thread id", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const refused = await state.harness.behavior.runCli(
      ["delegate", "--title", "Sneaky", "--mission", "Spawn a sibling", "--unplanned-reason", "x"],
      { threadId: worker.threadId, projectId: "proj_1" },
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("chief_report");
    const inspected = await state.harness.behavior.runCli(["inspect", "--json", worker.threadId], { threadId: chief.threadId, projectId: "proj_1" });
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout!).threadId).toBe(worker.threadId);
  });

  test("a long worker result never clips the next call out of Chief's alert", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "x".repeat(7_900) }, { threadId: worker.threadId, projectId: "proj_1" });
    const alert = JSON.stringify(state.sent.at(-1));
    expect(alert).toContain("chief_review");
  });
});
