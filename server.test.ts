import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { MIGRATIONS, RESEARCH_SCRIPTS } from "./server";
import { checkPlan } from "./reportIntake";
import { managedSkills } from "./roles";
import type { TodoItem } from "./server";

// Stands in for git/gh/glab so pull-request resolution tests never shell out for real.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  const execFile: any = () => { throw new Error("execFile must be invoked through promisify"); };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => execFileMock(...args);
  return { execFile };
});

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
  execFileMock.mockReset();
});

// Every plan test needs a NOT-doing heading, so a single fixture keeps the wording pinned in one place.
const PLAN_FIXTURE = "# Plan\n\n## Contracts to verify\n- Totals stay non-negative\n\n## What we're NOT doing\n- x";
const wave = (n: number, text = "Do the work.") => `# Wave ${n}\n${text}\n\n## Contracts to verify\n- Wave ${n} keeps its invariant`;
// A plan worker's ready report must carry a Deviations heading.
const NO_DEVIATIONS = "\n\n## Deviations from plan\nNone";
// #159: every chain of a plan ends in a test wave (test: true), which defaults to depending on the wave before it.
// Plan files are artifacts of the data dir: <dataDir>/chief/<project>/<planner>/plan-<n>.md.
const planFile = (state: { storageRoot: string }, plannerThreadId: string, n: number) => join(state.storageRoot, "chief", "proj_1", plannerThreadId, `plan-${n}.md`);
const TEST_WAVE = (n: number, dependsOn?: number[]) => ({ body: wave(n, "Write the tests."), test: true, ...(dependsOn ? { dependsOn } : {}) });

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

async function setup(options: { hostStatus?: string; providerAvailable?: boolean; projectPath?: string; pluginId?: string; usageLimits?: (args: any) => unknown; system?: object } = {}) {
  const storageRoot = await mkdtemp(join(tmpdir(), "chief-plan-"));
  let section: { id: string; name: string; createdAt: number; updatedAt: number } | null = null;
  let spawnIndex = 0;
  let sendFailures = 0;
  let callerPermissionMode = "auto";
  let threadExecution: { model?: string } | null | undefined = null;
  let projectDefaults: { providerId: string; model: string } | null = null;
  let projectDefaultsReads = 0;
  let getFailures = new Map<string, number>();
  let patch = "diff --git a/totals.ts b/totals.ts\n+const total = subtotal - discount;";
  let updateFailures = new Map<string, number>();
  const live = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const pluginMetadataStore = new Map<string, any>();
  const queuedMessagesStore = new Map<string, any[]>();
  const sent: any[] = [];
  const eventsStore = new Map<string, any[]>();
  const spawned: any[] = [];
  const stopped: string[] = [];
  const catalogReads: (string | undefined)[] = [];
  const tabsStore = new Map<string, { revision: number; tabs: any[] }>();
  let tabsUpdateFailures = 0;
  const archivedEnvs: string[] = [];
  const archivedThreads: string[] = [];
  // Clean, on feature/x, and pushed (origin/feature/x exists with nothing ahead).
  const envStatus = (mergeBaseBranch?: string): any => ({
    outcome: "available",
    workspace: {
      workingTree: { hasUncommittedChanges: false, files: [] },
      checkout: { kind: "branch", branchName: "feature/x" },
      mergeBase: mergeBaseBranch ? { baseRef: "abc", aheadCount: 0, behindCount: 0 } : null,
    },
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: options.pluginId ?? "chief",
    agentSkillIds: ["chief", "chief-worker"],
    sdk: {
      system: options.system ?? { usageLimits: async (args: any) => options.usageLimits?.(args) ?? {} },
      threadSections: {
        list: async () => section ? [section] : [],
        create: async ({ name }: { name: string }) => section = { id: "sec_chief", name, createdAt: 1, updatedAt: 1 },
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: projectId === "proj_1" ? "Asha" : "Second",
          kind: "standard",
          ...(options.projectPath ? { sources: [{ path: options.projectPath, hostId: "host_1", isDefault: true }] } : {}),
        }),
        fileContent: async () => { throw new Error("missing"); },
        defaultExecutionOptions: async () => { projectDefaultsReads += 1; return projectDefaults; },
      },
      hosts: { get: async () => ({ id: "host_storage", threadStorageRootPath: join(storageRoot, "thread-storage") }), list: async () => [{ id: "host_1", name: "Local", status: options.hostStatus ?? "connected" }] },
      // Thread storage sits on host_storage, not this machine: a plan must be written through it.
      files: {
        write: async ({ hostId, path, content }: { hostId?: string; path: string; content: string }) => {
          if (hostId !== "host_storage") throw new Error(`wrote ${path} to host ${hostId}`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content);
          return {};
        },
        move: async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => { await rename(sourcePath, destinationPath); return {}; },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          id: environmentId, hostId: "host_1", workspaceProvisionType: environmentId.startsWith("env_worker") ? "managed-worktree" : null,
        }),
        status: async ({ mergeBaseBranch }: { mergeBaseBranch?: string }) => envStatus(mergeBaseBranch),
        archiveThreads: async ({ environmentId }: { environmentId: string }) => {
          archivedEnvs.push(environmentId);
          return { ok: true, archivedThreadIds: [...live.values()].filter((t) => t.environmentId === environmentId).map((t) => t.id) };
        },
        diffFiles: async () => ({ outcome: "available", files: [{ path: "totals.ts" }] }),
        diffPatch: async () => ({ outcome: "available", patches: [{ patch, truncated: false }] }),
      },
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", available: options.providerAvailable ?? true, capabilities: { permissionModes: ["accept-edits", "auto", "full"] } },
          { id: "claude-code", displayName: "Claude Code", available: true, capabilities: { permissionModes: ["accept-edits", "auto", "full"] } },
          { id: "acp-antigravity", displayName: "Antigravity", available: true, capabilities: { permissionModes: ["accept-edits", "full"] } },
        ],
        models: async (args?: { providerId?: string }) => {
          catalogReads.push(args?.providerId);
          return {
            modelLoadError: null,
            providers: [],
            selectedOnlyModels: [],
            models: args?.providerId === "acp-antigravity" ? [catalogModel("gemini-3-pro", ["medium", "high"], true)]
              : args?.providerId === "claude-code"
              ? [catalogModel("claude-opus-5", ["medium", "high"], true)]
              : [catalogModel("gpt-6-astra", ["medium", "high"], true), catalogModel("gpt-6-mini", ["medium"])],
          };
        },
      },
      threads: {
        events: { list: async ({ threadId }: { threadId: string }) => eventsStore.get(threadId) ?? [] },
        defaultExecutionOptions: async () => threadExecution === undefined ? null : ({ permissionMode: callerPermissionMode, ...(threadExecution ?? {}) }),
        spawn: async (args: any) => {
          spawned.push(args);
          spawnIndex += 1;
          const id = `thr_${spawnIndex}`;
          const thread = makeThreadResponse({
            id,
            projectId: args.projectId,
            // Each fresh worktree is its own environment (the first is env_worker); reuse keeps the given one.
            environmentId: args.environment.type === "project-default" ? `env_default_${spawnIndex}`
              : args.environment.type === "reuse" ? args.environment.environmentId
              : [...live.values()].some((t) => t.environmentId === "env_worker") ? `env_worker_${spawnIndex}` : "env_worker",
            title: args.title,
            sectionId: args.sectionId,
            visibility: args.visibility,
            status: "idle",
            // Seeding pluginMetadata always attributes the new thread to this plugin.
            originPluginId: args.pluginMetadata ? "chief" : null,
            parentThreadId: args.parentThreadId ?? null,
          });
          live.set(id, thread);
          if (args.pluginMetadata) pluginMetadataStore.set(id, args.pluginMetadata);
          return thread;
        },
        list: async ({ environmentId, archived, includeHidden }: { environmentId: string; archived?: boolean; includeHidden?: boolean }) => {
          return [...live.values()].filter((t) => t.environmentId === environmentId
            && (archived !== false || !t.archivedAt) && (includeHidden || t.visibility !== "hidden"));
        },
        archive: async ({ threadId }: { threadId: string }) => { archivedThreads.push(threadId); return { ok: true }; },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => pluginMetadataStore.get(threadId) ?? {},
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host_storage", storageRootPath: join(storageRoot, threadId) }),
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
        tabs: {
          get: async ({ threadId }: { threadId: string }) => tabsStore.get(threadId) ?? { revision: 0, tabs: [] },
          update: async ({ threadId, expectedRevision, tabs }: any) => {
            if (tabsUpdateFailures > 0) { tabsUpdateFailures -= 1; throw new Error("tabs update failed"); }
            const current = tabsStore.get(threadId) ?? { revision: 0, tabs: [] };
            if (current.revision !== expectedRevision) throw new Error("revision conflict");
            const next = { revision: current.revision + 1, tabs };
            tabsStore.set(threadId, next);
            return next;
          },
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => queuedMessagesStore.get(threadId) ?? [],
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stopped.push(threadId);
          live.set(threadId, { ...live.get(threadId)!, status: "idle" });
          return { ok: true as const };
        },
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
    db: bb.storage.database(),
    storageRoot,
    spawned,
    sent,
    seedEvents: (threadId: string, events: any[]) => eventsStore.set(threadId, events),
    stopped,
    live,
    catalogReads,
    archivedEnvs,
    archivedThreads,
    section: () => section,
    failNextGet(threadId: string) { getFailures.set(threadId, (getFailures.get(threadId) ?? 0) + 1); },
    failNextUpdate(threadId: string) { updateFailures.set(threadId, (updateFailures.get(threadId) ?? 0) + 1); },
    failNextSend() { sendFailures += 1; },
    setCallerPermissionMode(mode: string) { callerPermissionMode = mode; },
    /** undefined makes defaultExecutionOptions resolve null. */
    setThreadExecution(next: { model?: string } | null | undefined) { threadExecution = next; },
    setProjectDefaults(next: { providerId: string; model: string } | null) { projectDefaults = next; },
    projectDefaultsReads: () => projectDefaultsReads,
    tabs: (threadId: string) => tabsStore.get(threadId)?.tabs ?? [],
    seedTabs(threadId: string, tabs: any[]) { tabsStore.set(threadId, { revision: 7, tabs }); },
    failTabsUpdates(count: number) { tabsUpdateFailures = count; },
    setPatch(next: string) { patch = next; },
    seedQueuedMessage(threadId: string, text: string) {
      const existing = queuedMessagesStore.get(threadId) ?? [];
      existing.push({ content: [{ type: "text", text, mentions: [] }] });
      queuedMessagesStore.set(threadId, existing);
    },
    seedPluginMetadata(threadId: string, metadata: any) { pluginMetadataStore.set(threadId, metadata); },
    addLive(threadId: string, projectId: string, title = "Existing thread", originPluginId: string | null = null) {
      live.set(threadId, makeThreadResponse({
        id: threadId,
        projectId,
        environmentId: `env_${threadId}`,
        title,
        sectionId: null,
        visibility: "visible",
        status: "idle",
        originPluginId,
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

async function delegate(
  state: Awaited<ReturnType<typeof setup>>,
  chiefThreadId: string,
  title = "Fix checkout totals",
  forge?: { branch?: string; issueUrl?: string; prUrl?: string; replaces?: string; kind?: string },
) {
  const result = await state.harness.behavior.runCli([
    "delegate", "--title", title, "--mission", "Correct and verify totals", "--criteria", "Regression passes",
    ...(forge?.branch ? ["--branch", forge.branch] : []),
    ...(forge?.issueUrl ? ["--issue-url", forge.issueUrl] : []),
    ...(forge?.prUrl ? ["--pr-url", forge.prUrl] : []),
    ...(forge?.replaces ? ["--replaces", forge.replaces] : ["--unplanned-reason", "Bounded test fixture"]),
    ...(forge?.kind ? ["--kind", forge.kind] : []),
    "--json",
  ], { threadId: chiefThreadId, projectId: state.live.get(chiefThreadId)!.projectId });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout!) as { threadId: string; projectId: string };
}

// A plan of more than one implementation wave needs its one advisor review before any wave is delegated.
async function approvePlan(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, planThreadId: string) {
  const chiefCtx = { threadId: chiefThreadId, projectId: "proj_1" };
  await state.harness.behavior.callAgentTool("chief_consult", { planThreadId, title: "Plan", mission: "Review this plan before delegation" }, chiefCtx);
  const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
  await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "The plan is sound.", verdict: "approve" }, { threadId: advisor.threadId, projectId: "proj_1" });
}

// Waiving a plan's test waves (chief_skip_tests) drops them from the wave graph, so the implementation waves are the
// chain tips again: the graph the tests below were written against, before #159 made every chain end in a test wave.
async function waiveTests(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, planThreadId: string, testWaves: number[]) {
  for (const wave of testWaves) {
    await state.harness.behavior.callAgentTool("chief_skip_tests", { planThreadId, wave, reason: "graph under test is the implementation waves" }, { threadId: chiefThreadId, projectId: "proj_1" });
  }
}

async function status(state: Awaited<ReturnType<typeof setup>>) {
  return state.harness.behavior.callRpc("status", null);
}

// A two-wave schedule (wave 1 carrying the required "What
// we're NOT doing" section) shared by every delegate()-from-plan test below.
async function planTwoWaves(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string) {
  await state.harness.behavior.runCli(
    ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
    { threadId: chiefThreadId, projectId: state.live.get(chiefThreadId)!.projectId },
  );
  const planner = (await status(state)).threads.find((row) => row.role === "planner" && row.chiefThreadId === chiefThreadId)!;
  await state.harness.behavior.callAgentTool("chief_report", {
    state: "ready",
    result: "Two waves: schema, then its tests.",
    plan: [
      { body: PLAN_FIXTURE },
      TEST_WAVE(2),
    ],
  }, { threadId: planner.threadId, projectId: state.live.get(chiefThreadId)!.projectId });
  return {
    planner,
    path1: planFile(state, planner.threadId, 1),
    path2: planFile(state, planner.threadId, 2),
  };
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
      parentThreadId: chief.threadId,
      visibility: "visible",
      environment: { type: "host", hostId: "host_1", workspace: { type: "managed-worktree" } },
    });
  });

  test("files planner, worker and reviewer threads as children of their Chief", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: state.live.get(chief.threadId)!.projectId };
    expect((await state.harness.behavior.runCli(
      ["plan", "--title", "Plan checkout", "--mission", "Plan how to correct and verify the checkout totals"], opts,
    )).exitCode).toBe(0);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    expect((await state.harness.behavior.runCli(["review", worker.threadId], opts)).exitCode).toBe(0);
    expect(state.spawned.slice(1).map((entry: any) => entry.parentThreadId))
      .toEqual([chief.threadId, chief.threadId, chief.threadId]);
  });

  test.each([false, true])("sets lifecycleOwnerThreadId on child spawns only when cascadeArchive is %s", async (cascadeArchive) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true, cascadeArchive });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: state.live.get(chief.threadId)!.projectId };
    expect((await state.harness.behavior.runCli(
      ["plan", "--title", "Plan checkout", "--mission", "Plan how to correct and verify the checkout totals"], opts,
    )).exitCode).toBe(0);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    expect((await state.harness.behavior.runCli(["review", worker.threadId], opts)).exitCode).toBe(0);
    expect(state.spawned[0].lifecycleOwnerThreadId).toBeUndefined();
    expect(state.spawned.slice(1).map((entry: any) => entry.lifecycleOwnerThreadId))
      .toEqual(Array(3).fill(cascadeArchive ? chief.threadId : undefined));
  });

  test("after a transfer only the current owner sees and controls the work", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Original child worker");
    const ctx = { threadId: chief.threadId, projectId: "proj_1" };

    // Simulate a replacement Chief taking over the worker's chief_thread_id
    state.db.prepare(`UPDATE managed_threads SET chief_thread_id='thr_replacement' WHERE thread_id=?`).run(worker.threadId);

    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(worker.threadId)!, lastAssistantText: "x" });
    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, ctx);
    expect(JSON.stringify(roster)).not.toContain(worker.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, ctx)).rejects.toThrow("for this Chief");
    await expect(state.harness.behavior.callAgentTool("chief_continue", { threadId: worker.threadId, instruction: "Keep working" }, ctx)).rejects.toThrow("for this Chief");
    expect(state.db.prepare(`SELECT chief_thread_id FROM managed_threads WHERE thread_id=?`).get(worker.threadId))
      .toEqual({ chief_thread_id: "thr_replacement" });
  });

  test("auto-resolves and inspects an untracked child thread this plugin spawned outside chief_delegate", async () => {
    const state = await setup();
    const chief = await start(state);

    // Simulate a thread this plugin spawned (pluginMetadata + originPluginId prove it)
    // whose managed_threads row was never inserted, e.g. a restart in the gap.
    const childId = "thr_manual_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "Manual child task",
      sectionId: "sec_chief",
      visibility: "visible",
      status: "idle",
      originPluginId: "chief",
      parentThreadId: chief.threadId,
    }));
    state.seedPluginMetadata(childId, { role: "worker", chiefThreadId: chief.threadId });

    // Chief inspects the child thread directly - it auto-resolves and inspects
    const inspected = await state.harness.behavior.callAgentTool("chief_inspect", { threadId: childId }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(String(inspected)).toContain(childId);

    // Chief can continue it
    await state.harness.behavior.callAgentTool("chief_continue", { threadId: childId, instruction: "Proceed" }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1)).toMatchObject({ threadId: childId, senderThreadId: chief.threadId });
  });

  test("does not adopt a user-created sub-thread under Chief that this plugin never spawned", async () => {
    const state = await setup();
    const chief = await start(state);

    // A thread the user created directly in the BB UI under Chief: live, same
    // project, correct parent — but no pluginMetadata this plugin ever seeded.
    const childId = "thr_user_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "User's own sub-thread",
      sectionId: null,
      visibility: "visible",
      status: "idle",
      originPluginId: null,
      parentThreadId: chief.threadId,
    }));

    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: childId }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow("for this Chief");
    expect(state.db.prepare(`SELECT 1 FROM managed_threads WHERE thread_id=?`).get(childId)).toBeUndefined();
  });

  test("does not adopt a deleted or archived child thread even if this plugin spawned it", async () => {
    const state = await setup();
    const chief = await start(state);

    const childId = "thr_deleted_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "Deleted child",
      sectionId: null,
      visibility: "visible",
      status: "idle",
      originPluginId: "chief",
      parentThreadId: chief.threadId,
      deletedAt: Date.now(),
    }));
    state.seedPluginMetadata(childId, { role: "worker", chiefThreadId: chief.threadId });

    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: childId }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow("for this Chief");
    expect(state.db.prepare(`SELECT 1 FROM managed_threads WHERE thread_id=?`).get(childId)).toBeUndefined();
  });

  test("rejects chief_continue and chief_inspect from a Chief already superseded", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    // Trigger the real supersede path: an archived Chief with an orphaned active
    // worker gets replaced, and spawnChief marks the old Chief row complete.
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(chief.threadId)! });
    await state.supervisorCycle();
    const rows = (await status(state)).threads;
    expect(rows.find((row) => row.threadId === chief.threadId)?.state).toBe("complete");

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "Keep going" }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow();
    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow();
  });

  test("does not let a non-Chief caller insert a row via chief_inspect", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);

    const childId = "thr_worker_child";
    state.live.set(childId, makeThreadResponse({
      id: childId,
      projectId: "proj_1",
      environmentId: "env_manual",
      title: "Child of a worker",
      sectionId: null,
      visibility: "visible",
      status: "idle",
      originPluginId: "chief",
      parentThreadId: worker.threadId,
    }));
    state.seedPluginMetadata(childId, { role: "worker", chiefThreadId: worker.threadId });

    await expect(state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: childId }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow();
    expect(state.db.prepare(`SELECT 1 FROM managed_threads WHERE thread_id=?`).get(childId)).toBeUndefined();
  });

  test("starts or resolves a project Chief through RPC for frontend launchers", async () => {
    const state = await setup();
    const first = await state.harness.behavior.callRpc("start", { projectId: "proj_2" });
    const second = await state.harness.behavior.callRpc("start", { projectId: "proj_2" });

    expect(first).toEqual({ threadId: "thr_1", created: true });
    expect(second).toEqual({ threadId: "thr_1", created: false });
    expect(state.spawned[0]).toMatchObject({ projectId: "proj_2", title: "Chief · Second" });
  });

  test("pins one Chief pending tab after the user's tabs when Chief starts", async () => {
    const state = await setup();
    state.seedTabs("thr_1", [{ kind: "git-diff", id: "user_diff" }]);
    await state.harness.behavior.callRpc("start", { projectId: "proj_1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await state.harness.behavior.callRpc("start", { projectId: "proj_1" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(state.tabs("thr_1")).toEqual([
      { kind: "git-diff", id: "user_diff" },
      { kind: "plugin-panel", id: "plugin-panel:chief%3Apending%3A:none", pluginId: "chief", actionId: "pending", title: "Chief to-do", paramsJson: null },
    ]);
  });

  test("pins the pending tab under the host's canonical id", async () => {
    const pluginId = "chief.dev:v2/@x";
    const state = await setup({ pluginId });
    await state.harness.behavior.callRpc("start", { projectId: "proj_1" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Host recipe (buildFixedPanelTabId): path `${pluginId}:${actionId}:${paramsJson ?? ""}`, encoded once, then `:none`.
    const hostId = "plugin-panel:chief.dev%3Av2%2F%40x%3Apending%3A:none";
    expect(state.tabs("thr_1")).toEqual([
      { kind: "plugin-panel", id: hostId, pluginId, actionId: "pending", title: "Chief to-do", paramsJson: null },
    ]);
  });

  test("a failing tab pin never fails Chief start", async () => {
    const state = await setup();
    state.failTabsUpdates(2);
    expect(await state.harness.behavior.callRpc("start", { projectId: "proj_1" })).toEqual({ threadId: "thr_1", created: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(state.tabs("thr_1")).toEqual([]);
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

  test("keeps a ready report while the reporting turn is still live, then reviews", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    // chief_report runs inside the worker's own turn, so the live status is
    // still "active" for a while after the row is marked ready.
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    const before = state.db.prepare(`SELECT active_cycle FROM managed_threads WHERE thread_id=?`).get(worker.threadId) as any;
    await state.supervisorCycle();
    const after = state.db.prepare(`SELECT state, active_cycle FROM managed_threads WHERE thread_id=?`).get(worker.threadId) as any;
    expect(after.state).toBe("ready");
    expect(after.active_cycle).toBe(before.active_cycle);

    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    // Idle alone spawns no reviewer; Chief has to call chief_review itself.
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(0);
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
  });

  describe("waits for a just-reported worker to go idle", () => {
    const reviews = (state: Awaited<ReturnType<typeof setup>>) =>
      state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals");
    const reportWhileActive = async (state: Awaited<ReturnType<typeof setup>>) => {
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Totals fixed",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      return { chief, worker };
    };

    test("chief_review waits, then reviews", async () => {
      const state = await setup();
      const { chief, worker } = await reportWhileActive(state);
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const call = state.harness.behavior.callAgentTool(
          "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
        );
        await vi.advanceTimersByTimeAsync(4_000);
        expect(reviews(state)).toHaveLength(0);
        state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
        await vi.advanceTimersByTimeAsync(2_000);
        await call;
        expect(reviews(state)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    test("chief_review gives up after the wait cap", async () => {
      const state = await setup();
      const { chief, worker } = await reportWhileActive(state);
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const call = state.harness.behavior.callAgentTool(
          "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
        );
        const outcome = expect(call).rejects.toThrow("is active; wait until it is idle before starting a review");
        await vi.advanceTimersByTimeAsync(62_000);
        await outcome;
        expect(reviews(state)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    test("chief_review does not wait for a worker that has not reported", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        await expect(state.harness.behavior.callAgentTool(
          "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
        )).rejects.toThrow("is active; wait until it is idle before starting a review");
      } finally {
        vi.useRealTimers();
      }
    });

    test("chief_delegate replaces: waits, then hands off", async () => {
      const state = await setup();
      const { chief, worker } = await reportWhileActive(state);
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        const call = delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
        await vi.advanceTimersByTimeAsync(4_000);
        state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
        await vi.advanceTimersByTimeAsync(2_000);
        expect((await call).threadId).not.toBe(worker.threadId);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  test("keeps blocked while the live status is still stopping", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await state.harness.behavior.callAgentTool("chief_stop", {
      threadId: worker.threadId, reason: "looping on the same failing test",
    }, { threadId: chief.threadId, projectId: "proj_1" });
    // The live thread has not caught up to the stop yet.
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "stopping" });
    await state.supervisorCycle();
    const row = (await status(state)).threads.find((entry) => entry.threadId === worker.threadId)!;
    expect(row.state).toBe("blocked");
  });

  test("suppresses idle behind a queued (undelivered) report", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    const result = await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(result).toContain("Report queued for Chief");
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("is idle"))).toBe(false);
    const pending = state.db.prepare(`SELECT delivered_at FROM alert_outbox WHERE dedupe_key LIKE ?`).get(`${worker.threadId}:report:%`) as any;
    expect(pending).toBeDefined();
    expect(pending.delivered_at).toBeNull();
  });

  test("replaces a terminal Chief and transfers its workers and pending alerts", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for the successor",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(chief.threadId)! });
    await state.supervisorCycle();
    const rows = (await status(state)).threads;
    const replacement = rows.find((row) => row.role === "chief" && row.threadId !== chief.threadId);
    expect(replacement).toBeDefined();
    expect(rows.find((row) => row.threadId === worker.threadId)?.chiefThreadId).toBe(replacement!.threadId);
    expect(state.sent.at(-1)?.threadId).toBe(replacement!.threadId);
  });

  test("does not resurrect a terminal Chief when there are no active workers or pending alerts", async () => {
    const state = await setup();
    const chief = await start(state);
    expect(state.spawned).toHaveLength(1);
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(chief.threadId)! });
    await state.supervisorCycle();
    const rows = (await status(state)).threads;
    const activeChiefs = rows.filter((row) => row.role === "chief" && row.state !== "archived");
    expect(activeChiefs).toHaveLength(0);
    expect(state.spawned).toHaveLength(1);
  });

  test("does not auto-spawn Chief on startup or settings change by default", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
    expect(state.spawned).toHaveLength(0);
    await state.harness.behavior.setSettings({ chiefProject: "proj_2" });
    expect(state.spawned).toHaveLength(0);
    await state.supervisorCycle();
    expect(state.spawned).toHaveLength(0);
  });

  test("auto-spawns Chief on settings change when autoSpawn is enabled", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ autoSpawn: true });
    expect(state.spawned).toHaveLength(0);
    await state.harness.behavior.setSettings({ autoSpawn: true, chiefProject: "proj_1" });
    // allow async ensureChief triggered by onChange
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.spawned).toHaveLength(1);
    expect(state.spawned[0].title).toContain("Chief · Asha");
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
    const result = await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Tests pass and diff is ready",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(result).toContain("Report queued for Chief");
    expect(state.sent).toHaveLength(0);
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].threadId).toBe(chief.threadId);
    expect(state.sent[0].senderThreadId).toBe(worker.threadId);
  });

  test("sends no plugin alert on a plain idle or failed event", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    // BB's own native parent notice already covers a plain idle or failed
    // thread; the plugin must stay silent here with nothing pending.
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "idle result",
    });
    expect(state.sent).toHaveLength(0);
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });
    await state.harness.behavior.emitThreadEvent("thread.failed", {
      thread: state.live.get(worker.threadId)!,
      error: "boom",
    });
    expect(state.sent).toHaveLength(0);
  });

  async function failWith(state: Awaited<ReturnType<typeof setup>>, threadId: string, detail: string) {
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(threadId)! });
    state.seedEvents(threadId, [{ type: "provider/error", createdAt: Date.now(), data: { message: "Provider error", detail } }]);
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(threadId)!, error: null });
  }

  test("transient provider: usage limit alerts Chief once with a retry at the reset", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, `cpa API error (429): {"code":"model_cooldown","last_upstream_error":"usage_limit_reached: The usage limit has been reached","model":"gpt-6.1-sol","reset_seconds":2194,"reset_time":"36m34s"}`);
    expect(state.sent).toHaveLength(1);
    const text = state.sent[0].input[0].text;
    expect(state.sent[0].threadId).toBe(chief.threadId);
    expect(text).toContain("usage limit");
    expect(text).toContain("Usage limit resets at");
    expect(text).toContain(`bb thread retry ${worker.threadId} --send-at 38m`);
    expect(text).toContain("Do not spawn a replacement");
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(worker.threadId)!, error: null });
    expect(state.sent).toHaveLength(1);
  });

  test("transient provider: connection error alerts Chief with a short retry", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, "Connection error.");
    expect(state.sent).toHaveLength(1);
    const text = state.sent[0].input[0].text;
    expect(text).toContain(`bb thread retry ${worker.threadId} --send-at 2m`);
    expect(text).not.toContain("usage limit");
  });

  test("transient provider: a non-transient error stays silent", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, "context window exceeded");
    expect(state.sent).toHaveLength(0);
  });

  const MODEL_COOLDOWN = `cpa API error (429): {"code":"model_cooldown","model":"gpt-6-astra","reset_seconds":2194}`;
  /** Fails the thread on codex (model gpt-6-astra) with the given provider error. */
  async function coolDown(state: Awaited<ReturnType<typeof setup>>, threadId: string, detail: string) {
    state.live.set(threadId, { ...state.live.get(threadId)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    await failWith(state, threadId, detail);
  }
  const ISO = /cooling down until \d{4}-\d\d-\d\dT[\d:.]+Z/;

  test("cooldown: a per-model usage limit refuses chief_review on that model", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "reviewer", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: worker.threadId, projectId: "proj_1" });
    const sentBefore = state.sent.length;
    await coolDown(state, worker.threadId, MODEL_COOLDOWN);
    expect(state.sent.at(-1).input[0].text).toMatch(/work on codex\/gpt-6-astra is refused until \d{4}-/);
    expect(state.sent.length).toBe(sentBefore + 1);
    const spawnedBefore = state.spawned.length;
    await expect(state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts))
      .rejects.toThrow(/Provider codex model gpt-6-astra hit its usage limit/);
    await expect(state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts)).rejects.toThrow(ISO);
    expect(state.spawned).toHaveLength(spawnedBefore);
    // The refused call left nothing behind: once the cooldown expires, the review starts.
    state.db.prepare("UPDATE provider_cooldowns SET until_at=0").run();
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    expect(state.spawned).toHaveLength(spawnedBefore + 1);
  });

  test("cooldown: a provider-wide limit blocks delegate, plan, consult and branch review until it expires", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "429 usage_limit_reached");
    expect(state.db.prepare("SELECT provider_id, model FROM provider_cooldowns").all()).toEqual([{ provider_id: "codex", model: "" }]);
    // No role pick: the spawn would run on the project default.
    state.setProjectDefaults({ providerId: "codex", model: "gpt-6-mini" });
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const spawnedBefore = state.spawned.length;
    const tools: [string, Record<string, unknown>][] = [
      ["chief_delegate", { title: "Next", mission: "Do it", unplannedReason: "Bounded test fixture" }],
      ["chief_plan", { title: "Rework", mission: "Propose" }],
      ["chief_consult", { title: "Diagnose", mission: "Explore" }],
      ["chief_review", { branch: "feature/x" }],
    ];
    const sectionRow = () => state.db.prepare("SELECT value FROM plugin_meta WHERE key='section_id'").get();
    for (const [tool, params] of tools) {
      // The gate runs before ensureSection: a refused call writes no section row.
      state.db.prepare("DELETE FROM plugin_meta WHERE key='section_id'").run();
      await expect(state.harness.behavior.callAgentTool(tool, params, opts)).rejects.toThrow(/Provider codex hit its usage limit/);
      expect(sectionRow()).toBeUndefined();
    }
    expect(state.spawned).toHaveLength(spawnedBefore);
    state.db.prepare("UPDATE provider_cooldowns SET until_at=0").run();
    await state.harness.behavior.callAgentTool(...tools[0]!, opts);
    expect(state.spawned).toHaveLength(spawnedBefore + 1);
  });

  test("cooldown: a per-model cooldown leaves another model of the same provider alone", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "worker", selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, MODEL_COOLDOWN);
    await delegate(state, chief.threadId, "Second");
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
  });

  test("cooldown: a model_cooldown with no known model records nothing and blocks no other model", async () => {
    for (const execution of [undefined, {}]) {
      const state = await setup();
      await state.harness.behavior.callRpc("setRoleModel", {
        hostId: "host_1", role: "worker", selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" },
      });
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, providerId: "codex" });
      state.setThreadExecution(execution);
      await failWith(state, worker.threadId, MODEL_COOLDOWN);
      expect(state.db.prepare("SELECT * FROM provider_cooldowns").all()).toEqual([]);
      await delegate(state, chief.threadId, "Second");
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
    }
  });

  test("cooldown: a connection error records nothing, and no live cooldown costs no SDK read", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "Connection error.");
    expect(state.db.prepare("SELECT * FROM provider_cooldowns").all()).toEqual([]);
    await delegate(state, chief.threadId, "Second");
    expect(state.projectDefaultsReads()).toBe(0);
  });

  test("cooldown: an unknown provider records nothing and the alert still lands", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, providerId: "" });
    await failWith(state, worker.threadId, "429 usage_limit_reached");
    expect(state.db.prepare("SELECT * FROM provider_cooldowns").all()).toEqual([]);
    expect(state.sent.at(-1).input[0].text).not.toContain("is refused until");
  });

  /** A ready worker whose reviewer pick (codex/gpt-6-astra) is cooling down. */
  async function coolingReviewer() {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "reviewer", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: worker.threadId, projectId: "proj_1" });
    await coolDown(state, worker.threadId, MODEL_COOLDOWN);
    const review = () => state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" });
    return { state, chief, worker, review };
  }

  test("cooldown: a cooling reviewer is refused", async () => {
    const { state, review } = await coolingReviewer();
    const spawnedBefore = state.spawned.length;
    await expect(review()).rejects.toThrow(/Provider codex model gpt-6-astra hit its usage limit/);
    expect(state.spawned).toHaveLength(spawnedBefore);
  });

  test("cooldown: a refused review leaves the previous reviewer not complete", async () => {
    const { state, worker, review } = await coolingReviewer();
    state.db.prepare("UPDATE provider_cooldowns SET until_at=0").run();
    await review();
    const first = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Changes", verdict: "request_changes" }, { threadId: first.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed" }, { threadId: worker.threadId, projectId: "proj_1" });
    state.db.prepare("UPDATE provider_cooldowns SET until_at=?").run(Date.now() + 600_000);
    await expect(review()).rejects.toThrow(/hit its usage limit/);
    expect((state.db.prepare("SELECT state FROM managed_threads WHERE thread_id=?").get(first.threadId) as { state: string }).state).not.toBe("complete");
  });

  test("cooldown: worker, planner, advisor and branch review on a cooling project default are refused", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "429 usage_limit_reached");
    state.setProjectDefaults({ providerId: "codex", model: "gpt-6-mini" });
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    for (const [tool, params] of [
      ["chief_delegate", { title: "Next", mission: "Do it", unplannedReason: "Bounded test fixture" }],
      ["chief_plan", { title: "Rework", mission: "Propose" }],
      ["chief_consult", { title: "Diagnose", mission: "Explore" }],
      ["chief_review", { branch: "feature/x" }],
    ] as const) {
      await expect(state.harness.behavior.callAgentTool(tool, params, opts)).rejects.toThrow(/Provider codex hit its usage limit/);
    }
  });

  describe("bb chief stats", () => {
    type State = Awaited<ReturnType<typeof setup>>;
    const stats = async (state: State, context: { threadId?: string; projectId?: string } = {}) => {
      const result = await state.harness.behavior.runCli(["stats", "--project", "proj_1", "--json"], context);
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout!);
    };
    const reviewThenVerdict = async (state: State, chiefId: string, workerId: string, verdict: "approve" | "request_changes") => {
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: workerId, projectId: "proj_1" });
      const review = JSON.parse((await state.harness.behavior.runCli(["review", workerId, "--json"], { threadId: chiefId, projectId: "proj_1" })).stdout!);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", verdict }, { threadId: review.threadId, projectId: "proj_1" });
    };

    test("chief stats: an unplanned chain completes once; open and archived tasks count separately", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/x" });
      await reviewThenVerdict(state, chief.threadId, first.threadId, "request_changes");
      const fix = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: first.threadId });
      await reviewThenVerdict(state, chief.threadId, fix.threadId, "approve");
      expect((await state.harness.behavior.runCli(["complete", fix.threadId])).exitCode).toBe(0);
      await delegate(state, chief.threadId, "Open task", { branch: "feature/open" });
      const archived = await delegate(state, chief.threadId, "Archived task", { branch: "feature/gone" });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(archived.threadId)! });

      const result = await stats(state);
      expect(result.tasks).toEqual({ total: 3, completed: 1, open: 1, dropped: 1 });
      const chain = result.perTask.find((task: any) => task.key === "branch:proj_1:feature/x");
      expect(chain).toMatchObject({ status: "completed", workers: 2, replacements: 1, requestChanges: 1 });
      expect(result.wallTimeMs.completed).toBe(1);
      expect(result.repairs.replacements).toBe(1);
    });

    test("chief stats: a branchless replaces chain is one task", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: first.threadId, projectId: "proj_1" });
      await delegate(state, chief.threadId, "Fix checkout totals", { replaces: first.threadId });
      const result = await stats(state);
      expect(result.tasks.total).toBe(1);
      expect(result.perTask[0]).toMatchObject({ workers: 2, replacements: 1 });
    });

    test("chief stats: wave hand-offs are not repairs, and a plan stopped before its final wave is dropped", async () => {
      const state = await setup();
      const chief = await start(state);
      const { planner, path1, path2 } = await planTwoWaves(state, chief.threadId);
      const ctx = { threadId: chief.threadId, projectId: "proj_1" };
      const wave1 = JSON.parse((await state.harness.behavior.runCli(["delegate", "--title", "Wave 1", "--mission", `Implement ${path1}`, "--plan-thread", planner.threadId, "--wave", "1", "--json"], ctx)).stdout!);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Wave 1 done" }, { threadId: wave1.threadId, projectId: "proj_1" });
      expect((await stats(state)).tasks).toEqual({ total: 1, completed: 0, open: 1, dropped: 0 });
      expect((await state.harness.behavior.runCli(["complete", wave1.threadId])).exitCode).toBe(0);
      expect((await stats(state)).tasks.dropped).toBe(1);

      const wave2 = JSON.parse((await state.harness.behavior.runCli(["delegate", "--title", "Wave 2", "--mission", `Implement ${path2}`, "--plan-thread", planner.threadId, "--wave", "2", "--replaces", wave1.threadId, "--json"], ctx)).stdout!);
      await reviewThenVerdict(state, chief.threadId, wave2.threadId, "approve");
      expect((await state.harness.behavior.runCli(["complete", wave2.threadId])).exitCode).toBe(0);
      const result = await stats(state);
      expect(result.tasks).toEqual({ total: 1, completed: 1, open: 0, dropped: 0 });
      expect(result.perTask[0]).toMatchObject({ waves: 2, replacements: 0 });
    });

    test("chief stats: a parallel plan completes only once every chain's tip is ready", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      const ctx = { threadId: chief.threadId, projectId: "proj_1" };
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctx);
      const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Two independent waves.",
        plan: [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [] }],
      }, { threadId: planner.threadId, projectId: "proj_1" });
      const delegateWave = async (n: number) => JSON.parse((await state.harness.behavior.runCli([
        "delegate", "--title", `Wave ${n}`, "--mission", "Do it", "--plan-thread", planner.threadId, "--wave", String(n), "--branch", `feature/w${n}`, "--json",
      ], ctx)).stdout!) as { threadId: string };
      const w1 = await delegateWave(1);
      const w2 = await delegateWave(2);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Wave 2 done" }, { threadId: w2.threadId, projectId: "proj_1" });
      expect((await state.harness.behavior.runCli(["complete", w2.threadId])).exitCode).toBe(0);
      // Wave 2 is the last wave by number but wave 1's chain is still running.
      expect((await stats(state)).tasks.completed).toBe(0);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Wave 1 done" }, { threadId: w1.threadId, projectId: "proj_1" });
      expect((await state.harness.behavior.runCli(["complete", w1.threadId])).exitCode).toBe(0);
      expect((await stats(state)).tasks).toMatchObject({ total: 1, completed: 1 });
    });

    test("chief stats: counts usage-limit, connection and non-transient failures once each", async () => {
      const state = await setup();
      const chief = await start(state);
      const a = await delegate(state, chief.threadId, "A");
      const b = await delegate(state, chief.threadId, "B");
      const c = await delegate(state, chief.threadId, "C");
      await failWith(state, a.threadId, "cpa API error (429): usage_limit_reached");
      await failWith(state, b.threadId, "Connection error.");
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(c.threadId)! });
      await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(c.threadId)!, error: null });
      await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(c.threadId)!, error: null });
      expect((await stats(state)).failures).toMatchObject({ usageLimit: 1, connection: 1, threadErrors: 1 });
    });

    test("chief stats: a busy rejection keeps its message and is counted", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await expect(state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
      )).rejects.toThrow(`Worker ${worker.threadId} is active; wait until it is idle before starting a review.`);
      expect((await stats(state)).failures.busyRejections).toBe(1);
    });

    test("chief stats: scoped like status, with text notes", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      const other = JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!);
      await delegate(state, other.threadId, "Other task");

      expect((await stats(state)).tasks.total).toBe(2);
      const own = await stats(state, { threadId: chief.threadId, projectId: "proj_1" });
      expect(own.tasks.total).toBe(1);
      expect(own.scope.chiefThreadId).toBe(chief.threadId);
      expect(typeof own.statsSince).toBe("number");
      expect((await stats(state, {})).scope.chiefThreadId).toBeNull();
      const byChief = JSON.parse((await state.harness.behavior.runCli(["stats", "--chief", other.threadId, "--json"])).stdout!);
      expect(byChief.perTask.map((task: any) => task.title)).toEqual(["Other task"]);

      expect((await state.harness.behavior.runCli(["stats"], { threadId: worker.threadId, projectId: "proj_1" })).exitCode).toBe(1);
      const text = (await state.harness.behavior.runCli(["stats", "--project", "proj_1"])).stdout!;
      expect(text).toContain("Tasks:");
      expect(text).toContain("Not measured:");
    });
  });

  test("supersedes an undelivered alert instead of re-delivering it after a newer report", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    const firstResult = await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "First report",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(firstResult).toContain("Report queued for Chief");
    expect(state.sent).toHaveLength(0);

    // A newer report lands before the failed one is ever retried.
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Second report",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].input[0].text).toContain("Second report");

    // The first attempt's alert is still sitting undelivered; a retry sweep must not
    // resurrect it now that Chief has already received what actually happened next.
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(1);
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("First report"))).toBe(false);
  });

  test("does not let an ordinary lifecycle alert evict a report still waiting for delivery", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    const result = await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Needs review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(result).toContain("Report queued for Chief");
    expect(state.sent).toHaveLength(0);

    // Generic lifecycle noise (a different alert "kind") must never evict the
    // still-undelivered report alert above.
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "idle result",
    });
    await state.supervisorCycle();
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("Needs review"))).toBe(true);
  });

  test("identical re-report in the same cycle sends once", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
  });

  test("retry does not re-send an alert BB already queued", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.failNextSend();
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(0);
    const outboxRow = state.db.prepare(`SELECT message FROM alert_outbox WHERE dedupe_key LIKE ?`)
      .get(`${worker.threadId}:report:%`) as any;
    state.seedQueuedMessage(chief.threadId, outboxRow.message);
    await state.supervisorCycle();
    expect(state.sent).toHaveLength(0);
    const delivered = state.db.prepare(`SELECT delivered_at FROM alert_outbox WHERE dedupe_key LIKE ?`)
      .get(`${worker.threadId}:report:%`) as any;
    expect(delivered.delivered_at).not.toBeNull();
  });

  test("self-woken turn after a report sends no idle alert", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(state.sent).toHaveLength(1);
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done again",
    });
    expect(state.sent).toHaveLength(1);
  });

  test("sends no idle alert after a delivered planner or blocked-worker report", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Plan written", plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2)],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    const sentAfterPlan = state.sent.length;
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(planner.threadId)!,
      lastAssistantText: "done",
    });
    expect(state.sent).toHaveLength(sentAfterPlan);
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("is idle"))).toBe(false);

    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "blocked", blocker: "Missing scope", recommendation: "Ask the user",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    const sentAfterBlocked = state.sent.length;
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    expect(state.sent).toHaveLength(sentAfterBlocked);
    expect(state.sent.some((entry: any) => entry.input[0].text.includes("is idle"))).toBe(false);
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
    expect(state.spawned.at(-1).prompt).toContain("Remain review-only");
    // The reviewer confirms the automated criteria ran instead of taking the worker's word for it.
    expect(state.spawned.at(-1).prompt).toContain("Confirm the automated criteria actually ran with their exit status; list the manual criteria that still need a human to confirm.");
  });

  test("starts a review for a plain branch with no managed worker, on a fresh worktree based on it", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix", "--json"], opts);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout!) as { threadId: string; title: string; created: boolean };
    expect(parsed.created).toBe(true);
    expect(parsed.title).toBe("Review · feature/legacy-fix");
    const spawnedReview = state.spawned.find((entry) => entry.title === "Review · feature/legacy-fix");
    expect(spawnedReview).toMatchObject({
      parentThreadId: chief.threadId,
      environment: {
        type: "host", hostId: "host_1",
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/legacy-fix" } },
      },
    });
    expect(spawnedReview.prompt).toContain("Remain review-only");
    expect(spawnedReview.prompt).toContain("feature/legacy-fix");
  });

  test("returns the existing reviewer instead of duplicating one for the same branch", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const [first, second] = await Promise.all([
      state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix", "--json"], opts),
      state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix", "--json"], opts),
    ]);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(state.spawned.filter((entry) => entry.title === "Review · feature/legacy-fix")).toHaveLength(1);
    // A later, no-longer-in-flight call must also return the same reviewer, not spawn another.
    const third = await state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix", "--json"], opts);
    expect(JSON.parse(third.stdout!).created).toBe(false);
    expect(state.spawned.filter((entry) => entry.title === "Review · feature/legacy-fix")).toHaveLength(1);
  });

  test.each([
    ["both a worker and a branch", true],
    ["neither a worker nor a branch/pull request", false],
  ])("rejects chief_review given %s", async (_name, both) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const params = both ? { workerThreadId: worker.threadId, branch: "feature/legacy-fix" } : {};
    await expect(state.harness.behavior.callAgentTool(
      "chief_review", params, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow("Give exactly one of workerThreadId, pullRequest, or branch.");
  });

  test("a branch reviewer's row records the branch, and reports through the same verdict contract as a worker's reviewer", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix", "--json"], opts);
    const { threadId: reviewerThreadId } = JSON.parse(result.stdout!) as { threadId: string };
    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, opts) as string;
    expect(roster).toContain("branch: feature/legacy-fix");
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Reviewed the branch", verdict: "approve",
    }, { threadId: reviewerThreadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: approve");
  });

  test("does not review a ready worker until Chief calls chief_review", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed and covered by a test",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    // The report itself already names the exact next call.
    expect(state.sent.at(-1).input[0].text).toContain(`chief_review (workerThreadId: ${worker.threadId})`);
    const sentBeforeIdle = state.sent.length;
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    // Idle alone spawns no reviewer and sends no extra alert.
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(0);
    expect(state.sent).toHaveLength(sentBeforeIdle);

    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const review = state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals");
    expect(review).toHaveLength(1);
    expect(review[0].environment).toEqual({ type: "reuse", environmentId: "env_worker" });
    // A second chief_review call must not spawn a second reviewer.
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
  });

  test("keeps a busy reviewer instead of spawning a second one", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready again",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );

    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
  });

  test("starts a fresh reviewer after the worker fixes what it found", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const ready = async () => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Ready for review",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    await ready();
    const firstReviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals are off by the discount", verdict: "request_changes",
    }, { threadId: firstReviewer.threadId, projectId: "proj_1" });
    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });

    await ready();

    // A fresh reviewer, not the finished one asked to re-check — but its verdict
    // and pointer travel forward so the fresh reviewer can pick up where it left off.
    const reviewSpawns = state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals");
    expect(reviewSpawns).toHaveLength(2);
    for (const entry of reviewSpawns) {
      expect(entry.environment).toEqual({ type: "reuse", environmentId: "env_worker" });
    }
    expect((await status(state)).threads.find((row) => row.threadId === firstReviewer.threadId)?.state).toBe("complete");
    expect(reviewSpawns[1].prompt).toContain("Totals are off by the discount");
    expect(reviewSpawns[1].prompt).toContain("Verdict: request_changes");
    expect(reviewSpawns[1].prompt).toContain("The previous review");
    expect(state.sent.filter((entry) => entry.threadId === firstReviewer.threadId)
      .some((entry) => entry.input[0].text.includes("Re-check"))).toBe(false);
    // The worker's own ready report names the exact next call; chief_review itself sends no alert.
    expect(state.sent.at(-1).input[0].text).toContain(`chief_review (workerThreadId: ${worker.threadId})`);
  });

  test("dedups the worker's pending review even when the report and reviewer turnaround share a millisecond", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");

    // Freeze the clock across the worker's report, the reviewer spawn, and the
    // reviewer's own report: comparing updated_at would find them all equal and
    // wrongly still recommend a review, since nothing in that comparison could
    // tell the two reports apart. The report_seq tie has to do it instead.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
      const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Looks correct", verdict: "approve",
      }, { threadId: reviewer.threadId, projectId: "proj_1" });

      const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
      expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("picks the newest reviewer round even when both rounds share a millisecond", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    const workerOpts = { threadId: worker.threadId, projectId: "proj_1" };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, workerOpts);
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
      const first = (await status(state)).threads.find((row) => row.role === "reviewer")!;
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fix it", verdict: "request_changes" }, { threadId: first.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_complete", { threadId: first.threadId, result: "Round 1" }, opts);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed" }, workerOpts);
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
      const second = (await status(state)).threads.find((row) => row.role === "reviewer" && row.threadId !== first.threadId)!;
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Good", verdict: "approve" }, { threadId: second.threadId, projectId: "proj_1" });

      const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
      expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("does not bring back a spurious review once its reviewer is completed directly", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", verdict: "approve",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    // Complete the reviewer thread directly, not the worker — its row's state
    // moves to complete, which a state-filtered lookup would then skip, wrongly
    // making the worker look unreviewed again.
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: reviewer.threadId, result: "Reviewed" }, opts);

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);
  });

  test("routes on a reviewer's structured verdict and names a pair that stops converging", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const ready = async () => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Ready for review",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    await ready();
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

    // A rejection must be a field, not prose Chief has to parse back out.
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice",
    }, { threadId: reviewer.threadId, projectId: "proj_1" })).rejects.toThrow(/verdict/);

    const reject = async (reviewerThreadId: string) => state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice", verdict: "request_changes",
    }, { threadId: reviewerThreadId, projectId: "proj_1" });
    await reject(reviewer.threadId);
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: request_changes");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.at(-1).input[0].text).not.toContain("not converging");
    expect(state.sent.at(-1).input[0].text).not.toContain("chief_consult");
    expect(JSON.stringify(await state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
    ))).toContain("Verdict: request_changes");

    // Second round on the same objection: the fix cycle spawns a fresh reviewer,
    // which carries the reject_streak forward — Chief is told to escalate, not to
    // fund a third round.
    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await ready();
    const secondReviewer = (await status(state)).threads.find((row) => row.role === "reviewer" && row.state !== "complete")!;
    expect(secondReviewer.threadId).not.toBe(reviewer.threadId);
    await reject(secondReviewer.threadId);
    expect(state.sent.at(-1).input[0].text).toContain("not converging");
    expect(state.sent.at(-1).input[0].text).toContain("escalate to the user");
    expect(state.sent.at(-1).input[0].text).toContain(`Call chief_consult (workerThreadId: ${worker.threadId}) only when a finding is disputed`);
    expect(state.sent.at(-1).input[0].text).toContain(`hand it straight to a fresh worker with chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.at(-1).input[0].text).not.toContain("Before starting another worker round");
  });

  test("tester model: a kind tester spawn uses the Tester pick when set, else the Worker pick", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "worker", selection: { providerId: "codex", model: "gpt-6-mini", reasoningLevel: "medium" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const unset = await delegate(state, chief.threadId, "Test unset", { kind: "tester", replaces: worker.threadId });
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });

    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "tester", selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    await delegate(state, chief.threadId, "Test set", { kind: "tester", replaces: unset.threadId });
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
    // The Tester pick is not the Worker pick: a plain worker stays on the Worker model.
    await delegate(state, chief.threadId, "Plain work");
    expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });

    const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(configuration.hosts[0]!.selections.tester).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
  });

  describe("designer kind", () => {
    const opts = (chiefThreadId: string) => ({ threadId: chiefThreadId, projectId: "proj_1" });
    const rowOf = (state: any, threadId: string) => state.db.prepare("SELECT role, kind FROM managed_threads WHERE thread_id=?").get(threadId);

    test("chief_delegate kind designer adds the design-work section; the role stays worker", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId, "Draw the checkout screen", { kind: "designer" });
      const prompt: string = state.spawned.at(-1).prompt;
      expect(prompt).toContain("## Design work");
      expect(prompt).toContain("paper-mcp-instructions");
      expect(prompt).toContain("finish_working_on_nodes");
      expect(rowOf(state, worker.threadId)).toEqual({ role: "worker", kind: "designer" });
      expect(state.spawned.at(-1).pluginMetadata.role).toBe("worker");
      const roster = JSON.stringify(await state.harness.behavior.callAgentTool("chief_inspect", { threadId: worker.threadId }, opts(chief.threadId)));
      expect(roster).toContain("Kind: designer");
    });

    test("plain chief_delegate has no design-work section and no kind", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      expect(state.spawned.at(-1).prompt).not.toContain("## Design work");
      expect(rowOf(state, worker.threadId)).toEqual({ role: "worker", kind: null });
      expect(JSON.stringify(await state.harness.behavior.callAgentTool("chief_roster", {}, opts(chief.threadId)))).not.toContain("kind:");
    });

    test("replaces: keeps the designer kind; an explicit kind wins", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId, "Draw the checkout screen", { kind: "designer" });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Drawn" }, { threadId: first.threadId, projectId: "proj_1" });
      const second = await delegate(state, chief.threadId, "Draw the checkout screen", { replaces: first.threadId });
      expect(state.spawned.at(-1).prompt).toContain("## Design work");
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Drawn" }, { threadId: second.threadId, projectId: "proj_1" });
      const third = await delegate(state, chief.threadId, "Wire the checkout screen", { replaces: second.threadId, kind: "worker" });
      expect(state.spawned.at(-1).prompt).not.toContain("## Design work");
      expect(rowOf(state, third.threadId).kind).toBeNull();
    });

    test("reviewer of a designer gets the design check", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId, "Draw the checkout screen", { kind: "designer" });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Drawn" }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts(chief.threadId));
      expect(state.spawned.at(-1).prompt).toContain("This is design work: check the result with the design tool's screenshots (read-only)");
    });
  });

  describe("verdict file", () => {
    const reviewed = async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" });
      const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
      return { state, chief, worker, reviewer, path: join(state.storageRoot, reviewer.threadId, "verdict.md") };
    };
    const findings = `${"The discount is applied twice. ".repeat(80)}END-OF-FINDINGS`;

    test("persists a reviewer's full verdict to a file and names it in the alert and inspect", async () => {
      const { state, chief, worker, reviewer, path } = await reviewed();
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, verdict: "request_changes", regression: true, recommendation: "Apply it once",
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      const file = await readFile(path, "utf8");
      expect(file).toContain(findings);
      expect(file).toContain("Verdict: request_changes\nRegression: yes");
      expect(file).toContain(`Reviewed worker: ${worker.threadId}`);
      expect(file).toContain("## Recommendation\n\nApply it once");
      const alert: string = state.sent.at(-1).input[0].text;
      expect(alert).toContain(`Verdict: request_changes\nVerdict file: ${path}`);
      expect(alert.indexOf("Verdict file:")).toBeLessThan(alert.indexOf("Result:"));
      expect(JSON.stringify(await state.harness.behavior.callAgentTool(
        "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
      ))).toContain(`Verdict file: ${path}`);
    });

    test("hands a replacement worker the reviewer's verdict file", async () => {
      const { state, chief, worker, reviewer, path } = await reviewed();
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, verdict: "request_changes",
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
      const prompt: string = state.spawned.at(-1).prompt;
      expect(prompt).toContain(`Verdict file (read it in full): ${path}`);
      expect(prompt).toContain("names a plan file or verdict file, read that file in full");
    });

    test("a failed verdict-file write does not fail the report", async () => {
      const { state, chief, reviewer } = await reviewed();
      // A plain file where the reviewer's storage directory should be makes the write fail.
      await writeFile(join(state.storageRoot, reviewer.threadId), "not a directory");
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, verdict: "approve",
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      expect(state.sent.at(-1).input[0].text).toContain("Verdict: approve");
      expect(state.sent.at(-1).input[0].text).not.toContain("Verdict file:");
      expect(JSON.stringify(await state.harness.behavior.callAgentTool(
        "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
      ))).not.toContain("Verdict file:");
    });
  });

  test("does not misfire the not-converging escalation on a phase's first rejection", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const ready = async (result: string) => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result,
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    const verdict = (reviewerThreadId: string, value: "approve" | "request_changes") =>
      state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Phase reviewed", verdict: value,
      }, { threadId: reviewerThreadId, projectId: "proj_1" });
    const latestReviewer = async () => (await status(state)).threads.find((row) => row.role === "reviewer" && row.state !== "complete")!;

    // Phase 1 approved, then phase 2's fresh reviewer approves again — active_cycle
    // must not read as prior disagreement just because it is climbing.
    await ready("Phase 1 implemented");
    await verdict((await latestReviewer()).threadId, "approve");

    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await ready("Phase 2 implemented");
    await verdict((await latestReviewer()).threadId, "approve");

    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await ready("Phase 3 implemented");

    // Phase 3's very first rejection must not read as two rounds of disagreement.
    await verdict((await latestReviewer()).threadId, "request_changes");
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: request_changes");
    expect(state.sent.at(-1).input[0].text).not.toContain("not converging");
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(3);
  });

  test("routes a first rejection that reports a regression straight to a fresh worker", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "This broke the tax calculation", verdict: "request_changes", regression: true,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    const text = state.sent.at(-1).input[0].text as string;
    expect(text).toContain("introduced a new problem");
    expect(text).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(text).not.toContain("chief_consult (workerThreadId");
    expect(text).not.toContain("not converging");
    const consultAction = `The reviewer requires changes. The reviewer reports this change introduced a new problem; make the fix's brief name it. Hand the fix to a fresh worker with chief_delegate (replaces: ${worker.threadId}); its findings are attached automatically. Escalate if the disagreement is a genuine decision.`;
    expect(text).toContain(consultAction);

    // The roster must recommend the exact same next step, not a second inline wording.
    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" }));
    expect(roster).toContain(`: ${consultAction}`);
  });

  test.each([
    ["tells Chief to complete work its reviewer approved", {}],
    ["ignores a regression flag on an approval", { regression: true }],
  ])("%s", async (_name, extra) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks good", verdict: "approve", ...extra,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    const text = state.sent.at(-1).input[0].text as string;
    expect(text).toContain("Verdict: approve");
    expect(text).toContain("The reviewer approves. Complete this work, then mark the pull request ready.");
    expect(text).not.toContain("chief_consult");
  });

  test("hands the reviewer the brief and report the work was judged against", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed and covered by a test",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const review = state.spawned.find((entry: any) => entry.title === "Review · Fix checkout totals");
    // Without the brief the reviewer scores the change against a standard nobody set.
    expect(review.prompt).toContain("Correct and verify totals");
    expect(review.prompt).toContain("Regression passes");
    expect(review.prompt).toContain("Totals fixed and covered by a test");
    expect(review.prompt).toContain(`bb chief inspect ${worker.threadId}`);
  });

  test("keeps a plan file path in the reviewer's brief excerpt behind a long-but-valid mission", async () => {
    const state = await setup();
    const chief = await start(state);
    // A long mission alone can push "## Context" — where a plan file path now lives,
    // since ## Context is assembled last in the stored brief — past a tail-only clip
    // of the reviewer's brief excerpt.
    const mission = "Correct and verify totals. ".repeat(300);
    const planPath = "/Users/example/.bb/thread-storage/thr_plan123/plan.md";
    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", mission,
      "--context", `Plan file: ${planPath}`, "--unplanned-reason", "Bounded test fixture", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);
    const worker = JSON.parse(result.stdout!) as { threadId: string };

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals fixed and covered by a test",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );

    const review = state.spawned.find((entry: any) => entry.title === "Review · Fix checkout totals");
    expect(review.prompt).toContain(planPath);
    // The head of the mission survives the same clip, alongside the tail.
    expect(review.prompt).toContain("Correct and verify totals.");
  });

  test("clips the worker's result in first and fresh reviewer prompts", async () => {
    const state = await setup();
    const chief = await start(state);
    let worker = await delegate(state, chief.threadId);
    const longResult = "r".repeat(5_000);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: longResult,
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );

    const review = state.spawned.find((entry: any) => entry.title === "Review · Fix checkout totals");
    const resultLine = review.prompt.split("## What the worker reported")[1].split("\n")[1];
    expect(resultLine.length).toBeLessThanOrEqual(300);
    expect(review.prompt).toContain(`bb chief inspect ${worker.threadId}`);

    // The fresh reviewer spawned after a fix clips the worker's new result the same way.
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Found an issue", verdict: "request_changes",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: longResult,
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const freshReviewSpawn = state.spawned.filter((entry: any) => entry.title === "Review · Fix checkout totals").at(-1)!;
    const freshResultLine = freshReviewSpawn.prompt.split("## What the worker reported")[1].split("\n")[1];
    expect(freshResultLine.length).toBeLessThanOrEqual(300);
    expect(freshReviewSpawn.prompt).toContain(`bb chief inspect ${worker.threadId}`);
  });

  test("keeps reviewers read-only however the continuation is phrased", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const review = JSON.parse((await state.harness.behavior.runCli(["review", worker.threadId, "--json"])).stdout!);
    // The removed --allow-edits flag must not resurface as an unreviewed edit path.
    await state.harness.behavior.runCli(["continue", review.threadId, "--instruction", "Fix it yourself", "--allow-edits"]);
    const text = state.sent.filter((entry: any) => entry.threadId === review.threadId).at(-1).input[0].text;
    expect(text).toContain("Remain review-only");
    expect(text).not.toContain("edits are allowed");
    const chiefTools = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(JSON.stringify(chiefTools.tools.find((tool: any) => tool.name === "chief_continue"))).not.toContain("allowEdits");
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
      expect(line).toMatch(/^- worker “Worker \d+” \(thr_\d+\): Start its review now: chief_review \(workerThreadId: thr_\d+\)\. Complete the work only on the reviewer's approve\.$/);
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
    const todo = async () => ((await state.harness.behavior.callRpc("pending", { threadId: chief.threadId })) as { items: TodoItem[] }).items.find((item) => item.id === "todo #1");
    const signals = () => state.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "pending").length;

    const count = signals();
    const added = await roster({ todo: { text: "Rebase onto main", after: "PR #42 merges" } });
    expect(added.startsWith("Pending:\n- 1 waiting todo (#1) hidden")).toBe(true);
    expect(await roster({ includeWaiting: true })).toContain("- todo #1: Rebase onto main (after: PR #42 merges)");
    expect(await todo()).toMatchObject({ id: "todo #1", label: "Rebase onto main (after: PR #42 merges)", status: "open", done: false });
    expect(signals()).toBe(count + 1);
    const cli = await state.harness.behavior.runCli(["status", "--project", "proj_1"]);
    expect(cli.stdout).toContain("- todo #1: Rebase onto main (after: PR #42 merges)");

    expect(await roster({ todo: { id: 1, text: "Rebase onto #43", after: "" } })).toContain("- todo #1: Rebase onto #43");
    expect(await todo()).toMatchObject({ label: "Rebase onto #43", done: false });
    await roster({ todo: { id: 1, state: "done" } });
    expect(await todo()).toMatchObject({ label: "Rebase onto #43", status: "done", done: true });
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
    ))).toContain("- todo #1: Ship docs");

    const other = await start(state, "proj_2");
    const otherOpts = { threadId: other.threadId, projectId: "proj_2" };
    expect(String(await state.harness.behavior.callAgentTool("chief_roster", {}, otherOpts))).not.toContain("todo #1");
    await expect(state.harness.behavior.callAgentTool("chief_roster", { todo: { id: 1, state: "done" } }, otherOpts)).rejects.toThrow("No todo #1");

    const worker = await delegate(state, replacement.threadId, "Fix checkout totals");
    await expect(state.harness.behavior.callAgentTool(
      "chief_roster", { todo: { text: "Sneaky" } }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow("requires an active registered Chief");
  });

  test("the pending RPC lists every item and signals only on change", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const signals = () => state.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "pending").length;
    const items = async () => ((await state.harness.behavior.callRpc("pending", { threadId: chief.threadId })) as { items: TodoItem[] }).items;

    let count = signals();
    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    expect(signals()).toBeGreaterThan(count);
    expect(await items()).toEqual([expect.objectContaining({ id: worker.threadId, label: "worker “Fix checkout totals”", action: null, done: false })]);
    expect(await state.harness.behavior.callRpc("pending", { threadId: worker.threadId })).toEqual({ chief: false, items: [], doneOmitted: 0 });
    count = signals();
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    expect(signals()).toBe(count + 1);

    const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    const [item] = await items();
    expect(item).toMatchObject({ id: worker.threadId, status: "ready", done: false });
    expect(roster).toContain(item!.action!);

    count = signals();
    await state.supervisorCycle();
    await state.harness.behavior.callAgentTool("chief_roster", {}, opts);
    expect(signals()).toBe(count);

    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Shipped" }, opts);
    expect(signals()).toBe(count + 1);
    expect(await items()).toEqual([expect.objectContaining({ id: worker.threadId, status: "complete", action: null, done: true })]);
  });

  test("the to-do list orders action, in-progress, open todos, then capped done", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const roster = (params: object) => state.harness.behavior.callAgentTool("chief_roster", params, opts);
    const pending = async () => (await state.harness.behavior.callRpc("pending", { threadId: chief.threadId })) as { items: TodoItem[]; doneOmitted: number };

    const ready = await delegate(state, chief.threadId, "Ready work");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: ready.threadId, projectId: "proj_1" });
    const active = await delegate(state, chief.threadId, "Active work");
    await roster({ todo: { text: "Open todo" } });
    await roster({ todo: { text: "Dropped todo" } });
    await roster({ todo: { id: 2, state: "dropped" } });

    let list = await pending();
    expect(list.items.map((item) => item.id)).toEqual([ready.threadId, active.threadId, "todo #1", "todo #2"]);
    expect(list.items.some((item) => item.id === chief.threadId)).toBe(false);
    expect(list.items[3]).toMatchObject({ status: "dropped", done: true });
    expect(list.doneOmitted).toBe(0);

    const insert = state.db.prepare(`INSERT INTO chief_todos (project_id, text, after, state, created_at, updated_at) VALUES ('proj_1', ?, NULL, 'done', 1, 1)`);
    for (let index = 0; index < 51; index++) insert.run(`Old ${index}`);
    list = await pending();
    expect(list.items.filter((item) => item.done)).toHaveLength(50);
    expect(list.items.filter((item) => item.done)[0]!.id).toBe("todo #2"); // newest first
    expect(list.doneOmitted).toBe(2);
  });

  test("the roster's Pending block uses the same wording as the lifecycle alert", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };

    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    const workerAlert = state.sent.at(-1).input[0].text as string;
    const workerAction = `Start its review now: chief_review (workerThreadId: ${worker.threadId}). Complete the work only on the reviewer's approve.`;
    expect(workerAlert).toContain(workerAction);
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("Pending:");
    expect(roster).toContain(`- worker “Fix checkout totals” (${worker.threadId}): ${workerAction}`);

    // Once the review is actually in flight, the worker drops out of Pending.
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", verdict: "approve",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    const reviewAlert = state.sent.at(-1).input[0].text as string;
    const approveAction = "The reviewer approves. Complete this work, then mark the pull request ready.";
    expect(reviewAlert).toContain(approveAction);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain(`- reviewer “Review · Fix checkout totals” (${reviewer.threadId}): ${approveAction}`);

    // Once Chief completes the worker, the approved reviewer must not keep advertising it.
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed" }, opts);
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
      state: "ready", result: "Off by one in the discount calc", verdict: "request_changes",
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
    expect(roster).toContain(`- planner “Plan · Rework checkout” (${planner.threadId}): Delegate wave 1 now: chief_delegate (planThreadId: ${planner.threadId}, wave: 1). The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.`);

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
    expect(chief.tools.map((tool) => tool.name)).toEqual(["chief_forge_init", "chief_delegate", "chief_spawn_child", "chief_plan", "chief_consult", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete", "chief_research"]);
    expect(chief.skills).toEqual(["chief"]);
    expect(worker.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(worker.skills).toEqual(["chief-worker"]);
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
    await state.harness.behavior.runCli(["review", worker.threadId, "--json"]);
    // insertThread only runs after threads.spawn resolves, so the tool set for a
    // brand-new thread's first turn cannot depend on that row already existing —
    // it has to come from what was seeded into pluginMetadata at spawn time.
    expect(state.spawned.at(-1).pluginMetadata).toEqual({ role: "reviewer", chiefThreadId: chief.threadId });

    const resolved = await state.harness.behavior.resolveAgentConfiguration({
      ...configurationContext("thr_not_yet_persisted"),
      pluginMetadata: { role: "reviewer", chiefThreadId: chief.threadId },
    });
    expect(resolved.tools.map((tool: any) => tool.name)).toContain("chief_report");
    expect(resolved.skills).toEqual(["chief-worker"]);
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
      state: "ready", result: "Confirmed against the regression test", verdict: "approve",
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

  test("hands Chief a forge script instead of the plumbing to reassemble", async () => {
    const state = await setup();
    const chief = await start(state);
    const script = await state.harness.behavior.callAgentTool(
      "chief_forge_init",
      { title: "Fix checkout totals" },
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
      "chief_forge_init", { title: "Fix checkout totals" }, { threadId: chief.threadId, projectId: "proj_1" },
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
      "chief_forge_init", { title: "Fix checkout totals" }, { threadId: chief.threadId, projectId: "proj_1" },
    ) as string;
    expect(result).toContain("```sh");
    expect(result).toContain("CHIEF_FORGE");
    if (!projectPath) expect(execFileMock.mock.calls.filter(([file]) => file === "sh")).toHaveLength(0);
    else expect(result).toContain("so run it yourself");
  });

  test("keeps the delegation policy and project rules out of every spawn prompt", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], opts,
    );
    const worker = await delegate(state, chief.threadId);
    const workerReview = JSON.parse((await state.harness.behavior.runCli(["review", worker.threadId, "--json"], opts)).stdout!) as { threadId: string };
    const branchReview = JSON.parse((await state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix", "--json"], opts)).stdout!) as { threadId: string };

    // Both live in what bb.agents.configure puts into every turn: the chief skill
    // and the rules. A second copy in a spawn prompt is one that can drift.
    expect(state.spawned[0].prompt).not.toContain("high blast radius");
    for (const entry of state.spawned) {
      const text = (entry.prompt ?? entry.input?.[0]?.text ?? "") as string;
      expect(text).not.toContain("## Project rules");
    }

    // The built-in rules are Chief's own; a managed thread would only be told to call tools it lacks.
    const chiefInstructions = (await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId))).instructions;
    expect(chiefInstructions).toContain("Chief operating rules");
    expect(chiefInstructions).toContain("In a managed thread's worktree, Chief only reads");
    expect(chiefInstructions).toContain("never a retry loop");
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    for (const threadId of [worker.threadId, planner.threadId, workerReview.threadId, branchReview.threadId]) {
      const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
      expect(configured.instructions).not.toContain("Chief operating rules");
      expect(configured.instructions).not.toContain("Chief only reads");
    }
  });

  test("does not repeat the planning instructions in the Chief spawn prompt", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const prompt = state.spawned[0].prompt as string;
    expect(prompt).not.toContain("chief_plan first");
    expect(prompt.indexOf("chief_plan")).toBeLessThan(prompt.indexOf("chief_forge_init"));
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configured.instructions).toContain("chief_plan first");
    expect(configured.instructions).toContain("delegate every wave the ready alert lists right away, one chief_delegate per wave in the same turn, without waiting for user sign-off");
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
    expect(configured.instructions).toContain("well-specified");
    expect(configured.instructions).toContain("chief_plan → chief_forge_init → chief_delegate");
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
      title: "Plan · X", mission: "Propose how to fix totals",
    }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(state.spawned.at(-1)?.title).toBe("Plan · X");
    await state.harness.behavior.callAgentTool("chief_consult", {
      title: "Consult · X", mission: "Diagnose totals",
    }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(state.spawned.at(-1)?.title).toBe("Consult · X");
  });

  test("plans read-only in the project's own checkout and spends no worktree", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const plan = await state.harness.behavior.callAgentTool("chief_plan", {
      title: "Rework checkout", mission: "Propose how to fix totals",
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
    const planPrompt = spawned.prompt as string;
    expect(planPrompt).toContain("do not create, modify, or delete any file it tracks");
    // The plan body goes through chief_report's plan field, never a direct file write.
    expect(planPrompt).toContain("chief_report's `plan` field");
    expect(planPrompt).not.toContain("$BB_THREAD_STORAGE");
    // Split success criteria and the out-of-scope section are the planner's contract, not an afterthought.
    expect(planPrompt).toContain("Read every file this brief names in full before proposing anything: no partial reads, no limit or offset.");
    expect(planPrompt).toContain("Split success criteria per wave into Automated Verification (a command a worker can run, reported with its exit status) and Manual Verification (what only a human can confirm)");
    expect(planPrompt).toContain("What we're NOT doing");
    expect(JSON.stringify(plan)).toContain("Its ready alert lists the wave schedule and the exact next call");

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
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Change totals.ts, then cover it with a test", plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2)],
    }, { threadId: planner.threadId, projectId: "proj_1" });

    const reported = state.sent.at(-1).input[0].text;
    // Not "Worker report": Chief has to see which role spoke.
    expect(reported).toContain("Planner report");
    const planPath = planFile(state, planner.threadId, 1);
    expect(reported).toContain("Plan: 2 wave(s)");
    expect(reported).toContain(`Wave 1 of 2: ${planPath}`);
    expect(reported).toContain(`Delegate wave 1 now: run chief_forge_init (planThreadId: ${planner.threadId}, wave: 1), then chief_delegate (planThreadId: ${planner.threadId}, wave: 1)`);
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
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
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
      state: "ready", result: "Done", plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2)],
    }, { threadId: worker.threadId, projectId: "proj_1" })).rejects.toThrow(/plan is only for a planner's ready report \(role is worker\)/);
  });

  test("a multi-wave plan writes one file per wave, persists the schedule, and alerts it without opening any plan file", async () => {
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

    const path1 = planFile(state, planner.threadId, 1);
    const path2 = planFile(state, planner.threadId, 2);
    const path3 = planFile(state, planner.threadId, 3);
    const path4 = planFile(state, planner.threadId, 4);
    expect(await readFile(path1, "utf8")).toBe(`${PLAN_FIXTURE}\n`);
    expect(await readFile(path2, "utf8")).toBe(`${wave(2, "Migrate the data.")}\n`);
    expect(await readFile(path3, "utf8")).toBe(`${wave(3, "Wire up delegation.")}\n`);

    const reported = state.sent.at(-1).input[0].text;
    expect(reported).toContain("Plan: 4 wave(s)");
    expect(reported).toContain(`Wave 1 of 4: ${path1}`);
    expect(reported).toContain(`Wave 2 of 4: ${path2}`);
    expect(reported).toContain(`Wave 3 of 4: ${path3}`);
    expect(reported).toContain(`Wave 4 of 4: ${path4}`);
    // Mirrored into Chief's storage so Chief can echo inline-vis previews.
    expect(await readFile(join(state.storageRoot, chief.threadId, "plans", planner.threadId, "plan-2.md"), "utf8")).toBe(`${wave(2, "Migrate the data.")}\n`);
    expect(reported).toContain(`::inline-vis{source="thread-storage" file="plans/${planner.threadId}/plan-1.md"}`);
    expect(reported).toContain(`Plan ${planner.threadId} has 3 implementation waves: get its one advisor review first`);
    expect(reported).not.toContain("Read that file in full");

    const persisted = state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planner.threadId) as { plan_waves: string };
    expect(JSON.parse(persisted.plan_waves)).toEqual([
      { path: path1, contracts: "- Totals stay non-negative", title: "Plan" },
      { path: path2, contracts: "- Wave 2 keeps its invariant", title: "Wave 2" },
      { path: path3, contracts: "- Wave 3 keeps its invariant", title: "Wave 3" },
      { path: path4, contracts: "- Wave 4 keeps its invariant", test: true, title: "Wave 4" },
    ]);
  });

  test("accepts a JSON-encoded wave array as a multi-wave plan", async () => {
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
      result: "Two waves, JSON-encoded.",
      plan: JSON.stringify([
        { body: PLAN_FIXTURE },
        { body: wave(2, "Migrate the data.") },
        TEST_WAVE(3),
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
      { path: path1, contracts: "- Totals stay non-negative", title: "Plan" },
      { path: path2, contracts: "- Wave 2 keeps its invariant", title: "Wave 2" },
      { path: path3, contracts: "- Wave 3 keeps its invariant", test: true, title: "Wave 3" },
    ]);
  });

  test("rejects a JSON-encoded wave array with an invalid wave", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
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
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const waves = Array.from({ length: 8 }, (_, index) => index === 7 ? TEST_WAVE(8) : ({
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
    for (const index of waves.keys()) {
      const path = planFile(state, planner.threadId, index + 1);
      expect(reported).toContain(`Wave ${index + 1} of 8: ${path}`);
    }
    expect(reported).toContain(`Plan ${planner.threadId} has 7 implementation waves: get its one advisor review first — chief_consult (planThreadId: ${planner.threadId}`);
  });

  test("rejects a planner's ready report with more than 8 waves", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    const tooManyWaves = Array.from({ length: 9 }, (_, index) => index === 8 ? TEST_WAVE(9) : ({
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
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
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
      expect(state.sent.at(-1).input[0].text).toContain("Delegate wave 1 now: chief_delegate");
    }
  });

  test.each([
    ["rejects", "wave 2 has no Contracts to verify heading", [{ body: PLAN_FIXTURE }, { body: "# Wave 2\nDo the work." }], /Wave 2 lacks a "## Contracts to verify"/],
    ["rejects", "Contracts to verify is bold text", "# Plan\n\n**Contracts to verify**\n- x\n\n## What we're NOT doing\n- x", /Wave 1 lacks a "## Contracts to verify"/],
    ["rejects", "the Contracts to verify section is empty", "# Plan\n\n## Contracts to verify\n\n## What we're NOT doing\n- x", /Wave 1 lacks a "## Contracts to verify"/],
    ["accepts", "Contracts to verify is a ### heading", "# Plan\n\n### Contracts to verify\n- x\n\n## What we're NOT doing\n- x", undefined],
  ])("%s a planner's ready report when %s", async (outcome, _name, plan, error) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
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

  test("a single-wave reviewer gets the Contracts to verify list even when the brief is clipped", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], opts);
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "One wave", plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2)],
    }, { threadId: planner.threadId, projectId: "proj_1" });
    const delegated = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "M".repeat(5_000),
      "--plan-thread", planner.threadId, "--wave", "1", "--json",
    ], opts);
    const worker = JSON.parse(delegated.stdout!) as { threadId: string };
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Wave 1 of 1 done.\n\n## Deviations from plan\nNone",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    // Waiving the test wave leaves the implementation worker as the chain's only tip, as the one-wave plan was.
    await state.harness.behavior.callAgentTool("chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, opts);

    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    const reviewSpawn = state.spawned.filter((entry: any) => entry.title === "Review · Fix checkout totals").at(-1)!;
    expect(reviewSpawn.prompt).toContain("## Contracts to verify\nWave 1 of 2:\n- Totals stay non-negative");
  });

  test("steers a continuation with the instruction first", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.runCli(
      ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    await state.harness.behavior.runCli(["continue", planner.threadId, "--instruction", "Name the test file"]);

    expect(state.sent.at(-1).mode).toBe("steer-if-active");
    const text = state.sent.at(-1).input[0].text as string;
    expect(text.startsWith("Name the test file")).toBe(true);
    expect(text.startsWith("Remain read-only")).toBe(false);
    // The read-only reminder still follows, unchanged in wording.
    expect(text).toContain("Remain read-only in the repository: do not create, modify, or delete any file it tracks. Submit the plan itself through chief_report's plan field, not as a file write. A worker implements the plan in its own worktree.");
  });

  test.each([
    ["planner", "fresh chief_plan"],
    ["reviewer", "fresh review with chief_review"],
    ["advisor", "fresh chief_consult"],
  ])("rejects an over-long %s instruction with a %s reroute", async (role, reroute) => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    if (role === "planner") await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], opts);
    if (role === "reviewer") await state.harness.behavior.runCli(["review", (await delegate(state, chief.threadId)).threadId], opts);
    if (role === "advisor") await state.harness.behavior.runCli(["consult", "--title", "Rework checkout", "--mission", "Explore a fix for the discount bug"], opts);
    const target = (await status(state)).threads.find((row) => row.role === role)!;
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === target.threadId).length;
    const result = await state.harness.behavior.runCli(["continue", target.threadId, "--instruction", "x".repeat(7_995)]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(reroute);
    expect(state.sent.filter((entry: any) => entry.threadId === target.threadId)).toHaveLength(sentBefore);
  });

  test("refuses chief_continue on a worker that already reported ready", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === worker.threadId).length;

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "Keep going" }, { threadId: chief.threadId, projectId: "proj_1" },
    )).rejects.toThrow(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore);
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).toBe("ready");

    const cliResult = await state.harness.behavior.runCli(["continue", worker.threadId, "--instruction", "Keep going"]);
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stderr).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore);
  });

  test("refuses chief_continue on a reviewer that already reported", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    expect(state.spawned.at(-1).prompt).toContain("file:line");
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Tax is off", verdict: "request_changes",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    const before = state.db.prepare("SELECT state, verdict, regression, reject_streak, verdict_path FROM managed_threads WHERE thread_id=?").get(reviewer.threadId);
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === reviewer.threadId).length;

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: reviewer.threadId, instruction: "Look again" }, opts,
    )).rejects.toThrow("chief_review");
    const cliResult = await state.harness.behavior.runCli(["continue", reviewer.threadId, "--instruction", "Look again"]);
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stderr).toContain("chief_review");
    expect(state.sent.filter((entry: any) => entry.threadId === reviewer.threadId)).toHaveLength(sentBefore);
    expect(state.db.prepare("SELECT state, verdict, regression, reject_streak, verdict_path FROM managed_threads WHERE thread_id=?").get(reviewer.threadId)).toEqual(before);
    expect(before).toMatchObject({ state: "ready", verdict: "request_changes", verdict_path: expect.any(String) });
  });

  test("refuses chief_continue on a worker that already reported complete", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed" }, opts);

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "Keep going" }, opts,
    )).rejects.toThrow(`chief_delegate (replaces: ${worker.threadId})`);
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)?.state).toBe("complete");
  });

  test("rejects a nudge over 500 characters but accepts one at the limit", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const worker = await delegate(state, chief.threadId);
    const sentBefore = state.sent.filter((entry: any) => entry.threadId === worker.threadId).length;

    await expect(state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "x".repeat(501) }, opts,
    )).rejects.toThrow(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore);

    await state.harness.behavior.callAgentTool(
      "chief_continue", { threadId: worker.threadId, instruction: "x".repeat(500) }, opts,
    );
    expect(state.sent.filter((entry: any) => entry.threadId === worker.threadId)).toHaveLength(sentBefore + 1);
  });

  test("consults a read-only advisor in the failing worker's worktree with its brief, verdicts, and branch", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "advisor",
      selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/fix-checkout-totals" });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals are off by the discount", verdict: "request_changes",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    await state.harness.behavior.callAgentTool("chief_consult", {
      title: "Fix checkout totals", mission: "Diagnose why the discount keeps failing review",
      workerThreadId: worker.threadId,
    }, { threadId: chief.threadId, projectId: "proj_1" });

    const spawned = state.spawned.at(-1);
    expect(spawned).toMatchObject({
      title: "Consult · Fix checkout totals",
      environment: { type: "reuse", environmentId: "env_worker" },
      pluginMetadata: { role: "advisor" },
      providerId: "codex",
    });
    expect(spawned.prompt).toBeDefined();
    expect(spawned.input).toBeUndefined();
    const prompt = spawned.prompt as string;
    expect(prompt).toContain("Remain advisory");
    expect(prompt).toContain("Correct and verify totals");
    expect(prompt).toContain("Regression passes");
    expect(prompt).toContain("Verdict: request_changes");
    expect(prompt).toContain("Totals are off by the discount");
    expect(prompt).toContain("feature/fix-checkout-totals");

    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(advisor.threadId));
    expect(configured.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(configured.skills).toEqual(["chief-worker"]);
  });

  test("consults without a worker in the project checkout, and only from Chief", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli(
      ["consult", "--title", "Rework checkout", "--mission", "Explore a fix for the discount bug"], opts,
    );
    expect(result.exitCode).toBe(0);
    expect(state.spawned.at(-1)).toMatchObject({ environment: { type: "project-default" } });

    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool(
      "chief_consult", { title: "Sneak one in", mission: "Not allowed" }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow(/active registered Chief/);

    const otherChief = await start(state, "proj_2");
    await expect(state.harness.behavior.callAgentTool(
      "chief_consult", { title: "Cross-chief", mission: "Not allowed", workerThreadId: worker.threadId },
      { threadId: otherChief.threadId, projectId: "proj_2" },
    )).rejects.toThrow("for this Chief");
  });

  test("hands an advisor's advice back to Chief and never auto-reviews it", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.runCli(
      ["consult", "--title", "Fix checkout totals", "--mission", "Diagnose the discount bug", "--worker", worker.threadId],
      { threadId: chief.threadId, projectId: "proj_1" },
    );
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is applied before the tax rounds",
    }, { threadId: advisor.threadId, projectId: "proj_1" });

    const reported = state.sent.at(-1).input[0].text;
    expect(reported).toContain("Advisor report");
    expect(reported).toContain(`chief_delegate (replaces: ${worker.threadId})`);

    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(advisor.threadId)!,
      lastAssistantText: "advice given",
    });
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);
  });

  test.each(["planner", "advisor"])("upgrading an existing database keeps its rows and admits the %s role", async (role) => {
    // The rebuild that widens the role CHECK drops live tables, so the upgrade
    // path is driven here against a real database rather than only a fresh one.
    const { bb, harness } = createFakePluginHost({ pluginId: `chief-upgrade-${role}` });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes(`'${role}'`))));

    if (role === "advisor") {
      // reject_streak and parent_thread_id are pre-existing columns by this point
      // in the migration chain; the rebuild must carry their nondefault values over.
      db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at, reject_streak, parent_thread_id)
        VALUES ('thr_old', 'worker', 'proj_1', 'thr_chief', 'Existing work', 'ready', 1, 2, 2, 'thr_parent')`).run();
    } else {
      db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at)
        VALUES ('thr_old', 'worker', 'proj_1', 'thr_chief', 'Existing work', 'ready', 1, 2)`).run();
    }
    db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES ('host_1', 'senior', 'codex', 'gpt-6-astra', 'high', 3)`).run();

    bb.storage.migrate(db, MIGRATIONS);

    if (role === "advisor") {
      expect(db.prepare(`SELECT title, state, reject_streak, parent_thread_id FROM managed_threads WHERE thread_id='thr_old'`).get())
        .toEqual({ title: "Existing work", state: "ready", reject_streak: 2, parent_thread_id: "thr_parent" });
    } else {
      expect(db.prepare(`SELECT title, state, chief_thread_id FROM managed_threads WHERE thread_id='thr_old'`).get())
        .toEqual({ title: "Existing work", state: "ready", chief_thread_id: "thr_chief" });
    }
    expect(db.prepare(`SELECT model, reasoning_level FROM chief_models WHERE host_id='host_1' AND role='worker'`).get())
      .toEqual({ model: "gpt-6-astra", reasoning_level: "high" });
    // Widening that CHECK is the whole point of the rebuild.
    expect(() => db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, title, state, created_at, updated_at)
      VALUES ('thr_new', ?, 'proj_1', 'New role', 'idle', 4, 4)`).run(role)).not.toThrow();
    expect(() => db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES ('host_1', ?, 'codex', 'gpt-6-astra', 'high', 5)`).run(role)).not.toThrow();
    // Dropping the table dropped its index; the roster scan needs it back.
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='managed_threads_chief'`).get())
      .toBeTruthy();
  });

  test("adds reject_streak to an existing database and survives a restart", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-reject-streak" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    const beforeRejectStreak = MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("reject_streak")));
    bb.storage.migrate(db, beforeRejectStreak);

    db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at)
      VALUES ('thr_old', 'reviewer', 'proj_1', 'thr_chief', 'Existing review', 'ready', 1, 2)`).run();

    bb.storage.migrate(db, MIGRATIONS);

    expect(db.prepare(`SELECT title, reject_streak FROM managed_threads WHERE thread_id='thr_old'`).get())
      .toEqual({ title: "Existing review", reject_streak: 0 });
    expect(() => db.prepare(`UPDATE managed_threads SET reject_streak=reject_streak+1 WHERE thread_id='thr_old'`).run()).not.toThrow();
    // A restart re-runs the full, now-longer migration list against an already-upgraded database.
    expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();
  });

  test("drops the retired Jev tables and forgets its verified key on an existing database", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-drop-jev" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    const beforeDrop = MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("reject_streak")) + 1);
    bb.storage.migrate(db, beforeDrop);

    db.prepare(`INSERT INTO jev_scores (worker_thread_id, base_branch, evaluation, updated_at)
      VALUES ('thr_worker', 'main', '{}', 1)`).run();
    db.prepare(`INSERT INTO jev_metric_stats (metric, samples, abstained, score_sum, updated_at)
      VALUES ('correctness', 1, 0, 8, 1)`).run();
    db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('jev_verified', 'fingerprint')`).run();

    expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();

    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='jev_scores'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='jev_metric_stats'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT value FROM plugin_meta WHERE key='jev_verified'`).get()).toBeUndefined();
  });

  test("stops the supervisor service cleanly on abort", async () => {
    const state = await setup();
    const service = state.harness.behavior.runService("supervisor");
    service.controller.abort();
    await expect(service.done).resolves.toBeUndefined();
  });

  test("alerts a stalled thread once with evidence and a ladder, then once to stop it at twice the threshold", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });

      nowSpy.mockReturnValue(t0 + 61_000);
      await state.supervisorCycle();
      const afterSoft = state.sent.length;
      const softAlert = state.sent.at(-1).input[0].text;
      expect(softAlert).toContain("has been active for 1 minutes");
      expect(softAlert).toContain(`last output from ${worker.threadId}`);
      expect(softAlert).toContain("chief_stop");
      expect(softAlert).toContain(`chief_delegate (replaces: ${worker.threadId})`);
      expect(softAlert).toContain(`chief_consult (workerThreadId: ${worker.threadId})`);

      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterSoft);

      nowSpy.mockReturnValue(t0 + 121_000);
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterSoft + 1);
      const hardAlert = state.sent.at(-1).input[0].text;
      expect(hardAlert).toContain("twice the 1-minute stall threshold");
      expect(hardAlert).toContain("Stop it now with chief_stop");

      const afterHard = state.sent.length;
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterHard);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a supervisor that first sees a thread past twice the threshold sends only the stop alert", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });

      nowSpy.mockReturnValue(t0 + 121_000);
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(1);
      expect(state.sent.at(-1).input[0].text).toContain("Stop it now with chief_stop");

      await state.supervisorCycle();
      expect(state.sent).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a continued thread earns fresh stall alerts in its new active cycle", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker.threadId)! });

      nowSpy.mockReturnValue(t0 + 121_000);
      await state.supervisorCycle();
      expect(state.sent.at(-1).input[0].text).toContain("Stop it now with chief_stop");

      const continueTime = t0 + 121_000;
      nowSpy.mockReturnValue(continueTime);
      const continued = await state.harness.behavior.runCli(["continue", worker.threadId, "--instruction", "Try again"]);
      expect(continued.exitCode).toBe(0);
      const afterContinue = state.sent.length;

      nowSpy.mockReturnValue(continueTime + 61_000);
      await state.supervisorCycle();
      expect(state.sent).toHaveLength(afterContinue + 1);
      expect(state.sent.at(-1).input[0].text).toContain("has been active for 1 minutes");
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a reviewer's stall ladder points at a fresh review, not a replacement worker", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;

    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(reviewer.threadId, { ...state.live.get(reviewer.threadId)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

      nowSpy.mockReturnValue(t0 + 61_000);
      await state.supervisorCycle();
      const alert = state.sent.at(-1).input[0].text;
      expect(alert).toContain(`chief_review (workerThreadId: ${worker.threadId})`);
      expect(alert).not.toContain("chief_delegate");
    } finally {
      nowSpy.mockRestore();
    }
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
        planner: null,
        worker: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
        reviewer: null,
        advisor: null,
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
    // The forge stays Chief's: the brief has to say so, or the worker opens its own PR.
    expect(state.spawned[1].prompt).toContain("Your worktree is based on feature/fix-checkout-totals");
    expect(state.spawned[1].prompt).toContain("https://github.com/acme/shop/issues/7");
    expect(state.spawned[1].prompt).toContain("Do not create, merge, or mark ready any pull request");
    // The worker's ready report splits verification the same way the planner's does.
    expect(state.spawned[1].prompt).toContain("Read every file this brief names in full before acting or spawning anything: no partial reads, no limit or offset.");
    expect(state.spawned[1].prompt).toContain("splits verification into Automated (the command you ran and its exit status) and Manual (what only a human can confirm)");
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
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed" }, { threadId: chief.threadId, projectId: "proj_1" });
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
    const ready = async (threadId: string, result: string) => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result,
      }, { threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool(
        "chief_review", { workerThreadId: threadId }, { threadId: chief.threadId, projectId: "proj_1" },
      );
    };
    await ready(worker.threadId, "Totals fixed");
    const reviewer1 = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals are off by the discount", verdict: "request_changes",
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
    expect(freshWorkerSpawn.prompt).toContain("Totals are off by the discount");
    expect(freshWorkerSpawn.prompt).toContain("Your worktree is based on feature/fix-checkout-totals");

    const rows = (await status(state)).threads;
    expect(rows.find((row) => row.threadId === worker.threadId)?.state).toBe("complete");
    expect(rows.find((row) => row.threadId === reviewer1.threadId)?.workerThreadId).toBe(freshWorker.threadId);
    const freshWorkerRow = state.db.prepare(`SELECT branch, pr_url FROM managed_threads WHERE thread_id=?`).get(freshWorker.threadId) as any;
    expect(freshWorkerRow.branch).toBe("feature/fix-checkout-totals");
    expect(freshWorkerRow.pr_url).toBe("https://github.com/acme/shop/pull/8");

    // A fresh reviewer for the fresh worker, carrying reviewer1's verdict forward.
    await ready(freshWorker.threadId, "Discount fixed");
    const reviewer2 = (await status(state)).threads.find((row) => row.role === "reviewer" && row.state !== "complete")!;
    expect(reviewer2.threadId).not.toBe(reviewer1.threadId);
    expect(state.spawned.at(-1).prompt).toContain("The previous review");

    // Second straight rejection across the fresh worker and fresh reviewers: not converging.
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Still off by a cent", verdict: "request_changes",
    }, { threadId: reviewer2.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain("not converging");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_consult (workerThreadId: ${freshWorker.threadId}) only when`);
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
    expect(state.spawned.at(-1).prompt).toContain("## Contracts to verify\n- Totals stay non-negative\nKeep every item above.");

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
      { path: planFile(state, planner.threadId, 1), contracts: "- Totals stay non-negative", title: "Plan" },
      { path: planFile(state, planner.threadId, 2), contracts: "- Wave 2 keeps its invariant", test: true, title: "Wave 2" },
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
    expect(state.spawned.at(-1).prompt).toContain("## Contracts to verify\n- Totals stay non-negative");
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
    expect(reviewSpawn.prompt).toContain("Review the whole branch against its base against the plan wave files in review-context.md.");
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
    expect(roster).toContain("waves: 0/2 done, wave 1 starting, wave 2 starting");
    expect(roster).toContain(`: ${path2} (independent)`);
    expect(state.spawned.at(-1).prompt).toContain("This wave is independent");

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
    expect(reviewSpawn.prompt).toContain("Review each branch against its base against the plan wave files in review-context.md");

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
    const delegate = async (n: number, branch: string) => JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", `Wave ${n} work`, "--mission", "Do it",
      "--plan-thread", planner.threadId, "--wave", String(n), "--branch", branch, "--json",
    ], opts)).stdout!) as { threadId: string };
    await delegate(1, "feature/a");
    const w2 = await delegate(2, "feature/b");
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
    expect(roster).toContain("waves: 0/3 done, wave 1 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 1 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w1.threadId, projectId: "proj_1" });
    const w2 = JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "2", "--replaces", w1.threadId, "--json",
    ], opts)).stdout!) as { threadId: string };
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 1/3 done, wave 2 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 2 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w2.threadId, projectId: "proj_1" });
    const w3 = JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "3", "--replaces", w2.threadId, "--json",
    ], opts)).stdout!) as { threadId: string };
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 2/3 done, wave 3 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 3 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w3.threadId, projectId: "proj_1" });
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 2/3 done, wave 3 ready");

    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: w3.threadId }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 2/3 done, wave 3 in review");

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", verdict: "approve", findings: [],
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 3/3 done, wave 3 approved");
  });

  test("tells the worker the forge is Chief's even when only a pull request was created", async () => {
    const state = await setup();
    const chief = await start(state);
    // Branch creation can fail after the draft PR exists; the constraint still has to reach the worker.
    await delegate(state, chief.threadId, "Fix checkout totals", { prUrl: "https://github.com/acme/shop/pull/8" });
    expect(state.spawned[1].prompt).toContain("## Git workflow");
    expect(state.spawned[1].prompt).toContain("https://github.com/acme/shop/pull/8");
    expect(state.spawned[1].prompt).toContain("Do not create, merge, or mark ready any pull request");
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

  test("migration rewrites an existing worker model pick to worker, preserving provider/model/reasoning", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief", agentSkillIds: ["chief", "chief-worker"] });
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
    const result = await experimental_scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), { allow: [/^vitest$/, /^react$/, /^@testing-library\/react$/] });
    expect(result.violations).toEqual([]);
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
    const result = await state.harness.behavior.runCli(["review", "--pull-request", "42", "--json"], opts);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!).title).toBe("Review · 42");
    // Assert on recorded options after the await: an assertion inside the mock itself
    // would throw into resolvePullRequestBranch's own catch, producing the same
    // null-fallback the test expects either way, masking a missing timeout.
    expect(seenOptions.length).toBeGreaterThan(0);
    for (const options of seenOptions) expect(options?.timeout).toBeGreaterThan(0);
  });

  test("resolves an explicit GitHub PR URL through gh without inspecting the project's own remote", async () => {
    execFileMock.mockImplementation((file: string, args: string[]) => {
      if (file === "git") return Promise.resolve({ stdout: "git@gitlab.example.com:acme/widgets.git\n", stderr: "" });
      if (file === "gh") { expect(args).toContain("pr"); return Promise.resolve({ stdout: "feature/from-github\n", stderr: "" }); }
      return Promise.reject(new Error(`unexpected CLI ${file}`));
    });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli(
      ["review", "--pull-request", "https://github.com/acme/widgets/pull/7", "--json"], opts,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!).title).toBe("Review · feature/from-github");
    expect(execFileMock).not.toHaveBeenCalledWith("git", expect.anything(), expect.anything());
  });

  test("resolves a bare PR number's forge from the target project's own checkout, not the plugin process's cwd", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], options: any) => {
      expect(options.cwd).toBe("/repo/proj1");
      if (file === "git") return Promise.resolve({ stdout: "git@github.com:acme/widgets.git\n", stderr: "" });
      if (file === "gh") return Promise.resolve({ stdout: "feature/bare-number\n", stderr: "" });
      return Promise.reject(new Error(`unexpected CLI ${file}`));
    });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli(["review", "--pull-request", "42", "--json"], opts);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!).title).toBe("Review · feature/bare-number");
  });

  test("resolves an owner/repo#number reference's forge as gitlab from the project's own remote", async () => {
    execFileMock.mockImplementation((file: string, _args: string[], options: any) => {
      expect(options.cwd).toBe("/repo/proj1");
      if (file === "git") return Promise.resolve({ stdout: "git@gitlab.example.com:acme/widgets.git\n", stderr: "" });
      if (file === "glab") return Promise.resolve({ stdout: JSON.stringify({ source_branch: "feature/from-gitlab" }), stderr: "" });
      return Promise.reject(new Error(`unexpected CLI ${file}`));
    });
    const state = await setup({ projectPath: "/repo/proj1" });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const result = await state.harness.behavior.runCli(["review", "--pull-request", "acme/widgets#9", "--json"], opts);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!).title).toBe("Review · feature/from-gitlab");
  });

  test("a completed worker stays complete through later turns and reconciles", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    expect((await state.harness.behavior.runCli(["complete", worker.threadId])).exitCode).toBe(0);
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

describe("auto-completing absorbed supporting threads", () => {
  const P = { projectId: "proj_1" };
  // The sweep runs off the reload and awaits a fresh threads.get per row; let it drain.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stateOf = (state: Awaited<ReturnType<typeof setup>>, id: string) =>
    (state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(id) as { state: string }).state;
  const call = (state: Awaited<ReturnType<typeof setup>>, tool: string, params: object, threadId: string) =>
    state.harness.behavior.callAgentTool(tool, params, { threadId, ...P });
  async function reviewed(state: Awaited<ReturnType<typeof setup>>, chiefId: string, workerId: string, verdict: "approve" | "request_changes") {
    await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, workerId);
    await call(state, "chief_review", { workerThreadId: workerId }, chiefId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer" && row.workerThreadId === workerId && row.state !== "complete")!;
    const findings = verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "Wrong total", fix: "Fix it" }];
    await call(state, "chief_report", { state: "ready", result: "Checked", verdict, findings }, reviewer.threadId);
    return reviewer.threadId;
  }
  async function consulted(state: Awaited<ReturnType<typeof setup>>, chiefId: string, workerId: string) {
    await call(state, "chief_consult", { title: "Advice", mission: "Diagnose", workerThreadId: workerId }, chiefId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor" && row.state !== "complete")!;
    await call(state, "chief_report", { state: "ready", result: "Try X" }, advisor.threadId);
    return advisor.threadId;
  }

  test("chief_complete on a worker completes its reviewer and advisor, idempotently", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    const advisor = await consulted(state, chief.threadId, worker.threadId);
    await call(state, "chief_complete", { threadId: worker.threadId }, chief.threadId);
    await settle();
    expect([stateOf(state, reviewer), stateOf(state, advisor)]).toEqual(["complete", "complete"]);
    const before = state.db.prepare(`SELECT thread_id, state, updated_at FROM managed_threads ORDER BY thread_id`).all();
    await call(state, "chief_roster", {}, chief.threadId);
    await expect(call(state, "chief_complete", { threadId: worker.threadId }, chief.threadId)).resolves.toBeDefined();
    expect(state.db.prepare(`SELECT thread_id, state, updated_at FROM managed_threads WHERE thread_id<>? ORDER BY thread_id`).all(worker.threadId))
      .toEqual((before as any[]).filter((row) => row.thread_id !== worker.threadId));
  });

  test("a busy reviewer is swept only after it goes idle", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer)! });
    await call(state, "chief_complete", { threadId: worker.threadId }, chief.threadId);
    await settle();
    expect(stateOf(state, reviewer)).toBe("active");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
    await settle();
    expect(stateOf(state, reviewer)).toBe("complete");
  });

  test("replaces: completes the prior worker's advisor and hides the re-pointed reviewer's stale line", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "request_changes");
    const advisor = await consulted(state, chief.threadId, worker.threadId);
    const fresh = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await settle();
    expect(stateOf(state, advisor)).toBe("complete");
    await settle();
    expect(stateOf(state, reviewer)).toBe("ready");
    const roster = String(await call(state, "chief_roster", {}, chief.threadId));
    expect(roster).not.toContain(`replaces: ${fresh.threadId}`);
    expect(roster).not.toContain(`(${reviewer}):`);
  });

  test("a planner completes only after its final wave and every linked worker is done", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    const cli = async (args: string[]) => {
      const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], { threadId: chief.threadId, ...P });
      expect(result.exitCode).toBe(0);
      return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
    };
    const wave1 = await cli(["--plan-thread", planner.threadId, "--wave", "1"]);
    const wave2 = await cli(["--replaces", wave1, "--plan-thread", planner.threadId, "--wave", "2"]);
    await settle();
    expect(stateOf(state, wave1)).toBe("complete");
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("ready");
    const fix = await cli(["--replaces", wave2, "--kind", "worker"]);
    await settle();
    expect(stateOf(state, wave2)).toBe("complete");
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("ready");
    expect(state.archivedThreads).toEqual([]);
    await call(state, "chief_report", { state: "ready", result: `Fixed${NO_DEVIATIONS}` }, fix);
    await call(state, "chief_complete", { threadId: fix, skipReview: "review is not under test" }, chief.threadId);
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("complete");
    expect(state.archivedThreads).toEqual([]);
  });

  test("completing an approved final-wave planned worker completes its planner and reviewer and archives nothing", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    const cli = async (args: string[]) => {
      const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], { threadId: chief.threadId, ...P });
      expect(result.exitCode).toBe(0);
      return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
    };
    const wave1 = await cli(["--plan-thread", planner.threadId, "--wave", "1"]);
    const wave2 = await cli(["--replaces", wave1, "--plan-thread", planner.threadId, "--wave", "2"]);
    const reviewer = await reviewed(state, chief.threadId, wave2, "approve");
    const advisor = await consulted(state, chief.threadId, wave2);
    await call(state, "chief_complete", { threadId: wave2 }, chief.threadId);
    await settle();
    await settle();
    expect([wave2, planner.threadId, reviewer, advisor].map((id) => stateOf(state, id))).toEqual(["complete", "complete", "complete", "complete"]);
    expect([state.archivedEnvs, state.archivedThreads]).toEqual([[], []]);
  });

  test("completing an approved unplanned worker archives no threads", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await reviewed(state, chief.threadId, worker.threadId, "approve");
    const reply = String(await call(state, "chief_complete", { threadId: worker.threadId }, chief.threadId));
    expect(reply).not.toMatch(/Worktree|Archived|release/);
    expect(stateOf(state, worker.threadId)).toBe("complete");
    expect([state.archivedEnvs, state.archivedThreads]).toEqual([[], []]);
  });

  test("a replaces: hand-off completes the prior worker without archiving", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await reviewed(state, chief.threadId, worker.threadId, "approve");
    await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await settle();
    expect(stateOf(state, worker.threadId)).toBe("complete");
    expect([state.archivedEnvs, state.archivedThreads]).toEqual([[], []]);
  });

  test("archiving a complete worker keeps its row complete", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await call(state, "chief_complete", { threadId: worker.threadId }, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, archivedAt: 2 });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(worker.threadId)! });
    expect(stateOf(state, worker.threadId)).toBe("complete");
  });

  test("a reviewer that reported ready while still live-active is swept only after it goes idle", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: "Done" }, worker.threadId);
    await call(state, "chief_review", { workerThreadId: worker.threadId }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!.threadId;
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer)! });
    await call(state, "chief_report", { state: "ready", result: "Checked", verdict: "approve" }, reviewer);
    await call(state, "chief_complete", { threadId: worker.threadId }, chief.threadId);
    await settle();
    expect(stateOf(state, reviewer)).toBe("ready");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
    await settle();
    expect(stateOf(state, reviewer)).toBe("complete");
  });

  test("a reviewer seen idle once is not swept when it later turns active unseen or its read fails", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" }); // no lifecycle event
    const other = await delegate(state, chief.threadId, "Other");
    const failing = await reviewed(state, chief.threadId, other.threadId, "approve");
    await call(state, "chief_complete", { threadId: worker.threadId }, chief.threadId);
    state.failNextGet(failing);
    await call(state, "chief_complete", { threadId: other.threadId }, chief.threadId);
    await settle();
    expect([stateOf(state, reviewer), stateOf(state, failing)]).toEqual(["ready", "ready"]);
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(failing)!, lastAssistantText: "done" }); // a later reload retries
    await settle();
    expect(stateOf(state, failing)).toBe("complete");
  });

  test("startup sweeps absorbed rows only once their live status is known and idle", async () => {
    const liveStatus: Record<string, string> = { thr_plan: "idle", thr_work: "idle", thr_rev: "idle", thr_busy: "active" };
    const { bb, harness } = createFakePluginHost({
      pluginId: "chief-sweep",
      sdk: {
        threadSections: { list: async () => [{ id: "sec", name: "Chief", createdAt: 1, updatedAt: 1 }], create: async () => ({ id: "sec" }) },
        projects: { get: async () => ({ id: "proj_1", name: "P", kind: "standard" }), fileContent: async () => { throw new Error("missing"); } },
        threads: {
          // thr_unknown has no live answer: its read keeps failing, so its status stays unobserved.
          get: async ({ threadId }: { threadId: string }) => {
            if (!liveStatus[threadId]) throw new Error("transient get");
            return makeThreadResponse({ id: threadId, projectId: "proj_1", sectionId: "sec", visibility: "visible", status: liveStatus[threadId] });
          },
          update: async () => ({}),
        },
      },
    });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const insert = db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, worker_thread_id, title, state, status, verdict, plan_waves, plan_thread_id, plan_wave, reviewed_report_seq, created_at, updated_at)
      VALUES (?, ?, 'proj_1', 'thr_chief', ?, ?, ?, 'idle', ?, ?, ?, ?, ?, 1, 1)`);
    insert.run("thr_plan", "planner", null, "Plan", "ready", null, JSON.stringify([{ path: "a" }]), null, null, null);
    insert.run("thr_work", "worker", null, "Work", "complete", null, null, "thr_plan", 1, null);
    insert.run("thr_rev", "reviewer", "thr_work", "Review", "ready", "approve", null, null, null, 1);
    insert.run("thr_busy", "reviewer", "thr_work", "Busy review", "ready", "approve", null, null, null, 1);
    insert.run("thr_unknown", "advisor", "thr_work", "Advice", "ready", null, null, null, null, null);
    await plugin(bb);
    expect(db.prepare(`SELECT thread_id, state FROM managed_threads WHERE thread_id<>'thr_work' ORDER BY thread_id`).all()).toEqual([
      { thread_id: "thr_busy", state: "ready" },
      { thread_id: "thr_plan", state: "complete" },
      { thread_id: "thr_rev", state: "complete" },
      { thread_id: "thr_unknown", state: "ready" },
    ]);
  });

  test("panel unchecked actions equal Pending lines; action-less supporting rows are done", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const { planner } = await planTwoWaves(state, chief.threadId);
    await state.harness.behavior.runCli(["delegate", "--title", "Planned", "--mission", "Do it", "--plan-thread", planner.threadId, "--wave", "1", "--json"], { threadId: chief.threadId, ...P });
    const ready = await delegate(state, chief.threadId, "Ready work");
    await call(state, "chief_report", { state: "ready", result: "Done" }, ready.threadId);
    const blockedWorker = await delegate(state, chief.threadId, "Blocked review target");
    await call(state, "chief_report", { state: "ready", result: "Done" }, blockedWorker.threadId);
    await call(state, "chief_review", { workerThreadId: blockedWorker.threadId }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await call(state, "chief_report", { state: "blocked", blocker: "No access", recommendation: "Grant it" }, reviewer.threadId);
    await call(state, "chief_consult", { title: "Idle advice", mission: "Think" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(advisor.threadId)!, lastAssistantText: "hm" });

    const { items } = (await state.harness.behavior.callRpc("pending", { threadId: chief.threadId })) as { items: TodoItem[] };
    const roster = String(await call(state, "chief_roster", {}, chief.threadId));
    const pendingLines = roster.split("\n").filter((line) => /\(thr_[^)]+\): /.test(line));
    const actions = items.filter((item) => !item.done && item.action);
    expect(actions.map((item) => `- ${item.label} (${item.id}): ${item.action}`).sort()).toEqual([...pendingLines].sort());
    const rows = (await status(state)).threads;
    for (const item of items.filter((item) => !item.done && !item.action && !item.id.startsWith("todo"))) {
      const row = rows.find((row) => row.threadId === item.id)!;
      expect(row.role === "worker" || ["active", "starting", "stopping", "pending"].includes(row.state)).toBe(true);
    }
    expect(items.find((item) => item.id === planner.threadId)).toMatchObject({ status: "ready", done: true });
    expect(items.find((item) => item.id === advisor.threadId)).toMatchObject({ status: "idle", done: true });
  });

  test("chief_complete lists open todos for a worker; instructions name the close-todo rule", async () => {
    const state = await setup();
    const chief = await start(state);
    // Completing an unplanned worker needs a ready report, a tester or testsSkipped, and a review or skipReview; none is under test here.
    const closeOut = { testsSkipped: "todos are under test", skipReview: "todos are under test" };
    const quiet = await delegate(state, chief.threadId, "Quiet");
    await call(state, "chief_report", { state: "ready", result: "Done" }, quiet.threadId);
    expect(String(await call(state, "chief_complete", { threadId: quiet.threadId, ...closeOut }, chief.threadId))).not.toContain("Open todos");
    await call(state, "chief_roster", { todo: { text: "Ship totals" } }, chief.threadId);
    const worker = await delegate(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: "Done" }, worker.threadId);
    const reply = String(await call(state, "chief_complete", { threadId: worker.threadId, ...closeOut }, chief.threadId));
    expect(reply).toContain(`Open todos: #1 Ship totals — close any this work finished with chief_roster todo { id, state: "done" }.`);
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(JSON.stringify(configured)).toContain("When work a todo tracks is finished, close that todo in the same turn");
  });
});

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

  async function roleThread(state: Awaited<ReturnType<typeof setup>>, role: string) {
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    if (role === "chief") return chief.threadId;
    if (role === "worker") return (await delegate(state, chief.threadId)).threadId;
    if (role === "planner") await state.harness.behavior.runCli(["plan", "--title", "Rework", "--mission", "Propose"], opts);
    if (role === "reviewer") await state.harness.behavior.runCli(["review", "--branch", "feature/x"], opts);
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

  test.each(["worker", "advisor"])("rejects a %s caller", async (role) => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    await expect(call(state, await roleThread(state, role), survey())).rejects.toThrow(/not available to a managed/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("rejects an unmanaged thread, a superseded Chief, and a planner asking for review", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    state.addLive("thr_user", "proj_1");
    await expect(call(state, "thr_user", survey())).rejects.toThrow(/only in an active Chief/);
    const planner = await roleThread(state, "planner");
    await expect(call(state, planner, survey({ mode: "review", concerns: ["x"] }))).rejects.toThrow(/modes survey, investigate, not review/);
    const old = (await status(state)).threads.find((row) => row.role === "chief")!.threadId;
    state.live.set(old, { ...state.live.get(old)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(old)! });
    await expect(call(state, old, survey())).rejects.toThrow(/only in an active Chief/);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test("lets a reviewer survey and runs the CLI as the caller", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const reviewer = await roleThread(state, "reviewer");
    const reply = await call(state, reviewer, survey());
    expect(reply).toContain("| Item | Finding | Evidence |");
    const [file, args, options] = calls("run")[0]!;
    expect(file).toBe(process.env.BB_CLI ?? "bb");
    expect(args.slice(0, 3)).toEqual(["workflows", "run", "--script"]);
    expect(args.at(-1)).toBe("--json");
    expect(options.env).toMatchObject({ BB_THREAD_ID: reviewer, BB_PROJECT_ID: "proj_1" });
    expect(options.env.PATH).toContain("/opt/homebrew/bin");
  });

  test("switches gate live, through settings and setResearchSettings", async () => {
    const state = await setup();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => done });
    const planner = await roleThread(state, "planner");
    const reviewer = await roleThread(state, "reviewer");
    const chief = (await status(state)).threads.find((row) => row.role === "chief" && row.state !== "archived")!.threadId;
    const off = "chief_research is off in Chief settings → Chief researcher.";
    await state.harness.behavior.setSettings({ plannerEnabled: true, researchEnabled: false });
    for (const threadId of [chief, planner, reviewer]) await expect(call(state, threadId, survey())).rejects.toThrow(off);
    await state.harness.behavior.setSettings({ plannerEnabled: true, researchEnabled: true });
    await expect(call(state, planner, survey())).resolves.toContain("wfr_1");
    expect(await state.harness.behavior.callRpc("setResearchSettings", { enabled: false })).toEqual({ enabled: false, maxAgentCalls: 24, timeoutMinutes: { survey: 10, review: 10, investigate: 10 } });
    for (const threadId of [chief, planner, reviewer]) await expect(call(state, threadId, survey())).rejects.toThrow(off);
    expect(await state.harness.behavior.callRpc("setResearchSettings", { enabled: true })).toEqual({ enabled: true, maxAgentCalls: 24, timeoutMinutes: { survey: 10, review: 10, investigate: 10 } });
    await expect(call(state, chief, survey())).resolves.toContain("wfr_1");
    await expect(state.harness.behavior.callRpc("setResearchSettings", { planner: { enabled: false } })).rejects.toThrow();
  });

  test("is on by default with no stored values, for every role", async () => {
    const state = await setup();
    const config = await state.harness.behavior.callRpc("researchConfiguration", null) as any;
    expect(config.settings).toEqual({ enabled: true, maxAgentCalls: 24, timeoutMinutes: { survey: 10, review: 10, investigate: 10 } });
    for (const role of ["chief", "planner", "reviewer"]) {
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
    await expect(call(state, chief, survey({ items: items.slice(0, 23) }))).resolves.toContain("wfr_1");
    expect(sentArgs()).toMatchObject({ cap: 24, batchSize: 1, verify: true });
    await state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 100 });
    await expect(call(state, chief, survey({ items }))).resolves.toContain("wfr_1");
    await expect(state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 0 })).rejects.toThrow();
    await expect(state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 101 })).rejects.toThrow();
  });

  test("stores one model per machine and mode, and flags one the catalog dropped", async () => {
    const state = await setup();
    const triple = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" };
    const none = { survey: null, review: null, investigate: null };
    const host = async () => (await state.harness.behavior.callRpc("researchConfiguration", null) as any).hosts[0];
    expect(await host()).toMatchObject({ selections: none, unusable: [] });
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "survey", selection: triple });
    expect(await host()).toMatchObject({ selections: { ...none, survey: triple }, unusable: [] });
    await expect(state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", selection: triple })).rejects.toThrow();
    await expect(state.harness.behavior.callRpc("setResearchModel", {
      hostId: "host_1", mode: "survey", selection: { providerId: "codex", model: "gpt-6-astra" },
    })).rejects.toThrow();
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "review", selection: triple });
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "survey", selection: { ...triple, model: "gone" } });
    expect((await host()).unusable).toEqual(["survey"]);
    await state.harness.behavior.callRpc("setResearchModel", { hostId: "host_1", mode: "survey", selection: null });
    expect(await host()).toMatchObject({ selections: { ...none, review: triple }, unusable: [] });
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
    for (const threadId of [planner, chief]) {
      execFileMock.mockClear();
      await call(state, threadId, survey());
      expect(sentArgs().models).toEqual({ scan: stored, verify: stored, combine: stored });
    }
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

  test("waits each mode's own timeout and rejects one out of range", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "running" }) });
    expect(await state.harness.behavior.callRpc("setResearchSettings", { timeoutMinutes: { survey: 2 } }))
      .toMatchObject({ timeoutMinutes: { survey: 2, review: 10, investigate: 10 } });
    for (const bad of [{ survey: 0 }, { survey: 61 }, { bogus: 5 }]) {
      await expect(state.harness.behavior.callRpc("setResearchSettings", { timeoutMinutes: bad })).rejects.toThrow();
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const surveyed = call(state, chief, survey());
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(await surveyed).toContain("Still running");
      let settled = false;
      const reviewed = call(state, chief, { mode: "review", question: "Ok?", concerns: ["x"] }).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(8 * 60_000);
      expect(await reviewed).toContain("Still running");
    } finally {
      vi.useRealTimers();
    }
  });

  test("falls back to history, parsed as JSON Lines, when the result was omitted", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", resultOmitted: true }) });
    const routed = execFileMock.getMockImplementation()!;
    execFileMock.mockImplementation(async (file: string, args: string[], options: any) => args[1] === "history"
      ? { stdout: [
        { type: "run", logVersion: 1, result: { table: "| from history |" } },
        { type: "call", callIndex: 0 },
        { type: "page", nextCursor: null },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n", stderr: "" }
      : routed(file, args, options));
    expect(await call(state, chief, survey())).toContain("| from history |");
    expect(calls("history")[0]![1]).toEqual(["workflows", "history", "wfr_1", "--cursor", "0", "--limit", "1", "--json"]);
  });

  test("waits through running, stops at the wait cap, and resumes by runId without starting a run", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    let polls = 0;
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => (++polls < 3 ? { status: "running" } : done) });
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const reply = call(state, chief, survey());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await reply).toContain("| Item | Finding | Evidence |");
      expect(polls).toBe(3);

      workflowsCli({ run: () => ({ runId: "wfr_2" }), status: () => ({ status: "running" }) });
      const capped = call(state, chief, survey());
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(await capped).toBe("Still running. Call chief_research again with runId: wfr_2 to keep waiting.");
    } finally {
      vi.useRealTimers();
    }
    execFileMock.mockClear();
    workflowsCli({ status: () => done });
    expect(await call(state, chief, survey({ runId: "wfr_2" }))).toContain("runId: wfr_2");
    expect(calls("run")).toHaveLength(0);
  });

  test("abort stops the run and rethrows", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "running" }), stop: () => ({ ok: true }) });
    const controller = new AbortController();
    const reply = call(state, chief, survey(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("cancelled"));
    await expect(reply).rejects.toThrow("cancelled");
    expect(calls("stop")[0]![1].slice(0, 3)).toEqual(["workflows", "stop", "wfr_1"]);
  });

  test("abort during a failing status call still stops the run", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    const controller = new AbortController();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => { controller.abort(new Error("cancelled")); throw new Error("killed"); }, stop: () => ({ ok: true }) });
    await expect(call(state, chief, survey(), controller.signal)).rejects.toThrow("cancelled");
    expect(calls("stop")[0]![1].slice(0, 3)).toEqual(["workflows", "stop", "wfr_1"]);
  });

  test("abort during the last poll before the deadline stops the run", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    const controller = new AbortController();
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => { if (Date.now() >= deadline) controller.abort(new Error("cancelled")); return { status: "running" }; }, stop: () => ({ ok: true }) });
    let deadline = Infinity;
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      deadline = Date.now() + 10 * 60_000;
      const reply = call(state, chief, survey(), controller.signal);
      const settled = expect(reply).rejects.toThrow("cancelled");
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(calls("stop")[0]![1].slice(0, 3)).toEqual(["workflows", "stop", "wfr_1"]);
  });

  test("hands the script back when the server cannot start it, and says check it yourself when status fails", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    execFileMock.mockRejectedValue(Object.assign(new Error("spawn bb ENOENT"), { stdout: "" }));
    const reply = await call(state, chief, survey()) as string;
    expect(reply).toContain("spawn bb ENOENT");
    expect(reply).toContain("call bb_workflow_run with exactly this script and args");
    expect(reply).toContain("export const meta = {");
    expect(reply).toContain('"question":"Who calls this?"');
    expect(await call(state, chief, survey({ runId: "wfr_9" }))).toBe(
      "Could not read workflow wfr_9 from the plugin server. Check it yourself with `bb workflows status wfr_9`.",
    );
  });

  test("validates per mode and accepts a bare runId resume", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    await expect(call(state, chief, { mode: "review", question: "Ship it?" })).rejects.toThrow(/concerns/);
    await expect(call(state, chief, { mode: "investigate", question: "Why?" })).rejects.toThrow(/questions/);
    await expect(call(state, chief, { mode: "survey", question: "Who?" })).rejects.toThrow(/items/);
    await expect(call(state, chief, { question: "Who?" })).rejects.toThrow(/mode/);
    workflowsCli({ status: () => done });
    expect(await call(state, chief, { runId: "wfr_7" })).toContain("runId: wfr_7");
    expect(calls("run")).toHaveLength(0);
  });

  test("starts review and investigate with their scripts and args", async () => {
    const state = await setup();
    const chief = await roleThread(state, "chief");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", result: { findings: [], markdown: "No confirmed findings." } }) });
    expect(await call(state, chief, { mode: "review", question: "Ship it?", concerns: ["correctness", "security"], diffRef: "main..HEAD" })).toContain("No confirmed findings.");
    const runArgs = () => calls("run").at(-1)![1];
    expect(runArgs()[3]).toContain('name: "chief-research-review"');
    expect(JSON.parse(runArgs()[5])).toMatchObject({ concerns: ["correctness", "security"], diffRef: "main..HEAD", verify: true, cap: 24 });

    const combine = { provider: "codex", model: "gpt-6-astra", reasoningLevel: "high" };
    workflowsCli({ run: () => ({ runId: "wfr_2" }), status: () => ({ status: "succeeded", result: { answers: [], brief: "## Confirmed" } }) });
    expect(await call(state, chief, { mode: "investigate", question: "Why?", questions: ["a?", "b?"], models: { combine } })).toContain("## Confirmed");
    expect(runArgs()[3]).toContain('name: "chief-research-investigate"');
    expect(JSON.parse(runArgs()[5])).toMatchObject({ questions: ["a?", "b?"], models: { combine } });

    const planner = await roleThread(state, "planner");
    await state.harness.behavior.callRpc("setResearchSettings", { maxAgentCalls: 2 });
    await expect(call(state, planner, { mode: "investigate", question: "Why?", questions: ["a?", "b?"] })).rejects.toThrow(/needs 3 agent calls.*limit is 2/);
  });

  test.each(["chief", "planner", "reviewer"])("configure gives a %s chief_research and its line only while on", async (role) => {
    const state = await setup();
    const threadId = await roleThread(state, role);
    const configured = () => state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
    const modes = { chief: "survey, review, investigate", planner: "survey, investigate", reviewer: "review, survey" }[role]!;
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

  test.each(["worker", "advisor"])("configure never gives a %s chief_research", async (role) => {
    const state = await setup();
    const config = await state.harness.behavior.resolveAgentConfiguration(configurationContext(await roleThread(state, role)));
    expect(config.tools.map((tool) => tool.name)).not.toContain("chief_research");
    expect(config.instructions).not.toContain("chief_research");
  });

  test("planner and reviewer spawn prompts mention chief_research only while on", async () => {
    const state = await setup();
    await roleThread(state, "planner");
    await roleThread(state, "reviewer");
    const prompt = (role: string) => state.spawned.findLast((args) => args.pluginMetadata?.role === role).prompt as string;
    expect(prompt("planner")).toContain("use chief_research");
    expect(prompt("reviewer")).toContain("chief_research review");
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
    const chief = (await status(state)).threads.find((row) => row.role === "chief" && row.state !== "archived")!.threadId;
    await state.harness.behavior.runCli(["plan", "--title", "Again", "--mission", "Propose"], { threadId: chief, projectId: "proj_1" });
    await state.harness.behavior.runCli(["review", "--branch", "feature/y"], { threadId: chief, projectId: "proj_1" });
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
  const finding = (line: number) => ({ file: "a.ts", line, summary: "s", severity: "high" });

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

  test("review reports a failed concern and a verify that dropped everything, or keeps findings when verify throws", async () => {
    const scan = (prompt: string) => {
      if (prompt.includes("Concern: security")) throw new Error("boom");
      return { findings: [finding(1), finding(2)] };
    };
    const args = { question: "Q", concerns: ["correctness", "security"] };
    let { result } = await runScript("review", args, (prompt, opts) => opts.phase === "Verify" ? { findings: [] } : scan(prompt));
    expect(result.missed).toEqual(["security"]);
    expect(result.markdown).toContain("Scanned 1/2 concerns, 2 findings; verify kept 0, dropped 2.");
    expect(result.markdown).toContain("Failed concerns: security");
    expect(result.markdown).toContain("No confirmed findings.");
    ({ result } = await runScript("review", args, (prompt, opts) => { if (opts.phase === "Verify") throw new Error("429"); return scan(prompt); }));
    expect(result).toMatchObject({ verified: false, findings: [finding(1), finding(2)] });
    expect(result.markdown).toContain("UNVERIFIED");
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
    const chief = await roleThread(state, "chief");
    const history = () => [
      { type: "run", logVersion: 1 },
      { type: "call", status: "failed", phase: "Verify", childThreadId: "thr_w" },
      { type: "call", status: "succeeded", phase: "Scan", childThreadId: "thr_s" },
    ];
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "failed", error: "Workflow worker failed" }), history });
    let reply = await call(state, chief, survey());
    expect(reply).toContain("Failed agent calls: Verify ×1. First failure (Verify, thread thr_w): last output from thr_w");
    expect(calls("history")[0]![1]).toEqual(["workflows", "history", "wfr_1", "--cursor", "0", "--limit", "100", "--json"]);

    workflowsCli({ run: () => ({ runId: "wfr_2" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: ["Verify: x"] } }), history });
    reply = await call(state, chief, survey());
    expect(reply).toContain("status: partial\nFailed agent calls: Verify ×1");

    execFileMock.mockClear();
    workflowsCli({ run: () => ({ runId: "wfr_3" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: [] } }), history });
    expect(await call(state, chief, survey())).toContain("status: succeeded");
    expect(calls("history")).toHaveLength(0);
  });

  test.each([
    ["survey", { question: "Q", items: ["a", "b"], batchSize: 1 }, "Verify"],
    ["review", { question: "Q", concerns: ["x", "y"] }, "Verify"],
    ["investigate", { question: "Q", questions: ["a?", "b?"] }, "Combine"],
  ] as const)("%s fails without %s when every scan failed", async (mode, args, later) => {
    const phases: string[] = [];
    await expect(runScript(mode, args, (_prompt, opts) => { phases.push(opts.phase); throw new Error("usage limit"); })).rejects.toThrow(/All .* failed/);
    expect(phases).not.toContain(later);
  });

  test("pre-flight refuses a provider that is out of quota or signed out, and fails open otherwise", async () => {
    let usage: (args: any) => unknown = () => ({});
    const state = await setup({ usageLimits: (args) => usage(args) });
    const chief = await roleThread(state, "chief");
    const provider = state.live.get(chief)!.providerId;
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: [] } }) });
    usage = () => ({ [provider]: { status: "ok", windows: [{ label: "5h", usedPercent: 100, resetsAt: "2026-10-08T12:00:00Z" }] } });
    await expect(call(state, chief, survey())).rejects.toThrow(/out of quota \(5h window at 100%, resets 2026-10-08T12:00:00Z\)/);
    usage = () => ({ [provider]: { status: "unauthenticated" } });
    await expect(call(state, chief, survey())).rejects.toThrow(/unauthenticated/);
    expect(calls("run")).toHaveLength(0);
    usage = () => ({ [provider]: { status: "error", message: "x" } });
    await call(state, chief, survey());
    usage = () => { throw new Error("rpc down"); };
    await call(state, chief, survey());
    expect(calls("run")).toHaveLength(2);
  });

  test.each([
    ["throws synchronously", { usageLimits: () => { throw new Error("rpc down"); } }],
    ["is absent on an older host", {}],
  ])("pre-flight fails open when system.usageLimits %s", async (_case, system) => {
    const state = await setup({ system });
    const chief = await roleThread(state, "chief");
    workflowsCli({ run: () => ({ runId: "wfr_1" }), status: () => ({ status: "succeeded", result: { rows: [], table: "t", failures: [] } }) });
    await call(state, chief, survey());
    expect(calls("run")).toHaveLength(1);
  });

  test("configure gives Chief the optional-research cue only while on", async () => {
    const state = await setup();
    const threadId = await roleThread(state, "chief");
    const configured = () => state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
    const on = (await configured()).instructions;
    expect(on).toContain("When a few known files answer the question, read them directly");
    expect(on).toContain("do not rerun the same fan-out");
    expect(on).not.toContain("Before chief_plan on a large or unclear issue");
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
    const off = (await configured()).instructions;
    expect(off).not.toContain("When a few known files answer the question, read them directly");
    expect(off).not.toContain("do not rerun the same fan-out");
  });
});

describe("waived test waves, reviewer waivers and the branch push line", () => {
  const P = { projectId: "proj_1" };
  type State = Awaited<ReturnType<typeof setup>>;
  /** The shared setup leaves hosts.get and files.move unstubbed, which writing a plan file needs. */
  async function setupWithPlans() {
    const state = await setup();
    state.harness.sdk.stub("hosts.get", async () => ({ id: "host_storage", threadStorageRootPath: join(state.storageRoot, "thread-storage") }));
    state.harness.sdk.stub("files.move", async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => { await rename(sourcePath, destinationPath); return {}; });
    return state;
  }
  const call = (state: State, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, ...P });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const stateOf = (state: State, id: string) => (state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(id) as { state: string }).state;
  const READY = "Done\n\n## Deviations from plan\nNone";
  const BLOCKED = { state: "blocked", result: "Tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" };
  const testWave = (n: number) => `# Wave ${n}\nRun the tests.\n\n## Contracts to verify\n- TESTWAVE${n} suite stays green`;

  async function planOf(state: State, chiefId: string, waves: { body: string; dependsOn?: number[]; test?: boolean }[]) {
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], { threadId: chiefId, ...P });
    const planner = (await status(state)).threads.find((row) => row.role === "planner" && row.chiefThreadId === chiefId)!;
    await call(state, "chief_report", { state: "ready", result: "Plan", plan: waves }, planner.threadId);
    return planner;
  }
  async function cli(state: State, chiefId: string, args: string[]) {
    const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], { threadId: chiefId, ...P });
    expect(result.exitCode, result.stderr).toBe(0);
    return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
  }
  const roster = async (state: State, chiefId: string) => String(await call(state, "chief_roster", {}, chiefId));
  const skip = (state: State, chiefId: string, planner: string, wave: number, reason: string) =>
    call(state, "chief_skip_tests", { planThreadId: planner, wave, reason }, chiefId);
  /** Plan [impl 1, test 2] with wave 1 ready and a tester delegated on wave 2. */
  async function withTester(state: State, chiefId: string) {
    const planner = await planOf(state, chiefId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    const impl = await cli(state, chiefId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    const tester = await cli(state, chiefId, ["--plan-thread", planner.threadId, "--wave", "2", "--replaces", impl]);
    return { planner, impl, tester };
  }

  const row = (state: State, id: string) => state.db.prepare(`SELECT state, last_report_state FROM managed_threads WHERE thread_id=?`).get(id) as { state: string; last_report_state: string };
  /** One more turn through the lifecycle boundary: the thread goes active, then idle; a report's state survives it. */
  async function turn(state: State, id: string) {
    for (const [status, event] of [["active", "thread.active"], ["idle", "thread.idle"]] as const) {
      state.live.set(id, { ...state.live.get(id)!, status });
      await state.harness.behavior.emitThreadEvent(event, { thread: state.live.get(id)!, lastAssistantText: "x" });
    }
  }

  // Contract: a delegated test wave Chief waived counts done whatever its tester's state (ready, idle after ready, idle after blocked, stopped after blocked), before any review; total stays waves.length.
  // Regression: progress stayed 1/2 ("wave 2 blocked") until an approving review. Also pins that the planner is neither complete nor absorbed on N/N alone.
  // The idle rows pin a managed row whose state is idle with the earlier report still recorded: counting only a ready or blocked state would miss them.
  test.each([
    ["ready", "ready", async () => {}, "ready", "ready"],
    ["ready, then idle", "ready", async (state: State, id: string) => { await turn(state, id); }, "idle", "ready"],
    ["blocked", "blocked", async () => {}, "blocked", "blocked"],
    ["blocked, then idle", "blocked", async (state: State, id: string) => { await turn(state, id); }, "idle", "blocked"],
    ["blocked, then stopped", "blocked", async (state: State, id: string, chiefId: string) => {
      state.live.set(id, { ...state.live.get(id)!, status: "active" });
      await call(state, "chief_stop", { threadId: id, reason: "Not worth more time" }, chiefId);
    }, "blocked", "blocked"],
  ])("a waived delegated test wave counts done once its tester is %s, before any review", async (_label, reported, settleTester, managed, lastReport) => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const { planner, tester } = await withTester(state, chief.threadId);
    await call(state, "chief_report", reported === "ready" ? { state: "ready", result: READY } : BLOCKED, tester);
    await settleTester(state, tester, chief.threadId);
    expect(row(state, tester)).toEqual({ state: managed, last_report_state: lastReport });
    expect(await roster(state, chief.threadId)).toContain(`waves: 1/2 done, wave 2 ${managed}`);

    await skip(state, chief.threadId, planner.threadId, 2, "Product bug tracked elsewhere");
    const waived = await roster(state, chief.threadId);
    expect(waived).toContain("waves: 2/2 done, wave 2 tests skipped");
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);
    // N/N alone neither completes nor absorbs the planner.
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("ready");
    await expect(call(state, "chief_complete", { threadId: tester }, chief.threadId)).rejects.toThrow(/Refusing to complete/);
    await call(state, "chief_complete", { threadId: tester, skipReview: "Waived tests, branch accepted as is" }, chief.threadId);
    await settle();
    expect(stateOf(state, planner.threadId)).toBe("complete");
  });

  // Contract: an approved waived wave counts once. Preservation: it passes before the fix too; the mutation control adds both terms.
  test("an approving review of a waived test wave keeps 2/2, never 3/2", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const { planner, tester } = await withTester(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    await skip(state, chief.threadId, planner.threadId, 2, "Fixture waiver");
    await call(state, "chief_review", { workerThreadId: tester }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await call(state, "chief_report", { state: "ready", result: "Looks right", verdict: "approve", findings: [] }, reviewer.threadId);
    const after = await roster(state, chief.threadId);
    expect(after).toContain("waves: 2/2 done, wave 2 approved");
    expect(after).not.toContain("3/2");
  });

  // Contract: equivalence. A plan with no waived wave counts exactly as before: done is the waves behind the current one, plus one once approved.
  // Preservation: passes before the fix; the mutation control makes every final wave count as waived.
  test("an unwaived plan's progress runs 0/2, 1/2, then 2/2 only once approved", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    expect(await roster(state, chief.threadId)).toContain("waves: 0/2 done, wave 1 not delegated");
    const impl = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    expect(await roster(state, chief.threadId)).toContain("waves: 0/2 done, wave 1 ready");
    const tester = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "2", "--replaces", impl]);
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    expect(await roster(state, chief.threadId)).toContain("waves: 1/2 done, wave 2 ready");
    await call(state, "chief_review", { workerThreadId: tester }, chief.threadId);
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await call(state, "chief_report", { state: "ready", result: "Looks right", verdict: "approve", findings: [] }, reviewer.threadId);
    expect(await roster(state, chief.threadId)).toContain("waves: 2/2 done, wave 2 approved");
  });

  // Contract: an undelegated waived wave counts done and stays in the total; the alert's M is the same total.
  // Regression: total dropped the absent wave (0/1), so the roster disagreed with "wave N of M".
  test("a test wave waived before delegation counts done and stays in the total", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    await skip(state, chief.threadId, planner.threadId, 2, "Docs only");
    expect(await roster(state, chief.threadId)).toContain("waves: 1/2 done, wave 1 not delegated");
    const impl = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    expect(state.spawned.at(-1).prompt).toContain("Wave 1 of 2");
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    expect(await roster(state, chief.threadId)).toContain("waves: 1/2 done, wave 1 ready");
    expect(state.sent.at(-1).input[0].text).toContain("All 2 waves are ready.");
  });

  // Contract: agreement. Two chains, one test wave waived after delegation and one before: the roster denominator equals the M of the wave line.
  test("with waived waves the progress denominator equals the plan's wave count", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [
      { body: PLAN_FIXTURE }, { body: testWave(2), test: true },
      { body: wave(3), dependsOn: [] }, { body: testWave(4), test: true, dependsOn: [3] },
    ]);
    // Two implementation waves need the plan's one advisor review before any delegation.
    await call(state, "chief_consult", { planThreadId: planner.threadId, title: "Plan review", mission: "Review this plan before delegation" }, chief.threadId);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await call(state, "chief_report", { state: "ready", result: "Sound plan", verdict: "approve" }, advisor.threadId);
    await skip(state, chief.threadId, planner.threadId, 4, "Second chain needs no tests");
    const impl1 = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl1);
    const tester = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "2", "--replaces", impl1]);
    expect(state.spawned.at(-1).prompt).toContain("Wave 2 of 4");
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    await skip(state, chief.threadId, planner.threadId, 2, "First chain waived after delegation");
    const text = await roster(state, chief.threadId);
    expect(text).toMatch(/waves: \d\/4 done/);
    expect(text).toContain("wave 2 of 4:");
    expect(text).toContain("wave 4 of 4:");
    expect(text).toContain("waves: 3/4 done, wave 2 tests skipped, wave 3 not delegated");
  });

  const reviewerSpawn = (state: State) => state.spawned.filter((entry) => String(entry.title).startsWith("Review · ")).at(-1)!.prompt as string;
  const reviewContext = async (state: State) => {
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    return readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
  };
  const WAIVER_REASON = "R".repeat(500);
  const RULE = "are authorized omissions: their absence is not scope drift";
  const KEEP = "Every commit on the branch (including any a waived tester already pushed) and every unwaived wave's contracts stay fully under review.";

  // Contract: through chief_review, the reviewer gets Chief's waiver in review-context.md and the authorized-omission rule in its prompt,
  // never the waived wave's contracts; unwaived contracts and the plan file list stay. Regression: the reviewer was asked to verify contracts of tests that never ran.
  test.each([
    ["a tester ran, then Chief waived", true],
    ["Chief waived before any tester", false],
  ])("the reviewer gets the waiver in place of the waived wave's contracts when %s", async (_label, delegated) => {
    const state = await setupWithPlans();
    const chief = await start(state);
    let reviewed: string;
    let planner: { threadId: string };
    if (delegated) {
      const set = await withTester(state, chief.threadId);
      planner = set.planner;
      reviewed = set.tester;
      await call(state, "chief_report", { state: "ready", result: READY }, reviewed);
      await skip(state, chief.threadId, planner.threadId, 2, WAIVER_REASON);
    } else {
      planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
      await skip(state, chief.threadId, planner.threadId, 2, WAIVER_REASON);
      reviewed = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1"]);
      await call(state, "chief_report", { state: "ready", result: READY }, reviewed);
    }
    await call(state, "chief_review", { workerThreadId: reviewed }, chief.threadId);
    const prompt = reviewerSpawn(state);
    const context = await reviewContext(state);
    const path2 = join(state.storageRoot, "chief", "proj_1", planner.threadId, "plan-2.md");

    expect(context).toContain(`## Waived test waves\nWave 2 of 2: ${path2}: tests skipped by Chief: ${WAIVER_REASON}`);
    expect(prompt).toContain("- The test waves Chief waived, with Chief's reason for each.");
    expect(prompt).toContain(RULE);
    expect(prompt).toContain(KEEP);
    expect(prompt).toContain("Totals stay non-negative");
    expect(prompt).not.toContain("TESTWAVE2");
    expect(prompt).toContain("Wave 1 of 2:\n- Totals stay non-negative");
    expect(prompt).not.toContain("Wave 2 of 2:\n");
    // The waived wave's file is still listed in the plan section.
    expect(context).toContain(`Wave 2 of 2: ${path2}`);
  });

  // Contract: with no waived wave the reviewer's prompt and context carry no waiver text and keep every wave's contracts in order.
  // Preservation: passes before the fix; the mutation control drops the waiverLines guard.
  test("a plan with no waived wave gets every contract and no waiver text", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const { tester } = await withTester(state, chief.threadId);
    await call(state, "chief_report", { state: "ready", result: READY }, tester);
    await call(state, "chief_review", { workerThreadId: tester }, chief.threadId);
    const prompt = reviewerSpawn(state);
    const context = await reviewContext(state);
    expect(prompt).toContain("## Contracts to verify\nWave 1 of 2:\n- Totals stay non-negative\nWave 2 of 2:\n- TESTWAVE2 suite stays green\n");
    for (const text of [prompt, context]) {
      expect(text).not.toContain("Waived test waves");
      expect(text).not.toContain("Chief waived");
      expect(text).not.toContain("authorized omissions");
    }
  });

  const pushRules = (prompt: string, branch: string) => {
    expect(prompt).toContain(`Your worktree is based on ${branch}. `);
    expect(prompt).toContain(`git push origin HEAD:${branch}`);
    expect(prompt).toContain("Never push any other branch");
    expect(prompt).toContain(`git fetch origin ${branch}`);
    expect(prompt).toContain("never force-push");
    expect(prompt).toContain("Do not create, merge, or mark ready any pull request");
  };

  // Contract (todo #743): every brief with a branch names the exact push refspec, so a worktree on its own bb/ branch still moves the named branch.
  // Regression: the brief said only "Check that branch out", and a tester pushed its bb/ branch instead.
  test.each([
    ["a fresh worker", "worker"],
    ["a fresh designer", "designer"],
  ])("%s with a branch gets the push refspec", async (_label, kind) => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId, "Fix totals", { branch: "feature/x", kind });
    pushRules(state.spawned.at(-1).prompt, "feature/x");
    expect(state.spawned.at(-1).environment.workspace.baseBranch).toEqual({ kind: "named", name: "feature/x" });
  });

  test("a tester on a new branch after the tested wave's PR merged gets the push refspec", async () => {
    const state = await setupWithPlans();
    const chief = await start(state);
    const planner = await planOf(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: testWave(2), test: true }]);
    const impl = await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "1", "--branch", "feature/x"]);
    await call(state, "chief_report", { state: "ready", result: READY }, impl);
    await call(state, "chief_complete", { threadId: impl, skipReview: "Merged; tests follow on the same branch name" }, chief.threadId);
    await cli(state, chief.threadId, ["--plan-thread", planner.threadId, "--wave", "2", "--kind", "tester", "--branch", "feature/x"]);
    const spawn = state.spawned.at(-1);
    expect(spawn.environment.workspace).toMatchObject({ type: "managed-worktree", baseBranch: { kind: "named", name: "feature/x" } });
    expect(spawn.prompt).toContain("## Test work");
    pushRules(spawn.prompt, "feature/x");
  });

  test.each([
    ["a worker", undefined],
    ["a tester", "tester"],
  ])("a replaces: successor %s inherits the branch and the push refspec", async (_label, kind) => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId, "Fix totals", { branch: "feature/x" });
    await delegate(state, chief.threadId, "Next", { replaces: first.threadId, ...(kind ? { kind } : {}) });
    pushRules(state.spawned.at(-1).prompt, "feature/x");
  });

  // Preservation: a brief with no branch has no push-target line; the mutation control makes the line unconditional.
  test("a brief with no branch has no push-target line", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    expect(state.spawned.at(-1).prompt).not.toContain("git push origin HEAD:");
    expect(state.spawned.at(-1).prompt).not.toContain("Never push any other branch");
  });

  const RUNS_TESTS = "not run: runs tests (a tester's)";
  const FULL_SUITE = "not run: full suite not asked for";
  const withVerify = async (state: State, chiefId: string, command: string, extra: string[]) => {
    const result = await state.harness.behavior.runCli(["delegate", "--title", "Check", "--mission", "Do it", "--verify", command, ...extra, "--json"], { threadId: chiefId, ...P });
    expect(result.exitCode, result.stderr).toBe(0);
    return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
  };
  const verifyBlock = (prompt: string, command: string) => expect(prompt).toContain(`## Verify command\n\`\`\`sh\n${command}\n\`\`\`\n`);

  // Contract: a test-running verifyCommand is accepted and only flagged in the brief, per role (a worker or designer must not run it; a tester must not run the full suite).
  // Preservation: the mutation control drops each instruction line.
  test.each([
    ["worker", ["--kind", "worker"], RUNS_TESTS, FULL_SUITE],
    ["designer", ["--kind", "designer"], RUNS_TESTS, FULL_SUITE],
  ])("a %s with a test-running verifyCommand is accepted and told not to run it", async (_role, extra, present, absent) => {
    const state = await setup();
    const chief = await start(state);
    await withVerify(state, chief.threadId, "npx vitest run", [...extra, "--unplanned-reason", "Bounded test fixture"]);
    const prompt: string = state.spawned.at(-1).prompt;
    verifyBlock(prompt, "npx vitest run");
    expect(prompt).toContain(present);
    expect(prompt).not.toContain(absent);
  });

  test.each([
    ["a filtered command", 'npx vitest run server.test.ts -t "totals"'],
    ["an unfiltered full-suite command", "npm test"],
  ])("a tester with %s gets the full-suite rule, not the worker's runs-tests line", async (_label, command) => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix totals");
    await withVerify(state, chief.threadId, command, ["--replaces", worker.threadId, "--kind", "tester"]);
    const prompt: string = state.spawned.at(-1).prompt;
    verifyBlock(prompt, command);
    expect(prompt).toContain(FULL_SUITE);
    expect(prompt).not.toContain(RUNS_TESTS);
  });

  test("replaces: inherits the verifyCommand and the successor's own role decides the instruction", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await withVerify(state, chief.threadId, "npm run build", ["--unplanned-reason", "Bounded test fixture"]);
    // A tester replacing a worker inherits the worker's build command.
    const tester = await delegate(state, chief.threadId, "Test it", { replaces: worker, kind: "tester" });
    verifyBlock(state.spawned.at(-1).prompt, "npm run build");
    expect(state.spawned.at(-1).prompt).toContain(FULL_SUITE);
    // A worker replacing a tester inherits the tester's test command and must not run it.
    const tests = await withVerify(state, chief.threadId, "npx vitest run", ["--replaces", tester.threadId, "--kind", "tester"]);
    await delegate(state, chief.threadId, "Fix product", { replaces: tests, kind: "worker" });
    const prompt: string = state.spawned.at(-1).prompt;
    verifyBlock(prompt, "npx vitest run");
    expect(prompt).toContain(RUNS_TESTS);
    expect(prompt).not.toContain(FULL_SUITE);
  });
});

describe("tester role", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const ctxOf = (state: State, chiefThreadId: string) => ({ threadId: chiefThreadId, projectId: state.live.get(chiefThreadId)!.projectId });
  const tool = (state: State, name: string, params: object, chiefThreadId: string) =>
    state.harness.behavior.callAgentTool(name, params, ctxOf(state, chiefThreadId)) as Promise<any>;
  const report = (state: State, threadId: string, params: object) =>
    state.harness.behavior.callAgentTool("chief_report", params, { threadId, projectId: "proj_1" }) as Promise<any>;
  const rowOf = (state: State, threadId: string) => state.db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(threadId) as any;
  const setLive = (state: State, threadId: string, status: string) => state.live.set(threadId, { ...state.live.get(threadId)!, status } as any);

  /** A planner whose ready report carries `waves` (default: one implementation wave, then its test wave). */
  async function plan(state: State, chiefThreadId: string, waves: object[] = [{ body: PLAN_FIXTURE }, TEST_WAVE(2)]) {
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chiefThreadId));
    const planner = (await status(state)).threads.filter((row) => row.role === "planner" && row.chiefThreadId === chiefThreadId).at(-1)!;
    await report(state, planner.threadId, { state: "ready", result: "Waves written.", plan: waves });
    return planner;
  }

  const delegateWave = (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, extra: object = {}) =>
    tool(state, "chief_delegate", { title: `Wave ${waveNo}`, mission: "Do the wave.", planThreadId, wave: waveNo, ...extra }, chiefThreadId);

  // A plan worker's ready report must carry a Deviations heading.
  const READY = "Done.\n\n## Deviations from plan\nNone";
  /** The newest worker row on a plan wave. */
  const workerOn = (state: State, planThreadId: string, waveNo: number) =>
    state.db.prepare(`SELECT * FROM managed_threads WHERE plan_thread_id=? AND plan_wave=? AND role='worker' ORDER BY rowid DESC`).get(planThreadId, waveNo) as any;
  const planWaves = (state: State, planThreadId: string) =>
    (state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planThreadId) as { plan_waves: string }).plan_waves;

  /** Chief + a [implementation, test] plan with wave 1 delegated, ready and idle. */
  async function readyImpl(state: State, wave1: object = {}) {
    const chief = await start(state);
    const planner = await plan(state, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1, wave1);
    const impl = workerOn(state, planner.threadId, 1);
    await report(state, impl.thread_id, { state: "ready", result: READY });
    setLive(state, impl.thread_id, "idle");
    return { chief, planner, impl: impl.thread_id as string };
  }

  /** The same plan with the tester delegated on wave 2 (still busy: the fake host starts it active). */
  async function withTester(state: State) {
    const ctx = await readyImpl(state);
    await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: ctx.impl });
    return { ...ctx, tester: workerOn(state, ctx.planner.threadId, 2).thread_id as string };
  }

  // Contract: checkPlan accepts a plan iff it is an array, every chain tip is test: true, every test wave is a
  // non-head tip whose parent is neither design nor test, and no wave is both. Regression: dropping any one rule
  // (e.g. the tip check) lets a plan without a test wave through; the table pins each rule's own refusal.
  // Existing checkPlan cases only cover plans without test waves, so none exercises these rules.
  const planWave = (n: number, extra: object = {}) => ({ body: n === 1 ? PLAN_FIXTURE : wave(n), ...extra });
  test.each<[string, string | unknown[], RegExp[]]>([
    ["accepts an implementation wave then its test wave", [planWave(1), planWave(2, { test: true })], []],
    ["accepts two chains that each end in a test wave", [planWave(1), planWave(2, { test: true }), planWave(3, { dependsOn: [] }), planWave(4, { dependsOn: [3], test: true })], []],
    ["refuses a string plan", PLAN_FIXTURE, [/plan needs at least two waves: implementation wave\(s\), then a test wave \(test: true\)/]],
    ["refuses a chain with no test tip", [planWave(1), planWave(2)], [/plan wave 2 ends a chain but is not test: true/]],
    ["refuses a test wave that starts a chain", [planWave(1, { test: true })], [/plan wave 1 is test: true but starts a chain/]],
    ["refuses a test wave in the middle of a chain", [planWave(1), planWave(2, { test: true }), planWave(3, { test: true })], [/plan wave 2 is test: true but a later wave builds on it/, /plan wave 3 is test: true but builds on test wave 2/]],
    ["refuses a test wave after a design wave", [planWave(1, { design: true }), planWave(2, { test: true })], [/plan wave 2 is test: true but builds on design wave 1/]],
    ["refuses a wave that is both design and test", [planWave(1), planWave(2, { design: true, test: true })], [/plan wave 2 is both design: true and test: true/]],
    ["refuses a non-boolean test", [planWave(1), planWave(2, { test: "yes" })], [/plan wave 2 test is "yes" \(string\); allowed true or false/]],
  ])("checkPlan %s", (_name, input, expected) => {
    const errors = checkPlan(input);
    if (!expected.length) expect(errors).toEqual([]);
    for (const pattern of expected) expect(errors.join("\n")).toMatch(pattern);
  });

  // Contract (absent waiver): chief_skip_tests on an undelegated test wave drops it from the graph, so the parent's
  // worker is the chain tip, the wave is not counted, delegating it is refused naming the reason, and completing the
  // parent absorbs the planner. Regression: the skipped wave stays pending (progress 0/2, planner never absorbed).
  // No existing test knows test waves or the waiver.
  test("chief_skip_tests on an undelegated test wave makes the implementation worker the chain tip", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state, { prUrl: "https://github.com/acme/shop/pull/8" });
    expect(state.sent.at(-1).input[0].text).toContain(
      `chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${impl}, kind: tester). To go without tests, record why: chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason).`);
    const before = JSON.parse(planWaves(state, planner.threadId));

    const text = await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, chief.threadId);
    expect(text).toContain(`Start the one review of the whole plan now: chief_review (workerThreadId: ${impl})`);
    const after = JSON.parse(planWaves(state, planner.threadId));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({ ...before[1], testsSkipped: "docs only" });

    const roster = String(await tool(state, "chief_roster", {}, chief.threadId));
    expect(roster).toContain("waves: 1/2 done, wave 1 ready");
    expect(roster).toContain("tests skipped: docs only");
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl })).rejects.toThrow("Wave 2's tests were skipped (docs only); nothing to delegate.");

    expect(String(await tool(state, "chief_inspect", { threadId: planner.threadId }, chief.threadId))).toContain("wave 2: tests skipped: docs only");

    await tool(state, "chief_complete", { threadId: impl, skipReview: "docs only change" }, chief.threadId);
    expect(rowOf(state, planner.threadId).state).toBe("complete");
    const comment = state.db.prepare(`SELECT body FROM forge_comments WHERE dedupe_key=?`).get(`complete:${impl}`) as { body: string };
    expect(comment.body).toContain("**Tests skipped (wave 2):** docs only");
  });

  // Contract (delegated waiver): once a tester on the test wave is idle, blocked or stopped, chief_skip_tests succeeds,
  // leaves that tester the branch owner with its row untouched, and its blocked report can still be completed with
  // skipReview. Regression: the waiver deletes/rewrites the tester, or refuses a blocked tester, so Chief cannot accept
  // failing tests it chose to waive.
  test.each([
    ["idle after a ready report", "ready", "idle"],
    ["idle after a blocked report", "blocked", "idle"],
    ["stopped after a blocked report", "blocked", "stopped"],
  ])("chief_skip_tests on a delegated test wave succeeds for a tester that is %s", async (_label, reportState, liveStatus) => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await report(state, tester, reportState === "ready" ? { state: "ready", result: READY } : { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
    setLive(state, tester, liveStatus);
    const rowBefore = rowOf(state, tester);
    const workersBefore = state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='worker'`).get();

    const text = await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "failures accepted" }, chief.threadId);
    expect(text).toBe(`Tests on wave 2 waived. ${tester} still owns the branch: review it — chief_review (workerThreadId: ${tester}) — or complete it without one — chief_complete (threadId: ${tester}, skipReview: your reason).`);
    expect(rowOf(state, tester)).toEqual(rowBefore);
    expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='worker'`).get()).toEqual(workersBefore);
    expect(JSON.parse(planWaves(state, planner.threadId))[1].testsSkipped).toBe("failures accepted");
    expect(workerOn(state, planner.threadId, 2).thread_id).toBe(tester);

    // The waived wave is never pending: a blocked or stopped tester's review is still admitted.
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).toContain("tests skipped: failures accepted");
    await reviewed(state, chief.threadId, tester, "approve");
    // A blocked report passes skipReview only because its test wave is waived.
    await tool(state, "chief_complete", { threadId: tester, skipReview: "waived" }, chief.threadId);
    expect(rowOf(state, tester).state).toBe("complete");
  });

  // Contract (delegated waiver refusals): a busy tester is still working and a complete one has nothing left to waive.
  test("chief_skip_tests refuses a busy tester and a complete tester", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    const skip = () => tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "no" }, chief.threadId);
    setLive(state, tester, "active");
    await expect(skip()).rejects.toThrow(`Wave 2's worker ${tester} is active: wait until it is idle, then waive.`);
    await report(state, tester, { state: "ready", result: READY });
    setLive(state, tester, "idle");
    await tool(state, "chief_complete", { threadId: tester, skipReview: "reviewed elsewhere" }, chief.threadId);
    await expect(skip()).rejects.toThrow(`Wave 2's worker ${tester} is complete: nothing left to waive.`);
    expect(JSON.parse(planWaves(state, planner.threadId))[1].testsSkipped).toBeUndefined();
  });

  // Contract (idempotency): a second identical chief_skip_tests returns the same text and leaves plan_waves
  // byte-identical. Regression: the second call rewrites the stored reason or reorders the wave fields.
  test.each([["an undelegated", false], ["a delegated", true]])("chief_skip_tests twice on %s test wave is a no-op", async (_label, delegated) => {
    const state = await setup();
    const { chief, planner, tester } = delegated ? await withTester(state) : { ...(await readyImpl(state)), tester: "" };
    if (delegated) { await report(state, tester, { state: "ready", result: READY }); setLive(state, tester, "idle"); }
    const skip = (reason: string) => tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason }, chief.threadId);
    const first = await skip("first reason");
    const stored = planWaves(state, planner.threadId);
    expect(await skip("first reason")).toBe(first);
    expect(await skip("a different reason")).toBe(first);
    expect(planWaves(state, planner.threadId)).toBe(stored);
  });

  // Contract (structural refusals): only this Chief's planner, only a test wave, and only once any required advisor
  // review is resolved. Regression: a refusal is dropped so Chief waives a non-test wave or another Chief's plan.
  test("chief_skip_tests refuses a non-test wave, another Chief's plan and an unreviewed plan", async () => {
    const state = await setup();
    const { chief, planner } = await readyImpl(state);
    const stored = planWaves(state, planner.threadId);
    await expect(tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 1, reason: "no" }, chief.threadId)).rejects.toThrow(`Wave 1 of planner ${planner.threadId} is not a test wave (test: true).`);
    const other = await start(state, "proj_2");
    await expect(tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "no" }, other.threadId)).rejects.toThrow(`No managed planner ${planner.threadId} for this Chief.`);

    const unreviewed = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)]);
    await expect(tool(state, "chief_skip_tests", { planThreadId: unreviewed.threadId, wave: 3, reason: "no" }, chief.threadId)).rejects.toThrow(`Plan ${unreviewed.threadId} has 2 implementation waves: get its one advisor review first`);
    expect(planWaves(state, planner.threadId)).toBe(stored);
    expect(JSON.parse(planWaves(state, unreviewed.threadId))[2].testsSkipped).toBeUndefined();
  });

  // Contract (#158 preserved): skipReview on a ready idle implementation worker whose test successor is undelegated is
  // accepted, and the sequence skipReview -> tester replaces: -> tester ready -> complete absorbs the planner.
  // Regression: a testing-related refusal on skipReview, or a tester that cannot continue a completed worker's branch,
  // breaks the review-skipped-then-test path. No existing test has a test wave to run it against.
  test("skipReview on the implementation, then a tester on its branch, completes the plan", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    expect(await tool(state, "chief_complete", { threadId: impl, skipReview: "small change" }, chief.threadId)).toContain("without a review (reason recorded)");
    expect(rowOf(state, planner.threadId).state).not.toBe("complete");

    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
    const tester = workerOn(state, planner.threadId, 2);
    expect(tester).toMatchObject({ kind: "tester", role: "worker", plan_wave: 2 });
    await report(state, tester.thread_id, { state: "ready", result: READY });
    setLive(state, tester.thread_id, "idle");
    await tool(state, "chief_complete", { threadId: tester.thread_id, skipReview: "tests are the evidence" }, chief.threadId);
    expect(rowOf(state, tester.thread_id).state).toBe("complete");
    expect(rowOf(state, planner.threadId).state).toBe("complete");
  });

  // Contract (#161): a tester with a branch and no replaces may start fresh once the tested wave's worker is complete;
  // before that, or without a branch, a test wave still must continue the tested worker's branch.
  // Regression: afterMerge accepted while the tested worker is still open, or ignoring the branch.
  test.each([
    ["accepts a branch once the tested wave's worker is complete", true, "tests/after-merge", null],
    ["refuses a branch while the tested wave's worker is not complete", false, "tests/after-merge", /Wave 2 is a test wave: it runs on wave 1's branch/],
    ["refuses a complete tested worker with no branch", true, undefined, /Wave 2 is a test wave: it runs on wave 1's branch/],
  ])("a tester with no replaces %s", async (_label, complete, branch, refusal) => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    if (complete) await tool(state, "chief_complete", { threadId: impl, skipReview: "merged" }, chief.threadId);
    const call = delegateWave(state, chief.threadId, planner.threadId, 2, { kind: "tester", ...(branch ? { branch } : {}) });
    if (refusal) { await expect(call).rejects.toThrow(refusal); return; }
    await call;
    expect(workerOn(state, planner.threadId, 2)).toMatchObject({ kind: "tester", branch, plan_wave: 2 });
  });

  // Contract (kinds): a test wave's first hand-off defaults to tester, which is a worker-role thread with the tester skill.
  // Regression: the default is lost (a plain worker is spawned on the test wave) or the tester loads no tester policy.
  test("a test wave's first hand-off with no kind spawns a tester worker whose kind loads the tester skill", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
    const tester = workerOn(state, planner.threadId, 2);
    expect(tester).toMatchObject({ role: "worker", kind: "tester" });
    expect(managedSkills("worker", "tester")).toEqual(["chief-worker", "chief-role-worker", "chief-role-tester"]);
    expect(managedSkills("worker", null)).toEqual(["chief-worker", "chief-role-worker"]);
    const chiefConfigured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(chiefConfigured.tools.map((entry: any) => entry.name)).toContain("chief_skip_tests");
  });

  // Contract (kind refusals on a new plan): designer and worker cannot take a test wave's first hand-off; a test wave
  // needs a replaces: of its parent; after a tester the kind must be named; tester only runs test waves.
  test.each<[string, (impl: string) => object, RegExp]>([
    ["a designer on a test wave", (impl) => ({ replaces: impl, kind: "designer" }), /Wave 2 is a test wave: a designer cannot run it/],
    ["a worker as the first hand-off of a test wave", (impl) => ({ replaces: impl, kind: "worker" }), /Wave 2 is a test wave: its first hand-off is kind: tester/],
    ["a test wave with no replaces", () => ({}), /Wave 2 is a test wave: it runs on wave 1's branch\. Delegate it as chief_delegate \(planThreadId: thr_\d+, wave: 2, replaces: thr_\d+, kind: tester\)/],
    ["a tester on an implementation wave of a new plan", (impl) => ({ replaces: impl, kind: "tester", wave: 1 }), /Wave 1 is not a test wave: a tester runs only this plan's test waves \(2\)/],
  ])("kind rules refuse %s", async (_label, extra, refusal) => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    const { wave: waveNo = 2, ...rest } = extra(impl) as { wave?: number };
    const rowsBefore = state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get();
    await expect(delegateWave(state, chief.threadId, planner.threadId, waveNo, rest)).rejects.toThrow(refusal);
    expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get()).toEqual(rowsBefore);
  });

  // Contract (explicit kind): replacing a tester, or a worker already on the test wave, must name worker or tester so a
  // product fix never lands on a tester by default.
  test("replacing a tester or a test-wave worker without a kind is refused until the kind is named", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await report(state, tester, { state: "ready", result: READY });
    setLive(state, tester, "idle");
    const explicit = "Name the kind: kind: worker to change product code, kind: tester to change tests.";
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester })).rejects.toThrow(explicit);

    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2);
    expect(fix).toMatchObject({ kind: null, role: "worker" });
    await report(state, fix.thread_id, { state: "ready", result: READY });
    setLive(state, fix.thread_id, "idle");
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: fix.thread_id })).rejects.toThrow(explicit);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: fix.thread_id, kind: "tester" });
    expect(workerOn(state, planner.threadId, 2).kind).toBe("tester");
  });

  // Contract (explicit kind, unplanned): the same rule outside a plan, where the wave-based check does not apply —
  // replacing an unplanned tester without naming a kind is refused. Regression: the successor silently inherits
  // kind tester, so a product fix lands on a tester. The plan test above is also guarded by the wave rule and cannot catch it.
  test("replacing an unplanned tester without a kind is refused", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await readyIdle(state, worker.threadId, "Done");
    await tool(state, "chief_delegate", { title: "Tests", mission: "Test it", replaces: worker.threadId, kind: "tester" }, chief.threadId);
    const tester = (await status(state)).threads.filter((row) => row.role === "worker").at(-1)!;
    await readyIdle(state, tester.threadId, "Tested");
    await expect(tool(state, "chief_delegate", { title: "Fix", mission: "Fix it", replaces: tester.threadId }, chief.threadId))
      .rejects.toThrow("Name the kind: kind: worker to change product code, kind: tester to change tests.");
  });

  // Contract (legacy plans): a plan persisted before test waves existed has no test marker; a tester runs on it only
  // with replaces:. Regression: the bootstrap is refused (the plan that introduced testers cannot be tested) or a
  // tester starts on a legacy plan with no worker to test.
  test("kind tester on a legacy plan (no test wave) needs replaces:", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    const legacy = JSON.parse(planWaves(state, planner.threadId)).map(({ test, ...rest }: any) => rest);
    state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
    // The store caches rows and reloads from the DB on its next write: a fresh ready report from the same worker is one.
    await report(state, impl, { state: "ready", result: `${READY} (re-reported)` });
    await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { kind: "tester" })).rejects.toThrow("kind: tester on a plan with no test wave needs replaces:");
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl, kind: "tester" });
    expect(workerOn(state, planner.threadId, 2)).toMatchObject({ kind: "tester", plan_wave: 2 });
  });

  // Contract (equivalence, server wiring only): legacyWaveGraph.test.ts owns graph/progress equivalence against bf73de5.
  // Here a persisted plan with no test fields behaves as before test waves existed — wave 2 is an
  // ordinary worker (no kind), the ready step offers no tester or waiver, and finishing the last wave absorbs the planner
  // with no testsSkipped. Regression: a missing `test` reads as an untested chain, so a tester is demanded or the
  // planner is never absorbed. No other test starts from a legacy plan.
  test("a legacy plan with no test fields keeps its pre-tester graph and progress", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    const legacy = JSON.parse(planWaves(state, planner.threadId)).map(({ test, ...rest }: any) => rest);
    state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
    await report(state, impl, { state: "ready", result: `${READY} (re-reported)` });
    const next = state.sent.at(-1).input[0].text;
    expect(next).toContain(`chief_delegate (planThreadId: ${planner.threadId}, wave: 2`);
    expect(next).not.toMatch(/tester|chief_skip_tests/);

    await delegateWave(state, chief.threadId, planner.threadId, 2);
    const last = workerOn(state, planner.threadId, 2);
    expect(last.kind).toBeNull();
    await readyIdle(state, last.thread_id);
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).toContain("waves: 1/2 done, wave 2 ready");
    await tool(state, "chief_complete", { threadId: impl, skipReview: "checked" }, chief.threadId);
    expect(rowOf(state, planner.threadId).state).not.toBe("complete");
    await tool(state, "chief_complete", { threadId: last.thread_id, skipReview: "checked" }, chief.threadId);
    expect(rowOf(state, planner.threadId).state).toBe("complete");
  });

  // Contract (plan-review trigger): only implementation waves count toward the advisor review — an implementation wave
  // plus its test wave is two waves but not reviewed, two implementation waves or a `complex` plan are. Regression:
  // the test wave counts, so every plan is reviewed (or, with the filter dropped, a plan is never reviewed).
  // The existing review-trigger tests use plans with no test wave.
  test.each<[string, object[], boolean, boolean]>([
    ["one implementation wave and its test wave", [planWave(1), TEST_WAVE(2)], false, false],
    ["two implementation waves and a test wave", [planWave(1), planWave(2), TEST_WAVE(3)], false, true],
    ["one implementation wave and its test wave, marked complex", [planWave(1), TEST_WAVE(2)], true, true],
  ])("plan review is required for %s", async (_label, waves, complex, required) => {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chief.threadId));
    const planner = (await status(state)).threads.filter((row) => row.role === "planner").at(-1)!;
    await report(state, planner.threadId, { state: "ready", result: "Waves written.", plan: waves, ...(complex ? { complex } : {}) });
    const attempt = delegateWave(state, chief.threadId, planner.threadId, 1);
    if (required) await expect(attempt).rejects.toThrow("get its one advisor review first");
    else await attempt;
  });

  test("kind tester on unplanned work needs replaces:", async () => {
    const state = await setup();
    const chief = await start(state);
    const call = (extra: object) => tool(state, "chief_delegate", { title: "Tests", mission: "Test it", unplannedReason: "Bounded", kind: "tester", ...extra }, chief.threadId);
    await expect(call({})).rejects.toThrow("kind: tester on unplanned work needs replaces: of the worker whose branch it tests.");
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "ready", result: "Done" });
    setLive(state, worker.threadId, "idle");
    await tool(state, "chief_delegate", { title: "Tests", mission: "Test it", replaces: worker.threadId, kind: "tester" }, chief.threadId);
    expect(state.db.prepare(`SELECT kind FROM managed_threads WHERE title='Tests' AND role='worker'`).get()).toEqual({ kind: "tester" });
  });

  // Contract (unplanned testsSkipped): unplanned work with no tester in its task chain cannot complete without a recorded
  // reason, whichever way it completes; the reason is stored apart from unplanned_reason and review_skipped and shown in
  // the roster, inspect and the completion comment. Regression: the refusal is dropped, or the reason is written to
  // another field or not shown.
  test.each([["skipReview", { skipReview: "no review" }], ["override", { override: "no approve" }]])(
    "completing unplanned work with %s and no tester is refused without testsSkipped and recorded with it", async (_label, how) => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId, "Fix totals", { prUrl: "https://github.com/acme/shop/pull/8" });
      await report(state, worker.threadId, { state: "ready", result: "Done" });
      setLive(state, worker.threadId, "idle");
      await expect(tool(state, "chief_complete", { threadId: worker.threadId, ...how }, chief.threadId)).rejects.toThrow(
        `No tester ran on this work: delegate one first — chief_delegate (replaces: ${worker.threadId}, kind: tester) — or pass testsSkipped: your reason.`);
      expect(rowOf(state, worker.threadId).state).toBe("ready");

      await tool(state, "chief_complete", { threadId: worker.threadId, ...how, testsSkipped: "typo, no behaviour" }, chief.threadId);
      const row = rowOf(state, worker.threadId);
      expect(row).toMatchObject({ state: "complete", tests_skipped: "typo, no behaviour", unplanned_reason: "Bounded test fixture" });
      expect(row.review_skipped).toBe(how.skipReview ?? null);
      expect(String(await tool(state, "chief_roster", { includeComplete: true }, chief.threadId))).toContain("tests skipped: typo, no behaviour");
      expect(String(await tool(state, "chief_inspect", { threadId: worker.threadId }, chief.threadId))).toContain("Tests skipped: typo, no behaviour");
      const comment = state.db.prepare(`SELECT body FROM forge_comments WHERE dedupe_key=?`).get(`complete:${worker.threadId}`) as { body: string };
      expect(comment.body).toContain("**Tests skipped:** typo, no behaviour");
    });

  test("completing unplanned work needs no testsSkipped when a tester is in its task chain", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await report(state, worker.threadId, { state: "ready", result: "Done" });
    setLive(state, worker.threadId, "idle");
    const tester = await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
    await report(state, tester.threadId, { state: "ready", result: "Tested" });
    setLive(state, tester.threadId, "idle");
    await tool(state, "chief_complete", { threadId: tester.threadId, skipReview: "tests pass" }, chief.threadId);
    expect(rowOf(state, tester.threadId)).toMatchObject({ state: "complete", tests_skipped: null });
  });

  test("testsSkipped is refused on a worker whose plan has a test wave", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await expect(tool(state, "chief_complete", { threadId: impl, skipReview: "x", testsSkipped: "no tests" }, chief.threadId)).rejects.toThrow(
      `its plan has a test wave; go without it with chief_skip_tests (planThreadId: ${planner.threadId}, wave, reason), not testsSkipped.`);
    expect(rowOf(state, impl)).toMatchObject({ state: "ready", tests_skipped: null });
  });


  /** Chief reviews `targetId`; its reviewer reports `verdict`. Returns the alert Chief received. */
  async function reviewed(state: State, chiefThreadId: string, targetId: string, verdict: "approve" | "request_changes") {
    await tool(state, "chief_review", { workerThreadId: targetId }, chiefThreadId);
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer" && row.workerThreadId === targetId && row.state !== "complete").at(-1)!;
    await report(state, reviewer.threadId, {
      state: "ready", result: "The discount is still applied twice", verdict,
      findings: verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "The discount is applied twice", fix: "Apply it once" }],
    });
    return state.sent.at(-1).input[0].text as string;
  }
  const readyIdle = async (state: State, threadId: string, result = READY) => { await report(state, threadId, { state: "ready", result }); setLive(state, threadId, "idle"); };

  // Contract (routing): a reviewer's request_changes on a tester or test-wave target hands off with the kind named
  // (worker for product-code findings, tester for test-only ones) plus the mixed-findings sentence, in the single and
  // plan branches and at the consult rung. Regression: the bare `chief_delegate (replaces: T)` is back, so a product fix
  // lands on the tester by default (the server would then refuse it for lack of a kind). Existing routing tests only
  // use plain workers, whose line must stay unchanged.
  test.each([["a single unplanned tester", false], ["a plan's tester", true]])("request_changes on %s names kind: worker and kind: tester", async (_label, planned) => {
    const state = await setup();
    const { chief, planner, impl } = planned ? await readyImpl(state) : { chief: await start(state), planner: null, impl: "" };
    let target: string;
    if (planner) {
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
      target = workerOn(state, planner.threadId, 2).thread_id;
    } else {
      const worker = await delegate(state, chief.threadId);
      await readyIdle(state, worker.threadId, "Done");
      target = (await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId })).threadId;
    }
    await readyIdle(state, target, planned ? READY : "Tested");
    const alert = await reviewed(state, chief.threadId, target, "request_changes");
    expect(alert).toContain(`chief_delegate (replaces: ${target}, kind: worker) for product-code findings or chief_delegate (replaces: ${target}, kind: tester) for test-only findings`);
    expect(alert).toContain("Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests.");
  });

  test("a second request_changes on a plan's test wave reaches the consult rung with the kinds named", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await readyIdle(state, tester);
    await reviewed(state, chief.threadId, tester, "request_changes");
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2).thread_id;
    await readyIdle(state, fix);
    const alert = await reviewed(state, chief.threadId, fix, "request_changes");
    expect(alert).toContain("chief_consult");
    expect(alert).toContain(`chief_delegate (replaces: ${fix}, kind: worker) for product-code findings or chief_delegate (replaces: ${fix}, kind: tester) for test-only fin`);
  });

  // Contract (blocked tester): a tester that reports blocked is a test failure: the next call is a fresh worker for the
  // product code (kind: worker), with the waiver offered on a plan wave and testsSkipped when unplanned. Once the wave
  // is waived the blocked tester's line becomes the waived-wave line. Regression: the generic "Blocked: decide or
  // escalate" line returns, leaving Chief no route to the product fix.
  test.each([["a plan's tester", true], ["an unplanned tester", false]])("a blocked %s tells Chief to delegate kind: worker", async (_label, planned) => {
    const state = await setup();
    const blocked = { state: "blocked", result: "Tests fail", blocker: "Totals test fails", recommendation: "Fix the totals" };
    const { chief, planner, tester } = planned ? await withTester(state) : await (async () => {
      const chiefThread = await start(state);
      const worker = await delegate(state, chiefThread.threadId);
      await readyIdle(state, worker.threadId, "Done");
      const t = await delegate(state, chiefThread.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
      return { chief: chiefThread, planner: null, tester: t.threadId };
    })();
    await report(state, tester, blocked);
    setLive(state, tester, "idle");
    const alert = state.sent.at(-1).input[0].text as string;
    const head = `Tests failed: Totals test fails. Delegate a fresh worker to fix the product code: chief_delegate (replaces: ${tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester.`;
    expect(alert).toContain(head);
    if (planner) {
      expect(alert).toContain(`If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason).`);
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
      const roster = String(await tool(state, "chief_roster", {}, chief.threadId));
      expect(roster).toContain(`Tests on wave 2 waived. ${tester} still owns the branch`);
      expect(roster).not.toContain("Tests failed:");
    } else {
      expect(alert).toContain("If you judge the failures acceptable, complete it with testsSkipped (your reason).");
      expect(alert).not.toContain("chief_skip_tests");
    }
  });

  // Contract (retest): a worker that changed code on a test wave after the tests ran is told to rerun them before the
  // review; the line is dropped once a review covers that report, and a waiver also drops it. Regression: the review
  // is offered straight away (tests never rerun after a product fix), or the retest line never goes away.
  test("a worker fix on a test wave is told to rerun the tests until a review covers it", async () => {
    const state = await setup();
    const { chief, planner, tester } = await withTester(state);
    await readyIdle(state, tester);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: tester, kind: "worker" });
    const fix = workerOn(state, planner.threadId, 2).thread_id;
    await readyIdle(state, fix);
    const retest = `A worker changed code on test wave 2 after the tests ran: rerun them — chief_delegate (replaces: ${fix}, kind: tester) — then review. If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason) or start the review: chief_review (workerThreadId: ${fix}).`;
    expect(state.sent.at(-1).input[0].text).toContain(retest);
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).toContain(retest);

    await reviewed(state, chief.threadId, fix, "approve");
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).not.toContain("after the tests ran");
  });

  test("a tester's own ready report on a test wave is not asked to retest", async () => {
    const state = await setup();
    const { chief, tester } = await withTester(state);
    await readyIdle(state, tester);
    expect(String(await tool(state, "chief_roster", {}, chief.threadId))).not.toContain("after the tests ran");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_review (workerThreadId: ${tester})`);
  });

  /** Two non-test waves make the plan's one advisor review a prerequisite of delegation. */
  const wavePaths = (state: State, planThreadId: string) => (JSON.parse(planWaves(state, planThreadId)) as { path: string }[]).map((entry) => entry.path);

  // Contract (provenance, tester brief): the tester's brief lists every present wave file and contract of its chain as
  // its source of truth, and the approved design when the chain has one; unplanned, the head worker's brief.
  // Regression: the tester is briefed from the diff alone (no spec section), so its cases are derived from the code.
  test("a tester's brief lists its chain's plan files and contracts as the source of truth", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
    const [path1, path2] = wavePaths(state, planner.threadId);
    expect(state.spawned.at(-1).prompt).toContain(
      `## Source of truth for test cases\nRead each in full, with the docs they name. Derive every test case from these, never from the implementation.\nWave 1 of 2: ${path1}\n- Totals stay non-negative\nWave 2 of 2: ${path2}\n- Wave 2 keeps its invariant`);
  });

  test("a tester's brief on an approved design chain names the approval and the designer report", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE, design: true }, { body: wave(2) }, TEST_WAVE(3)]);
    await approvePlan(state, chief.threadId, planner.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1);
    const designer = workerOn(state, planner.threadId, 1);
    expect(designer.kind).toBe("designer");
    await readyIdle(state, designer.thread_id, `${READY}\nArtboards: Checkout`);
    await tool(state, "chief_owner_approval", { workerThreadId: designer.thread_id, approval: "Looks right, ship it" }, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: designer.thread_id });
    const implementer = workerOn(state, planner.threadId, 2).thread_id;
    await readyIdle(state, implementer);
    await delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: implementer });
    const prompt = state.spawned.at(-1).prompt as string;
    const reportPath = rowOf(state, designer.thread_id).report_path;
    expect(prompt).toContain(`Approved design: wave 1's artboards, owner's approval “Looks right, ship it”, designer report ${reportPath}`);
    for (const path of wavePaths(state, planner.threadId)) expect(prompt).toContain(path);
  });

  test("an unplanned tester's brief carries the replaced chain head's brief", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await readyIdle(state, worker.threadId, "Done");
    await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
    expect(state.spawned.at(-1).prompt).toMatch(/## Source of truth for test cases\nRead each in full[^\n]*\n[\s\S]*Correct and verify totals/);
  });

  // Contract (provenance, reviewer evidence): a whole-plan review whose targets are testers lists each target's earlier
  // workers with their report pointers — worker -> tester -> fix worker -> tester on one chain, worker -> tester on
  // the other — and tells the reviewer how to scope a tester. Regression: the reviewer sees only the tester's report and
  // cannot find the implementing worker's lint/build evidence or Deviations from plan.
  test("a whole-plan review of tester targets lists each chain's earlier workers", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId, [planWave(1), TEST_WAVE(2), planWave(3, { dependsOn: [] }), TEST_WAVE(4, [3])]);
    await approvePlan(state, chief.threadId, planner.threadId);
    // A result past the alert's summary limit is written to a report file; the others have only the inspect line.
    const LONG = `${READY}\n${"Lint and build clean. ".repeat(60)}`;
    const handOff = async (waveNo: number, extra: object, result = READY) => {
      await delegateWave(state, chief.threadId, planner.threadId, waveNo, extra);
      const row = workerOn(state, planner.threadId, waveNo);
      await readyIdle(state, row.thread_id, result);
      return row.thread_id as string;
    };
    const w1 = await handOff(1, { branch: "feature/a" }, LONG);
    const w3 = await handOff(3, { branch: "feature/b" });
    const t2 = await handOff(2, { replaces: w1 }, LONG);
    const fix = await handOff(2, { replaces: t2, kind: "worker" }, LONG);
    const t2b = await handOff(2, { replaces: fix, kind: "tester" });
    const t4 = await handOff(4, { replaces: w3 });

    await tool(state, "chief_review", { workerThreadId: t2b }, chief.threadId);
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
    const pointer = (kind: string, id: string) => {
      const file = rowOf(state, id).report_path as string | null;
      return `- ${kind} ${id}: ${file ? `Full report: ${file}; ` : ""}bb chief inspect ${id}`;
    };
    for (const id of [w1, t2, fix]) expect(rowOf(state, id).report_path).toBe(join(state.storageRoot, "chief", "proj_1", id, "report-1.md"));
    for (const id of [w3]) expect(rowOf(state, id).report_path).toBeNull();
    const section = (id: string) => context.split(`### Before worker ${id}\n`)[1]!.split(/\n###? /)[0]!;
    expect(section(t2b).trim().split("\n")).toEqual([pointer("worker", fix), pointer("tester", t2), pointer("worker", w1)]);
    expect(section(t4).trim().split("\n")).toEqual([pointer("worker", w3)]);
    expect(state.spawned.at(-1).prompt).toContain("A tester changes only tests, fixtures, test helpers and test config: check its commits since the Base commit its report names (git diff <base>..<head> --stat); a product-code change there is scope drift.");
  });

  // Contract (testing policy at the brief boundary): a worker's and a designer's spawn prompt forbids writing or running
  // tests; a tester's replaces that with the test-work section and the test-files-only limit; a reviewer is told a missing
  // test is never a finding against a worker or designer. Regression: a worker is briefed to test (or a tester is told
  // not to), so test work lands in product commits.
  test.each<[string, (previous: string) => object, boolean]>([
    ["worker", () => ({}), false],
    ["designer", () => ({ kind: "designer" }), false],
    ["tester", (previous) => ({ kind: "tester", replaces: previous }), true],
  ])("a %s's spawn prompt states the testing policy", async (_label, extra, tests) => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId, "Fix totals");
    await readyIdle(state, first.threadId, "Done");
    const worker = await delegate(state, chief.threadId, "Policy", extra(first.threadId));
    const prompt = state.spawned.at(-1).prompt as string;
    expect(prompt.includes("Never write, edit or run tests of any kind (unit, integration, end-to-end, screenshot or golden); a tester does.")).toBe(!tests);
    expect(prompt.includes("## Test work")).toBe(tests);
    expect(prompt.includes("Change only test files, fixtures, test helpers and test config; never product code.")).toBe(tests);
    await readyIdle(state, worker.threadId, "Done");
    await tool(state, "chief_review", { workerThreadId: worker.threadId }, chief.threadId);
    expect(state.spawned.at(-1).prompt).toContain("A missing test or test run is never a finding against a worker or designer: workers never test. Against a tester's work it is missing verification evidence.");
  });

  // Contract (provenance, single target): a review of one tester shows the earlier worker's recorded commands under its
  // report pointer, failures first, so the reviewer sees the implementer's lint/build evidence without opening the report.
  // Regression: a single-target review lists the pointer only (no commands) or drops the predecessor's commands.
  test("a single review of a tester shows the earlier worker's recorded commands under its pointer", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const command = (text: string, exitCode: number) => ({ type: "item/completed", seq: 1, data: { item: { type: "commandExecution", command: text, exitCode, status: exitCode ? "failed" : "completed" } } });
    state.seedEvents(worker.threadId, [command("npm run build", 0), command("npm run lint", 1)]);
    await readyIdle(state, worker.threadId, `Done\n${"Lint and build clean. ".repeat(60)}`);
    const tester = await delegate(state, chief.threadId, "Tests", { kind: "tester", replaces: worker.threadId });
    await readyIdle(state, tester.threadId, "Tested");
    await tool(state, "chief_review", { workerThreadId: tester.threadId }, chief.threadId);
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
    expect(context).toContain([
      "## Earlier workers on this branch",
      `- worker ${worker.threadId}: Full report: ${rowOf(state, worker.threadId).report_path}; bb chief inspect ${worker.threadId}`,
      "  Recorded (last 2 commands): 1 non-zero exit",
      "    npm run lint → exit 1",
      "    npm run build → exit 0",
    ].join("\n"));
  });
});
