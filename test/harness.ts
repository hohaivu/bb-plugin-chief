import { access, mkdir, mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { type PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import plugin from "../server";
import { MIGRATIONS } from "../src/db/migrations";
import { managedSkills } from "../src/core/roles";
import { sdk } from "./sdk";
import { execFileMock } from "./execMock";
export { execFileMock };

// Every skill dir the plugin ships: managedSkills (roles.ts) selects from these, and the fake host throws on an unknown id.
export const AGENT_SKILL_IDS = ["chief", "coordinator", "chief-worker", "chief-role-read-only", "chief-role-worker", "chief-role-reviewer", "chief-role-designer", "chief-role-tester", "chief-role-spec-writer"];

// gh pr view --json headRefName,headRefOid,baseRefName: the pull request's head branch, pinned commit and base.
export const HEAD_SHA = "a".repeat(40);
export const ghHead = (branch: string) => JSON.stringify({ headRefName: branch, headRefOid: HEAD_SHA, baseRefName: "main" });

// Base oracles in test/fixtures/ predate the make-native lines. Expected text = the base oracle with exactly one line spliced in
// after each anchor line; every other byte stays the base's, so a changed, moved or doubled line fails the exact compare.
// The inserted lines are copied from wave 1's plan, not from the implementation.
export const REVIEWER_ANCHOR = "Classify the change, then check it by type:";
export const REVIEWER_NATIVE_LINE = "Native-design check, for feature work only (never a bug fix, nor a refactor or migration on its own; in a mixed change, only its feature part): look for these smells on lines the diff introduced: an alias that re-derives a value an existing function or field already returns; an `if (newKind)` branch in code that already dispatches on kind; a new file or component that mirrors an existing one for one variant; a new flag, option or boolean that duplicates what a type already encodes; a validation or download path beside the shared one; a test whose only purpose is \"nothing else changed\" (a test that proves a listed equivalence or preservation contract is not one); a second system for a concern that already has one (a counter, logger, retry helper, config reader, …). Report each as a finding whose message names, at file:line, the existing value, dispatch, component, type or system it duplicates, and whose fix folds the feature into it. Genuinely different behaviour is not a smell. A smell is a nit unless a listed contract rules it out (a reshape wave's contracts do); then it is an unmet contract. A reshape commit belongs to its feature: judge the feature and its reshape together as one feature against the plan's contracts, not the reshape commit as a refactor with the base commit as the oracle.";
export const PLANNER_ANCHOR = "- Workers never write or run tests: implementation waves hold no test work.";
export const RESHAPE_CHECKLIST_LINE = "- A big feature (3+ modules or 10+ files of new behaviour) whose chain has no reshape wave before its test wave, a reshape wave on a bug fix, refactor or smaller change, or a reshape wave that writes or runs tests.";
// The design-wave plan changes one planner sentence and adds one advisor checklist line; the new text is copied from that plan, the old text from the base oracle.
export const PLANNER_OLD_COMPLEX_TAIL = "A plan with more than one implementation wave gets one advisor review either way; test waves do not count.";
export const PLANNER_NEW_COMPLEX_TAIL = "A plan with more than one implementation wave gets one advisor review either way; design and test waves do not count.";
export const TEST_WAVE_CHECKLIST_LINE = "- A chain without a final test wave, or test work inside an implementation wave.";
export const DESIGN_CHECKLIST_LINE = "- UI whose look no approved design or explicit visual spec fixes with no `design: true` wave before the wave that builds it, or app code inside a design wave.";
/** Base oracle text with `from` replaced by `to` exactly `expectedCount` times. */
export const replaceText = (base: string, from: string, to: string, expectedCount: number) => {
  const parts = base.split(from);
  expect(parts.length - 1).toBe(expectedCount);
  return parts.join(to);
};
/** Base oracle text with `line` inserted after every line that starts with `anchor`; fails when no anchor line exists. */
export const spliceAfter = (base: string, anchor: string, line: string, expectedCount: number) => {
  let count = 0;
  const out = base.split("\n").flatMap((l) => l.startsWith(anchor) ? (count += 1, [l, line]) : [l]).join("\n");
  expect(count).toBe(expectedCount);
  return out;
};
export const withReviewerLine = (base: string, count = 1) => spliceAfter(base, REVIEWER_ANCHOR, REVIEWER_NATIVE_LINE, count);
export const snapshotText = (name: string) => readFile(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

export const disposals: Array<() => Promise<void>> = [];
export const disposeAll = async () => {
  while (disposals.length) await disposals.pop()!();
  execFileMock.mockReset();
};
// Every plan test needs a NOT-doing heading, so a single fixture keeps the wording pinned in one place.
export const PLAN_FIXTURE = "# Plan\n\n## Contracts to verify\n- Totals stay non-negative\n\n## What we're NOT doing\n- x";
export const wave = (n: number, text = "Do the work.") => `# Wave ${n}\n${text}\n\n## Contracts to verify\n- Wave ${n} keeps its invariant`;
// A plan worker's ready report must carry a Deviations heading.
export const NO_DEVIATIONS = "\n\n## Deviations from plan\nNone";
// #159: every chain of a plan ends in a test wave (test: true), which defaults to depending on the wave before it.
// Plan files are artifacts of the data dir: <dataDir>/chief/<project>/<planner>/plan-<n>.md.
export const planFile = (state: { storageRoot: string }, plannerThreadId: string, n: number) => join(state.storageRoot, "chief", "proj_1", plannerThreadId, `plan-${n}.md`);
export const TEST_WAVE = (n: number, dependsOn?: number[]) => ({ body: wave(n, "Write the tests."), test: true, ...(dependsOn ? { dependsOn } : {}) });

export function configurationContext(threadId: string, projectId = "proj_1", name = projectId === "proj_1" ? "Asha" : "Second"): PluginAgentConfigurationContext {
  return {
    thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: projectId, kind: "standard", name, gitRemoteUrl: null },
    environment: { id: "env_1", name: "worktree", path: "/tmp/worktree", workspaceProvisionType: "managed-worktree", branchName: "chief/test" },
    host: { id: "host_1", name: "Local" },
    provider: { id: "codex", model: "model", capabilities: { supportsNativeUserQuestion: false } },
    origin: { kind: null, pluginId: "chief" },
  };
}

export function catalogModel(model: string, reasoningEfforts = ["medium", "high"], isDefault = false) {
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

export async function setup(options: { /** projects.get rejects these ids, as the host does for a project that does not exist. */ missingProjects?: string[]; rules?: string; hostStatus?: string; providerAvailable?: boolean; /** The plugin build under test; defaults to this checkout (the base-preservation tests pass the 95aa7df build). */ module?: typeof plugin; projectPath?: string; pluginId?: string; usageLimits?: (args: any) => unknown; system?: object;
  /** tabs.update fails this many times from the start, so a plugin start can meet it. */
  failTabsUpdates?: number;
  /** Runs on the migrated database right before the plugin starts: seeds state a restart would find. */
  seed?: (ctx: { bb: any; db: any; live: Map<string, any>; tabsStore: Map<string, { revision: number; tabs: any[] }> }) => void;
  /** Runs in every tabs.get after it read its snapshot, before it returns it: a hook may race a write or never settle. */
  onTabsGet?: (ctx: { threadId: string; call: number; tabsStore: Map<string, { revision: number; tabs: any[] }> }) => Promise<void> | void,
  /** Runs in every threads.getPluginMetadata before it answers: a hook may hold the spawn-recovery lookup open while a launch lands. */
  onPluginMetadata?: (threadId: string) => Promise<void> | void } = {}) {
  const storageRoot = await mkdtemp(join(tmpdir(), "chief-plan-"));
  let section: { id: string; name: string; createdAt: number; updatedAt: number } | null = null;
  let spawnIndex = 0;
  let sendFailures = 0;
  let callerPermissionMode = "auto";
  let threadExecution: { model?: string } | null | undefined = null;
  let executionLookupFails = false;
  let projectDefaults: { providerId: string; model: string } | null = null;
  let projectDefaultsReads = 0;
  let getFailures = new Map<string, number>();
  let patch = "diff --git a/totals.ts b/totals.ts\n+const total = subtotal - discount;";
  let updateFailures = new Map<string, number>();
  const live = new Map<string, any>();
  const pluginMetadataStore = new Map<string, any>();
  const queuedMessagesStore = new Map<string, any[]>();
  const sent: any[] = [];
  const eventsStore = new Map<string, any[]>();
  const spawned: any[] = [];
  const stopped: string[] = [];
  const catalogReads: (string | undefined)[] = [];
  const tabsStore = new Map<string, { revision: number; tabs: any[] }>();
  let tabsUpdateFailures = options.failTabsUpdates ?? 0;
  let failedWrites: RegExp | null = null;
  let tabsGets = 0;
  const tabsUpdates: Array<{ threadId: string; expectedRevision: number; tabs: any[] }> = [];
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
  const { bb, harness } = sdk.createFakePluginHost({
    pluginId: options.pluginId ?? "chief",
    agentSkillIds: AGENT_SKILL_IDS,
    sdk: {
      system: options.system ?? { usageLimits: async (args: any) => options.usageLimits?.(args) ?? {} },
      threadSections: {
        list: async () => section ? [section] : [],
        create: async ({ name }: { name: string }) => section = { id: "sec_chief", name, createdAt: 1, updatedAt: 1 },
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => options.missingProjects?.includes(projectId) ? Promise.reject(new Error("not found")) : ({
          id: projectId,
          name: projectId === "proj_1" ? "Asha" : "Second",
          kind: "standard",
          ...(options.projectPath ? { sources: [{ path: options.projectPath, hostId: "host_1", isDefault: true }] } : {}),
        }),
        fileContent: async () => { if (options.rules === undefined) throw new Error("missing"); return { content: options.rules, contentEncoding: "utf8" }; },
        defaultExecutionOptions: async () => { projectDefaultsReads += 1; return projectDefaults; },
      },
      hosts: { get: async () => ({ id: "host_storage", threadStorageRootPath: join(storageRoot, "thread-storage") }), list: async () => [{ id: "host_1", name: "Local", status: options.hostStatus ?? "connected" }] },
      // Thread storage sits on host_storage, not this machine: a plan must be written through it.
      files: {
        write: async ({ hostId, path, content }: { hostId?: string; path: string; content: string }) => {
          if (failedWrites?.test(path)) throw new Error(`write refused for ${path}`);
          // A reviewer's attempt folder (review-<report>/<attempt>/) is written on the host the reviewer runs on, here host_1; every other file goes to host_storage.
          const attemptFolder = /\/review-\d+\/[0-9a-f]{8}\//.test(path);
          if (hostId !== "host_storage" && !(attemptFolder && hostId === "host_1")) throw new Error(`wrote ${path} to host ${hostId}`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content);
          return {};
        },
        // The real host refuses an existing destination (no overwrite flag); node rename would silently replace it.
        move: async ({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }) => {
          if (await access(destinationPath).then(() => true, () => false)) throw new Error(`HTTP 502: Destination already exists: ${destinationPath}`);
          await rename(sourcePath, destinationPath);
          return {};
        },
        // One file, not recursive; a missing path errors, as on the host.
        remove: async ({ path }: { path: string }) => { await unlink(path); return {}; },
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
        defaultExecutionOptions: async () => executionLookupFails ? Promise.reject(new Error("execution options unavailable")) : threadExecution === undefined ? null : ({ permissionMode: callerPermissionMode, ...(threadExecution ?? {}) }),
        spawn: async (args: any) => {
          spawned.push(args);
          spawnIndex += 1;
          const id = `thr_${spawnIndex}`;
          const thread = sdk.makeThreadResponse({
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
        getPluginMetadata: async ({ threadId }: { threadId: string }) => { await options.onPluginMetadata?.(threadId); return pluginMetadataStore.get(threadId) ?? {}; },
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
          get: async ({ threadId }: { threadId: string }) => {
            const snapshot = structuredClone(tabsStore.get(threadId) ?? { revision: 0, tabs: [] });
            tabsGets += 1;
            await options.onTabsGet?.({ threadId, call: tabsGets, tabsStore });
            return snapshot;
          },
          update: async ({ threadId, expectedRevision, tabs }: any) => {
            tabsUpdates.push({ threadId, expectedRevision, tabs });
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
  if (options.seed) {
    bb.storage.migrate(bb.storage.database(), MIGRATIONS);
    options.seed({ bb, db: bb.storage.database(), live, tabsStore });
  }
  await (options.module ?? plugin)(bb);
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
    /** Makes every threads.defaultExecutionOptions lookup reject. */
    failExecutionLookups() { executionLookupFails = true; },
    /** undefined makes defaultExecutionOptions resolve null. */
    setThreadExecution(next: { model?: string } | null | undefined) { threadExecution = next; },
    setProjectDefaults(next: { providerId: string; model: string } | null) { projectDefaults = next; },
    projectDefaultsReads: () => projectDefaultsReads,
    tabs: (threadId: string) => tabsStore.get(threadId)?.tabs ?? [],
    tabsGets: () => tabsGets,
    tabsUpdates,
    seedTabs(threadId: string, tabs: any[]) { tabsStore.set(threadId, { revision: 7, tabs }); },
    failTabsUpdates(count: number) { tabsUpdateFailures = count; },
    /** Every file write to a path matching `pattern` fails until it is set to null. */
    failWritesMatching(pattern: RegExp | null) { failedWrites = pattern; },
    setPatch(next: string) { patch = next; },
    seedQueuedMessage(threadId: string, text: string) {
      const existing = queuedMessagesStore.get(threadId) ?? [];
      existing.push({ content: [{ type: "text", text, mentions: [] }] });
      queuedMessagesStore.set(threadId, existing);
    },
    seedPluginMetadata(threadId: string, metadata: any) { pluginMetadataStore.set(threadId, metadata); },
    addLive(threadId: string, projectId: string, title = "Existing thread", originPluginId: string | null = null) {
      live.set(threadId, sdk.makeThreadResponse({
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

export async function start(state: Awaited<ReturnType<typeof setup>>, projectId = "proj_1") {
  const result = await state.harness.behavior.runCli(["start", "--project", projectId, "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout!) as { threadId: string; created: boolean };
}

export async function delegate(
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
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout!) as { threadId: string; projectId: string };
}

// A plan of more than one implementation wave needs its one advisor review before any wave is delegated.
export async function approvePlan(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, planThreadId: string) {
  const chiefCtx = { threadId: chiefThreadId, projectId: "proj_1" };
  await state.harness.behavior.callAgentTool("chief_consult", { planThreadId, title: "Plan", mission: "Review this plan before delegation" }, chiefCtx);
  const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
  await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "The plan is sound.", verdict: "approve" }, { threadId: advisor.threadId, projectId: "proj_1" });
}

// Waiving a plan's test waves (chief_skip_tests) drops them from the wave graph, so the implementation waves are the
// chain tips again: the graph the tests below were written against, before #159 made every chain end in a test wave.
export async function waiveTests(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, planThreadId: string, testWaves: number[]) {
  for (const wave of testWaves) {
    await state.harness.behavior.callAgentTool("chief_skip_tests", { planThreadId, wave, reason: "graph under test is the implementation waves" }, { threadId: chiefThreadId, projectId: "proj_1" });
  }
}

// A plan wave delegated the way the server stored one before a chain shared one branch: a worker row of its own, on its own branch.
// chief_delegate now refuses to build one (a later wave of a chain replaces its chain's worker), so a test of the legacy stacked
// graph seeds the row directly: an unplanned worker, stamped with its plan wave. The thread store reloads its row cache on its
// next write (the next delegate or report), which every caller below makes before it reads the row back.
export async function legacyWave(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, planThreadId: string, n: number, branch: string, title = `Wave ${n} work`) {
  const result = await state.harness.behavior.runCli([
    "delegate", "--title", title, "--mission", "Do it", "--unplanned-reason", "Legacy stacked fixture", "--branch", branch, "--json",
  ], { threadId: chiefThreadId, projectId: "proj_1" });
  expect(result.exitCode).toBe(0);
  const { threadId } = JSON.parse(result.stdout!) as { threadId: string };
  state.db.prepare("UPDATE managed_threads SET plan_thread_id=?, plan_wave=?, unplanned_reason=NULL WHERE thread_id=?").run(planThreadId, n, threadId);
  return { threadId };
}

// chief_review answers `Started|Using existing “<title>” in thread <id>.`: the retired `bb chief review` CLI answered JSON with these fields.
export async function chiefReview(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, params: { workerThreadId?: string; branch?: string; pullRequest?: string }) {
  const text = await state.harness.behavior.callAgentTool("chief_review", params, { threadId: chiefThreadId, projectId: "proj_1" }) as string;
  const [, title, threadId] = /^(?:Started|Using existing) “(.*)” in thread (\S+?)\./.exec(text)!;
  return { text, title: title!, threadId: threadId!, created: text.startsWith("Started") };
}

// A reviewer's ready report must carry findings: [] for an approve and a blocking entry for request_changes.
/** The review-context.md a reviewer reads: the brief, the worker's report and any earlier review travel there, not in the prompt. */
export const reviewContextOf = async (state: { spawned: { prompt?: string }[] }, reviewerThreadId: string) => {
  // The reviewer's prompt names the absolute path the context was written to before the launch (thr_<n> is the n-th spawn).
  const prompt = state.spawned[Number(reviewerThreadId.slice("thr_".length)) - 1]?.prompt ?? "";
  const path = /Read `([^`]+review-context\.md)` in full before reviewing/.exec(prompt)?.[1];
  if (!path) throw new Error(`the prompt of ${reviewerThreadId} names no review-context.md`);
  return readFile(path, "utf8");
};
export const latestReviewContext = async (state: Awaited<ReturnType<typeof setup>>) =>
  reviewContextOf(state, (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!.threadId);
/** The Pending line a ready, unplanned worker shows until Chief starts its review; the roster and the lifecycle alert carry it word for word. */
export const readyAction = (id: string) => `Workers never test: delegate a tester on this branch first — chief_delegate (replaces: ${id}, kind: tester) — or, to go without, pass testsSkipped (your reason) when you complete it. Start its review now: chief_review (workerThreadId: ${id}), and complete the work on the reviewer's approve — or, if you judge a review unnecessary after reading its report and recorded commands, complete it without one: chief_complete (threadId: ${id}, skipReview: your reason).`;
export const APPROVE = { verdict: "approve", findings: [] } as const;
export const REQUEST_CHANGES = { verdict: "request_changes", findings: [{ file: "totals.ts", line: 1, severity: "blocking", message: "Totals go negative." }] } as const;

// #159: completing unplanned work needs a tester (or testsSkipped) and a review (or skipReview). A test that is not about
// either closes its worker out with both reasons.
export const CLOSE_OUT = { testsSkipped: "tests are not under test here", skipReview: "review is not under test here" };
export async function completeWorker(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, threadId: string, extra: Record<string, unknown> = {}) {
  // skipReview needs a ready report to skip a review of.
  if (!state.db.prepare("SELECT 1 FROM managed_threads WHERE thread_id=? AND last_report_state='ready'").get(threadId)) {
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, { threadId, projectId: "proj_1" });
  }
  return state.harness.behavior.callAgentTool("chief_complete", { threadId, ...CLOSE_OUT, ...extra }, { threadId: chiefThreadId, projectId: "proj_1" });
}

export async function status(state: Awaited<ReturnType<typeof setup>>) {
  return state.harness.behavior.callRpc("status", null);
}

// A two-wave schedule (wave 1 carrying the required "What
// we're NOT doing" section) shared by every delegate()-from-plan test below.
export async function planTwoWaves(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string) {
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


export function rowOf(state: { db: any }, id: string) {
  return state.db.prepare("SELECT * FROM managed_threads WHERE thread_id=?").get(id) as any;
}

