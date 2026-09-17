import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
});

function configurationContext(threadId: string, projectId = "proj_1"): PluginAgentConfigurationContext {
  return {
    thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: projectId, kind: "standard", name: projectId === "proj_1" ? "Asha" : "Second", gitRemoteUrl: null },
    environment: { id: "env_1", name: "worktree", path: "/tmp/worktree", workspaceProvisionType: "managed-worktree", branchName: "chief/test" },
    host: { id: "host_1", name: "Local" },
    provider: { id: "codex", model: "model", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: "chief" },
  };
}

function catalogModel(model: string, reasoningEfforts = ["medium", "high"], isDefault = false) {
  return {
    id: model,
    model,
    displayName: model,
    description: "",
    isDefault,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
  };
}

async function setup(options: { hostStatus?: string; providerAvailable?: boolean } = {}) {
  let section: { id: string; name: string; createdAt: number; updatedAt: number } | null = null;
  let spawnIndex = 0;
  let sendFailures = 0;
  let getFailures = new Map<string, number>();
  let updateFailures = new Map<string, number>();
  const live = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const sent: any[] = [];
  const spawned: any[] = [];
  const catalogReads: (string | undefined)[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "chief",
    agentSkillIds: ["chief", "chief-worker"],
    sdk: {
      threadSections: {
        list: async () => section ? [section] : [],
        create: async ({ name }: { name: string }) => section = { id: "sec_chief", name, createdAt: 1, updatedAt: 1 },
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId === "proj_1" ? "Asha" : "Second", kind: "standard" }),
        fileContent: async () => { throw new Error("missing"); },
      },
      hosts: { list: async () => [{ id: "host_1", name: "Local", status: options.hostStatus ?? "connected" }] },
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_1" }) },
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", available: options.providerAvailable ?? true },
          { id: "claude-code", displayName: "Claude Code", available: true },
        ],
        models: async (args?: { providerId?: string }) => {
          catalogReads.push(args?.providerId);
          return {
            modelLoadError: null,
            providers: [],
            selectedOnlyModels: [],
            models: args?.providerId === "claude-code"
              ? [catalogModel("claude-opus-5", ["medium", "high"], true)]
              : [catalogModel("gpt-6-astra", ["medium", "high"], true), catalogModel("gpt-6-mini", ["medium"])],
          };
        },
      },
      threads: {
        spawn: async (args: any) => {
          spawned.push(args);
          spawnIndex += 1;
          const id = `thr_${spawnIndex}`;
          const thread = makeThreadResponse({
            id,
            projectId: args.projectId,
            environmentId: args.environment.type === "project-default" ? `env_default_${spawnIndex}` : "env_worker",
            title: args.title,
            sectionId: args.sectionId,
            visibility: args.visibility,
            status: "idle",
          });
          live.set(id, thread);
          return thread;
        },
        get: async ({ threadId }: { threadId: string }) => {
          const failures = getFailures.get(threadId) ?? 0;
          if (failures > 0) {
            getFailures.set(threadId, failures - 1);
            throw new Error("transient get");
          }
          const thread = live.get(threadId);
          if (!thread) throw new Error("not found");
          return thread;
        },
        update: async ({ threadId, ...changes }: any) => {
          const failures = updateFailures.get(threadId) ?? 0;
          if (failures > 0) {
            updateFailures.set(threadId, failures - 1);
            throw new Error("transient update");
          }
          const current = live.get(threadId);
          if (!current) throw new Error("not found");
          const next = { ...current, ...changes };
          live.set(threadId, next);
          return next;
        },
        send: async (args: any) => {
          if (sendFailures > 0) {
            sendFailures -= 1;
            throw new Error("transient send");
          }
          sent.push(args);
          return { ok: true, delivery: "sent" as const };
        },
        output: async ({ threadId }: { threadId: string }) => ({ output: `last output from ${threadId}` }),
      },
    },
  });
  await plugin(bb);
  disposals.push(() => harness.lifecycle.dispose());

  async function supervisorCycle() {
    const service = harness.behavior.runService("supervisor");
    await new Promise((resolve) => setTimeout(resolve, 15));
    service.controller.abort();
    await service.done;
  }

  return {
    harness,
    spawned,
    sent,
    live,
    catalogReads,
    section: () => section,
    failNextGet(threadId: string) { getFailures.set(threadId, (getFailures.get(threadId) ?? 0) + 1); },
    failNextUpdate(threadId: string) { updateFailures.set(threadId, (updateFailures.get(threadId) ?? 0) + 1); },
    failNextSend() { sendFailures += 1; },
    addLive(threadId: string, projectId: string, title = "Existing thread") {
      live.set(threadId, makeThreadResponse({
        id: threadId,
        projectId,
        environmentId: `env_${threadId}`,
        title,
        sectionId: null,
        visibility: "visible",
        status: "idle",
      }));
    },
    supervisorCycle,
  };
}

async function start(state: Awaited<ReturnType<typeof setup>>, projectId = "proj_1") {
  const result = await state.harness.behavior.runCli(["start", "--project", projectId, "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout!) as { threadId: string; created: boolean };
}

async function delegate(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, title = "Fix checkout totals") {
  const result = await state.harness.behavior.runCli([
    "delegate", "--title", title, "--mission", "Correct and verify totals", "--criteria", "Regression passes", "--json",
  ], { threadId: chiefThreadId, projectId: state.live.get(chiefThreadId)!.projectId });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout!) as { threadId: string; projectId: string };
}

async function status(state: Awaited<ReturnType<typeof setup>>) {
  return state.harness.behavior.callRpc("status", null);
}

describe("Chief backend", () => {
  test("creates the native section and files visible, clearly titled worktree threads", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    expect(state.section()?.name).toBe("Chief");
    expect(state.spawned[0]).toMatchObject({ title: "Chief · Asha", sectionId: "sec_chief", visibility: "visible", environment: { type: "project-default" } });
    expect(state.spawned[1]).toMatchObject({
      title: "Fix checkout totals",
      sectionId: "sec_chief",
      visibility: "visible",
      environment: { type: "host", hostId: "host_1", workspace: { type: "managed-worktree" } },
    });
  });

  test("starts or resolves a project Chief through RPC for frontend launchers", async () => {
    const state = await setup();
    const first = await state.harness.behavior.callRpc("start", { projectId: "proj_2" });
    const second = await state.harness.behavior.callRpc("start", { projectId: "proj_2" });

    expect(first).toEqual({ threadId: "thr_1", created: true });
    expect(second).toEqual({ threadId: "thr_1", created: false });
    expect(state.spawned[0]).toMatchObject({ projectId: "proj_2", title: "Chief · Second" });
  });

  test("creates multiple independent Chiefs for one project", async () => {
    const state = await setup();
    const first = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    const second = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });

    expect(first).toEqual({ threadId: "thr_1", created: true });
    expect(second).toEqual({ threadId: "thr_2", created: true });
    expect(state.spawned.map((thread) => thread.title)).toEqual([
      "Chief · Asha",
      "Chief · Asha · 2",
    ]);
    const rows = (await status(state)).threads.filter((thread) => thread.role === "chief");
    expect(rows).toHaveLength(2);
    expect(rows.every((thread) => thread.state !== "complete")).toBe(true);
  });

  test("keeps each same-project Chief's workers and controls independent", async () => {
    const state = await setup();
    const first = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    const second = await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    const firstWorker = await delegate(state, first.threadId, "First Chief work");
    const secondWorker = await delegate(state, second.threadId, "Second Chief work");

    const roster = await state.harness.behavior.callAgentTool(
      "chief_roster",
      {},
      { threadId: first.threadId, projectId: "proj_1" },
    );
    expect(JSON.stringify(roster)).toContain(firstWorker.threadId);
    expect(JSON.stringify(roster)).not.toContain(secondWorker.threadId);
    await expect(
      state.harness.behavior.callAgentTool(
        "chief_continue",
        { threadId: secondWorker.threadId, instruction: "Cross-control" },
        { threadId: first.threadId, projectId: "proj_1" },
      ),
    ).rejects.toThrow("for this Chief");
  });

  test("keeps one active Chief per project and scopes each roster", async () => {
    const state = await setup();
    const [first, second] = await Promise.all([start(state, "proj_1"), start(state, "proj_2")]);
    const firstWorker = await delegate(state, first.threadId, "First project task");
    const secondWorker = await delegate(state, second.threadId, "Second project task");
    const all = (await status(state)).threads;
    expect(all.filter((row) => row.role === "chief" && row.state !== "complete")).toHaveLength(2);
    expect(all.find((row) => row.threadId === firstWorker.threadId)?.chiefThreadId).toBe(first.threadId);
    expect(all.find((row) => row.threadId === secondWorker.threadId)?.chiefThreadId).toBe(second.threadId);

    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: first.threadId, projectId: "proj_1" });
    expect(JSON.stringify(roster)).toContain("First project task");
    expect(JSON.stringify(roster)).not.toContain("Second project task");
  });

  test("adopting a replacement Chief preserves other projects and reattaches this project's workers", async () => {
    const state = await setup();
    const first = await start(state, "proj_1");
    const second = await start(state, "proj_2");
    const worker = await delegate(state, first.threadId, "Move with replacement");
    state.addLive("thr_adopted", "proj_1");
    expect((await state.harness.behavior.runCli(["adopt", "--thread", "thr_adopted"])).exitCode).toBe(0);
    const all = (await status(state)).threads;
    expect(all.find((row) => row.threadId === first.threadId)?.state).toBe("complete");
    expect(all.find((row) => row.threadId === second.threadId)?.state).not.toBe("complete");
    expect(all.find((row) => row.threadId === worker.threadId)?.chiefThreadId).toBe("thr_adopted");
  });

  test("reconciles missed live status without false deletion or stale active timing", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)).toMatchObject({ state: "active", status: "active" });
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "pending" });
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)).toMatchObject({ state: "pending", status: "pending" });
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)).toMatchObject({ state: "idle", status: "idle" });
  });

  test("replaces a terminal Chief and transfers its workers and pending alerts", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for the successor",
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow();
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(chief.threadId)! });
    await state.supervisorCycle();
    const rows = (await status(state)).threads;
    const replacement = rows.find((row) => row.role === "chief" && row.threadId !== chief.threadId);
    expect(replacement).toBeDefined();
    expect(rows.find((row) => row.threadId === worker.threadId)?.chiefThreadId).toBe(replacement!.threadId);
    expect(state.sent.at(-1)?.threadId).toBe(replacement!.threadId);
  });

  test("retries transient get and filing failures without classifying the thread deleted", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, sectionId: null, visibility: "hidden" });
    state.failNextGet(worker.threadId);
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).not.toBe("deleted");
    state.failNextUpdate(worker.threadId);
    await state.supervisorCycle();
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).not.toBe("deleted");
    await state.supervisorCycle();
    expect(state.live.get(worker.threadId)).toMatchObject({ sectionId: "sec_chief", visibility: "visible" });
  });

  test("persists failed notifications and retries them before reporting delivery", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Tests pass and diff is ready",
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow("saved but could not be delivered");
    expect(state.sent).toHaveLength(0);
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].threadId).toBe(chief.threadId);
  });

  test("retries a failed lifecycle alert without duplicate delivery", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "idle result",
    });
    expect(state.sent).toHaveLength(0);
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(1);
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "idle result",
    });
    expect(state.sent).toHaveLength(1);
  });

  test("requires canonical ready and complete report payloads", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "ready" }, { threadId: worker.threadId })).rejects.toThrow();
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "blocked", blocker: "Need scope" }, { threadId: worker.threadId })).rejects.toThrow();
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "complete", result: "done" }, { threadId: worker.threadId })).rejects.toThrow();
  });

  test("refuses completion while a thread is running", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    const denied = await state.harness.behavior.runCli(["complete", worker.threadId]);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("while it is active");
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    expect((await state.harness.behavior.runCli(["complete", worker.threadId])).exitCode).toBe(0);
  });

  test("waits for an idle worker, starts a read-only review, and deduplicates concurrent requests", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    expect((await state.harness.behavior.runCli(["review", worker.threadId])).exitCode).toBe(1);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    const [first, second] = await Promise.all([
      state.harness.behavior.runCli(["review", worker.threadId, "--json"]),
      state.harness.behavior.runCli(["review", worker.threadId, "--json"]),
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
    expect(state.spawned.at(-1).prompt).toContain("read-only review");
  });

  test("reviews a ready worker without Chief asking for it", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed and covered by a test",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    const review = state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals");
    expect(review).toHaveLength(1);
    expect(review[0].environment).toEqual({ type: "reuse", environmentId: "env_worker" });
    // Chief must learn the review exists, or it completes the work before the verdict.
    expect(state.sent.at(-1).input[0].text).toContain("Read its report before completing");
    // A second idle event must not spawn a second reviewer.
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
  });

  test("enforces agent-tool authorization at execution time", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_delegate", {
      title: "Unauthorized", mission: "Must not start",
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow("active registered Chief");
    expect((await state.harness.behavior.runCli(["complete", worker.threadId])).exitCode).toBe(0);
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "late report",
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow("can no longer report");
  });

  test("inspects bounded live and persisted evidence", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready evidence" }, { threadId: worker.threadId });
    const inspected = await state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, { threadId: chief.threadId });
    expect(JSON.stringify(inspected)).toContain("Ready evidence");
    expect(JSON.stringify(inspected)).toContain(`last output from ${worker.threadId}`);
  });

  test("selects supervisor and reporting tools only for the matching roles", async () => {
    const state = await setup();
    const chiefId = (await start(state)).threadId;
    const workerId = (await delegate(state, chiefId)).threadId;
    const chief = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chiefId));
    const worker = await state.harness.behavior.resolveAgentConfiguration(configurationContext(workerId));
    const ordinary = await state.harness.behavior.resolveAgentConfiguration(configurationContext("thr_other"));
    expect(chief.tools.map((tool) => tool.name)).toEqual(["chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_review", "chief_complete"]);
    expect(chief.skills).toEqual(["chief"]);
    expect(worker.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(worker.skills).toEqual(["chief-worker"]);
    expect(ordinary.tools).toEqual([]);
  });

  test("stops the supervisor service cleanly on abort", async () => {
    const state = await setup();
    const service = state.harness.behavior.runService("supervisor");
    service.controller.abort();
    await expect(service.done).resolves.toBeUndefined();
  });

  test("spawns on BB defaults until a machine and role are given a model", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    expect(state.spawned[0]).not.toHaveProperty("providerId");
    expect(state.spawned[1]).not.toHaveProperty("model");
  });

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
        worker: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
        reviewer: null,
      },
      unusable: [],
    }]);

    await state.harness.behavior.callRpc("setRoleModel", { hostId: "host_1", role: "worker", selection: null });
    const cleared = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(cleared.hosts[0]!.selections.worker).toBeNull();
  });

  test("scans a machine's provider once no matter how many roles picked it", async () => {
    const state = await setup();
    for (const role of ["chief", "worker", "reviewer"]) {
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
    const result = await experimental_scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), { allow: [/^vitest$/, /^react$/, /^@testing-library\/react$/] });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
