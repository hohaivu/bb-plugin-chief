import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
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
import { PR_AGENT_DIR } from "./prAgent";
import { reviewBrief, type ReviewBriefInput } from "./reviewStart";
import { managedSkills } from "./roles";

// Stands in for git/gh/glab so pull-request resolution tests never shell out for real.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => {
  const execFile: any = () => { throw new Error("execFile must be invoked through promisify"); };
  execFile[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => execFileMock(...args);
  return { execFile };
});

// Every skill dir the plugin ships: managedSkills (roles.ts) selects from these, and the fake host throws on an unknown id.
const AGENT_SKILL_IDS = ["chief", "coordinator", "chief-worker", "chief-role-read-only", "chief-role-worker", "chief-role-reviewer", "chief-role-designer", "chief-role-tester", "chief-role-spec-writer"];

// gh pr view --json headRefName,headRefOid,baseRefName: the pull request's head branch, pinned commit and base.
const HEAD_SHA = "a".repeat(40);
const ghHead = (branch: string) => JSON.stringify({ headRefName: branch, headRefOid: HEAD_SHA, baseRefName: "main" });

// Base oracles in __snapshots__/ predate the make-native lines. Expected text = the base oracle with exactly one line spliced in
// after each anchor line; every other byte stays the base's, so a changed, moved or doubled line fails the exact compare.
// The inserted lines are copied from wave 1's plan, not from the implementation.
const REVIEWER_ANCHOR = "Classify the change, then check it by type:";
const REVIEWER_NATIVE_LINE = "Native-design check, for feature work only (never a bug fix, nor a refactor or migration on its own; in a mixed change, only its feature part): look for these smells on lines the diff introduced: an alias that re-derives a value an existing function or field already returns; an `if (newKind)` branch in code that already dispatches on kind; a new file or component that mirrors an existing one for one variant; a new flag, option or boolean that duplicates what a type already encodes; a validation or download path beside the shared one; a test whose only purpose is \"nothing else changed\" (a test that proves a listed equivalence or preservation contract is not one); a second system for a concern that already has one (a counter, logger, retry helper, config reader, …). Report each as a finding whose message names, at file:line, the existing value, dispatch, component, type or system it duplicates, and whose fix folds the feature into it. Genuinely different behaviour is not a smell. A smell is a nit unless a listed contract rules it out (a reshape wave's contracts do); then it is an unmet contract. A reshape commit belongs to its feature: judge the feature and its reshape together as one feature against the plan's contracts, not the reshape commit as a refactor with the base commit as the oracle.";
const PLANNER_ANCHOR = "- Workers never write or run tests: implementation waves hold no test work.";
const PLANNER_RESHAPE_LINE = "- Big feature (new behaviour, not a bug fix, refactor, migration or docs- or test-only change, whose implementation touches 3+ modules or 10+ files): put one reshape wave between the chain's last feature implementation wave and its test wave. It is an ordinary implementation wave on the same chain (default `dependsOn`), whose worker continues the branch with `replaces:` the feature worker. Its body orders the make-native skill (load it when listed) and restates the steps: read the feature diff against the chain's base (`git diff origin/<base>...HEAD`); learn each touched area one or two levels deeper than the call sites; redesign the feature as if it were in the original spec, folding it into the existing types, dispatch and systems, with no new abstraction layer and genuinely different behaviour kept; apply Pareto (the common case simple, an edge case that would complicate it handled separately or failing clearly); `git grep` each removed symbol for leftovers; run the project's lint/analyze and build. The reshape worker never writes, edits, deletes or runs tests: make-native's step 5 is the tester's. It commits the reshape separately from the feature commits (`refactor` when behaviour is unchanged, `feat` when it changes), keeps every feature contract and the committed spec, and reports blocked when a better shape would break one. Its `## Contracts to verify` repeats the feature's contracts and adds: no make-native smell left in the feature diff. The chain's test wave body then also orders the tests rewritten to the reshaped design: delete tests whose only purpose is proving old behaviour survived the workaround, and update the rest. Never add a reshape wave to a bug fix, a refactor or a smaller feature.";
const RESHAPE_CHECKLIST_LINE = "- A big feature (3+ modules or 10+ files of new behaviour) whose chain has no reshape wave before its test wave, a reshape wave on a bug fix, refactor or smaller change, or a reshape wave that writes or runs tests.";
/** Base oracle text with `line` inserted after every line that starts with `anchor`; fails when no anchor line exists. */
const spliceAfter = (base: string, anchor: string, line: string, expectedCount: number) => {
  let count = 0;
  const out = base.split("\n").flatMap((l) => l.startsWith(anchor) ? (count += 1, [l, line]) : [l]).join("\n");
  expect(count).toBe(expectedCount);
  return out;
};
const withReviewerLine = (base: string, count = 1) => spliceAfter(base, REVIEWER_ANCHOR, REVIEWER_NATIVE_LINE, count);
const snapshotText = (name: string) => readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", name), "utf8");

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

function configurationContext(threadId: string, projectId = "proj_1", name = projectId === "proj_1" ? "Asha" : "Second"): PluginAgentConfigurationContext {
  return {
    thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
    project: { id: projectId, kind: "standard", name, gitRemoteUrl: null },
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

async function setup(options: { /** projects.get rejects these ids, as the host does for a project that does not exist. */ missingProjects?: string[]; rules?: string; hostStatus?: string; providerAvailable?: boolean; projectPath?: string; pluginId?: string; usageLimits?: (args: any) => unknown; system?: object;
  /** tabs.update fails this many times from the start, so a plugin start can meet it. */
  failTabsUpdates?: number;
  /** Runs on the migrated database right before the plugin starts: seeds state a restart would find. */
  seed?: (ctx: { bb: any; db: any; live: Map<string, ReturnType<typeof makeThreadResponse>>; tabsStore: Map<string, { revision: number; tabs: any[] }> }) => void;
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
  let tabsUpdateFailures = options.failTabsUpdates ?? 0;
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
  const { bb, harness } = createFakePluginHost({
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
    tabsGets: () => tabsGets,
    tabsUpdates,
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
  expect(result.exitCode, result.stderr).toBe(0);
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

// A plan wave delegated the way the server stored one before a chain shared one branch: a worker row of its own, on its own branch.
// chief_delegate now refuses to build one (a later wave of a chain replaces its chain's worker), so a test of the legacy stacked
// graph seeds the row directly: an unplanned worker, stamped with its plan wave. The thread store reloads its row cache on its
// next write (the next delegate or report), which every caller below makes before it reads the row back.
async function legacyWave(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, planThreadId: string, n: number, branch: string, title = `Wave ${n} work`) {
  const result = await state.harness.behavior.runCli([
    "delegate", "--title", title, "--mission", "Do it", "--unplanned-reason", "Legacy stacked fixture", "--branch", branch, "--json",
  ], { threadId: chiefThreadId, projectId: "proj_1" });
  expect(result.exitCode).toBe(0);
  const { threadId } = JSON.parse(result.stdout!) as { threadId: string };
  state.db.prepare("UPDATE managed_threads SET plan_thread_id=?, plan_wave=?, unplanned_reason=NULL WHERE thread_id=?").run(planThreadId, n, threadId);
  return { threadId };
}

// chief_review answers `Started|Using existing “<title>” in thread <id>.`: the retired `bb chief review` CLI answered JSON with these fields.
async function chiefReview(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, params: { workerThreadId?: string; branch?: string; pullRequest?: string }) {
  const text = await state.harness.behavior.callAgentTool("chief_review", params, { threadId: chiefThreadId, projectId: "proj_1" }) as string;
  const [, title, threadId] = /^(?:Started|Using existing) “(.*)” in thread (\S+?)\./.exec(text)!;
  return { text, title: title!, threadId: threadId!, created: text.startsWith("Started") };
}

// A reviewer's ready report must carry findings: [] for an approve and a blocking entry for request_changes.
/** The review-context.md a reviewer reads: the brief, the worker's report and any earlier review travel there, not in the prompt. */
const reviewContextOf = (state: { storageRoot: string }, reviewerThreadId: string) => readFile(join(state.storageRoot, reviewerThreadId, "review-context.md"), "utf8");
const latestReviewContext = async (state: Awaited<ReturnType<typeof setup>>) =>
  reviewContextOf(state, (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!.threadId);
/** The Pending line a ready, unplanned worker shows until Chief starts its review; the roster and the lifecycle alert carry it word for word. */
const readyAction = (id: string) => `Workers never test: delegate a tester on this branch first — chief_delegate (replaces: ${id}, kind: tester) — or, to go without, pass testsSkipped (your reason) when you complete it. Start its review now: chief_review (workerThreadId: ${id}), and complete the work on the reviewer's approve — or, if you judge a review unnecessary after reading its report and recorded commands, complete it without one: chief_complete (threadId: ${id}, skipReview: your reason).`;
const APPROVE = { verdict: "approve", findings: [] } as const;
const REQUEST_CHANGES = { verdict: "request_changes", findings: [{ file: "totals.ts", line: 1, severity: "blocking", message: "Totals go negative." }] } as const;

// #159: completing unplanned work needs a tester (or testsSkipped) and a review (or skipReview). A test that is not about
// either closes its worker out with both reasons.
const CLOSE_OUT = { testsSkipped: "tests are not under test here", skipReview: "review is not under test here" };
async function completeWorker(state: Awaited<ReturnType<typeof setup>>, chiefThreadId: string, threadId: string, extra: Record<string, unknown> = {}) {
  // skipReview needs a ready report to skip a review of.
  if (!state.db.prepare("SELECT 1 FROM managed_threads WHERE thread_id=? AND last_report_state='ready'").get(threadId)) {
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, { threadId, projectId: "proj_1" });
  }
  return state.harness.behavior.callAgentTool("chief_complete", { threadId, ...CLOSE_OUT, ...extra }, { threadId: chiefThreadId, projectId: "proj_1" });
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
    await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
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
    await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
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

  // Contract (work-list spec, Removed): spawning a Chief neither reads nor writes thread tabs.
  test("starting a Chief makes no tabs call", async () => {
    const state = await setup();
    state.seedTabs("thr_1", [{ kind: "git-diff", id: "user_diff" }]);
    await state.harness.behavior.callRpc("start", { projectId: "proj_1" });
    await state.harness.behavior.callRpc("create", { projectId: "proj_1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.tabsGets()).toBe(0);
    expect(state.tabsUpdates).toEqual([]);
    expect(state.tabs("thr_1")).toEqual([{ kind: "git-diff", id: "user_diff" }]);
  });

  // Contract (work-list spec, Removed): the `pending` RPC and its realtime signal are gone; no store reload, sweep or state change publishes the channel.
  test("the pending RPC is unknown and nothing publishes the pending realtime channel", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await expect(state.harness.behavior.callRpc("pending", { threadId: chief.threadId })).rejects.toThrow();

    const worker = await delegate(state, chief.threadId, "Fix checkout totals"); // store write -> reload
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_roster", { todo: { text: "Follow up" } }, opts);
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(worker.threadId)!, lastAssistantText: "done" }); // sweep
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(worker.threadId)!, lastAssistantText: "boom" });
    await state.supervisorCycle();
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, ...CLOSE_OUT }, opts);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(state.harness.inspection.realtimeSignals.filter((signal) => signal.channel === "pending")).toEqual([]);
  });

  // Contract (work-list spec, Added: startup unpin): at plugin start each active Chief loses a stale `pending` plugin-panel tab, and only that tab.
  describe("plugin start unpins the stale pending tab", () => {
    const stale = { kind: "plugin-panel", id: "plugin-panel:chief%3Apending%3A:none", pluginId: "chief", actionId: "pending", title: "Chief to-do", paramsJson: null };
    const userDiff = { kind: "git-diff", id: "user_diff" };
    // Looks like the stale tab but belongs to another plugin, or to another action of this one: both must stay.
    const otherPluginPending = { ...stale, id: "plugin-panel:other%3Apending%3A:none", pluginId: "other" };
    const ownOtherAction = { ...stale, id: "plugin-panel:chief%3Anotes%3A:none", actionId: "notes", title: "Notes" };
    const chiefRow = (db: any, id: string, state: string) => {
      db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, title, state, status, created_at, updated_at) VALUES (?, 'chief', 'proj_1', 'Chief · Asha', ?, 'idle', 1, 1)`).run(id, state);
    };
    const liveChief = (live: Map<string, any>, id: string) => live.set(id, makeThreadResponse({ id, projectId: "proj_1", environmentId: `env_${id}`, title: "Chief · Asha", sectionId: null, visibility: "visible", status: "idle", originPluginId: "chief" }));
    const withChiefs = (tabs: Record<string, any[]>, states: Record<string, string> = { thr_old: "idle" }) => ({ db, live, tabsStore }: any) => {
      for (const [id, state] of Object.entries(states)) { chiefRow(db, id, state); liveChief(live, id); }
      for (const [id, list] of Object.entries(tabs)) tabsStore.set(id, { revision: 7, tabs: list });
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

    test("an active Chief loses exactly that tab; the other tabs keep their order and content", async () => {
      const state = await setup({ seed: withChiefs({ thr_old: [userDiff, stale, otherPluginPending, ownOtherAction] }) });
      await vi.waitFor(() => expect(state.tabs("thr_old")).toEqual([userDiff, otherPluginPending, ownOtherAction]));
      expect(state.tabsUpdates).toEqual([{ threadId: "thr_old", expectedRevision: 7, tabs: [userDiff, otherPluginPending, ownOtherAction] }]);
    });

    test("every active Chief is unpinned; a complete Chief's tabs are left alone", async () => {
      const state = await setup({ seed: withChiefs(
        { thr_old: [stale], thr_idle: [userDiff, stale], thr_done: [stale] },
        { thr_old: "active", thr_idle: "idle", thr_done: "complete" },
      ) });
      await vi.waitFor(() => expect([state.tabs("thr_old"), state.tabs("thr_idle")]).toEqual([[], [userDiff]]));
      expect(state.tabs("thr_done")).toEqual([stale]);
    });

    test("an active Chief without that tab gets no tabs.update", async () => {
      const state = await setup({ seed: withChiefs({ thr_old: [userDiff, otherPluginPending, ownOtherAction] }) });
      await vi.waitFor(() => expect(state.tabsGets()).toBe(1)); // it looked
      await settle();
      expect(state.tabsUpdates).toEqual([]);
      expect(state.tabs("thr_old")).toEqual([userDiff, otherPluginPending, ownOtherAction]);
    });

    test("a revision conflict on the first tabs.update retries once and succeeds", async () => {
      const late = { kind: "git-diff", id: "late_tab" };
      // The user adds a tab between the unpin's read and its write.
      const state = await setup({
        seed: withChiefs({ thr_old: [userDiff, stale] }),
        onTabsGet: ({ threadId, call, tabsStore }) => {
          if (call === 1) tabsStore.set(threadId, { revision: 8, tabs: [userDiff, stale, late] });
        },
      });
      await vi.waitFor(() => expect(state.tabs("thr_old")).toEqual([userDiff, late]));
      expect(state.tabsUpdates.map((update) => update.expectedRevision)).toEqual([7, 8]);
    });

    test("two failures log a warning once; start completes and nothing throws", async () => {
      let warn: any;
      const state = await setup({ failTabsUpdates: 2, seed: (ctx) => { warn = vi.spyOn(ctx.bb.log, "warn"); withChiefs({ thr_old: [userDiff, stale] })(ctx); } });
      await vi.waitFor(() => expect(state.tabsUpdates).toHaveLength(2));
      await settle();
      expect(warn.mock.calls.map(([message]: [string]) => message).filter((message: string) => message.startsWith("Could not unpin the pending tab on thr_old"))).toHaveLength(1);
      expect(state.tabs("thr_old")).toEqual([userDiff, stale]);
      expect((await status(state)).threads.find((row) => row.threadId === "thr_old")).toBeDefined();
    });

    test("plugin start does not wait for the tabs read", async () => {
      // setup() resolves only if plugin start does, and the tabs read never settles.
      const state = await setup({ seed: withChiefs({ thr_old: [stale] }), onTabsGet: () => new Promise<void>(() => {}) });
      await vi.waitFor(() => expect(state.tabsGets()).toBe(1));
      expect(state.tabs("thr_old")).toEqual([stale]);
    });
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

  test("stays silent on a plain idle event and alerts Chief once on a failed one", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    // BB's own native parent notice already covers a plain idle thread; the
    // plugin stays silent there. A failure with no transient cause is Chief's to reroute.
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
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].threadId).toBe(chief.threadId);
    const text = state.sent[0].input[0].text;
    expect(text).toContain(`worker “Fix checkout totals” (${worker.threadId}) failed.`);
    expect(text).toContain("No provider error was recorded.");
    expect(text).toContain("chief_consult");
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

  test("transient provider: a non-transient error alerts Chief to reroute, with no retry", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await failWith(state, worker.threadId, "context window exceeded");
    expect(state.sent).toHaveLength(1);
    const text = state.sent[0].input[0].text;
    expect(text).toContain(`(${worker.threadId}) failed.`);
    expect(text).toMatch(/Provider error: .*context window exceeded/);
    expect(text).not.toContain("bb thread retry");
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

  test("cooldown: a model limit blocks delegate, plan, consult and branch review on that model until it expires", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "429 usage_limit_reached");
    expect(state.db.prepare("SELECT provider_id, model FROM provider_cooldowns").all()).toEqual([{ provider_id: "codex", model: "gpt-6-astra" }]);
    // No role pick: the spawn would run on the project default.
    state.setProjectDefaults({ providerId: "codex", model: "gpt-6-astra" });
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
      await expect(state.harness.behavior.callAgentTool(tool, params, opts)).rejects.toThrow(/Provider codex model gpt-6-astra hit its usage limit/);
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

  test("cooldown: a refused review leaves the previous reviewer not complete", async () => {
    const { state, worker, review } = await coolingReviewer();
    state.db.prepare("UPDATE provider_cooldowns SET until_at=0").run();
    await review();
    const first = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Changes", ...REQUEST_CHANGES }, { threadId: first.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed" }, { threadId: worker.threadId, projectId: "proj_1" });
    state.db.prepare("UPDATE provider_cooldowns SET until_at=?").run(Date.now() + 600_000);
    await expect(review()).rejects.toThrow(/hit its usage limit/);
    expect((state.db.prepare("SELECT state FROM managed_threads WHERE thread_id=?").get(first.threadId) as { state: string }).state).not.toBe("complete");
  });

  test("cooldown: worker, planner, advisor and branch review on a cooling project-default model are refused", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await coolDown(state, worker.threadId, "429 usage_limit_reached");
    state.setProjectDefaults({ providerId: "codex", model: "gpt-6-astra" });
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    for (const [tool, params] of [
      ["chief_delegate", { title: "Next", mission: "Do it", unplannedReason: "Bounded test fixture" }],
      ["chief_plan", { title: "Rework", mission: "Propose" }],
      ["chief_consult", { title: "Diagnose", mission: "Explore" }],
      ["chief_review", { branch: "feature/x" }],
    ] as const) {
      await expect(state.harness.behavior.callAgentTool(tool, params, opts)).rejects.toThrow(/Provider codex model gpt-6-astra hit its usage limit/);
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
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Ready${NO_DEVIATIONS}` }, { threadId: workerId, projectId: "proj_1" });
      const review = await chiefReview(state, chiefId, { workerThreadId: workerId });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...(verdict === "approve" ? APPROVE : REQUEST_CHANGES) }, { threadId: review.threadId, projectId: "proj_1" });
    };

    test("chief stats: an unplanned chain completes once; open and archived tasks count separately", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId, "Fix checkout totals", { branch: "feature/x" });
      await reviewThenVerdict(state, chief.threadId, first.threadId, "request_changes");
      const fix = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: first.threadId });
      await reviewThenVerdict(state, chief.threadId, fix.threadId, "approve");
      await completeWorker(state, chief.threadId, fix.threadId, { skipReview: undefined });
      await delegate(state, chief.threadId, "Open task", { branch: "feature/open" });
      const archived = await delegate(state, chief.threadId, "Archived task", { branch: "feature/gone" });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(archived.threadId)! });

      const result = await stats(state);
      expect(result.tasks).toMatchObject({ total: 3, completed: 1, open: 1, dropped: 1 });
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
      const ctx = { threadId: chief.threadId, projectId: "proj_1" };
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctx);
      const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Two waves, then their tests.",
        plan: [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)],
      }, { threadId: planner.threadId, projectId: "proj_1" });
      await approvePlan(state, chief.threadId, planner.threadId);
      await waiveTests(state, chief.threadId, planner.threadId, [3]);
      const path1 = planFile(state, planner.threadId, 1);
      const path2 = planFile(state, planner.threadId, 2);
      const wave1 = JSON.parse((await state.harness.behavior.runCli(["delegate", "--title", "Wave 1", "--mission", `Implement ${path1}`, "--plan-thread", planner.threadId, "--wave", "1", "--json"], ctx)).stdout!);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 1 done${NO_DEVIATIONS}` }, { threadId: wave1.threadId, projectId: "proj_1" });
      expect((await stats(state)).tasks).toMatchObject({ total: 1, completed: 0, open: 1, dropped: 0 });
      await completeWorker(state, chief.threadId, wave1.threadId, { testsSkipped: undefined });
      expect((await stats(state)).tasks.dropped).toBe(1);

      const wave2 = JSON.parse((await state.harness.behavior.runCli(["delegate", "--title", "Wave 2", "--mission", `Implement ${path2}`, "--plan-thread", planner.threadId, "--wave", "2", "--replaces", wave1.threadId, "--json"], ctx)).stdout!);
      await reviewThenVerdict(state, chief.threadId, wave2.threadId, "approve");
      await completeWorker(state, chief.threadId, wave2.threadId, { testsSkipped: undefined, skipReview: undefined });
      const result = await stats(state);
      expect(result.tasks).toMatchObject({ total: 1, completed: 1, open: 0, dropped: 0 });
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
        plan: [{ body: PLAN_FIXTURE }, { body: wave(2), dependsOn: [] }, TEST_WAVE(3, [1]), TEST_WAVE(4, [2])],
      }, { threadId: planner.threadId, projectId: "proj_1" });
      await approvePlan(state, chief.threadId, planner.threadId);
      await waiveTests(state, chief.threadId, planner.threadId, [3, 4]);
      const delegateWave = async (n: number) => JSON.parse((await state.harness.behavior.runCli([
        "delegate", "--title", `Wave ${n}`, "--mission", "Do it", "--plan-thread", planner.threadId, "--wave", String(n), "--branch", `feature/w${n}`, "--json",
      ], ctx)).stdout!) as { threadId: string };
      const w1 = await delegateWave(1);
      const w2 = await delegateWave(2);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 2 done${NO_DEVIATIONS}` }, { threadId: w2.threadId, projectId: "proj_1" });
      await completeWorker(state, chief.threadId, w2.threadId, { testsSkipped: undefined });
      // Wave 2 is the last wave by number but wave 1's chain is still running.
      expect((await stats(state)).tasks.completed).toBe(0);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Wave 1 done${NO_DEVIATIONS}` }, { threadId: w1.threadId, projectId: "proj_1" });
      await completeWorker(state, chief.threadId, w1.threadId, { testsSkipped: undefined });
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

      // Review counts: one plan review covers two workers (two target rows per report) and counts as one event per report.
      // A branch-only reviewer covers no worker and has no task; it counts in the global totals only.
      const second = await delegate(state, chief.threadId, "Second task");
      const seedReviewer = (id: string, extra: Record<string, unknown>, covers: string[]) => {
        const row = { thread_id: id, role: "reviewer", project_id: "proj_1", chief_thread_id: chief.threadId, title: id, state: "ready", created_at: 1, updated_at: 1, ...extra };
        state.db.prepare(`INSERT INTO managed_threads (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
        for (const covered of covers) state.db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq) VALUES (?, ?, 1)`).run(id, covered);
        state.addLive(id, "proj_1");
      };
      seedReviewer("review_plan", { worker_thread_id: worker.threadId }, [worker.threadId, second.threadId]);
      seedReviewer("review_branch", { branch: "feature/orphan" }, []);
      // The thread store reloads its row cache on its next write; seeded rows are read after this report.
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: second.threadId, projectId: "proj_1" });
      const reviewer = (id: string) => ({ threadId: id, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fix it.", ...REQUEST_CHANGES }, reviewer("review_plan"));
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed.", ...APPROVE }, reviewer("review_plan"));
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fine.", ...APPROVE }, reviewer("review_branch"));
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM reviewer_verdicts WHERE reviewer_thread_id='review_plan'").get()).toEqual({ n: 4 });

      const reviewed = await stats(state, { threadId: chief.threadId, projectId: "proj_1" });
      // 2 events of the plan review + 1 of the branch-only reviewer, not 5 rows.
      expect(reviewed.verdicts).toEqual({ approve: 2, request_changes: 1 });
      expect(reviewed.repairs.requestChanges).toBe(1);
      // The plan review belongs to its first worker's task; the second task and the orphan reviewer add nothing per task.
      const perTask = (title: string) => reviewed.perTask.find((task: any) => task.title === title);
      expect(perTask("Fix checkout totals")).toMatchObject({ approvals: 1, requestChanges: 1 });
      expect(perTask("Second task")).toMatchObject({ approvals: 0, requestChanges: 0 });
      expect(reviewed.perTask.reduce((n: number, task: any) => n + task.approvals, 0)).toBe(1);
      expect(byChief.perTask.every((task: any) => task.approvals === 0 && task.requestChanges === 0)).toBe(true);
    });

    // Contract (PR #187): stats counts a legacy reviewer (no reviewer_verdicts rows, current verdict request_changes) as one event,
    // while the replacement gate still reads its carried reject_streak of 3. The two numbers answer different questions.
    test("chief stats: a legacy reviewer with a carried streak of 3 is one request_changes event, and still stops a replacement", async () => {
      const state = await setup();
      const chief = await start(state);
      const worker = await delegate(state, chief.threadId, "Legacy task", { branch: "feature/legacy-streak" });
      state.db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at, worker_thread_id, verdict, reject_streak)
        VALUES ('legacy_review', 'reviewer', 'proj_1', ?, 'legacy_review', 'ready', 1, 1, ?, 'request_changes', 3)`).run(chief.threadId, worker.threadId);
      state.db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq) VALUES ('legacy_review', ?, 1)`).run(worker.threadId);
      state.addLive("legacy_review", "proj_1");
      // The thread store reloads its row cache on its next write.
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready" }, { threadId: worker.threadId, projectId: "proj_1" });

      expect(state.db.prepare("SELECT COUNT(*) AS n FROM reviewer_verdicts").get()).toEqual({ n: 0 });
      const result = await stats(state);
      expect(result.verdicts).toEqual({ approve: 0, request_changes: 1 });
      expect(result.perTask[0]).toMatchObject({ approvals: 0, requestChanges: 1 });
      await expect(state.harness.behavior.callAgentTool("chief_delegate", {
        title: "Repair", mission: "Fix the findings", replaces: worker.threadId,
      }, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow(`The reviewer has requested changes 3 times in a row on ${worker.threadId}. Do not delegate another round`);
    });

    // Contract (PR #187, preservation): the whole `bb chief stats` text and JSON, project-wide and per Chief, equal what pre-refactor
    // 512cfeb855abda0ae90df972121b977318e959d7 printed on this same fixture under a fixed clock. The oracle file was captured by running
    // this marked block against 512cfeb's server.ts, with the one marked comparison line swapped for a write. It also pins the fixture's
    // database hash, so a drifting fixture fails here instead of passing against a stale oracle.
    // Regression: stats counting a review event per target row, per carried streak or per replacement chain; a legacy reviewer counted
    // twice or dropped; or any other stats byte changing with the refactor.
    // <stats-oracle-fixture>
    const statsOracleRun = async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        let clock = Date.UTC(2026, 0, 1);
        const tick = (minutes: number) => vi.setSystemTime((clock += minutes * 60_000));
        tick(0);
        const state = await setup();
        const chief = await start(state);
        const other = JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!);
        const asWorker = (id: string) => ({ threadId: id, projectId: "proj_1" });
        const ready = (id: string) => state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: `Ready${NO_DEVIATIONS}` }, asWorker(id));
        tick(5);
        const taskA = await delegate(state, chief.threadId, "Task A", { branch: "feature/a" });
        tick(5);
        await ready(taskA.threadId);
        tick(5);
        const taskB = await delegate(state, chief.threadId, "Task B", { branch: "feature/b" });
        const taskA2 = await delegate(state, chief.threadId, "Task A", { replaces: taskA.threadId });
        const taskO = await delegate(state, other.threadId, "Other task", { branch: "feature/other" });
        // Reviewer rows: report_seq 1 targets for the ones that report; legacy rows carry a verdict and no history.
        const seed = (id: string, owner: string, extra: Record<string, unknown>, covers: string[]) => {
          const row = { thread_id: id, role: "reviewer", project_id: "proj_1", chief_thread_id: owner, title: id, state: "ready", created_at: clock, updated_at: clock, ...extra };
          state.db.prepare(`INSERT INTO managed_threads (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
          for (const covered of covers) state.db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq) VALUES (?, ?, 1)`).run(id, covered);
          state.addLive(id, "proj_1");
        };
        // Multi-target plan review: three reports, each covering Task A's worker and Task B's worker (two target rows per report).
        seed("review_plan", chief.threadId, { worker_thread_id: taskA.threadId }, [taskA.threadId, taskB.threadId]);
        // Legacy reviewers from before reviewer_verdicts: no history, a carried streak of 3, an approve, and a null verdict.
        seed("legacy_rc", chief.threadId, { worker_thread_id: taskB.threadId, verdict: "request_changes", reject_streak: 3 }, [taskB.threadId]);
        seed("legacy_approve", chief.threadId, { worker_thread_id: taskA2.threadId, verdict: "approve" }, [taskA2.threadId]);
        seed("legacy_null", chief.threadId, { worker_thread_id: taskA2.threadId, verdict: null }, [taskA2.threadId]);
        // Branch-only reviewers: no worker and no targets. One names Task A's branch (joins its task), one names no task's branch.
        seed("branch_task", chief.threadId, { branch: "feature/a" }, []);
        seed("branch_orphan", chief.threadId, { branch: "feature/orphan" }, []);
        // A reviewer of another Chief: counts project-wide, not in this Chief's scope.
        seed("other_review", other.threadId, { worker_thread_id: taskO.threadId }, [taskO.threadId]);
        tick(5);
        // The thread store reloads its row cache on its next write; the seeded rows are read after this report.
        await ready(taskB.threadId);
        const verdict = async (id: string, params: Record<string, unknown>) => {
          tick(10);
          await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...params }, asWorker(id));
        };
        await verdict("review_plan", REQUEST_CHANGES);
        await verdict("review_plan", APPROVE);
        await verdict("review_plan", APPROVE);
        await verdict("branch_task", APPROVE);
        // The regression flag lives on a reviewer's last request_changes: this reviewer's final report.
        await verdict("branch_task", { ...REQUEST_CHANGES, regression: true });
        await verdict("branch_orphan", APPROVE);
        await verdict("other_review", REQUEST_CHANGES);
        tick(10);
        await completeWorker(state, chief.threadId, taskA2.threadId);
        tick(1);
        // The fixture's own failure and stats cutoffs are stamped by SQLite's real clock at setup: pin them.
        state.db.prepare("UPDATE plugin_meta SET value=? WHERE key IN ('stats_since','failure_events_since')").run(String(Date.UTC(2026, 0, 1)));

        // The Coordinator migration appends two columns to managed_threads; the oracle hash predates them, so they are checked NULL and dropped.
        const table = (name: string) => (state.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Record<string, unknown>[]).map((row) => {
          if (name !== "managed_threads") return row;
          const { coordinator, coordinator_thread_id: coordinatorThreadId, ...legacy } = row;
          expect([coordinator ?? null, coordinatorThreadId ?? null]).toEqual([null, null]);
          return legacy;
        });
        // Only the random temp storage root (in report_path and verdict_path) is normalized.
        const fixtureHash = createHash("sha256").update(JSON.stringify(["managed_threads", "review_targets", "reviewer_verdicts", "plugin_meta"].map(table)).replaceAll(state.storageRoot, "<storage>")).digest("hex");
        const runs = [];
        for (const scope of [["--project", "proj_1"], ["--chief", chief.threadId], ["--chief", other.threadId]]) {
          for (const mode of [[], ["--json"]]) {
            const args = ["stats", ...scope, ...mode];
            const result = await state.harness.behavior.runCli(args);
            runs.push({ args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? null });
          }
        }
        return { state, fixtureHash, runs };
      } finally {
        vi.useRealTimers();
      }
    };
    // </stats-oracle-fixture>

    test("chief stats: text and JSON equal pre-refactor 512cfeb on a multi-target, multi-report, legacy, scoped and branch-only fixture", async () => {
      const { state, fixtureHash, runs } = await statsOracleRun();
      // The fixture really holds the cases: 3 plan reports x 2 targets, 2 branch_task reports, then 1 + 1 single reports, legacy rows with no history.
      const historyOf = (id: string) => state.db.prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT report_seq) AS events FROM reviewer_verdicts WHERE reviewer_thread_id=?").get(id);
      expect(historyOf("review_plan")).toEqual({ rows: 6, events: 3 });
      expect(historyOf("branch_task")).toEqual({ rows: 2, events: 2 });
      for (const legacy of ["legacy_rc", "legacy_approve", "legacy_null"]) expect(historyOf(legacy)).toEqual({ rows: 0, events: 0 });
      // Counts worked out from the contract, not from the code: plan 2+1, legacy 1 approve + 1 rc, branch_task 1+1, orphan 1, other chief 1 rc.
      const json = (index: number) => JSON.parse(runs[index]!.stdout!);
      expect(json(1).verdicts).toEqual({ approve: 5, request_changes: 4 });
      expect(json(3).verdicts).toEqual({ approve: 5, request_changes: 3 });
      expect(json(3).repairs).toMatchObject({ requestChanges: 3, regressions: 1 });
      expect(json(5).verdicts).toEqual({ approve: 0, request_changes: 1 });
      expect(runs.map((run) => run.exitCode)).toEqual([0, 0, 0, 0, 0, 0]);

      const actual = JSON.stringify({ fixtureHash, runs }, null, 2) + "\n";
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "chief-stats-512cfeb.json"), "utf8");
      expect(actual).toBe(oracle); // oracle-compare
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
    await completeWorker(state, chief.threadId, worker.threadId);
    expect((await status(state)).threads.find((row) => row.threadId === worker.threadId)!.state).toBe("complete");
  });

  test("waits for an idle worker, starts a read-only review, and deduplicates concurrent requests", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "active" });
    await expect(chiefReview(state, chief.threadId, { workerThreadId: worker.threadId })).rejects.toThrow("is active; wait until it is idle before starting a review.");
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    const [first, second] = await Promise.all([
      chiefReview(state, chief.threadId, { workerThreadId: worker.threadId }),
      chiefReview(state, chief.threadId, { workerThreadId: worker.threadId }),
    ]);
    expect(first.threadId).toBe(second.threadId);
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
    expect(state.spawned.at(-1).prompt).toContain("Remain review-only");
    // The reviewer confirms the automated criteria ran instead of taking the worker's word for it.
    expect(state.spawned.at(-1).prompt).toContain("Confirm the automated criteria actually ran with their exit status; list the manual criteria that still need a human to confirm.");
  });

  test("starts a review for a plain branch with no managed worker, on a fresh worktree based on it", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const parsed = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });
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
    // The CLI door is shut for every caller, the active Chief included: reviews start only through chief_review.
    const retired = await state.harness.behavior.runCli(["review", "--branch", "feature/legacy-fix"], opts);
    expect(retired.exitCode).toBe(1);
    expect(retired.stderr).toContain("bb chief review is retired");
  });

  test("returns the existing reviewer instead of duplicating one for the same branch", async () => {
    const state = await setup();
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    const [first, second] = await Promise.all([
      chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" }),
      chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" }),
    ]);
    expect(first.threadId).toBe(second.threadId);
    expect(state.spawned.filter((entry) => entry.title === "Review · feature/legacy-fix")).toHaveLength(1);
    // A later, no-longer-in-flight call must also return the same reviewer, not spawn another.
    const third = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });
    expect(third.created).toBe(false);
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
    const { threadId: reviewerThreadId } = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });
    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, opts) as string;
    expect(roster).toContain("branch: feature/legacy-fix");
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Reviewed the branch", ...APPROVE,
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
      state: "ready", result: "Totals are off by the discount", ...REQUEST_CHANGES,
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
    const secondReviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
    const context = await reviewContextOf(state, secondReviewer.threadId);
    expect(context).toContain(`## The previous review (${firstReviewer.threadId})`);
    expect(context).toContain("Totals are off by the discount");
    expect(context).toContain("Verdict: request_changes");
    expect(reviewSpawns[1].prompt).toContain("Check each finding of the previous review");
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
        state: "ready", result: "Looks correct", ...APPROVE,
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
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fix it", ...REQUEST_CHANGES }, { threadId: first.threadId, projectId: "proj_1" });
      await state.harness.behavior.callAgentTool("chief_complete", { threadId: first.threadId, result: "Round 1" }, opts);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Fixed" }, workerOpts);
      await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
      const second = (await status(state)).threads.find((row) => row.role === "reviewer" && row.threadId !== first.threadId)!;
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Good", ...APPROVE }, { threadId: second.threadId, projectId: "proj_1" });

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
      state: "ready", result: "Looks correct", ...APPROVE,
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
      state: "ready", result: "The discount is still applied twice", ...REQUEST_CHANGES,
    }, { threadId: reviewerThreadId, projectId: "proj_1" });
    await reject(reviewer.threadId);
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: request_changes");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.at(-1).input[0].text).not.toContain("consecutive rounds");
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
    expect(state.sent.at(-1).input[0].text).toContain("still requires changes after 2 consecutive rounds");
    expect(state.sent.at(-1).input[0].text).toContain(`Call chief_consult (workerThreadId: ${worker.threadId}) now, before any further delegation`);
    expect(state.sent.at(-1).input[0].text).toContain(`hand its advice to one fresh worker with chief_delegate (replaces: ${worker.threadId})`);
    expect(state.sent.at(-1).input[0].text).toContain("If that review still requires changes, stop and escalate to the user.");
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
      expect(state.spawned.at(-1).prompt).toContain("This is design work (a Designer). Check it read-only against the brief's mode. Design tool: check the result with the tool's screenshots");
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
      const pathOf = () => (state.db.prepare("SELECT verdict_path FROM managed_threads WHERE thread_id=?").get(reviewer.threadId) as { verdict_path: string }).verdict_path;
      return { state, chief, worker, reviewer, pathOf };
    };
    const findings = `${"The discount is applied twice. ".repeat(80)}END-OF-FINDINGS`;

    test("persists a reviewer's full verdict to a file and names it in the alert and inspect", async () => {
      const { state, chief, worker, reviewer, pathOf } = await reviewed();
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, ...REQUEST_CHANGES, regression: true, recommendation: "Apply it once",
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      const path = pathOf();
      expect(path).toMatch(/verdict-1\.md$/);
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
      const { state, chief, worker, reviewer, pathOf } = await reviewed();
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, ...REQUEST_CHANGES,
      }, { threadId: reviewer.threadId, projectId: "proj_1" });
      await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
      const prompt: string = state.spawned.at(-1).prompt;
      expect(prompt).toContain(`Verdict file: ${pathOf()}`);
      expect(prompt).toContain("Totals go negative.");
      expect(prompt).toContain("names a plan file or verdict file, read that file in full");
    });

    test("a failed verdict-file write does not fail the report", async () => {
      const { state, chief, reviewer } = await reviewed();
      // A plain file where the reviewer's artifact directory should be makes the write fail.
      await mkdir(join(state.storageRoot, "chief", "proj_1"), { recursive: true });
      await writeFile(join(state.storageRoot, "chief", "proj_1", reviewer.threadId), "not a directory");
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: findings, ...APPROVE,
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
        state: "ready", result: "Phase reviewed", ...(value === "approve" ? APPROVE : REQUEST_CHANGES),
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
    expect(state.sent.at(-1).input[0].text).not.toContain("consecutive rounds");
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
      state: "ready", result: "This broke the tax calculation", ...REQUEST_CHANGES, regression: true,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    const text = state.sent.at(-1).input[0].text as string;
    expect(text).toContain("introduced a new problem");
    expect(text).toContain(`chief_delegate (replaces: ${worker.threadId})`);
    expect(text).not.toContain("chief_consult (workerThreadId");
    expect(text).not.toContain("consecutive rounds");
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
      state: "ready", result: "Looks good", ...APPROVE, ...extra,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });

    const text = state.sent.at(-1).input[0].text as string;
    expect(text).toContain("Verdict: approve");
    expect(text).toContain(`The reviewer approves. chief_complete (threadId: ${worker.threadId}); it marks the pull request ready.`);
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
    // Without the brief the reviewer scores the change against a standard nobody set.
    const context = await latestReviewContext(state);
    expect(context).toContain("Correct and verify totals");
    expect(context).toContain("Regression passes");
    expect(context).toContain("Totals fixed and covered by a test");
    expect(context).toContain(`bb chief inspect ${worker.threadId}`);
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

    const context = await latestReviewContext(state);
    expect(context).toContain(planPath);
    // The head of the mission survives the same clip, alongside the tail.
    expect(context).toContain("Correct and verify totals.");
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

    const context = await latestReviewContext(state);
    const resultLine = context.split("## What the worker reported")[1]!.split("\n")[1]!;
    expect(resultLine.length).toBeLessThanOrEqual(300);
    expect(context).toContain(`bb chief inspect ${worker.threadId}`);

    // The fresh reviewer spawned after a fix clips the worker's new result the same way.
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Found an issue", ...REQUEST_CHANGES,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    worker = await delegate(state, chief.threadId, "Fix checkout totals", { replaces: worker.threadId });
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: longResult,
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool(
      "chief_review", { workerThreadId: worker.threadId }, { threadId: chief.threadId, projectId: "proj_1" },
    );
    const freshContext = await latestReviewContext(state);
    const freshResultLine = freshContext.split("## What the worker reported")[1]!.split("\n")[1]!;
    expect(freshResultLine.length).toBeLessThanOrEqual(300);
    expect(freshContext).toContain(`bb chief inspect ${worker.threadId}`);
  });

  test("keeps reviewers read-only however the continuation is phrased", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
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
      const id = /^- worker “Worker \d+” \((thr_\d+)\): /.exec(line)?.[1];
      expect(id).toBeDefined();
      expect(line.endsWith(`: ${readyAction(id!)}`)).toBe(true);
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

  test("chief todos are project-scoped and survive a replacement Chief", async () => {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.callAgentTool("chief_roster", { todo: { text: "Ship docs" } }, { threadId: chief.threadId, projectId: "proj_1" });
    const replacement = await state.harness.behavior.callRpc("create", { projectId: "proj_1" }) as { threadId: string };
    expect(String(await state.harness.behavior.callAgentTool(
      "chief_roster", {}, { threadId: replacement.threadId, projectId: "proj_1" },
    ))).toContain(`Other Chiefs' todos (not your work; act on one only when the user asks):\n- todo #1 (Chief ${chief.threadId}): Ship docs`);

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
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };

    const worker = await delegate(state, chief.threadId, "Fix checkout totals");
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done" }, { threadId: worker.threadId, projectId: "proj_1" });
    const workerAlert = state.sent.at(-1).input[0].text as string;
    const workerAction = readyAction(worker.threadId);
    // The alert clips an action over 400 characters (the full text is in its report file's Next line); the roster carries it whole.
    expect(workerAlert).toContain(workerAction.slice(0, 300));
    expect(await readFile(join(state.storageRoot, "chief", "proj_1", worker.threadId, "report-1.md"), "utf8")).toContain(`Next: ${workerAction}`);
    let roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("Pending:");
    expect(roster).toContain(`- worker “Fix checkout totals” (${worker.threadId}): ${workerAction}`);

    // Once the review is actually in flight, the worker drops out of Pending.
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker.threadId }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).not.toContain(`- worker “Fix checkout totals” (${worker.threadId}):`);

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", ...APPROVE,
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    const reviewAlert = state.sent.at(-1).input[0].text as string;
    const approveAction = `The reviewer approves. chief_complete (threadId: ${worker.threadId}); it marks the pull request ready. Nits listed with an approve are optional: start no worker round for them alone.`;
    expect(reviewAlert).toContain(approveAction);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain(`- reviewer “Review · Fix checkout totals” (${reviewer.threadId}): ${approveAction}`);

    // Once Chief completes the worker, the approved reviewer must not keep advertising it.
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed", ...CLOSE_OUT }, opts);
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
      state: "ready", result: "Off by one in the discount calc", ...REQUEST_CHANGES,
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
    expect(roster).toContain(`- planner “Plan · Rework checkout” (${planner.threadId}): Delegate wave 1 now: run chief_forge_init (planThreadId: ${planner.threadId}, wave: 1), then chief_delegate (planThreadId: ${planner.threadId}, wave: 1). The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.`);

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
    expect(chief.tools.map((tool) => tool.name)).toEqual(["chief_forge_init", "chief_delegate", "chief_plan", "chief_spawn", "chief_coordinate", "chief_consult", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete", "chief_owner_approval", "chief_skip_tests", "chief_skip_specs", "chief_escalate", "chief_sync", "chief_research"]);
    expect(chief.skills).toEqual(["chief", "coordinator"]);
    expect(worker.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(worker.skills).toEqual(["chief-worker", "chief-role-worker"]);
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
    await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    // insertThread only runs after threads.spawn resolves, so the tool set for a
    // brand-new thread's first turn cannot depend on that row already existing —
    // it has to come from what was seeded into pluginMetadata at spawn time.
    expect(state.spawned.at(-1).pluginMetadata).toEqual({ role: "reviewer", chiefThreadId: chief.threadId });

    const resolved = await state.harness.behavior.resolveAgentConfiguration({
      ...configurationContext("thr_not_yet_persisted"),
      pluginMetadata: { role: "reviewer", chiefThreadId: chief.threadId },
    });
    expect(resolved.tools.map((tool: any) => tool.name)).toContain("chief_report");
    expect(resolved.skills).toEqual(["chief-worker", "chief-role-reviewer"]);
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
    const workerReview = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    const branchReview = await chiefReview(state, chief.threadId, { branch: "feature/legacy-fix" });

    // Both live in what bb.agents.configure puts into every turn: the chief skill
    // and the rules. A second copy in a spawn prompt is one that can drift.
    expect(state.spawned[0].prompt).not.toContain("high blast radius");
    for (const entry of state.spawned) {
      const text = (entry.prompt ?? entry.input?.[0]?.text ?? "") as string;
      expect(text).not.toContain("## Project rules");
    }

    // The built-in rules are Chief's own; a managed thread would only be told to call tools it lacks.
    const chiefInstructions = (await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId))).instructions;
    expect(chiefInstructions).toContain("# Chief operating rules");
    expect(chiefInstructions).toContain("# Chief core rules (always apply)");
    expect(chiefInstructions).toContain("Chief never edits code and never runs anything in a worktree");
    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    for (const threadId of [worker.threadId, planner.threadId, workerReview.threadId, branchReview.threadId]) {
      const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId));
      expect(configured.instructions).not.toContain("Chief operating rules");
      expect(configured.instructions).not.toContain("Chief core rules");
      expect(configured.instructions).not.toContain("Chief never edits code");
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
    expect(configured.instructions).toContain("delegate every wave it lists right away, one chief_delegate per wave in the same turn, without user sign-off");
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
    expect(configured.instructions).toContain("chief_plan (skipped only with unplannedReason: your reason) → chief_forge_init (planThreadId and wave, so the plan travels in the pull request body) → chief_delegate");
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
    expect(planPrompt).toContain("do not create, modify, or delete any file the repository tracks, and do not commit or push");
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
    ["accepts", "What we are not doing is a markdown heading", [{ body: wave(1, "\n## What we are not doing\n- No extra scope.") }, TEST_WAVE(2)]],
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
      expect(state.sent.at(-1).input[0].text).toContain("Delegate wave 1 now: run chief_forge_init");
    }
  });

  test.each([
    ["rejects", "wave 2 has no Contracts to verify heading", [{ body: PLAN_FIXTURE }, { body: "# Wave 2\nWrite the tests.", test: true }], /plan wave 2 lacks a "## Contracts to verify"/],
    ["rejects", "Contracts to verify is bold text", [{ body: "# Plan\n\n**Contracts to verify**\n- x\n\n## What we're NOT doing\n- x" }, TEST_WAVE(2)], /plan wave 1 lacks a "## Contracts to verify"/],
    ["rejects", "the Contracts to verify section is empty", [{ body: "# Plan\n\n## Contracts to verify\n\n## What we're NOT doing\n- x" }, TEST_WAVE(2)], /plan wave 1 lacks a "## Contracts to verify"/],
    ["accepts", "Contracts to verify is a ### heading", [{ body: "# Plan\n\n### Contracts to verify\n- x\n\n## What we're NOT doing\n- x" }, TEST_WAVE(2)], undefined],
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
    expect(text).toContain("Remain read-only: do not create, modify, or delete any file the repository tracks, and do not commit or push. Submit the plan itself through chief_report's plan field, not as a file write. A worker implements the plan in its own worktree.");
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
    if (role === "reviewer") await chiefReview(state, chief.threadId, { workerThreadId: (await delegate(state, chief.threadId)).threadId });
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
      state: "ready", result: "Tax is off", ...REQUEST_CHANGES,
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
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed", ...CLOSE_OUT }, opts);

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
    )).rejects.toThrow("instruction: Too big: expected string to have <=500 characters");
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
      state: "ready", result: "Totals are off by the discount", ...REQUEST_CHANGES,
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
    expect(configured.skills).toEqual(["chief-worker", "chief-role-read-only"]);
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
        designer: null,
        "spec-writer": null,
        tester: null,
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
    await completeWorker(state, chief.threadId, worker.threadId, { result: "Landed" });
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
      state: "ready", result: "Totals are off by the discount", ...REQUEST_CHANGES,
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
    expect(freshWorkerSpawn.prompt).toContain("- totals.ts:1 — Totals go negative.");
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
    expect(state.spawned.at(-1).prompt).toContain("Check each finding of the previous review");

    // Second straight rejection across the fresh worker and fresh reviewers: consult before another round.
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Still off by a cent", ...REQUEST_CHANGES,
    }, { threadId: reviewer2.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain("still requires changes after 2 consecutive rounds");
    expect(state.sent.at(-1).input[0].text).toContain(`chief_consult (workerThreadId: ${freshWorker.threadId}) now, before any further delegation`);
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
    expect(roster).toContain("waves: 2/4 done, wave 1 starting, wave 2 starting");
    expect(roster).toContain(`: ${path2} (independent)`);
    expect(state.spawned.at(-1).prompt).toContain("This wave heads its own chain: it has its own branch, PR and worktree from the default base; do not build on another chain's branch.");

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
    // Rows of a plan written before chains shared a branch: wave 2 is stacked on wave 1's own branch, wave 1 still active.
    await legacyWave(state, chief.threadId, planner.threadId, 1, "feature/a");
    const w2 = await legacyWave(state, chief.threadId, planner.threadId, 2, "feature/b");
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
    expect(roster).toContain("waves: 1/4 done, wave 1 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 1 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w1.threadId, projectId: "proj_1" });
    const w2 = JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "2", "--replaces", w1.threadId, "--json",
    ], opts)).stdout!) as { threadId: string };
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 2/4 done, wave 2 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 2 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w2.threadId, projectId: "proj_1" });
    const w3 = JSON.parse((await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals", "--mission", "Correct and verify totals",
      "--plan-thread", planner.threadId, "--wave", "3", "--replaces", w2.threadId, "--json",
    ], opts)).stdout!) as { threadId: string };
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 3/4 done, wave 3 starting");

    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: `Wave 3 of 3 done${NO_DEVIATIONS}`,
    }, { threadId: w3.threadId, projectId: "proj_1" });
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 3/4 done, wave 3 ready");

    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: w3.threadId }, opts);
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 3/4 done, wave 3 in review");

    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Looks correct", verdict: "approve", findings: [],
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, opts));
    expect(roster).toContain("waves: 4/4 done, wave 3 approved");
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
    expect(result.violations.filter((v) => !v.file.startsWith("scripts/"))).toEqual([]);
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
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect([stateOf(state, reviewer), stateOf(state, advisor)]).toEqual(["complete", "complete"]);
    const before = state.db.prepare(`SELECT thread_id, state, updated_at FROM managed_threads ORDER BY thread_id`).all();
    await call(state, "chief_roster", {}, chief.threadId);
    await expect(call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId)).resolves.toBeDefined();
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
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect(stateOf(state, reviewer)).toBe("active");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
    await settle();
    expect(stateOf(state, reviewer)).toBe("complete");
  });

  // Contract (work-list spec, Contracts that stay): the sweep still runs on `failed` events (the `idle` case is the test above) once pendingReady is set.
  test("a busy reviewer is swept once it fails", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const reviewer = await reviewed(state, chief.threadId, worker.threadId, "approve");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" });
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer)! });
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    await settle();
    expect(stateOf(state, reviewer)).toBe("active");
    state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "failed" });
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(reviewer)!, lastAssistantText: "boom" });
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
    const reply = String(await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId));
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
    await completeWorker(state, chief.threadId, worker.threadId);
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
    await call(state, "chief_report", { state: "ready", result: "Checked", ...APPROVE }, reviewer);
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
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
    await call(state, "chief_complete", { threadId: worker.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
    state.failNextGet(failing);
    await call(state, "chief_complete", { threadId: other.threadId, testsSkipped: CLOSE_OUT.testsSkipped }, chief.threadId);
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
    // A reviewer's coverage lives in the review_targets ledger, not in managed_threads.worker_thread_id.
    const cover = db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id) VALUES (?, 'thr_work')`);
    cover.run("thr_rev");
    cover.run("thr_busy");
    await plugin(bb);
    expect(db.prepare(`SELECT thread_id, state FROM managed_threads WHERE thread_id<>'thr_work' ORDER BY thread_id`).all()).toEqual([
      { thread_id: "thr_busy", state: "ready" },
      { thread_id: "thr_plan", state: "complete" },
      { thread_id: "thr_rev", state: "complete" },
      { thread_id: "thr_unknown", state: "ready" },
    ]);
  });

  test("the roster Pending lines list only threads with a next action; supporting and in-progress rows are not listed", async () => {
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

    const roster = String(await call(state, "chief_roster", {}, chief.threadId));
    const pendingLines = roster.split("\n").filter((line) => /\(thr_[^)]+\): /.test(line));
    // Only a thread with a next action is listed; the planner, the idle advisor, the planned worker in progress and the worker already under review are not.
    expect([...pendingLines].sort()).toEqual([
      `- reviewer “Review · Blocked review target” (${reviewer.threadId}): Blocked: No access — decide or escalate to the user.`,
      `- worker “Ready work” (${ready.threadId}): ${readyAction(ready.threadId)}`,
    ]);
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

  // The SDK cuts configure() instructions at 4096 chars (the testing host slices the same way), and chief.md may be up to 32,000; the project name is also unbounded input.
  test.each([[5_000, 4], [32_000, 4], [5_000, 5_000]])("a %i-char chief.md and a %i-char project name only trim project rules: Chief's own instructions stay inside the 4096-char cut", async (size, nameLength) => {
    const marker = "# Project rules marker";
    const state = await setup({ rules: `${marker}\n${"- Project rule text.\n".repeat(Math.ceil(size / 21))}`.slice(0, size) });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const threadId = await roleThread(state, "chief");
    const { instructions } = await state.harness.behavior.resolveAgentConfiguration(configurationContext(threadId, "proj_1", "N".repeat(nameLength)));
    expect(instructions!.length).toBe(4096);
    const coreEnd = instructions!.indexOf("chief_escalate with the thread and the full request");
    expect(coreEnd).toBeGreaterThan(-1);
    for (const part of [
      "# Chief core rules (always apply)", "Call chief_roster at the start of every turn", "never poll managed threads",
      "chief_plan first", "delegate every wave it lists right away",
      "chief_research is optional.", "or the doubtful evidence to chief_review.",
      "Guidance, not a rule", "Chief never edits code",
    ]) expect(instructions).toContain(part);
    expect(instructions!.indexOf(marker)).toBeGreaterThan(coreEnd);
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
  // Preservation: passes before the fix; the mutation control drops the waiverLines guard and fails the byte comparison.
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
    // Byte equivalence: the files were captured from chief_review at the pre-fix oracle (8f7e4d6) on these same inputs.
    const portable = (text: string) => text.replaceAll(state.storageRoot, "<storage>");
    // The prompt is the oracle plus the make-native reviewer line (the oracle file is untouched); the context is unchanged.
    expect(portable(prompt)).toBe(withReviewerLine(await snapshotText("review-no-waiver.prompt.txt")));
    await expect(portable(context)).toMatchFileSnapshot("./__snapshots__/review-no-waiver.context.txt");
  });

  // Contract: reviewBrief without waiverLines (an older caller) renders what it rendered before, and an empty list changes nothing.
  // The snapshot files were captured at the pre-fix oracle; the mutation control drops the waiverLines guard.
  test("reviewBrief without waiverLines renders the pre-waiver prompt and context", async () => {
    const target = { threadId: "thr_w", title: "Fix totals", prUrl: "https://github.com/acme/shop/pull/8", branch: "feature/x", reportSeq: 1, hasResult: true, reportPath: "/r/report-1.md",
      head: { branch: "feature/x", sha: "abc123", base: "main" } };
    const input: ReviewBriefInput = {
      worker: { ...target, kind: null, brief: null, reported: "Done" },
      targets: [target],
      wavePaths: ["/p/plan-1.md", "/p/plan-2.md"],
      chain: [1, 2],
      contractLines: ["Wave 1 of 2:", "- Totals stay non-negative", "Wave 2 of 2:", "- Suite stays green"],
      recordedLines: ["npm test → exit 0"],
      previous: null,
      chiefThreadId: "thr_c",
    };
    const omitted = reviewBrief(input);
    expect(reviewBrief({ ...input, waiverLines: [] })).toEqual(omitted);
    expect(omitted.prompt).toBe(withReviewerLine(await snapshotText("review-brief-no-waiverlines.prompt.txt")));
    await expect(omitted.context).toMatchFileSnapshot("./__snapshots__/review-brief-no-waiverlines.context.txt");
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
  // worker is the chain tip, the wave counts done but leaves the graph, delegating it is refused naming the reason, and completing the
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
    const explicit = "Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs/.";
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
      .rejects.toThrow("Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs/.");
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

    // The plan row is a pre-chain one: its wave 2 is a stacked worker of its own, which chief_delegate no longer builds.
    await legacyWave(state, chief.threadId, planner.threadId, 2, "feature/two");
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

  // Contracts (plan chains, wave 1): a plan chain has one branch, one pull request and one worker worktree, opened by
  // chief_forge_init on its head only and continued with chief_delegate (replaces:). Independent heads get their own.
  describe("plan chains", () => {
    const PR_A = "https://github.com/o/r/pull/1";
    const PR_B = "https://github.com/o/r/pull/2";
    const withContracts = (n: number, contracts: string) => `# Wave ${n}\nDo the work.\n\n## Contracts to verify\n- ${contracts}\n\n## What we're NOT doing\n- x`;
    /** An approved plan with the given waves; its ready result is `summary`. */
    async function chainPlan(state: State, chiefThreadId: string, waves: object[], summary = "Plan summary.") {
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chiefThreadId));
      const planner = (await status(state)).threads.filter((row) => row.role === "planner" && row.chiefThreadId === chiefThreadId).at(-1)!;
      await report(state, planner.threadId, { state: "ready", result: summary, plan: waves });
      await approvePlan(state, chiefThreadId, planner.threadId);
      return planner;
    }
    const linear = (long = "Wave 1 keeps its invariant") => [{ body: withContracts(1, long) }, { body: wave(2) }, TEST_WAVE(3)];
    const forge = (state: State, chiefThreadId: string, planThreadId: string, waveNo: number) =>
      tool(state, "chief_forge_init", { title: `Wave ${waveNo} work`, planThreadId, wave: waveNo }, chiefThreadId) as Promise<string>;
    const envOf = (state: State, threadId: string) => state.live.get(threadId)!.environmentId;
    const freshSpawns = (state: State) => state.spawned.filter((args) => args.environment?.type === "host").length;

    test("forge_init on a 3-wave chain head puts one section per chain wave in the pull request body, clipped, and says one pull request per chain in the issue", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, linear("a".repeat(3_000)), "S".repeat(3_000));
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 3, reason: "docs only" }, chief.threadId);
      const script = await forge(state, chief.threadId, planner.threadId, 1);
      expect(script).toContain("Plan — chain of waves 1, 2, 3 of 3");
      expect(script.match(/<summary>Wave \d of 3/g)).toHaveLength(3);
      expect(script.match(/Tests skipped: docs only/g)).toHaveLength(1);
      // Each contract is clipped at 2,000 characters (the last is the ellipsis) and the plan summary at 1,500.
      const contract = script.match(/### Contracts to verify\n(a[^\n]*|- a[^\n]*)\n/)![1]!;
      expect(contract).toHaveLength(2_000);
      expect(contract.endsWith("…")).toBe(true);
      const summary = script.match(/\(planner [^)]*\)<\/summary>\n\n(S+…?)\n<\/details>/)![1]!;
      expect(summary).toHaveLength(1_500);
      expect(summary.endsWith("…")).toBe(true);
      expect(script).toContain("ISSUE_BODY='Chief tracks this plan here: one comment per task outcome, one pull request per chain.");
    });

    test("an unplanned forge_init body is the title line plus the mission sections, as before chains", async () => {
      const state = await setup();
      const chief = await start(state);
      const script = await tool(state, "chief_forge_init", { title: "Fix checkout totals", mission: "Correct and verify totals", successCriteria: "Regression passes", constraints: "No refactors" }, chief.threadId) as string;
      const body = "Tracking work for Fix checkout totals.\n\n## Mission\nCorrect and verify totals\n## Success criteria\nRegression passes\n## Constraints\nNo refactors";
      expect(script).toContain(`\nBODY='${body}'\n`);
      expect(script).toContain(`\nISSUE_BODY='${body}'\n`);
      expect(script).not.toContain("<details>");
    });

    test("forge_init is refused on a wave that continues a chain, naming the head, and on a head whose chain already has a worker, naming the latest", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, linear());
      for (const n of [2, 3]) {
        await expect(forge(state, chief.threadId, planner.threadId, n)).rejects.toThrow(
          new RegExp(`Wave ${n} is not a chain head: it continues the chain of waves 1, 2, 3.*head wave 1 only.*replaces: <the chain's latest worker>`));
      }
      await forge(state, chief.threadId, planner.threadId, 1);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/chain", prUrl: PR_A });
      const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
      await expect(forge(state, chief.threadId, planner.threadId, 1)).rejects.toThrow(
        `Wave 1's chain already has worker ${w1} on branch feature/chain with pull request ${PR_A}: a chain has one branch and one pull request. Continue it with chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${w1}).`);
      // A fresh delegation on the started head is refused the same way, before a thread is spawned.
      const spawned = state.spawned.length;
      await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/second" })).rejects.toThrow(`replaces: ${w1}`);
      expect(state.spawned).toHaveLength(spawned);
      // Once wave 2 continues the chain, the refusal names the newest worker, not wave 1's.
      await readyIdle(state, w1);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1 });
      const w2 = workerOn(state, planner.threadId, 2).thread_id as string;
      await expect(forge(state, chief.threadId, planner.threadId, 1)).rejects.toThrow(`replaces: ${w2}).`);
    });

    test("a linear plan of N waves runs on one branch, one pull request and one worker worktree", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, [{ body: withContracts(1, "ok") }, { body: wave(2) }, { body: wave(3) }, TEST_WAVE(4)]);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/chain", prUrl: PR_A, issueUrl: "https://github.com/o/r/issues/9" });
      const workers = [workerOn(state, planner.threadId, 1).thread_id as string];
      for (const n of [2, 3]) {
        await readyIdle(state, workers.at(-1)!);
        await delegateWave(state, chief.threadId, planner.threadId, n, { replaces: workers.at(-1) });
        workers.push(workerOn(state, planner.threadId, n).thread_id);
      }
      const rows = workers.map((id) => rowOf(state, id));
      expect(new Set(rows.map((row) => row.branch))).toEqual(new Set(["feature/chain"]));
      expect(new Set(rows.map((row) => row.pr_url))).toEqual(new Set([PR_A]));
      expect(new Set(rows.map((row) => row.issue_url))).toEqual(new Set(["https://github.com/o/r/issues/9"]));
      expect(new Set(workers.map((id) => envOf(state, id))).size).toBe(1);
      // Only the head asks for a fresh worktree; each later wave reuses the prior worker's environment.
      expect(freshSpawns(state)).toBe(1);
      expect(state.spawned.slice(-2).map((args) => args.environment)).toEqual(Array(2).fill({ type: "reuse", environmentId: envOf(state, workers[0]) }));
    });

    test("two independent heads each get their own branch, pull request and worktree; a replacement across chains is refused before any spawn", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, [{ body: withContracts(1, "ok") }, TEST_WAVE(2), { body: wave(3), dependsOn: [] }, TEST_WAVE(4, [3])]);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a", prUrl: PR_A });
      const a = workerOn(state, planner.threadId, 1).thread_id as string;
      await forge(state, chief.threadId, planner.threadId, 3);
      const spawned = state.spawned.length;
      await expect(delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: a })).rejects.toThrow(/another chain/);
      expect(state.spawned).toHaveLength(spawned);
      await delegateWave(state, chief.threadId, planner.threadId, 3, { branch: "feature/b", prUrl: PR_B });
      const b = workerOn(state, planner.threadId, 3).thread_id as string;
      expect(envOf(state, b)).not.toBe(envOf(state, a));
      expect(rowOf(state, b)).toMatchObject({ branch: "feature/b", pr_url: PR_B });
      expect(rowOf(state, a)).toMatchObject({ branch: "feature/a", pr_url: PR_A });
      expect(freshSpawns(state)).toBe(2);
    });

    test("a replacement keeps its prior's branch and pull request: a different one is refused before any spawn, the same or none is accepted, and a null prior takes the given prUrl", async () => {
      const state = await setup();
      const chief = await start(state);
      const planner = await chainPlan(state, chief.threadId, linear());
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/chain", prUrl: PR_A });
      const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, w1);
      const spawned = state.spawned.length;
      await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1, prUrl: PR_B })).rejects.toThrow(
        `replaces: ${w1} carries pull request ${PR_A}; pass no prUrl or the same one. A plan chain has one pull request.`);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1, branch: "feature/other" })).rejects.toThrow(
        `replaces: ${w1} carries branch feature/chain; pass no --branch or the same one.`);
      expect(state.spawned).toHaveLength(spawned);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: w1, prUrl: PR_A, branch: "feature/chain" });
      const w2 = workerOn(state, planner.threadId, 2).thread_id as string;
      expect(rowOf(state, w2)).toMatchObject({ branch: "feature/chain", pr_url: PR_A });

      // A chain whose head had no pull request yet: the replacement's prUrl fills it in.
      const second = await chainPlan(state, chief.threadId, linear());
      await delegateWave(state, chief.threadId, second.threadId, 1, { branch: "feature/second" });
      const head = workerOn(state, second.threadId, 1).thread_id as string;
      expect(rowOf(state, head).pr_url).toBeNull();
      await readyIdle(state, head);
      await delegateWave(state, chief.threadId, second.threadId, 2, { replaces: head, prUrl: PR_B });
      expect(rowOf(state, workerOn(state, second.threadId, 2).thread_id).pr_url).toBe(PR_B);
    });
  });

  // Contracts (plan chains, wave 2): chain tasks share one worktree, so of the cleanup jobs on one environment exactly one
  // owns each action (branch deletion, teardown-trouble alert, teardown-stuck alert); the rest end at storage, silent.
  describe("cleanup of jobs sharing one worktree", () => {
    const HOUR = 60 * 60_000;
    type Env = { phase: "destroyed" | "destroying" | "active"; trouble?: boolean };
    const envOf = ({ phase, trouble }: Env, environmentId: string) => ({
      id: environmentId, hostId: "host_1", workspaceProvisionType: "managed-worktree", isWorktree: true, branchName: "bb/shared",
      status: phase === "destroyed" ? "destroyed" : "ready",
      hostLifecycle: phase === "destroyed" ? "removed" : trouble ? "cleanup-failed" : "ready",
      lifecycle: { phase, teardown: trouble ? { status: "failed", message: "Needs recovery: git worktree remove failed" } : { status: "running" } },
    });
    /** `count` archived workers whose cleanup jobs wait at the teardown step on the one environment `env_shared` (a chain's worktree). */
    async function sharedJobs(state: State, count: number, reads: (call: number) => Env) {
      let call = 0;
      state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => envOf(reads(call++), environmentId));
      await state.harness.behavior.setSettings({ cleanupApproved: true });
      const chief = await start(state);
      const archivedAt = Date.now() - 2 * HOUR;
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = (await delegate(state, chief.threadId, `Chain wave ${i + 1}`)).threadId;
        ids.push(id);
        state.live.set(id, { ...state.live.get(id)!, archivedAt } as any);
        state.db.prepare(`INSERT INTO cleanup_jobs (thread_id, chief_thread_id, project_id, environment_id, branch, step, step_at, archived_at, created_at, updated_at)
          VALUES (?, ?, 'proj_1', 'env_shared', ?, 'teardown', ?, ?, ?, ?)`).run(id, chief.threadId, `bb/${id}`, archivedAt, archivedAt, 1_000 + i, 1_000 + i);
      }
      return ids;
    }
    const job = (state: State, id: string) => state.db.prepare(`SELECT step, outcome FROM cleanup_jobs WHERE thread_id=?`).get(id) as { step: string; outcome: string | null };
    const alerts = (state: State, kind: string) => state.db.prepare(`SELECT source_thread_id FROM alert_outbox WHERE dedupe_key LIKE ?`).all(`%:${kind}:alert`) as { source_thread_id: string }[];
    const claims = (state: State) => state.db.prepare(`SELECT action, thread_id FROM cleanup_environment_claims WHERE environment_id='env_shared' ORDER BY action`).all();

    test("three jobs on a destroyed environment: one owns the branch, the others end at storage with no alert", async () => {
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
      const state = await setup({ projectPath: "/repo/proj1" });
      state.harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
      const [first, second, third] = await sharedJobs(state, 3, () => ({ phase: "destroyed" }));
      await state.supervisorCycle();
      expect(job(state, first!)).toMatchObject({ step: "branch" });
      for (const id of [second!, third!]) expect(job(state, id)).toEqual({ step: "storage", outcome: `worktree shared: branch handled by ${first}` });
      expect(claims(state)).toEqual([{ action: "branch", thread_id: first }]);
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key LIKE '%cleanup-%'`).get()).toEqual({ n: 0 });
      // The next pass runs the owner's branch step: only its bb/ branch is looked up (and deleted), never the others'.
      await state.supervisorCycle();
      const branchCalls = execFileMock.mock.calls.map((call) => JSON.stringify(call[1])).filter((args) => args.includes("refs/heads/bb/"));
      expect(branchCalls.length).toBeGreaterThan(0);
      for (const args of branchCalls) expect(args).toContain(`refs/heads/bb/${first}`);
      expect(job(state, first!).step).toBe("storage");
    });

    test.each([["trouble", true], ["stuck", false]])("three jobs on an environment with teardown %s raise exactly one alert", async (kind, trouble) => {
      const state = await setup();
      const [first, second, third] = await sharedJobs(state, 3, () => ({ phase: "destroying", trouble }));
      await state.supervisorCycle();
      expect(alerts(state, `cleanup-teardown-${kind}`)).toEqual([{ source_thread_id: first }]);
      expect(job(state, first!)).toEqual({ step: "storage", outcome: trouble ? "branch kept: teardown trouble" : "branch kept: teardown stuck" });
      for (const id of [second!, third!]) expect(job(state, id)).toEqual({ step: "storage", outcome: `worktree shared: ${kind} handled by ${first}` });
      expect(claims(state)).toEqual([{ action: kind, thread_id: first }]);
    });

    test("a job that finds the environment in use claims nothing: a later job that finds it destroyed still owns the branch", async () => {
      const state = await setup();
      const [first, second] = await sharedJobs(state, 2, (call) => ({ phase: call === 0 ? "active" : "destroyed" }));
      await state.supervisorCycle();
      expect(job(state, first!)).toEqual({ step: "storage", outcome: "branch kept: environment in use" });
      expect(job(state, second!)).toMatchObject({ step: "branch" });
      expect(claims(state)).toEqual([{ action: "branch", thread_id: second }]);
    });

    test.each([
      ["destroyed", { phase: "destroyed" as const }, "branch", null],
      ["teardown trouble", { phase: "destroying" as const, trouble: true }, "storage", "cleanup-teardown-trouble"],
      ["teardown stuck", { phase: "destroying" as const }, "storage", "cleanup-teardown-stuck"],
    ])("a single job on its own worktree behaves as before shared claims: %s", async (_name, env, step, alert) => {
      const state = await setup();
      const [only] = await sharedJobs(state, 1, () => env);
      await state.supervisorCycle();
      expect(job(state, only!).step).toBe(step);
      expect(job(state, only!).outcome ?? "").not.toContain("worktree shared");
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key LIKE '%cleanup-teardown-%'`).get()).toEqual({ n: alert ? 1 : 0 });
      if (alert) expect(alerts(state, alert)).toEqual([{ source_thread_id: only }]);
    });
  });

  // Contracts (reviewer reuse, wave 2): repeated pinned review rounds of one task review in one worktree, checked out
  // detached at each round's pinned commit; a reviewer whose worktree is gone, busy or not a worktree is never reused.
  describe("reviewer worktree reuse across rounds", () => {
    const PR = "https://github.com/acme/shop/pull/8";
    const shaOf = (round: number) => String(round).repeat(40);
    type Mode = { destroyed?: boolean; removed?: boolean; notWorktree?: boolean; unreadable?: boolean };
    async function setupRounds(mode: Mode = {}) {
      const state = await setup({ projectPath: "/oracle/checkout", system: { usageLimits: async () => ({}), config: async () => ({ primaryHostId: "host_1" }) } });
      let sha = shaOf(1);
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: sha, baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => {
        if (mode.unreadable) throw new Error("host unreachable");
        return {
          id: environmentId, hostId: "host_1", workspaceProvisionType: "managed-worktree", isWorktree: !mode.notWorktree,
          status: mode.destroyed ? "destroyed" : "ready", hostLifecycle: mode.removed ? "removed" : "ready", lifecycle: { phase: "idle" },
        };
      });
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", prUrl: PR }, chief);
      const worker = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, worker);
      /** One review round at `round`'s pinned commit, approved; returns its reviewer and how it was launched. */
      const round = async (n: number) => {
        sha = shaOf(n);
        await tool(state, "chief_review", { workerThreadId: worker }, chief);
        const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const { environment, prompt } = state.spawned.at(-1);
        await report(state, reviewer, { state: "ready", result: "Looks right", ...APPROVE });
        return { reviewer, environment, prompt: String(prompt) };
      };
      return { state, round, worker, chief };
    }
    const fresh = { type: "host", workspace: { type: "managed-worktree" } };

    test("four pinned rounds review in one worktree, each checked out detached at its own pinned commit", async () => {
      const { state, round } = await setupRounds();
      const rounds = [await round(1), await round(2), await round(3), await round(4)];
      expect(rounds[0]!.environment).toMatchObject(fresh);
      const first = state.live.get(rounds[0]!.reviewer)!.environmentId;
      for (const [index, entry] of rounds.slice(1).entries()) {
        expect(entry.environment).toEqual({ type: "reuse", environmentId: first });
        expect(entry.prompt).toContain(`git checkout --detach ${shaOf(index + 2)}`);
      }
      expect(new Set(rounds.map((entry) => state.live.get(entry.reviewer)!.environmentId))).toEqual(new Set([first]));
      expect(state.spawned.filter((args) => args.environment?.type === "host" && args.title?.startsWith("Review"))).toHaveLength(1);
    });

    test.each<[string, Mode, (state: State, reviewer: string) => void]>([
      ["its worktree is destroyed", { destroyed: true }, () => {}],
      ["its worktree is removed from the host", { removed: true }, () => {}],
      ["its environment is not a worktree", { notWorktree: true }, () => {}],
      ["its environment cannot be read", { unreadable: true }, () => {}],
      ["the reviewer thread is archived", {}, (state, id) => state.live.set(id, { ...state.live.get(id)!, archivedAt: Date.now() } as any)],
      ["the reviewer thread is deleted", {}, (state, id) => state.live.set(id, { ...state.live.get(id)!, deletedAt: Date.now() } as any)],
      ["the reviewer thread is still active", {}, (state, id) => setLive(state, id, "active")],
    ])("round 2 starts a fresh worktree when the earlier reviewer's worktree cannot be reused: %s", async (_name, mode, arrange) => {
      const { state, round } = await setupRounds(mode);
      const first = await round(1);
      arrange(state, first.reviewer);
      const second = await round(2);
      expect(second.environment).toMatchObject(fresh);
    });

    // Contract (wave 2.3): a reusableEnvironment lookup that never settles times out (CLEANUP_READ_MS = 15 s per bb read) and
    // round 2 still launches a fresh worktree. Mutation caught: dropping bounded() from either read in the server adapter
    // hangs chief_review forever on a host that never answers.
    test.each([
      ["the earlier reviewer's thread lookup", "threads.get"],
      ["the earlier reviewer's environment lookup", "environments.get"],
    ] as const)("round 2 completes on a fresh worktree after %s never settles", async (_name, hungRead) => {
      const { state, round, worker, chief } = await setupRounds();
      const first = await round(1);
      let pendingCalls = 0;
      const never = () => { pendingCalls += 1; return new Promise<never>(() => {}); };
      if (hungRead === "threads.get") {
        state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
          if (threadId === first.reviewer) return never();
          const thread = state.live.get(threadId);
          if (!thread) throw new Error("not found");
          return thread;
        });
      } else {
        state.harness.sdk.stub("environments.get", async () => never());
      }
      const spawnedBefore = state.spawned.length;
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: shaOf(2), baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        let settled = false;
        const review = tool(state, "chief_review", { workerThreadId: worker }, chief).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(14_000);
        expect(pendingCalls).toBe(1);
        expect(settled).toBe(false);
        expect(state.spawned).toHaveLength(spawnedBefore);
        await vi.advanceTimersByTimeAsync(1_500);
        await review;
      } finally {
        vi.useRealTimers();
      }
      expect(state.spawned).toHaveLength(spawnedBefore + 1);
      expect(state.spawned.at(-1).environment).toMatchObject(fresh);
      expect(String(state.spawned.at(-1).prompt)).toContain(`git checkout --detach ${shaOf(2)}`);
    });
  });

  // Contracts (review engine): the stored reviewEngine / prAgentDir settings are read when the review starts and reach the
  // launched prompt and the reviewer's storage; an unset or unrecognised value is the base reviewer behaviour.
  describe("reviewEngine setting reaches a started review", () => {
    const PR = "https://github.com/acme/shop/pull/8";
    const SHA = "1".repeat(40);
    /** The project's reviewer runs on host_1 and every thread's storage (the worker's, the reviewer's) is on host_storage, so the engine files must
     * land on host_1's data dir. `reviewerHost: "unknown"` makes host_1's data dir unreadable. */
    async function review(settings: Record<string, unknown>, { reviewerHost = "known" }: { reviewerHost?: "known" | "unknown" } = {}) {
      const state = await setup({ projectPath: "/oracle/checkout", system: { usageLimits: async () => ({}), config: async () => ({ primaryHostId: "host_1" }) } });
      const reviewerData = join(state.storageRoot, "reviewer-host-data");
      const writes: { hostId?: string; path: string }[] = [];
      state.harness.sdk.stub("hosts.get", async ({ hostId }: { hostId: string }) => {
        if (hostId !== "host_1") return { id: hostId, threadStorageRootPath: join(state.storageRoot, "thread-storage") };
        if (reviewerHost === "unknown") throw new Error("host_1 is offline");
        return { id: hostId, threadStorageRootPath: join(reviewerData, "thread-storage") };
      });
      state.harness.sdk.stub("files.write", async ({ hostId, path, content }: { hostId?: string; path: string; content: string }) => {
        writes.push({ hostId, path: path.replace(/\.tmp-[0-9a-f-]+$/, "") }); // atomicWrite lands the file under a temp name first
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        return {};
      });
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: SHA, baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      await state.harness.behavior.setSettings(settings);
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", prUrl: PR }, chief);
      const worker = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, worker);
      await tool(state, "chief_review", { workerThreadId: worker }, chief);
      const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer'`).get() as any).thread_id as string;
      // review-context.md is in the reviewer's storage; the engine files are in Chief's data folder for the worker on the reviewer's host, keyed by its
      // report and a fresh attempt id.
      const reportFolder = join(reviewerData, "chief", "proj_1", worker, "review-1");
      const attempts = await readdir(reportFolder).catch(() => [] as string[]);
      const engineDir = attempts.length === 1 ? join(reportFolder, attempts[0]!) : null;
      const file = (name: string) => readFile(join(name === "review-context.md" ? join(state.storageRoot, reviewer) : engineDir ?? join(reportFolder, "none"), name), "utf8").catch(() => null);
      return { prompt: String(state.spawned.at(-1).prompt), file, engineDir, attempts, writes, worker, state };
    }

    test("the two settings default to reviewer and PR_AGENT_DIR", async () => {
      const { state } = await review({});
      const descriptors = (state.harness.registrations.settingsDescriptors as any);
      expect(descriptors.reviewEngine).toMatchObject({ type: "select", options: ["reviewer", "pr-agent", "both"], default: "reviewer" });
      expect(descriptors.prAgentDir).toMatchObject({ type: "string", default: PR_AGENT_DIR });
    });

    // Contract: the settings page offers exactly the values already stored (reviewEngine reviewer|pr-agent|both, tracker none|bb-tasks), so no stored
    // value needs a migration; Tracker projects stays a string setting (same stored format) edited as a multiline field, one mapping per line.
    test("the tracker settings keep their stored formats: tracker is a select, trackerProjects a multiline string", async () => {
      const { state } = await review({});
      const descriptors = (state.harness.registrations.settingsDescriptors as any);
      expect(descriptors.tracker).toMatchObject({ type: "select", options: ["none", "bb-tasks"], default: "none" });
      expect(descriptors.trackerProjects).toMatchObject({ type: "string", experimental_multiline: true, default: "" });
    });

    // An unrecognised or empty reviewEngine can no longer be stored (the select rejects it); reviewEngine() in prAgent.test.ts still owns that fallback.
    test.each([["no stored value", {}]])("%s: reviewer mode, no section, no engine file", async (_name, settings) => {
      const { prompt, file } = await review(settings);
      expect(prompt).not.toContain("## Review engine");
      expect(await file("pr-agent-review.sh")).toBeNull();
      expect(await file("review-helper.md")).toBeNull();
      expect(await file("review-context.md")).not.toBeNull();
    });

    test("pr-agent: the section names the pinned pull request, the wrapper is written with the default directory", async () => {
      const { prompt, file, engineDir } = await review({ reviewEngine: "pr-agent" });
      expect(prompt).toContain("## Review engine: pr-agent");
      expect(prompt).toContain(`${PR} pinned to ${SHA} → pr-agent`);
      expect(engineDir).not.toBeNull();
      expect(prompt).toContain(`bash "${engineDir}/pr-agent-review.sh" ${PR} ${SHA}`);
      expect(prompt).not.toContain("$BB_THREAD_STORAGE/pr-agent-review.sh");
      expect(await file("pr-agent-review.sh")).toContain(PR_AGENT_DIR);
      expect(await file("review-helper.md")).toBeNull();
    });

    test("both: the configured directory reaches the wrapper and the helper prompt is written without the section", async () => {
      const { prompt, file, engineDir } = await review({ reviewEngine: "both", prAgentDir: "/opt/custom-pr-agent" });
      expect(prompt).toContain("## Review engine: both");
      expect(engineDir).not.toBeNull();
      expect(prompt).toContain(`--prompt-file "${engineDir}/review-helper.md"`);
      expect(await file("pr-agent-review.sh")).toContain("/opt/custom-pr-agent");
      expect(await file("pr-agent-review.sh")).not.toContain(PR_AGENT_DIR);
      const helper = (await file("review-helper.md"))!;
      expect(helper).toContain("## review-context.md");
      expect(helper).not.toContain("## Review engine");
    });

    // Contract (docs/specs/review-engine.md, Engine folder): the engine files are written on the host the reviewer runs on, under a fresh attempt id;
    // the reviewer's storage keeps only review-context.md. Regression: writing on the worker's thread-storage host leaves host_1 without the files.
    test("the engine files are written on the reviewer's host, not on the host of the worker's storage", async () => {
      const { prompt, engineDir, attempts, writes, worker, state } = await review({ reviewEngine: "both" });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatch(/^[0-9a-f]{8}$/);
      const engineWrites = writes.filter(({ path }) => path.includes("review-1"));
      expect(engineWrites.map(({ hostId, path }) => [hostId, path])).toEqual([
        ["host_1", join(engineDir!, "pr-agent-review.sh")],
        ["host_1", join(engineDir!, "review-helper.md")],
      ]);
      expect(writes.filter(({ path }) => path.endsWith("review-context.md")).map(({ hostId }) => hostId)).toEqual(["host_storage"]);
      expect(prompt).toContain(`bash "${engineDir}/pr-agent-review.sh"`);
      // The worker's own host (host_storage, whose data dir is the storage root) holds no engine folder.
      expect(await readdir(join(state.storageRoot, "chief", "proj_1", worker, "review-1")).catch(() => [])).toEqual([]);
    });

    // Contract (Flow 5): a wrapper that cannot be written leaves the prompt without an engine section. A reviewer host whose data dir cannot be read is
    // such a failure: the files are not written on another host. Regression: falling back to the worker's storage renders paths the reviewer's host lacks.
    test.each(["pr-agent", "both"])("%s: a reviewer host whose data dir is unknown gets a direct review: no section, no engine file anywhere, one alert", async (mode) => {
      const { prompt, attempts, writes, state } = await review({ reviewEngine: mode }, { reviewerHost: "unknown" });
      expect(prompt).not.toContain("## Review engine");
      expect(prompt).not.toContain("pr-agent-review.sh");
      expect(attempts).toEqual([]);
      expect(writes.filter(({ path }) => path.includes("pr-agent-review") || path.includes("review-helper"))).toEqual([]);
      expect(writes.filter(({ path }) => path.endsWith("review-context.md"))).toHaveLength(1);
      expect(state.sent.map((message) => String(message.input?.[0]?.text)).filter((text) => text.includes("pr-agent-review.sh"))).toHaveLength(1);
    }, 15_000);
  });

  describe("Spec Writer role", () => {
    const SPEC_DELTA = "## Spec delta\n- docs/specs/totals.md: CHANGED totals never go negative";
    /** An implementation wave that runs a Spec Writer before its worker. */
    const NOT_DOING = "\n\n## What we're NOT doing\n- x";
    const specImpl = (n = 1, extra: object = {}) => ({ body: wave(n, `Build the totals.\n\n${SPEC_DELTA}`) + NOT_DOING, spec: true, ...extra });
    const lastAlert = (state: State) => state.sent.at(-1).input[0].text as string;
    const roster = async (state: State, chiefThreadId: string) => String(await tool(state, "chief_roster", { includeComplete: true }, chiefThreadId));
    const workerCall = (planThreadId: string, writer: string, waveNo = 1) => `chief_delegate (planThreadId: ${planThreadId}, wave: ${waveNo}, replaces: ${writer}, kind: worker)`;
    const skipCall = (planThreadId: string, waveNo = 1) => `chief_skip_specs (planThreadId: ${planThreadId}, wave: ${waveNo}, reason)`;
    const skipSpecs = (state: State, chiefThreadId: string, planThreadId: string, reason = "docs are unchanged", waveNo = 1) =>
      tool(state, "chief_skip_specs", { planThreadId, wave: waveNo, reason }, chiefThreadId);
    const storedWave = (state: State, planThreadId: string, waveNo = 1) => JSON.parse(planWaves(state, planThreadId))[waveNo - 1];
    const countRows = (state: State) => (state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get() as { n: number }).n;
    const swap = async (state: State, chief: { threadId: string }, planThreadId: string, waveNo: number, replaces: string, kind: string) => {
      await delegateWave(state, chief.threadId, planThreadId, waveNo, { replaces, kind });
      return workerOn(state, planThreadId, waveNo).thread_id as string;
    };

    /** Chief + a plan (default: spec implementation wave 1, then its test wave 2). Nothing delegated. */
    async function specPlan(state: State, waves: object[] = [specImpl(), TEST_WAVE(2)], approve = false) {
      const chief = await start(state);
      const planner = await plan(state, chief.threadId, waves);
      if (approve) await approvePlan(state, chief.threadId, planner.threadId);
      return { chief, planner };
    }
    /** specPlan with wave 1's Spec Writer delegated by the default call (still busy). */
    async function withWriter(state: State, waves?: object[], extra: object = {}) {
      const ctx = await specPlan(state, waves);
      await delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 1, extra);
      return { ...ctx, writer: workerOn(state, ctx.planner.threadId, 1).thread_id as string };
    }
    /** The whole spec-first chain, every row ready and idle: Spec Writer, wave 1's worker, wave 2's tester. */
    async function fullChain(state: State, waves?: object[]) {
      const ctx = await withWriter(state, waves);
      await readyIdle(state, ctx.writer);
      const worker = await swap(state, ctx.chief, ctx.planner.threadId, 1, ctx.writer, "worker");
      await readyIdle(state, worker);
      const tester = await swap(state, ctx.chief, ctx.planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      return { ...ctx, worker, tester };
    }

    // Contract (model fallback): MODEL_FALLBACK["spec-writer"]="worker" — with no Spec Writer pick a Spec Writer spawns on
    // the Worker pick, with one on its own pick, a stored pick the machine cannot serve goes to the BB default (and Settings
    // flags it unusable), and a pick stored for another machine changes nothing here. Regression: dropping the fallback sends
    // the unset spawn to the BB default; reading the wrong role's row sends the plain worker to the Spec Writer model.
    test("spec writer model: the Spec Writer pick when set, else the Worker pick, else the BB default when unservable", async () => {
      const state = await setup();
      const set = (hostId: string, role: string, model: string) =>
        state.harness.behavior.callRpc("setRoleModel", { hostId, role, selection: { providerId: "codex", model, reasoningLevel: "high" } });
      await set("host_1", "worker", "gpt-6-mini");
      await set("host_2", "spec-writer", "gpt-6-astra");
      const { chief, planner, writer } = await withWriter(state);
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });

      await set("host_1", "spec-writer", "gpt-6-astra");
      await readyIdle(state, writer);
      const repair = await swap(state, chief, planner.threadId, 1, writer, "spec-writer");
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      // The Spec Writer pick is not the Worker pick: the wave's worker stays on the Worker model.
      await readyIdle(state, repair);
      const worker = await swap(state, chief, planner.threadId, 1, repair, "worker");
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
      const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
      expect(configuration.hosts[0]!.selections["spec-writer"]).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      expect(configuration.hosts[0]!.unusable).toEqual([]);

      await set("host_1", "spec-writer", "gpt-5-retired");
      await readyIdle(state, worker);
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      expect(state.spawned.at(-1)).not.toHaveProperty("providerId");
      expect(state.spawned.at(-1)).not.toHaveProperty("model");
      expect((await state.harness.behavior.callRpc("modelConfiguration", null)).hosts[0]!.unusable).toEqual(["spec-writer"]);
    });

    // Contract (model resolution is per machine): a Spec Writer spawns on the picks of the machine its worktree lives on. Two
    // machines with different Worker and Spec Writer picks, each repair made through chief_delegate on that machine's
    // environment: host_1 has its own Spec Writer pick, host_2 has none and inherits host_2's Worker pick, so neither
    // machine's pick reaches the other. Regression: a resolver that always reads the first machine sends host_2's Spec Writer
    // to host_1's Spec Writer model; one that reads the Worker row of the wrong machine sends it to host_1's Worker model.
    test("spec writer model: each spawn uses the picks of its own machine", async () => {
      const state = await setup();
      const set = (hostId: string, role: string, providerId: string, model: string) =>
        state.harness.behavior.callRpc("setRoleModel", { hostId, role, selection: { providerId, model, reasoningLevel: "medium" } });
      await set("host_1", "worker", "codex", "gpt-6-mini");
      await set("host_1", "spec-writer", "codex", "gpt-6-astra");
      await set("host_2", "worker", "claude-code", "claude-opus-5");
      const hostTwo = new Set<string>();
      state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
        id: environmentId, hostId: hostTwo.has(environmentId) ? "host_2" : "host_1", workspaceProvisionType: environmentId.startsWith("env_worker") ? "managed-worktree" : null,
      }));
      const chief = await start(state);
      const chains = [];
      for (const host of ["host_1", "host_2"]) {
        const planner = await plan(state, chief.threadId, [specImpl(), TEST_WAVE(2)]);
        await delegateWave(state, chief.threadId, planner.threadId, 1);
        const writer = workerOn(state, planner.threadId, 1).thread_id as string;
        if (host === "host_2") hostTwo.add(state.live.get(writer)!.environmentId as string);
        await readyIdle(state, writer);
        chains.push({ planner, writer });
      }
      const spawnRepair = async ({ planner, writer }: (typeof chains)[number]) => {
        await swap(state, chief, planner.threadId, 1, writer, "spec-writer");
        return state.spawned.at(-1);
      };
      expect(await spawnRepair(chains[0]!)).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      expect(await spawnRepair(chains[1]!)).toMatchObject({ providerId: "claude-code", model: "claude-opus-5" });
    });

    // Contract (chief_models_v8 migration, storage): a v7 database keeps all seven roles on two machines unchanged, then
    // accepts a spec-writer row and still refuses an unknown role. Regression: the rebuild drops a role or machine's row,
    // or leaves the old CHECK list so a Spec Writer pick cannot be saved.
    test("chief_models_v8 migration keeps every v7 model row and accepts a Spec Writer pick", async () => {
      const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-spec-writer" });
      disposals.push(() => harness.lifecycle.dispose());
      const db = bb.storage.database();
      bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("chief_models_v8"))));
      const insert = db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
      expect(() => insert.run("host_1", "spec-writer", "codex", "gpt-6-mini", "low", 0)).toThrow();
      const roles = ["chief", "planner", "worker", "reviewer", "advisor", "designer", "tester"];
      for (const host of ["host_1", "host_2"]) roles.forEach((role, i) => insert.run(host, role, "codex", `model-${host}-${role}`, "high", i + 1));
      const before = db.prepare(`SELECT * FROM chief_models ORDER BY host_id, role`).all();
      expect(before).toHaveLength(14);

      bb.storage.migrate(db, MIGRATIONS);

      expect(db.prepare(`SELECT * FROM chief_models ORDER BY host_id, role`).all()).toEqual(before);
      expect(() => insert.run("host_1", "spec-writer", "codex", "gpt-6-mini", "low", 100)).not.toThrow();
      expect(db.prepare(`SELECT model FROM chief_models WHERE host_id='host_1' AND role='spec-writer'`).get()).toEqual({ model: "gpt-6-mini" });
      expect(() => insert.run("host_1", "junior", "codex", "gpt-6-mini", "low", 101)).toThrow();
    });

    // Contract (checkPlan, byte-stable errors): a plan with no `spec` key gets exactly the errors it got before the flag
    // existed; the strings were captured by running checkPlan at the pre-wave-1 commit 783efcb on these inputs.
    // Regression: the spec branch reorders or rewords an old plan's errors, so a planner's retry loop sees new text.
    test("checkPlan returns byte-identical errors for plans that do not use spec", () => {
      const W = (n: number, extra: object = {}) => ({ body: `# Wave ${n}\nx\n\n## Contracts to verify\n- c${n}\n\n## What we're NOT doing\n- x`, ...extra });
      expect(checkPlan([W(1), W(2, { test: "yes" })])).toEqual([
        "plan wave 2 test is \"yes\" (string); allowed true or false. Send a boolean, or drop test.",
        "plan wave 2 ends a chain but is not test: true; follow it with a test wave (test: true, dependsOn [2]) that tests it.",
      ]);
      expect(checkPlan([W(1), W(2, { design: true, test: true })])).toEqual([
        "plan wave 2 is both design: true and test: true; a wave is one or the other.",
        "plan wave 2 is design: true but no wave builds on it; follow it with the wave that implements it (dependsOn [2] or the next wave), or drop design.",
      ]);
      expect(checkPlan([W(1), W(2, { test: true }), W(3, { test: true })])).toEqual([
        "plan wave 2 is test: true but a later wave builds on it; a test wave ends its chain.",
        "plan wave 3 is test: true but builds on test wave 2; build it on the chain's last implementation wave.",
      ]);
    });

    // Contract 1 (checkPlan, spec flag): spec is a boolean on an implementation wave whose body has a Spec delta heading; a test
    // or design wave never carries it. Regression: dropping the heading rule lets a docs step with no work list through;
    // dropping the test/design rule lets a Spec Writer be scheduled where no worker implements; dropping the copy loses the flag.
    test.each<[string, object[], RegExp[]]>([
      ["accepts spec: true on an implementation wave with a Spec delta heading", [specImpl(1), TEST_WAVE(2)], []],
      ["accepts a Spec delta heading at any level", [specImpl(1, { body: wave(1, "Build.\n\n### spec delta\n- docs/x.md") + NOT_DOING }), TEST_WAVE(2)], []],
      ["refuses a non-boolean spec", [planWave(1, { spec: "yes" }), planWave(2, { test: true })], [/plan wave 1 spec is "yes" \(string\); allowed true or false\. Send a boolean, or drop spec\./]],
      ["refuses spec: true on a test wave", [planWave(1), planWave(2, { test: true, spec: true, body: wave(2, `Tests.\n\n${SPEC_DELTA}`) })], [/plan wave 2 is spec: true and test: true; spec marks an implementation wave only\./]],
      ["refuses spec: true on a design wave", [planWave(1, { design: true, spec: true, body: wave(1, `Draw.\n\n${SPEC_DELTA}`) }), planWave(2), planWave(3, { test: true })], [/plan wave 1 is spec: true and design: true; spec marks an implementation wave only\./]],
      ["refuses spec: true with no Spec delta heading", [planWave(1, { spec: true }), planWave(2, { test: true })], [/plan wave 1 is spec: true but lacks a "## Spec delta" Markdown heading naming the docs the Spec Writer changes/]],
      ["refuses a Spec delta named only in bold text", [specImpl(1, { body: wave(1, "**Spec delta**\n- docs/x.md") + NOT_DOING }), TEST_WAVE(2)], [/plan wave 1 is spec: true but lacks a "## Spec delta"/]],
      ["accepts a Spec baseline heading on a spec wave", [specImpl(1, { body: wave(1, `Build.\n\n${SPEC_DELTA}\n\n## Spec baseline\n- docs/specs/totals.md (new): totals.ts`) + NOT_DOING }), TEST_WAVE(2)], []],
      ["accepts a Spec baseline heading at another level on a spec wave", [specImpl(1, { body: wave(1, `Build.\n\n${SPEC_DELTA}\n\n#### spec baseline\n- docs/specs/totals.md (new): totals.ts`) + NOT_DOING }), TEST_WAVE(2)], []],
      ["refuses a Spec baseline heading on a wave that is not spec: true", [planWave(1, { body: wave(1, "Build.\n\n## Spec baseline\n- docs/specs/totals.md (new): totals.ts") + NOT_DOING }), TEST_WAVE(2)], [/plan wave 1 has a "## Spec baseline" heading but is not spec: true; a baseline belongs to the spec wave that creates a new docs\/specs file\. Mark the wave spec: true, or drop the heading\./]],
      ["ignores Spec baseline in bold text on a wave that is not spec: true", [planWave(1, { body: wave(1, "Build.\n\n**Spec baseline**\n- docs/x.md") + NOT_DOING }), TEST_WAVE(2)], []],
    ])("checkPlan %s", (_name, input, expected) => {
      const errors = checkPlan(input);
      if (!expected.length) expect(errors).toEqual([]);
      for (const pattern of expected) expect(errors.join("\n")).toMatch(pattern);
    });

    test("a planner's spec flag is stored on the flagged implementation wave only", async () => {
      const state = await setup();
      const { planner } = await specPlan(state, [specImpl(1), TEST_WAVE(2), { body: wave(3), dependsOn: [] }, TEST_WAVE(4, [3])]);
      expect(JSON.parse(planWaves(state, planner.threadId)).map((entry: any) => entry.spec)).toEqual([true, undefined, undefined, undefined]);
    });

    // Contract 3 (spec-first flow): the default first call on a no-row spec wave spawns its Spec Writer; its ready alert, the
    // Pending block and the review refusal all name the worker call and neither the next wave nor the review; the worker's ready
    // then offers the test wave, and the tester's ready names the one review. Regression: dropping the readyStep/reviewBlock
    // "implement" branch offers the next wave or the review straight after the docs; keeping it for the worker too would
    // loop the hand-off.
    test("a ready Spec Writer hands off to its wave's worker before the next wave or the review", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      expect(rowOf(state, writer)).toMatchObject({ kind: "spec-writer", role: "worker", plan_wave: 1, replaces_thread_id: null });
      expect(state.spawned.at(-1).prompt).toContain("Wave 1 of 2: you run before its worker.");
      await report(state, writer, { state: "ready", result: READY });
      const implement = `Spec Writer ${writer} committed wave 1's docs. Once it is idle, delegate the wave's worker to implement against them: ${workerCall(planner.threadId, writer)}. Do not delegate the next wave or review yet.`;
      expect(lastAlert(state)).toContain(implement);
      expect(lastAlert(state)).not.toMatch(/Start the one review|delegate test wave 2|chief_skip_tests/);
      setLive(state, writer, "idle");
      expect(await roster(state, chief.threadId)).toContain(implement);
      await expect(tool(state, "chief_review", { workerThreadId: writer }, chief.threadId)).rejects.toThrow(
        `Wave 1 of 2 still owes its implementation: no review runs until its worker implements against the Spec Writer's docs — ${workerCall(planner.threadId, writer)}.`);
      expect((await status(state)).threads.filter((row) => row.role === "reviewer")).toEqual([]);

      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, worker);
      expect(lastAlert(state)).toContain(`delegate test wave 2: ${planFile(state, planner.threadId, 2)} — chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${worker}, kind: tester)`);
      expect(lastAlert(state)).not.toContain("Spec Writer");
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      expect(lastAlert(state)).toContain(`Start the one review of the whole plan now: chief_review (workerThreadId: ${tester})`);
      await reviewed(state, chief.threadId, tester, "approve");
      await tool(state, "chief_complete", { threadId: tester }, chief.threadId);
      expect(rowOf(state, tester).state).toBe("complete");
      expect(rowOf(state, planner.threadId).state).toBe("complete");
    });

    // Contract 2 (first delegation): a spec wave's first call defaults to kind spec-writer, also behind a parent wave; an explicit
    // worker, designer or tester there is refused with the Spec Writer call and chief_skip_specs, and starts nothing.
    // Regression: dropping the default spawns a plain worker with no docs; dropping the refusal lets a caller skip the Spec
    // Writer without recording why.
    test("a spec wave's first delegation defaults to its Spec Writer and refuses another kind", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [planWave(1), specImpl(2), TEST_WAVE(3)], true);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      const impl = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, impl);
      const rows = countRows(state);
      for (const kind of ["worker", "designer", "tester"]) {
        await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl, kind })).rejects.toThrow(
          `Wave 2 is marked spec: true: its Spec Writer runs before its worker — chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${impl}, kind: spec-writer). To go without, record why: ${skipCall(planner.threadId, 2)}.`);
      }
      expect(countRows(state)).toBe(rows);

      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
      expect(workerOn(state, planner.threadId, 2)).toMatchObject({ kind: "spec-writer", replaces_thread_id: impl });
      expect(countRows(state)).toBe(rows + 1);
    });

    // Contract 7 (chief_skip_specs): before any row it stores specsSkipped on that wave only, flips the default kind to worker
    // and refuses kind spec-writer; it is idempotent, and refused for a non-spec wave and once the wave has a row. Regression:
    // the flag is not stored on the wave (so the default stays spec-writer), is written to testsSkipped, or is accepted late.
    test("chief_skip_specs bypasses the Spec Writer before the first delegation only", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state);
      const before = JSON.parse(planWaves(state, planner.threadId));
      const text = await skipSpecs(state, chief.threadId, planner.threadId, "docs already describe this");
      expect(text).toBe(`Specs on wave 1 bypassed: delegate its worker — chief_delegate (planThreadId: ${planner.threadId}, wave: 1, kind: worker).`);
      const after = JSON.parse(planWaves(state, planner.threadId));
      expect(after[0]).toEqual({ ...before[0], specsSkipped: "docs already describe this" });
      expect(after[1]).toEqual(before[1]);
      const stored = planWaves(state, planner.threadId);
      expect(await skipSpecs(state, chief.threadId, planner.threadId, "another reason")).toBe(text);
      expect(planWaves(state, planner.threadId)).toBe(stored);

      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow(
        "Specs on wave 1 were bypassed (docs already describe this); no Spec Writer runs on it.");
      expect(countRows(state)).toBe(rows);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      expect(rowOf(state, workerOn(state, planner.threadId, 1).thread_id).kind).not.toBe("spec-writer");
      expect(state.spawned.at(-1).prompt).not.toContain("you run before its worker");
      expect(await skipSpecs(state, chief.threadId, planner.threadId)).toBe("Specs on wave 1 were already bypassed.");

      await expect(skipSpecs(state, chief.threadId, planner.threadId, "r", 2)).rejects.toThrow(`Wave 2 of planner ${planner.threadId} is not a spec: true implementation wave.`);
      const plain = await plan(state, chief.threadId);
      await expect(skipSpecs(state, chief.threadId, plain.threadId)).rejects.toThrow(`Wave 1 of planner ${plain.threadId} is not a spec: true implementation wave.`);
    });

    test("chief_skip_specs is refused once the wave has a row, whatever that row is", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await expect(skipSpecs(state, chief.threadId, planner.threadId)).rejects.toThrow(
        `Wave 1 already has worker ${writer}: chief_skip_specs only bypasses a Spec Writer before the wave's first delegation. Re-plan with a fresh chief_plan instead.`);
      expect(storedWave(state, planner.threadId).specsSkipped).toBeUndefined();
    });

    // Contract 8: chief_skip_tests waives the tests alone. specsSkipped stays unset, and for the same shape of plan its reply is
    // the text base 8250f0c returned (the review call, as for any plan whose chain ends on the ready worker). Regression: the old
    // coupling that also waived the Spec Writer step comes back and writes specsSkipped, or the reply gains a spec sentence.
    test("chief_skip_tests leaves specsSkipped unset and replies as base 8250f0c did", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, worker);
      const text = await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
      expect(text).toBe(`All 2 waves are ready. Start the one review of the whole plan now: chief_review (workerThreadId: ${worker}). It covers every branch (${worker}). Complete each worker on that reviewer's approve — or, if you judge a review unnecessary, complete each of them without one: chief_complete (threadId: <each>, skipReview: your reason).`);
      expect(storedWave(state, planner.threadId, 2).testsSkipped).toBe("accepted");
      expect(storedWave(state, planner.threadId, 1)).not.toHaveProperty("specsSkipped");
      expect(storedWave(state, planner.threadId, 2)).not.toHaveProperty("specsSkipped");
    });

    /** Puts wave 1's Spec Writer into `how`: ready (busy host), ready and idle, blocked and idle, idle with no report, or complete.
     * complete cannot be reached through the public calls (every route refuses it), so the row is forced and the store reloaded. */
    type WriterState = "ready" | "ready and idle" | "blocked" | "idle with no report" | "complete";
    async function putWriter(state: State, chiefThreadId: string, writer: string, how: WriterState) {
      if (how === "ready") await report(state, writer, { state: "ready", result: READY });
      if (how === "ready and idle") await readyIdle(state, writer);
      if (how === "blocked") {
        await report(state, writer, { state: "blocked", result: "Cannot write the delta", blocker: "Delta names no domain", recommendation: "Re-plan" });
        setLive(state, writer, "idle");
      }
      if (how === "idle with no report") {
        setLive(state, writer, "idle");
        await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(writer)!, lastAssistantText: "Stopped without a report" });
      }
      if (how === "complete") {
        await readyIdle(state, writer);
        state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id=?`).run(writer);
        await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, chiefThreadId);
      }
      expect(rowOf(state, writer).state).toBe({ ready: "ready", "ready and idle": "ready", blocked: "blocked", "idle with no report": "idle", complete: "complete" }[how]);
    }
    const WRITER_STATES: WriterState[] = ["ready", "ready and idle", "blocked", "idle with no report", "complete"];

    // Contract 4 (state machine): while wave 1's latest row is a Spec Writer, in any state, the wave still owes its worker. The
    // next wave's delegation (with or without replaces:), replaces: the writer on another wave, and the review are refused, and
    // the wave stays pending even when the test wave that follows it is waived. Regression: a predicate that holds only while the
    // writer is ready drops the blocked, idle-unreported and complete rows out of the schedule, so the test wave starts with no
    // docs or the review opens. Plan: two chains, so the second chain's tester can probe the Pending list.
    test.each(WRITER_STATES)("a Spec Writer that is %s still owes wave 1's implementation", async (how) => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), TEST_WAVE(2), planWave(3, { dependsOn: [] }), TEST_WAVE(4, [3])], true);
      await delegateWave(state, chief.threadId, planner.threadId, 3, { branch: "feature/b" });
      const w3 = workerOn(state, planner.threadId, 3).thread_id as string;
      await readyIdle(state, w3);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a" });
      const writer = workerOn(state, planner.threadId, 1).thread_id as string;
      const t4 = await swap(state, chief, planner.threadId, 4, w3, "tester");
      await readyIdle(state, t4);
      await putWriter(state, chief.threadId, writer, how);

      const rows = countRows(state);
      const owed = `Wave 1 still owes its implementation: its Spec Writer ${writer} hands off to its worker first — ${workerCall(planner.threadId, writer)}.`;
      const refusal = (extra: object) => delegateWave(state, chief.threadId, planner.threadId, 2, { kind: "tester", ...extra });
      await expect(refusal({})).rejects.toThrow(owed);
      const readyWriter = how === "ready" || how === "ready and idle";
      await expect(refusal({ replaces: writer })).rejects.toThrow(readyWriter
        ? `Wave 1's Spec Writer ${writer} is ready: the wave's worker implements against its docs first — ${workerCall(planner.threadId, writer)}.`
        : `Wave 1's Spec Writer ${writer} has not reported ready: retry it with the fix — chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${writer}, kind: spec-writer)`);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: writer, kind: "worker" })).rejects.toThrow(`Wave 1's Spec Writer ${writer}`);
      await expect(tool(state, "chief_review", { workerThreadId: writer }, chief.threadId)).rejects.toThrow(
        `Wave 1 of 4 still owes its implementation: no review runs until its worker implements against the Spec Writer's docs — ${workerCall(planner.threadId, writer)}.`);
      expect(countRows(state)).toBe(rows);
      expect((await status(state)).threads.filter((row) => row.role === "reviewer")).toEqual([]);

      // The advisor's probe: with the test wave waived the wave must still be pending, never [].
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
      await expect(tool(state, "chief_review", { workerThreadId: t4 }, chief.threadId)).rejects.toThrow("wave(s) 1 of 4 are not ready yet");
    });

    // Contract 5: a blocked or idle-unreported Spec Writer is retried by a Spec Writer only. A worker or designer there is refused
    // (nothing documents the wave yet), and the retry starts one row. Regression: the ready test is dropped from the hand-off check,
    // so a worker implements against docs the writer never reported ready.
    test.each<WriterState>(["blocked", "idle with no report"])("a Spec Writer that is %s is replaced by a Spec Writer only", async (how) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await putWriter(state, chief.threadId, writer, how);
      const rows = countRows(state);
      for (const kind of ["worker", "designer"]) {
        await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind })).rejects.toThrow(
          `Wave 1's Spec Writer ${writer} has not reported ready: retry it with the fix — chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${writer}, kind: spec-writer)`);
      }
      expect(countRows(state)).toBe(rows);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind: "spec-writer" });
      expect(workerOn(state, planner.threadId, 1)).toMatchObject({ kind: "spec-writer", replaces_thread_id: writer });
      expect(countRows(state)).toBe(rows + 1);
    });

    // Contract 6: chief_complete never finishes a Spec Writer: plain, override and skipReview all name the worker call (or the
    // tester rerun on a test wave). A test wave Chief waived is the one exception, since no rerun follows it. Regression: dropping the
    // guard lets an override complete the writer, which ends the wave with no implementation.
    const COMPLETE_PATHS = [["plain", {}], ["override", { override: "no approve" }], ["skipReview", { skipReview: "small change" }]] as const;
    test.each(COMPLETE_PATHS)("chief_complete refuses a spec wave's Spec Writer with %s", async (_label, how) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      await expect(tool(state, "chief_complete", { threadId: writer, ...how }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${writer}: a Spec Writer's docs need their worker — ${workerCall(planner.threadId, writer)}.`);
      expect(rowOf(state, writer).state).toBe("ready");
      expect(rowOf(state, planner.threadId).state).not.toBe("complete");
    });
    test.each(COMPLETE_PATHS)("chief_complete refuses a test wave's Spec Writer with %s", async (_label, how) => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const docs = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await readyIdle(state, docs);
      await expect(tool(state, "chief_complete", { threadId: docs, ...how }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${docs}: a Spec Writer's docs need a test rerun — chief_delegate (replaces: ${docs}, kind: tester).`);
      expect(rowOf(state, docs).state).toBe("ready");
    });

    test("chief_complete accepts a Spec Writer on a test wave Chief waived", async () => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const docs = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await readyIdle(state, docs);
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, chief.threadId);
      await tool(state, "chief_complete", { threadId: docs, skipReview: "docs only" }, chief.threadId);
      expect(rowOf(state, docs).state).toBe("complete");
    });

    // Contract 9 (admission): a Spec Writer starts only as the wave's first row on a spec wave (Initial) or as the replacement of
    // its wave's latest row on a spec-bearing chain (Repair). Accepted: replacing the spec wave's latest worker, the latest
    // tester, and the product-fix worker on the test wave. Regression: a Spec Writer branching from any other row, or on a chain
    // that has no Spec Writer, which would document work no wave owes.
    test("a Spec Writer repair is accepted on the latest tester and on a test-wave product fix", async () => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const rows = countRows(state);
      const afterTester = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      expect(rowOf(state, afterTester)).toMatchObject({ kind: "spec-writer", plan_wave: 2, replaces_thread_id: tester });
      await readyIdle(state, afterTester);
      const fix = await swap(state, chief, planner.threadId, 2, afterTester, "worker");
      await readyIdle(state, fix);
      const afterFix = await swap(state, chief, planner.threadId, 2, fix, "spec-writer");
      expect(rowOf(state, afterFix)).toMatchObject({ kind: "spec-writer", plan_wave: 2, replaces_thread_id: fix });
      expect(countRows(state)).toBe(rows + 3);
    });

    test("a Spec Writer repair is accepted on the spec wave's latest worker", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, worker);
      const repair = await swap(state, chief, planner.threadId, 1, worker, "spec-writer");
      expect(rowOf(state, repair)).toMatchObject({ kind: "spec-writer", plan_wave: 1, replaces_thread_id: worker });
    });

    test.each<[string, (ctx: Awaited<ReturnType<typeof fullChain>>) => Promise<{ call: object; wave: number; message: (planId: string, ctx: Awaited<ReturnType<typeof fullChain>>) => string }>]>([
      ["a replaced row that is not its wave's latest", async (ctx) => ({ call: { replaces: ctx.worker }, wave: 2, message: (planId, c) =>
        `A Spec Writer on wave 2 replaces its latest worker: chief_delegate (planThreadId: ${planId}, wave: 2, replaces: ${c.tester}, kind: spec-writer).` })],
      ["an earlier Spec Writer of the spec wave", async (ctx) => ({ call: { replaces: ctx.writer }, wave: 1, message: (planId, c) =>
        `A Spec Writer on wave 1 replaces its latest worker: chief_delegate (planThreadId: ${planId}, wave: 1, replaces: ${c.worker}, kind: spec-writer).` })],
    ])("a Spec Writer replacing %s is refused", async (_label, build) => {
      const state = await setup();
      const ctx = await fullChain(state);
      const { call, wave: waveNo, message } = await build(ctx);
      const rows = countRows(state);
      await expect(delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, waveNo, { ...call, kind: "spec-writer" })).rejects.toThrow(message(ctx.planner.threadId, ctx));
      expect(countRows(state)).toBe(rows);
    });

    test("a Spec Writer is refused on a chain with no spec, on a bypassed wave and on a design wave", async () => {
      // No spec on the chain: neither the worker's wave nor the test wave admits one.
      const state = await setup();
      const plain = await specPlan(state, [planWave(1), TEST_WAVE(2)]);
      await delegateWave(state, plain.chief.threadId, plain.planner.threadId, 1);
      const w1 = workerOn(state, plain.planner.threadId, 1).thread_id as string;
      await readyIdle(state, w1);
      const t2 = await swap(state, plain.chief, plain.planner.threadId, 2, w1, "tester");
      await readyIdle(state, t2);
      await expect(delegateWave(state, plain.chief.threadId, plain.planner.threadId, 2, { replaces: t2, kind: "spec-writer" })).rejects.toThrow("Wave 2: no spec on this chain, so no Spec Writer runs on it.");
      await expect(delegateWave(state, plain.chief.threadId, plain.planner.threadId, 1, { replaces: w1, kind: "spec-writer" })).rejects.toThrow("Wave 1: no spec on this chain, so no Spec Writer runs on it.");

      // A bypassed spec wave: the worker's wave and its test wave both refuse.
      const bypassed = await specPlan(state);
      await skipSpecs(state, bypassed.chief.threadId, bypassed.planner.threadId, "docs are unchanged");
      await delegateWave(state, bypassed.chief.threadId, bypassed.planner.threadId, 1);
      const b1 = workerOn(state, bypassed.planner.threadId, 1).thread_id as string;
      expect(rowOf(state, b1).kind).toBeNull();
      await readyIdle(state, b1);
      await expect(delegateWave(state, bypassed.chief.threadId, bypassed.planner.threadId, 1, { replaces: b1, kind: "spec-writer" })).rejects.toThrow(
        "Specs on wave 1 were bypassed (docs are unchanged); no Spec Writer runs on it.");

      // A design-only wave.
      const design = await specPlan(state, [planWave(1, { design: true }), specImpl(2), TEST_WAVE(3)], true);
      await expect(delegateWave(state, design.chief.threadId, design.planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow("Wave 1 is design-only: no Spec Writer runs on it.");
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE kind='spec-writer'`).get()).toEqual({ n: 0 });
    });

    /** What the owed-wave guard says for a Spec Writer in state `how`, for a call that names `call` as the writer's own replacement. */
    const notReadyText = (call: string) => `has not reported ready: retry it with the fix — ${call}, kind: spec-writer)`;
    const readyText = (call: string) => `is ready: the wave's worker implements against its docs first — ${call}, kind: worker).`;
    const isReady = (how: WriterState) => how === "ready" || how === "ready and idle";

    // Contract 4 + 5 (no replaces:): an owed wave admits a delegation only as its own Spec Writer's replacement. A worker or a
    // designer on a distinct branch with no replaces: is refused before anything spawns, in every writer state, so the wave
    // never loses its owed implementation to a row that did not read the docs. Regression (the review's trace): the guard runs
    // only when replaces: names a row, so a blocked, idle-unreported or complete writer's wave takes a designer or worker on
    // branch B, becomes "not owed", and implementation starts on unfinished docs.
    test.each(WRITER_STATES)("a worker or designer on its own branch with no replaces is refused while the Spec Writer is %s", async (how) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state, undefined, { branch: "feature/a" });
      await putWriter(state, chief.threadId, writer, how);
      const rows = countRows(state);
      const call = `chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${writer}`;
      for (const kind of ["worker", "designer"]) {
        await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { kind, branch: "feature/b" })).rejects.toThrow(
          `Wave 1's Spec Writer ${writer} ${isReady(how) ? readyText(call) : notReadyText(call)}`);
      }
      expect(countRows(state)).toBe(rows);
      expect(workerOn(state, planner.threadId, 1).thread_id).toBe(writer);
      await expect(tool(state, "chief_review", { workerThreadId: writer }, chief.threadId)).rejects.toThrow("Wave 1 of 2 still owes its implementation");
    });

    // Contract 3 + 4: the one way past an owed wave is the ready writer's own hand-off. Worker and designer are both admitted
    // there, on the writer's branch. Regression: tightening the guard so that it also refuses the ready hand-off loops the wave.
    test.each(["worker", "designer"])("a ready Spec Writer hands off to a %s that replaces it", async (kind) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state, undefined, { branch: "feature/a" });
      await readyIdle(state, writer);
      const rows = countRows(state);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind });
      expect(countRows(state)).toBe(rows + 1);
      expect(workerOn(state, planner.threadId, 1)).toMatchObject({ kind: kind === "worker" ? null : kind, replaces_thread_id: writer, branch: "feature/a" });
    });

    /** Wave 1 (spec) → wave 2 (implementation on its own branch B) → wave 3 (test), every row ready and idle, then a Spec Writer
     * repair on wave 1 (replacing wave 1's worker on branch A) put into `how`. */
    async function repairedChain(state: State, how: WriterState) {
      const { chief, planner } = await specPlan(state, [specImpl(1), planWave(2), TEST_WAVE(3)], true);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a" });
      const writer = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, writer);
      const w1 = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, w1);
      // Wave 2 is a legacy stacked row on its own branch B: a chain's wave 2 now replaces wave 1's worker on branch A.
      const { threadId: w2 } = await legacyWave(state, chief.threadId, planner.threadId, 2, "feature/b");
      await readyIdle(state, w2);
      const repair = await swap(state, chief, planner.threadId, 1, w1, "spec-writer");
      await putWriter(state, chief.threadId, repair, how);
      return { chief, planner, w1, w2, repair };
    }

    // Contract 4 (successors at any depth): while wave 1's repair Spec Writer is in any state, wave 2 (its direct successor, on its
    // own stacked branch) and wave 3 (the test wave behind wave 2) are refused, whatever replaces: names and whichever kind is
    // asked. Regression (the review's trace): the successor gate looks only at the wave's parent, so wave 3 replaces wave 2's
    // ready worker as a tester and starts while wave 1's docs are still owed.
    test.each(WRITER_STATES)("a spec repair on wave 1 in state %s refuses wave 2 and the later wave 3, whatever replaces: or kind", async (how) => {
      const state = await setup();
      const { chief, planner, w2, repair } = await repairedChain(state, how);
      const rows = countRows(state);
      const owedAncestor = `Wave 1 still owes its implementation: its Spec Writer ${repair} hands off to its worker first — ${workerCall(planner.threadId, repair)}.`;
      const writerCall = `chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${repair}`;
      const viaWriter = `Wave 1's Spec Writer ${repair} ${isReady(how) ? readyText(writerCall) : notReadyText(writerCall)}`;
      for (const target of [2, 3]) {
        for (const kind of ["worker", "designer", "tester"]) {
          await expect(delegateWave(state, chief.threadId, planner.threadId, target, { kind, branch: "feature/c" })).rejects.toThrow(owedAncestor);
          await expect(delegateWave(state, chief.threadId, planner.threadId, target, { kind, replaces: w2 })).rejects.toThrow(owedAncestor);
          await expect(delegateWave(state, chief.threadId, planner.threadId, target, { kind, replaces: repair })).rejects.toThrow(viaWriter);
        }
      }
      expect(countRows(state)).toBe(rows);
      expect((await status(state)).threads.filter((row) => row.planWave === 3)).toEqual([]);
    });

    // Contract 4 (control for the case above): once the repair writer is ready and hands off to its worker, the ancestor no longer
    // owes anything and wave 3 starts. Regression: an ancestor walk that never lets go strands the plan.
    test("wave 3 starts once wave 1's repair Spec Writer has handed off to its worker", async () => {
      const state = await setup();
      const { chief, planner, w2, repair } = await repairedChain(state, "ready and idle");
      const worker = await swap(state, chief, planner.threadId, 1, repair, "worker");
      await readyIdle(state, worker);
      await delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: w2, kind: "tester" });
      expect(workerOn(state, planner.threadId, 3)).toMatchObject({ kind: "tester", replaces_thread_id: w2 });
    });

    /** A blocked wave-1 Spec Writer on plan P (branch A), and a fresh plan Q with `waves`. */
    async function crossPlan(state: State, how: WriterState, waves: object[] = [specImpl(1), TEST_WAVE(2)]) {
      const first = await withWriter(state, undefined, { branch: "feature/a" });
      await putWriter(state, first.chief.threadId, first.writer, how);
      const fresh = await plan(state, first.chief.threadId, waves);
      if (waves.length > 2) await approvePlan(state, first.chief.threadId, fresh.threadId);
      const recovery = `chief_delegate (planThreadId: ${first.planner.threadId}, wave: 1, replaces: ${first.writer}`;
      const refusal = `Wave 1's Spec Writer ${first.writer} ${isReady(how) ? readyText(recovery) : notReadyText(recovery)}`;
      return { ...first, fresh, refusal };
    }

    // Contract 3 + 9 (cross-plan recovery): a fresh plan's wave 1 Spec Writer replaces a blocked Spec Writer of another plan, on its
    // branch; the old writer is closed out. This is the recovery path the blocked alert names. Regression: the owed-wave guard
    // refuses every cross-plan replacement, so a writer that cannot write its delta can never be recovered.
    test("a fresh plan's wave 1 Spec Writer replaces a blocked Spec Writer of another plan", async () => {
      const state = await setup();
      const { chief, writer, fresh } = await crossPlan(state, "blocked");
      await delegateWave(state, chief.threadId, fresh.threadId, 1, { replaces: writer, kind: "spec-writer" });
      expect(workerOn(state, fresh.threadId, 1)).toMatchObject({ kind: "spec-writer", plan_wave: 1, replaces_thread_id: writer, branch: "feature/a" });
      expect(rowOf(state, writer).state).toBe("complete");
    });

    // Contract 3 + 9 (every other cross-plan or cross-wave replacement of an owed writer is refused, with the writer's path): a worker
    // or designer kind; a target that is not wave 1 of the fresh plan; and a fresh wave 1 that is not itself spec: true.
    // Regression: widening the exception past "kind spec-writer, wave 1, another plan, blocked writer".
    test.each<[string, object[], number, string, (refusal: string) => string]>([
      ["kind worker", [specImpl(1), TEST_WAVE(2)], 1, "worker", (refusal) => refusal],
      ["kind designer", [specImpl(1), TEST_WAVE(2)], 1, "designer", (refusal) => refusal],
      ["a wave that is not wave 1", [planWave(1), specImpl(2), TEST_WAVE(3)], 2, "spec-writer", (refusal) => refusal],
      ["a fresh wave 1 that is not spec: true", [planWave(1), TEST_WAVE(2)], 1, "spec-writer", () => "Wave 1: no spec on this chain, so no Spec Writer runs on it."],
    ])("a blocked Spec Writer of another plan is not replaced by %s", async (_label, waves, target, kind, message) => {
      const state = await setup();
      const { chief, writer, fresh, refusal } = await crossPlan(state, "blocked", waves);
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, fresh.threadId, target, { replaces: writer, kind })).rejects.toThrow(message(refusal));
      expect(countRows(state)).toBe(rows);
      expect(rowOf(state, writer).state).toBe("blocked");
    });

    test.each<WriterState>(["ready", "ready and idle", "idle with no report", "complete"])("a Spec Writer of another plan that is %s is not replaced by a fresh plan's wave 1 Spec Writer", async (how) => {
      const state = await setup();
      const { chief, writer, fresh, refusal } = await crossPlan(state, how);
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, fresh.threadId, 1, { replaces: writer, kind: "spec-writer" })).rejects.toThrow(refusal);
      expect(countRows(state)).toBe(rows);
    });

    /** wave 1's worker, wave 2's tester on a plan: with a Spec Writer first (spec chain) or without (no spec). Returns the tester, blocked and idle. */
    async function blockedTester(state: State, spec: boolean) {
      const ctx = await specPlan(state, spec ? undefined : [planWave(1), TEST_WAVE(2)]);
      const { chief, planner } = ctx;
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      let head = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, head);
      if (spec) {
        head = await swap(state, chief, planner.threadId, 1, head, "worker");
        await readyIdle(state, head);
      }
      const tester = await swap(state, chief, planner.threadId, 2, head, "tester");
      await report(state, tester, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
      setLive(state, tester, "idle");
      return { ...ctx, tester };
    }

    // Contract 10 (blocked tester): on a spec-bearing chain the alert gives the tester's recommendation and the worker, spec-writer
    // and fresh-chief_plan routes; the same blocked tester on a no-spec chain gets #164's text unchanged. Regression: the
    // spec routes never reach Chief (no way to repair a wrong spec), or they leak onto a no-spec chain.
    test("a blocked tester's alert offers the spec routes on a spec-bearing chain only", async () => {
      const state = await setup();
      const { chief, planner, tester } = await blockedTester(state, true);
      const paths = [1, 2].map((n) => planFile(state, planner.threadId, n)).join(", ");
      const worker = `chief_delegate (replaces: ${tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester.`;
      const full = `Tests failed: Totals test fails. Tester's recommendation: Fix the product code. Route by cause. If the product code is wrong: ${worker} `
        + `If the spec is wrong: chief_delegate (replaces: ${tester}, kind: spec-writer) with the fix. `
        + `If the Spec delta cannot be built: start a fresh chief_plan with the plan files (${paths}), this blocked report (bb chief inspect ${tester}), branch ${rowOf(state, tester).branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${tester}. `
        + `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason).`;
      // The alert is length-capped after the three routes begin; the roster carries the whole line.
      expect(lastAlert(state)).toContain(full.slice(0, full.indexOf("with the plan files")));
      expect(await roster(state, chief.threadId)).toContain(full);

      const plain = await setup();
      const noSpec = await blockedTester(plain, false);
      expect(lastAlert(plain)).toContain(`Tests failed: Totals test fails. Delegate a fresh worker to fix the product code: chief_delegate (replaces: ${noSpec.tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester. `
        + `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${noSpec.planner.threadId}, wave: 2, reason).`);
      expect(lastAlert(plain)).not.toMatch(/spec-writer|Spec delta/);
    });

    // Contract 10 (blocked Spec Writer): the retry and fresh-chief_plan routes, never kind: worker (no docs, nothing to implement
    // against). Regression: the generic blocked text offers a worker the writer's delta never reached.
    test("a blocked Spec Writer's alert offers a retry and a fresh plan, never a worker", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await report(state, writer, { state: "blocked", result: "Cannot write the delta", blocker: "Delta names no domain", recommendation: "Re-plan" });
      const alert = lastAlert(state);
      const paths = [1, 2].map((n) => planFile(state, planner.threadId, n)).join(", ");
      const full = `Spec Writer blocked: Delta names no domain. Retry it with the fix: chief_delegate (replaces: ${writer}, kind: spec-writer). `
        + `If the Spec delta cannot be written: start a fresh chief_plan with the plan files (${paths}), this blocked report (bb chief inspect ${writer}), branch ${rowOf(state, writer).branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${writer}, kind: spec-writer.`;
      expect(alert).toContain(full.slice(0, full.indexOf("with the plan files")));
      expect(await roster(state, chief.threadId)).toContain(full);
      expect(alert).not.toContain("kind: worker");
      expect(full).not.toContain("kind: worker");
    });

    // Contract 10 (repair routing): a Spec Writer's ready report on a test wave asks for the test rerun; on the spec wave it asks
    // for the worker. Regression: the writer's hand-off alert is the same on both waves, so a docs repair on the test wave never
    // reruns the tests or a repair on the spec wave offers a review.
    test("a ready Spec Writer repair routes to a retest on a test wave and to the worker on the spec wave", async () => {
      const state = await setup();
      const { chief, planner, tester, worker } = await fullChain(state);
      const onTest = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await report(state, onTest, { state: "ready", result: READY });
      expect(lastAlert(state)).toContain(`A Spec Writer changed docs on test wave 2: rerun the tests against them — chief_delegate (replaces: ${onTest}, kind: tester) — then review. `
        + `If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason) or start the review: chief_review (workerThreadId: ${onTest}).`);
      setLive(state, onTest, "idle");
      const onSpec = await swap(state, chief, planner.threadId, 1, worker, "spec-writer");
      await report(state, onSpec, { state: "ready", result: READY });
      expect(lastAlert(state)).toContain(`Spec Writer ${onSpec} committed wave 1's docs. Once it is idle, delegate the wave's worker to implement against them: ${workerCall(planner.threadId, onSpec)}.`);
    });

    // Contract 10 (reroute and review hand-off): a stopped row's reroute and the reviewer's request_changes hand-off offer
    // kind spec-writer only on a spec-bearing chain. Regression: the docs route leaks onto no-spec chains, or is missing on spec ones.
    test("replacesCall and the reviewer hand-off offer a Spec Writer only on a spec-bearing chain", async () => {
      const stop = async (state: State, chiefThreadId: string, threadId: string) => {
        setLive(state, threadId, "active");
        const stopped = await state.harness.behavior.runCli(["stop", threadId, "--reason", "stuck"], ctxOf(state, chiefThreadId));
        expect(stopped.exitCode).toBe(0);
        return stopped.stdout as string;
      };
      const specState = await setup();
      const { chief, planner, writer, tester } = await fullChain(specState);
      expect(await stop(specState, chief.threadId, tester)).toContain(
        `chief_delegate (replaces: ${tester}, kind: worker) for a product-code fix, chief_delegate (replaces: ${tester}, kind: tester) for a test fix or chief_delegate (replaces: ${tester}, kind: spec-writer) for a docs fix`);
      const docs = await swap(specState, chief, planner.threadId, 2, tester, "spec-writer");
      expect(await stop(specState, chief.threadId, docs)).toContain(
        `chief_delegate (replaces: ${docs}, kind: tester) for a test rerun or chief_delegate (replaces: ${docs}, kind: spec-writer) for a docs fix`);
      expect(await stop(specState, chief.threadId, writer)).toContain(
        `chief_delegate (replaces: ${writer}, kind: worker) once it reported ready, or chief_delegate (replaces: ${writer}, kind: spec-writer) for a docs fix`);

      const reviewState = await setup();
      const chain = await fullChain(reviewState);
      await reviewed(reviewState, chain.chief.threadId, chain.tester, "request_changes");
      expect(lastAlert(reviewState)).toContain(`chief_delegate (replaces: ${chain.tester}, kind: spec-writer) for docs findings`);

      const plainState = await setup();
      const plain = await specPlan(plainState, [planWave(1), TEST_WAVE(2)]);
      await delegateWave(plainState, plain.chief.threadId, plain.planner.threadId, 1);
      const w1 = workerOn(plainState, plain.planner.threadId, 1).thread_id as string;
      await readyIdle(plainState, w1);
      const t2 = await swap(plainState, plain.chief, plain.planner.threadId, 2, w1, "tester");
      expect(await stop(plainState, plain.chief.threadId, t2)).toContain(
        `chief_delegate (replaces: ${t2}, kind: worker) for a product-code fix or chief_delegate (replaces: ${t2}, kind: tester) for a test fix`);
      expect(await stop(plainState, plain.chief.threadId, t2)).not.toContain("spec-writer");
      await readyIdle(plainState, t2);
      await reviewed(plainState, plain.chief.threadId, t2, "request_changes");
      expect(lastAlert(plainState)).not.toContain("spec-writer");
    });

    const section = (prompt: string, heading: string) => (prompt.split(`\n## ${heading}\n`)[1] ?? "").split("\n## ")[0]!;
    const BASE_HEAD = "- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start and as `Head commit: <sha>` when you report.";
    const WORKER_SPEC_RULES = [
      "Read each Spec Writer report below (`bb chief inspect <id>`), docs/INDEX.md and the specs those reports changed, and implement to match them.",
      "- Never change docs/: only a Spec Writer does.",
      "- If the spec is wrong, report blocked and recommend `chief_delegate (replaces: <your thread id>, kind: spec-writer)`. If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan.",
      BASE_HEAD,
    ];

    // Contract 11 (worker brief): every product worker on a spec-bearing chain reads the chain's Spec Writer reports from a
    // `## Spec` block and records Base/Head; the spec wave's worker and a test-wave product-fix worker both get it, and it names the
    // writer by its report path. Regression: the block is built from the replaced row only, so a fix worker on the test wave (whose
    // prior is the tester) never sees the docs it must match.
    test("a spec wave's worker and a test-wave product-fix worker get the Spec block with the chain's writer report", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      const specBlock = [...WORKER_SPEC_RULES.slice(0, 1), `Wave 1 Spec Writer ${writer}: report ${rowOf(state, writer).report_path ?? "none"}`, ...WORKER_SPEC_RULES.slice(1)].join("\n");
      expect(section(state.spawned.at(-1).prompt, "Spec")).toBe(specBlock + "\n");
      await readyIdle(state, worker);
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      await swap(state, chief, planner.threadId, 2, tester, "worker");
      expect(section(state.spawned.at(-1).prompt, "Spec")).toBe(specBlock + "\n");
    });

    test("an unplanned worker that replaces a Spec Writer gets the Spec block with that writer's report", async () => {
      const state = await setup();
      const chief = await start(state);
      const writer = await delegate(state, chief.threadId, "Docs", { kind: "spec-writer" });
      await readyIdle(state, writer.threadId, "Docs done");
      await delegate(state, chief.threadId, "Build", { replaces: writer.threadId, kind: "worker" });
      expect(section(state.spawned.at(-1).prompt, "Spec")).toBe([WORKER_SPEC_RULES[0], `Spec Writer ${writer.threadId}: report ${rowOf(state, writer.threadId).report_path ?? "none"}`, ...WORKER_SPEC_RULES.slice(1)].join("\n") + "\n");
    });

    // Contract 11 (tester brief): on a spec-bearing chain the tester's source-of-truth lines are what they are with no spec
    // (plan files and contracts only); the writer reports sit in the separate `## Spec` block, with the tester's own rules.
    // Regression: spec metadata folded into the sources changes what a no-spec tester reads, or the worker's Base/Head rule
    // reaches the tester.
    test("a tester's source lines equal the no-spec form and the spec metadata sits in its own section", async () => {
      const normalize = (state: State, prompt: string) => prompt.replaceAll(state.storageRoot, "<storage>");
      const specState = await setup();
      const spec = await fullChain(specState);
      const specPrompt = normalize(specState, specState.spawned.at(-1).prompt);

      const plainState = await setup();
      const { chief, planner } = await specPlan(plainState, [specImpl(1, { spec: false }), TEST_WAVE(2)]);
      await delegateWave(plainState, chief.threadId, planner.threadId, 1);
      const w1 = workerOn(plainState, planner.threadId, 1).thread_id as string;
      await readyIdle(plainState, w1);
      await swap(plainState, chief, planner.threadId, 2, w1, "tester");
      const plainPrompt = normalize(plainState, plainState.spawned.at(-1).prompt);

      expect(section(specPrompt, "Source of truth for test cases")).toBe(section(plainPrompt, "Source of truth for test cases"));
      expect(section(specPrompt, "Source of truth for test cases")).not.toMatch(/Spec Writer/);
      expect(plainPrompt).not.toContain("## Spec\n");
      expect(section(specPrompt, "Spec")).toContain(`Wave 1 Spec Writer ${spec.writer}: report`);
      expect(section(specPrompt, "Spec")).toContain("The committed docs are the source of truth.");
      expect(section(specPrompt, "Spec")).not.toContain("Base commit");
    });

    // Contract 16 (unplanned): the default kind stays worker; an explicit spec-writer is accepted with no plan, its ready alert names
    // the worker call with the unplannedReason and says not to review, a tester cannot follow it, and it never completes.
    // Regression: the unplanned default flips to spec-writer, or the writer is treated as finished work (review or complete).
    test("an unplanned Spec Writer is opt-in, hands off to a worker and is never completed", async () => {
      const state = await setup();
      const chief = await start(state);
      const plain = await delegate(state, chief.threadId, "Plain");
      expect(rowOf(state, plain.threadId).kind).toBeNull();

      const call = (extra: object) => tool(state, "chief_delegate", { title: "Docs", mission: "Update docs/specs/totals.md", unplannedReason: "Bounded", ...extra }, chief.threadId);
      await call({ kind: "spec-writer" });
      const writer = (await status(state)).threads.filter((row) => row.role === "worker").at(-1)!.threadId;
      expect(rowOf(state, writer)).toMatchObject({ kind: "spec-writer", plan_thread_id: null });
      expect(state.spawned.at(-1).prompt).toContain("Unplanned: Chief's mission is your Spec delta");
      await report(state, writer, { state: "ready", result: "Docs done" });
      expect(lastAlert(state)).toContain(`Spec Writer ${writer} committed the docs. Once it is idle, delegate the worker to implement against them: chief_delegate (replaces: ${writer}, kind: worker, unplannedReason: Bounded). Do not review yet.`);
      setLive(state, writer, "idle");
      await expect(tool(state, "chief_complete", { threadId: writer, skipReview: "docs only" }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${writer}: a Spec Writer's docs need their worker — chief_delegate (replaces: ${writer}, kind: worker).`);
      await expect(tool(state, "chief_delegate", { title: "Tests", mission: "Test it", replaces: writer, kind: "tester" }, chief.threadId)).rejects.toThrow(
        `Spec Writer ${writer} hands off to its worker: chief_delegate (replaces: ${writer}, kind: worker).`);
      expect(rowOf(state, writer).state).toBe("ready");
    });

    const reviewPrompt = async (state: State, chiefThreadId: string, workerThreadId: string) => {
      await tool(state, "chief_review", { workerThreadId }, chiefThreadId);
      const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
      const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
      return { prompt: state.spawned.at(-1).prompt as string, context };
    };
    /** Wave 1 (spec: true) bypassed before any row; its worker and wave 2's tester ready: the whole plan is reviewable. */
    async function bypassedChain(state: State, reasons: { specs: string; tests?: string }) {
      const { chief, planner } = await specPlan(state);
      await skipSpecs(state, chief.threadId, planner.threadId, reasons.specs);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      const worker = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, worker);
      if (reasons.tests) {
        await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: reasons.tests }, chief.threadId);
        return { chief, planner, worker, last: worker };
      }
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      return { chief, planner, worker, last: tester };
    }

    // Contract 12 (waiver type from the flags): a test waiver whose reason says "specs skipped by Chief" renders only under
    // `## Waived test waves`, and a spec bypass whose reason says "tests skipped by Chief" only under `## Bypassed Spec Writer
    // steps`; the prompt names each rule once. Regression: the waiver type is read from the line's text, so either reason files
    // its wave under the other waiver and exempts or gates the wrong work.
    test("a waiver's type comes from its flag, not from the words in its reason", async () => {
      const state = await setup();
      const { chief, planner, last } = await bypassedChain(state, { specs: "tests skipped by Chief: docs are unchanged", tests: "specs skipped by Chief: flaky suite" });
      const { prompt, context } = await reviewPrompt(state, chief.threadId, last);
      const testLine = `Wave 2 of 2: ${planFile(state, planner.threadId, 2)}: tests skipped by Chief: specs skipped by Chief: flaky suite`;
      const specLine = `Wave 1 of 2: ${planFile(state, planner.threadId, 1)}: specs skipped by Chief: tests skipped by Chief: docs are unchanged`;
      expect(section(context, "Waived test waves").trim()).toBe(testLine);
      expect(section(context, "Bypassed Spec Writer steps").trim()).toBe(specLine);
      expect(context.split(testLine)).toHaveLength(2);
      expect(context.split(specLine)).toHaveLength(2);
      expect(prompt).toContain("Chief waived the test waves listed under `## Waived test waves`");
      expect(prompt).toContain("Chief bypassed the Spec Writer on the waves listed under `## Bypassed Spec Writer steps`");
    });

    test("reviewBrief files each waiver line by its list, whatever its text says", () => {
      const target = { threadId: "thr_w", title: "Fix totals", prUrl: "https://github.com/acme/shop/pull/8", branch: "feature/x", reportSeq: 1, hasResult: true, reportPath: "/r/report-1.md",
        head: { branch: "feature/x", sha: "abc123", base: "main" } };
      const input: ReviewBriefInput = {
        worker: { ...target, kind: null, brief: null, reported: "Done" }, targets: [target], wavePaths: ["/p/plan-1.md", "/p/plan-2.md"], chain: [1, 2],
        contractLines: ["Wave 1 of 2:", "- Totals stay non-negative"], recordedLines: ["npm test → exit 0"], previous: null, chiefThreadId: "thr_c",
      };
      const asTests = reviewBrief({ ...input, waiverLines: ["Wave 2 of 2: /p/plan-2.md: tests skipped by Chief: specs skipped by Chief: flaky"] });
      expect(asTests.context).toContain("## Waived test waves\nWave 2 of 2: /p/plan-2.md: tests skipped by Chief: specs skipped by Chief: flaky");
      expect(asTests.context).not.toContain("## Bypassed Spec Writer steps");
      expect(asTests.prompt).toContain("Chief waived the test waves listed under `## Waived test waves`");
      expect(asTests.prompt).not.toContain("Chief bypassed the Spec Writer");
      const asSpecs = reviewBrief({ ...input, specWaiverLines: ["Wave 1 of 2: /p/plan-1.md: specs skipped by Chief: tests skipped by Chief: docs"] });
      expect(asSpecs.context).toContain("## Bypassed Spec Writer steps\nWave 1 of 2: /p/plan-1.md: specs skipped by Chief: tests skipped by Chief: docs");
      expect(asSpecs.context).not.toContain("## Waived test waves");
      expect(asSpecs.prompt).toContain("Chief bypassed the Spec Writer");
      expect(asSpecs.prompt).not.toContain("Chief waived the test waves");
    });

    // Contract 13 (bypassed wave's review): missing docs is not a finding, landed docs that contradict the code still are, and no
    // spec gate (no "marked spec: true", no blocking list) renders. Regression: a bypass leaves the gate on, so a review blocks
    // on docs nobody was asked to write, or the bypass sentence drops the contradiction rule.
    test("a bypassed spec wave's review excuses missing docs, keeps contradicting docs and renders no spec gate", async () => {
      const state = await setup();
      const { chief, last } = await bypassedChain(state, { specs: "docs are unchanged" });
      const { prompt } = await reviewPrompt(state, chief.threadId, last);
      expect(prompt).toContain("Review those waves against their plan: missing docs/ for them is not a finding, and they get no spec gate. The bypass never covers tests, and it never excuses landed docs/ that contradict the code.");
      expect(prompt).not.toMatch(/marked spec: true|This task ran a Spec Writer|\(1\) code that contradicts the committed docs/);
    });

    // Contract 14 (provenance): on a spec-bearing chain the reviewer's earlier-rows list keeps every Spec Writer and Tester row
    // even past four earlier rows, plus the worker interval line; a no-spec chain keeps the four-row cap. Regression: the
    // `.slice(0, 4)` cap drops the oldest Spec Writer (and the implementing worker's evidence) once the chain has a few fix rounds.
    test("a spec-bearing chain keeps every Spec Writer and Tester row in the review's earlier rows, a no-spec chain keeps the cap", async () => {
      const state = await setup();
      const { chief, planner, writer, tester } = await fullChain(state);
      const f1 = await swap(state, chief, planner.threadId, 2, tester, "worker");
      await readyIdle(state, f1);
      const t2 = await swap(state, chief, planner.threadId, 2, f1, "tester");
      await readyIdle(state, t2);
      const f2 = await swap(state, chief, planner.threadId, 2, t2, "worker");
      await readyIdle(state, f2);
      const t3 = await swap(state, chief, planner.threadId, 2, f2, "tester");
      await readyIdle(state, t3);
      const { prompt, context } = await reviewPrompt(state, chief.threadId, t3);
      const rows = context.split("\n").filter((line) => /^- (worker|tester|spec-writer|designer) thr_/.test(line));
      expect(rows.length).toBeGreaterThan(4);
      for (const row of [`spec-writer ${writer}`, `tester ${tester}`, `tester ${t2}`]) expect(rows.some((line) => line.startsWith(`- ${row}:`))).toBe(true);
      expect(prompt).toContain("Check each earlier worker on its own commits only: from the Base commit its report names to the Head commit it names");
      expect(prompt).toMatch(new RegExp(`Earlier here: [^.]*spec-writer ${writer}[^.]*`));

      const plainState = await setup();
      const chief2 = await start(plainState);
      let head = (await delegate(plainState, chief2.threadId, "Step 0")).threadId;
      const firstStep = head;
      for (let i = 1; i <= 5; i++) {
        await readyIdle(plainState, head, `Done ${i}`);
        head = (await delegate(plainState, chief2.threadId, `Step ${i}`, { replaces: head })).threadId;
      }
      await readyIdle(plainState, head, "Done 6");
      const plain = await reviewPrompt(plainState, chief2.threadId, head);
      const plainRows = plain.context.split("\n").filter((line) => /^- (worker|tester|spec-writer|designer) thr_/.test(line));
      expect(plainRows).toHaveLength(4);
      expect(plainRows.some((line) => line.includes(firstStep))).toBe(false);
      expect(plain.prompt).not.toContain("Check each earlier worker on its own commits only");
    });

    // Contract 15 (gate): the spec gate blocks on items (1)-(5) only, limits (5) to new or changed prose, needs no new commit for
    // correct content, and puts the ASD-STE100 rules in a trailing nit line. Regression: STE moves into the blocking list, or
    // the "no commit for correct content" / new-or-changed-prose limits are dropped, so reviews block on style or unchanged docs.
    test("the spec gate lists blocking items 1-5, the prose and no-commit limits, and the STE nit line", async () => {
      const state = await setup();
      const { chief, tester } = await fullChain(state);
      const { prompt } = await reviewPrompt(state, chief.threadId, tester);
      const gate = prompt.split("Block only on:\n")[1]!.split("\n\n")[0]!;
      const items = gate.split("\n");
      expect(items.slice(0, 5).map((line) => line.slice(0, 3))).toEqual(["(1)", "(2)", "(3)", "(4)", "(5)"]);
      expect(items[0]).toBe("(1) code that contradicts the committed docs;");
      expect(items[1]).toBe("(2) a test that contradicts them;");
      expect(items[2]).toBe("(3) a named Spec delta item that is missing or wrong in the final docs;");
      expect(items[3]).toBe("(4) a docs/ change in a worker's, designer's or tester's own commit range;");
      expect(items[4]).toMatch(/^\(5\) in new or changed docs prose only: no lead sentence saying what the domain is for;/);
      expect(items).toHaveLength(6);
      expect(items[5]).toBe("Content already correct needs no new commit. Unchanged existing docs are out of scope. A bypass never excuses landed docs that contradict the code. ASD-STE100 sentence rules (Simplified Technical English) are nits, never blocking.");
      expect(items.slice(0, 5).join("\n")).not.toMatch(/STE|Simplified Technical English/);
    });

    // Contract 17 (no-spec preservation, strings): for a plan with no spec wave, the alerts, Pending/roster text, review refusal,
    // stop reroute and reviewer hand-off Chief reads equal what #164's head (7c3a89d) produced on the same fixture. The oracle file
    // was captured by running this marked block unchanged against 7c3a89d; only the storage root is normalized.
    // Regression: a spec-first change that leaks a Spec Writer route, wording or ordering into a plan with no spec wave.
    // <strings-oracle-fixture>
    const stringsFixture = async (state: State) => {
      const out: string[] = [];
      const alertOf = () => state.sent.at(-1).input[0].text as string;
      const rosterOf = async (chiefThreadId: string) => String(await tool(state, "chief_roster", { includeComplete: true }, chiefThreadId));
      const chief = await start(state);
      const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE }, TEST_WAVE(2)]);
      const next = async (waveNo: number, extra: object) => {
        await delegateWave(state, chief.threadId, planner.threadId, waveNo, extra);
        return workerOn(state, planner.threadId, waveNo).thread_id as string;
      };
      const w1 = await next(1, {});
      await readyIdle(state, w1);
      out.push(`worker ready alert:\n${alertOf()}`, `roster:\n${await rosterOf(chief.threadId)}`);
      const t1 = await next(2, { replaces: w1, kind: "tester" });
      await report(state, t1, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
      setLive(state, t1, "idle");
      out.push(`blocked tester alert:\n${alertOf()}`, `roster:\n${await rosterOf(chief.threadId)}`);
      const stopped = await (async () => {
        setLive(state, t1, "active");
        const reply = await state.harness.behavior.runCli(["stop", t1, "--reason", "stuck"], ctxOf(state, chief.threadId));
        return reply.stdout as string;
      })();
      out.push(`stop reply:\n${stopped}`);
      const fix = await next(2, { replaces: t1, kind: "worker" });
      await readyIdle(state, fix);
      out.push(`fix ready alert:\n${alertOf()}`);
      const t2 = await next(2, { replaces: fix, kind: "tester" });
      await readyIdle(state, t2);
      out.push(`tester ready alert:\n${alertOf()}`, `roster:\n${await rosterOf(chief.threadId)}`);
      out.push(`review refusal:\n${await tool(state, "chief_review", { workerThreadId: w1 }, chief.threadId).then(() => "started", (error: Error) => error.message)}`);
      await reviewed(state, chief.threadId, t2, "request_changes");
      out.push(`request_changes alert:\n${alertOf()}`);
      return out.map((block) => `=== ${block.split(":\n")[0]} ===\n${block.replaceAll(state.storageRoot, "<storage>")}\n`).join("");
    };
    // </strings-oracle-fixture>

    test("a plan with no spec wave produces the strings #164's head produced", async () => {
      const state = await setup();
      const head = await stringsFixture(state);
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "strings-no-spec-7c3a89d.txt"), "utf8");
      expect(head).toBe(oracle);
    });

    // Contract 17 (no-spec preservation, briefs): the worker, designer and tester prompts chief_delegate builds on the oracle fixture
    // are the bytes base 8250f0c built, apart from #164's tester `Head commit` line, normalized by name. The oracle file was
    // captured by running the marked block against 8250f0c; only the storage root is normalized.
    // Regression: any unrelated work order added, reworded or dropped in these prompts by the spec-first change.
    // <brief-oracle-fixture>
    const briefFixture = async (state: State) => {
      const chief = await start(state);
      const out: Record<string, string> = {};
      const last = () => state.spawned.at(-1).prompt as string;
      const unplanned = await delegate(state, chief.threadId, "Plain");
      out["worker, unplanned"] = last();
      await delegate(state, chief.threadId, "Design", { kind: "designer" });
      out["designer, unplanned"] = last();
      await readyIdle(state, unplanned.threadId, "Done");
      await delegate(state, chief.threadId, "Tests", { replaces: unplanned.threadId, kind: "tester" });
      out["tester, unplanned"] = last();
      const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE },
        { body: wave(2, "Write the tests.\n\n## Spec delta\n- docs/specs/totals.md: CHANGED totals never go negative"), test: true }]);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { verifyCommand: "npx vitest run server.test.ts -t totals" });
      out["worker, planned"] = last();
      const impl = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, impl);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
      out["tester, planned"] = last();
      return Object.entries(out).map(([name, prompt]) => `=== ${name} ===\n${prompt.replaceAll(state.storageRoot, "<storage>")}\n`).join("");
    };
    // </brief-oracle-fixture>

    test("worker, designer and tester prompts equal base 8250f0c's apart from the tester Head commit line", async () => {
      const state = await setup();
      const head = await briefFixture(state);
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "briefs-base-8250f0c.txt"), "utf8");
      const headCommit = "- When you report, record `git rev-parse HEAD` as `Head commit: <sha>`.";
      const lines = head.split("\n");
      expect(lines.filter((line) => line === headCommit)).toHaveLength(2);
      expect(lines.filter((line) => line !== headCommit).join("\n")).toBe(oracle);
    });

    // Contract 17 (planner and advisor briefs): they change on purpose, so assert the changed lines only. The planner is told the
    // spec flag, the `## Spec delta` heading and that the Spec Writer runs before the wave's worker; the advisor's plan review
    // checks a docs-changing chain for a missing spec: true wave.
    test("the planner's and the advisor's briefs carry the spec-first lines", async () => {
      const state = await setup();
      const chief = await start(state);
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chief.threadId));
      const planPrompt = state.spawned.at(-1).prompt as string;
      expect(planPrompt).toContain("`{body, dependsOn, design?, test?, spec?}`");
      expect(planPrompt).toContain("mark the implementation wave that makes the change `spec: true` and give that wave a `## Spec delta` heading for the Spec Writer, who commits the docs before the wave's worker runs. Test waves are never `spec: true`.");
      expect(planPrompt).not.toContain("mark its test wave `spec: true`");

      const planner = await plan(state, chief.threadId, [specImpl(1), planWave(2), TEST_WAVE(3)]);
      await approvePlan(state, chief.threadId, planner.threadId);
      const advisorPrompt = state.spawned.at(-1).prompt as string;
      expect(advisorPrompt).toContain("A chain that changes documented behaviour with no `spec: true` implementation wave, or a `## Spec delta` that names no docs file or restates test cases.");
      // Contract (advisor plan-review checklist): the reshape line follows the test-wave line, and only a plan review has it.
      expect(advisorPrompt).toContain(`- A chain without a final test wave, or test work inside an implementation wave.\n${RESHAPE_CHECKLIST_LINE}\n`);
      await tool(state, "chief_consult", { title: "Totals", mission: "Why do totals go negative?" }, chief.threadId);
      expect(state.spawned.at(-1).prompt).not.toContain(RESHAPE_CHECKLIST_LINE);
    });

    // ---- First-touch baseline specs (wave 2 tests) ----
    // <baseline-oracle-begin>
    // The oracle fixtures below were run unchanged against base 6d288a2 to capture __snapshots__/*-6d288a2.txt; only the storage
    // root is normalized. On 6d288a2 the baseline heading is plain text, so `baseImpl` is a plain spec wave there.
    const BASELINE = "## Spec baseline\n- docs/specs/totals.md (new): totals.ts `computeTotal`";
    /** A spec wave whose body names a new spec file's baseline. */
    const baseImpl = (n = 1, extra: object = {}) => ({ body: wave(n, `Build the totals.\n\n${SPEC_DELTA}\n\n${BASELINE}`) + NOT_DOING, spec: true, ...extra });
    const hop = async (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, extra: object = {}) => {
      await delegateWave(state, chiefThreadId, planThreadId, waveNo, extra);
      return { id: workerOn(state, planThreadId, waveNo).thread_id as string, prompt: state.spawned.at(-1).prompt as string };
    };
    /** Spec chain of two spec waves then a test wave, run to the end: every row ready and idle. */
    async function mixedChain(state: State, waves: object[]) {
      const { chief, planner } = await specPlan(state, waves, true);
      const go = async (waveNo: number, extra: object) => {
        const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
        await readyIdle(state, row.id);
        return row;
      };
      const w1Writer = await go(1, {});
      const w1Worker = await go(1, { replaces: w1Writer.id, kind: "worker" });
      const w2Writer = await go(2, { replaces: w1Worker.id });
      const w2Worker = await go(2, { replaces: w2Writer.id, kind: "worker" });
      const tester = await go(3, { replaces: w2Worker.id, kind: "tester" });
      return { chief, planner, w1Writer, w1Worker, w2Writer, w2Worker, tester };
    }
    const asOracle = (state: State, entries: Array<[string, string]>) =>
      entries.map(([name, text]) => `=== ${name} ===\n${text.replaceAll(state.storageRoot, "<storage>")}\n`).join("");

    /** Spec Writer, worker, tester, a test-wave docs repair and the reviewer of a spec chain with no baseline, plus their alerts. */
    const existingOnlyFixture = async (state: State) => {
      const out: Array<[string, string]> = [];
      const { chief, planner } = await specPlan(state);
      const writer = await hop(state, chief.threadId, planner.threadId, 1);
      out.push(["spec writer prompt", writer.prompt]);
      await readyIdle(state, writer.id);
      out.push(["spec writer ready alert", lastAlert(state)], ["roster after writer", await roster(state, chief.threadId)]);
      const worker = await hop(state, chief.threadId, planner.threadId, 1, { replaces: writer.id, kind: "worker" });
      out.push(["worker prompt", worker.prompt]);
      await readyIdle(state, worker.id);
      out.push(["worker ready alert", lastAlert(state)]);
      const tester = await hop(state, chief.threadId, planner.threadId, 2, { replaces: worker.id, kind: "tester" });
      out.push(["tester prompt", tester.prompt]);
      await readyIdle(state, tester.id);
      out.push(["tester ready alert", lastAlert(state)]);
      const docs = await hop(state, chief.threadId, planner.threadId, 2, { replaces: tester.id, kind: "spec-writer" });
      out.push(["test-wave spec writer prompt", docs.prompt]);
      await readyIdle(state, docs.id);
      out.push(["test-wave spec writer ready alert", lastAlert(state)]);
      const review = await reviewPrompt(state, chief.threadId, docs.id);
      out.push(["reviewer prompt", review.prompt], ["reviewer context", review.context]);
      return asOracle(state, out);
    };

    /** Wave 1's Spec Writer and worker prompts of a chain whose wave 2 (not wave 1) has a baseline. */
    const mixedWaveOneFixture = async (state: State) => {
      const chain = await mixedChain(state, [specImpl(1), baseImpl(2), TEST_WAVE(3)]);
      return asOracle(state, [["wave 1 spec writer prompt", chain.w1Writer.prompt], ["wave 1 worker prompt", chain.w1Worker.prompt]]);
    };

    /** The planner prompt for a plain brief and for a revision of a plan whose one advisor review asked for changes. */
    const plannerFixture = async (state: State) => {
      const chief = await start(state);
      const cli = (args: string[]) => state.harness.behavior.runCli(args, ctxOf(state, chief.threadId));
      await cli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--context", "Totals went negative last week."]);
      const plain = state.spawned.at(-1).prompt as string;
      const first = await plan(state, chief.threadId, [planWave(1), planWave(2), TEST_WAVE(3)]);
      await tool(state, "chief_consult", { planThreadId: first.threadId, title: "Plan", mission: "Review this plan before delegation" }, chief.threadId);
      const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
      await report(state, advisor.threadId, { state: "ready", result: "Merge the two waves", verdict: "request_changes" });
      await cli(["plan", "--title", "Rework checkout", "--mission", "Revise per the advisor", "--revises", first.threadId]);
      return asOracle(state, [["plain planner prompt", plain], ["revision planner prompt", state.spawned.at(-1).prompt as string]]);
    };
    // <baseline-oracle-end>

    const oracleFile = (name: string) => readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", name), "utf8");
    const WRITER_BASELINE = "- Baseline: this wave's plan has a `## Spec baseline` heading.";
    const TESTER_BASELINE = "- A new spec's baseline (the current behaviour a Spec Writer documented";
    const gateOf = (prompt: string) => prompt.split("Block only on:\n")[1]!.split("\n\n")[0]!.split("\n");

    // Contract (existing-only equivalence, base oracle): a spec chain whose waves have no baseline spawns the Spec Writer, worker,
    // tester, test-wave Spec Writer and reviewer, and sends the alerts, with the bytes base 6d288a2 produced. Regression: a baseline
    // line, reworded line or extra gate item leaks into a chain that has no baseline.
    test("a spec chain with no baseline produces the prompts and alerts base 6d288a2 produced", async () => {
      const state = await setup();
      // Only the reviewer prompt changed: the make-native line follows its "Classify the change" line.
      expect(await existingOnlyFixture(state)).toBe(withReviewerLine(await oracleFile("spec-chain-6d288a2.txt")));
    });

    // Contract (planner equivalence, base oracle): plannerBrief output is the bytes of base 6d288a2 for a plain and a revision brief.
    // Regression: the baseline rule lands in the planner brief instead of the read-only skill.
    // Plan chains changed one bullet of both prompts (the `dependsOn: []` sentence now says an independent wave runs as its own chain); the rest is base's bytes.
    test("the planner prompt equals base 6d288a2's for a plain and a revision brief", async () => {
      const state = await setup();
      // Plain and revision briefs each gain the reshape rule right after the test-wave line (2 anchors); nothing else moves.
      expect(await plannerFixture(state)).toBe(spliceAfter(await oracleFile("planner-6d288a2.txt"), PLANNER_ANCHOR, PLANNER_RESHAPE_LINE, 2));
    });

    // Contract (mixed chain, existing-only first): wave 1's Spec Writer and worker prompts are base 6d288a2's bytes although wave 2 has
    // a baseline; wave 2's Spec Writer has the Baseline line, its worker does not, and the wave 3 tester has the tester line.
    // Regression: an unconditional line; a Spec Writer flag read from any wave of the chain (wave 1's writer would get wave 2's
    // line); a worker or designer that gets the Spec Writer line; a tester flag read from its own wave only.
    test("a baseline on wave 2 reaches wave 2's Spec Writer and the tester, not wave 1's prompts or wave 2's worker", async () => {
      const state = await setup();
      const chain = await mixedChain(state, [specImpl(1), baseImpl(2), TEST_WAVE(3)]);
      expect(chain.w1Writer.prompt).not.toContain(WRITER_BASELINE);
      expect(chain.w1Worker.prompt).not.toContain(WRITER_BASELINE);
      expect(chain.w2Writer.prompt).toContain(WRITER_BASELINE);
      expect(chain.w2Worker.prompt).not.toMatch(/baseline/i);
      expect(chain.tester.prompt).toContain(TESTER_BASELINE);
      expect(chain.tester.prompt).not.toContain(WRITER_BASELINE);
    });

    // Contract (mixed chain, byte identity): wave 1's Spec Writer and worker prompts are the bytes base 6d288a2 produced although wave 2
    // of the chain has a baseline. Regression: a Spec Writer or worker flag read from any wave of the chain.
    test("wave 1's prompts of a chain whose wave 2 has a baseline equal base 6d288a2's", async () => {
      const state = await setup();
      expect(await mixedWaveOneFixture(state)).toBe(await oracleFile("spec-chain-mixed-wave-1-6d288a2.txt"));
    });

    // Contract (mixed chain, reversed order): wave 1 has the baseline, wave 2 does not: wave 2's Spec Writer gets no line, and the
    // tester gets its line from ancestor wave 1. Regression: a Spec Writer that reads its ancestors' flag; a tester that reads only
    // its own wave.
    test("a baseline on wave 1 reaches wave 1's Spec Writer and the tester, not wave 2's Spec Writer", async () => {
      const state = await setup();
      const chain = await mixedChain(state, [baseImpl(1), specImpl(2), TEST_WAVE(3)]);
      expect(chain.w1Writer.prompt).toContain(WRITER_BASELINE);
      expect(chain.w1Worker.prompt).not.toMatch(/baseline/i);
      expect(chain.w2Writer.prompt).not.toMatch(/baseline/i);
      expect(chain.w2Worker.prompt).not.toMatch(/baseline/i);
      expect(chain.tester.prompt).toContain(TESTER_BASELINE);
    });

    // Contract (isolation): a baseline wave on another chain gives the other chain's Spec Writer and tester no line, and its own chain
    // still gets both. Regression: a flag read from any wave of the plan.
    test("a baseline on another chain reaches only that chain's Spec Writer and tester", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), TEST_WAVE(2), baseImpl(3, { dependsOn: [] }), TEST_WAVE(4, [3])], true);
      const go = async (waveNo: number, extra: object) => {
        const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
        await readyIdle(state, row.id);
        return row;
      };
      const bWriter = await go(3, { branch: "feature/b" });
      const aWriter = await go(1, { branch: "feature/a" });
      const bWorker = await go(3, { replaces: bWriter.id, kind: "worker" });
      const aWorker = await go(1, { replaces: aWriter.id, kind: "worker" });
      const bTester = await go(4, { replaces: bWorker.id, kind: "tester" });
      const aTester = await go(2, { replaces: aWorker.id, kind: "tester" });
      expect(bWriter.prompt).toContain(WRITER_BASELINE);
      expect(bTester.prompt).toContain(TESTER_BASELINE);
      expect(aWriter.prompt).not.toMatch(/baseline/i);
      expect(aTester.prompt).not.toMatch(/baseline/i);
    });

    // Contract (bypass): a baseline wave with chief_skip_specs sets no tester line and does not count in the reviewer's spec waves,
    // while the unbypassed spec wave that follows still renders the gate, without item (6). Regression: a flag read from a bypassed
    // wave (tester line or item (6) appears); item (6) read from every wave instead of the reviewed, unbypassed ones.
    test("a bypassed baseline wave gives the tester no line and the reviewer no item (6)", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [baseImpl(1), specImpl(2), TEST_WAVE(3)], true);
      await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
      const go = async (waveNo: number, extra: object) => {
        const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
        await readyIdle(state, row.id);
        return row;
      };
      const w1 = await go(1, {});
      const w2Writer = await go(2, { replaces: w1.id });
      const w2Worker = await go(2, { replaces: w2Writer.id, kind: "worker" });
      const tester = await go(3, { replaces: w2Worker.id, kind: "tester" });
      expect(rowOf(state, w1.id).kind).toBeNull();
      for (const row of [w1, w2Writer, w2Worker, tester]) expect(row.prompt).not.toMatch(/baseline/i);
      const { prompt } = await reviewPrompt(state, chief.threadId, tester.id);
      const gate = gateOf(prompt);
      expect(gate).toHaveLength(6);
      expect(gate.map((line) => line.slice(0, 3))).not.toContain("(6)");
    });

    // Contract (repairs): a Spec Writer that replaces the worker of a baseline wave, or repairs on the test wave, gets no Baseline
    // line; a retry of a writer that has not handed off gets it. Regression: the flag is set after the worker ran (repair gets the
    // line); the test-wave repair reads its ancestor's flag; the retry loses the line.
    test("a Spec Writer repair after the worker or on the test wave gets no baseline line, a retry before the worker does", async () => {
      const waves = () => [baseImpl(1), TEST_WAVE(2)];
      const afterWorker = await setup();
      const first = await withWriter(afterWorker, waves());
      await readyIdle(afterWorker, first.writer);
      const worker = await swap(afterWorker, first.chief, first.planner.threadId, 1, first.writer, "worker");
      await readyIdle(afterWorker, worker);
      await swap(afterWorker, first.chief, first.planner.threadId, 1, worker, "spec-writer");
      expect(afterWorker.spawned.at(-1).prompt).not.toMatch(/baseline/i);

      const onTestWave = await setup();
      const chain = await fullChain(onTestWave, waves());
      await swap(onTestWave, chain.chief, chain.planner.threadId, 2, chain.tester, "spec-writer");
      expect(onTestWave.spawned.at(-1).prompt).not.toMatch(/baseline/i);

      const retry = await setup();
      const stalled = await withWriter(retry, waves());
      expect(retry.spawned.at(-1).prompt).toContain(WRITER_BASELINE);
      await putWriter(retry, stalled.chief.threadId, stalled.writer, "blocked");
      await swap(retry, stalled.chief, stalled.planner.threadId, 1, stalled.writer, "spec-writer");
      expect(retry.spawned.at(-1).prompt).toContain(WRITER_BASELINE);
    });

    // Contract (replaces: alone): a retry that names only `replaces:` resolves the plan and wave from the replaced row and renders the
    // prompt of the call that names them. Regression: the bare call falls back to the unplanned branch (no line) or another wave's flag.
    test("a Spec Writer retry with replaces alone renders the same prompt as one naming the plan and wave", async () => {
      const prompts: string[] = [];
      for (const bare of [false, true]) {
        const state = await setup();
        const { chief, planner, writer } = await withWriter(state, [baseImpl(1), TEST_WAVE(2)]);
        await putWriter(state, chief.threadId, writer, "blocked");
        if (bare) await tool(state, "chief_delegate", { title: "Wave 1", mission: "Do the wave.", replaces: writer, kind: "spec-writer" }, chief.threadId);
        else await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind: "spec-writer" });
        prompts.push((state.spawned.at(-1).prompt as string).replaceAll(state.storageRoot, "<storage>"));
      }
      expect(prompts[0]).toContain(WRITER_BASELINE);
      expect(prompts[1]).toBe(prompts[0]);
    });

    // Contract (cross-plan recovery): a fresh plan's wave 1 writer that replaces a blocked writer of another plan reads the fresh
    // plan's flag, in both directions. Regression: the flag is read from the replaced row's plan.
    test.each<[string, object[], object[], boolean]>([
      ["a fresh baseline plan replacing a plain plan's writer", [specImpl(1), TEST_WAVE(2)], [baseImpl(1), TEST_WAVE(2)], true],
      ["a fresh plain plan replacing a baseline plan's writer", [baseImpl(1), TEST_WAVE(2)], [specImpl(1), TEST_WAVE(2)], false],
    ])("cross-plan recovery reads the fresh plan's flag: %s", async (_label, oldWaves, freshWaves, expected) => {
      const state = await setup();
      const old = await withWriter(state, oldWaves, { branch: "feature/a" });
      await putWriter(state, old.chief.threadId, old.writer, "blocked");
      const fresh = await plan(state, old.chief.threadId, freshWaves);
      await delegateWave(state, old.chief.threadId, fresh.threadId, 1, { replaces: old.writer, kind: "spec-writer" });
      expect((state.spawned.at(-1).prompt as string).includes(WRITER_BASELINE)).toBe(expected);
    });

    // Contract (persist round-trip): intake stores `baseline: true` only on a spec wave whose body has the heading; every other wave
    // has no `baseline` key, so the old JSON shape stays. Regression: the key is not stored (no wave gets a line); it is stored on
    // every spec wave; bold text or a non-spec wave gets it.
    test("intake stores baseline: true only on the spec wave that has the heading", async () => {
      const state = await setup();
      const boldOnly = specImpl(3, { dependsOn: [], body: wave(3, `Build.\n\n${SPEC_DELTA}\n\n**Spec baseline**\n- docs/x.md`) + NOT_DOING });
      const { planner } = await specPlan(state, [baseImpl(1), TEST_WAVE(2), boldOnly, TEST_WAVE(4, [3]), specImpl(5, { dependsOn: [] }), TEST_WAVE(6, [5])]);
      const stored = JSON.parse(planWaves(state, planner.threadId));
      expect(stored[0].baseline).toBe(true);
      for (const index of [1, 2, 3, 4, 5]) expect(stored[index]).not.toHaveProperty("baseline");
      expect(stored.map((entry: any) => entry.spec)).toEqual([true, undefined, true, undefined, true, undefined]);
    });

    // Contract (legacy row): a plan stored before this change has no `baseline` key; its body still has the heading, and no baseline
    // line renders for its Spec Writer or its tester. Regression: a runtime heading parse (the writer and tester get the lines).
    test("a stored plan without the baseline key renders no baseline line although its wave body has the heading", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [baseImpl(1), TEST_WAVE(2)]);
      expect(await readFile(planFile(state, planner.threadId, 1), "utf8")).toContain("## Spec baseline");
      const legacy = JSON.parse(planWaves(state, planner.threadId)).map(({ baseline: _dropped, ...rest }: any) => rest);
      state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
      await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, chief.threadId);
      expect(storedWave(state, planner.threadId)).not.toHaveProperty("baseline");
      const writer = await hop(state, chief.threadId, planner.threadId, 1);
      await readyIdle(state, writer.id);
      const worker = await hop(state, chief.threadId, planner.threadId, 1, { replaces: writer.id, kind: "worker" });
      await readyIdle(state, worker.id);
      const tester = await hop(state, chief.threadId, planner.threadId, 2, { replaces: worker.id, kind: "tester" });
      for (const row of [writer, worker, tester]) expect(row.prompt).not.toMatch(/baseline/i);
    });

    // Contract (reviewer item (6)): on a plan with a baseline the spec gate lists items (1)-(6) blocking, then the "Content already
    // correct" line that carries the STE nit; item (6) is absent when no reviewed spec wave has a baseline. Regression: item (6)
    // placed after the STE line (the nit line is no longer last); item (6) shown for every spec plan.
    test("the spec gate puts item (6) between item (5) and the Content already correct line, for a baseline plan only", async () => {
      const state = await setup();
      const chain = await mixedChain(state, [specImpl(1), baseImpl(2), TEST_WAVE(3)]);
      const { prompt } = await reviewPrompt(state, chain.chief.threadId, chain.tester.id);
      const items = gateOf(prompt);
      expect(items).toHaveLength(7);
      expect(items.slice(0, 5).map((line) => line.slice(0, 3))).toEqual(["(1)", "(2)", "(3)", "(4)", "(5)"]);
      expect(items[5]).toMatch(/^\(6\) a baseline statement /);
      expect(items[6]).toMatch(/^Content already correct needs no new commit\..*ASD-STE100 sentence rules .*nits, never blocking\.$/);
      expect(items.slice(0, 6).join("\n")).not.toMatch(/STE|Simplified Technical English/);

      const plain = await setup();
      const noBaseline = await mixedChain(plain, [specImpl(1), specImpl(2), TEST_WAVE(3)]);
      const plainItems = gateOf((await reviewPrompt(plain, noBaseline.chief.threadId, noBaseline.tester.id)).prompt);
      expect(plainItems).toHaveLength(6);
      expect(plainItems.join("\n")).not.toContain("(6)");
    });

    // ---- Plan admission and waivers: characterization on base c8a0d76 (tests first, before planLifecycle.ts) ----
    // Contract: for each case below, chief_delegate, chief_skip_tests and chief_skip_specs give the outcome saved in
    // __snapshots__/plan-admission-c8a0d76.txt: the refusal text, or the accepted kind plus the prompt the launched thread
    // received. The real handlers run; nothing is observed through a production seam; only the storage root is normalized.
    // Regression: a refactor of admission or the waiver predicates changes a refusal sentence or its order, a worker prompt
    // field, an idempotent repeat, or tightens a loose path (a terminal prior, a review after a worker fix on a test wave).
    // Plan chains (this branch) changed exactly these outcomes of the base snapshot, nothing else: wave 2 of a legacy plan, a second
    // worker on a started head, and a replaces: across chains now refuse with the chain sentences (a later wave continues its chain's
    // worker; the design-owner-approval refusal of a wave with no replaces is pre-empted by the same rule and still holds on replaces:);
    // the independent-wave brief line names the chain. Every other block is the base's bytes.
    // <plan-admission-oracle-begin>
    const admissionFixture = async () => {
      const blocks: string[] = [];
      const newestId = (state: State) => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
      const run = async (name: string, body: (k: any) => Promise<void>) => {
        const state = await setup();
        const lines: string[] = [];
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${text.replaceAll(state.storageRoot, "<storage>")}`);
        const newest = () => state.db.prepare(`SELECT * FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any;
        const k = {
          state,
          /** Chief plus a planner holding `waves`; approved unless it has at most one implementation wave. */
          mk: async (waves: object[], approve = waves.filter((entry: any) => !entry.test).length > 1) => {
            const chief = (await start(state)).threadId;
            const planner = (await plan(state, chief, waves)).threadId;
            if (approve) await approvePlan(state, chief, planner);
            return { chief, planner };
          },
          go: (c: any, n: number, extra: object = {}) => delegateWave(state, c.chief, c.planner, n, extra),
          /** Delegate (must be admitted), report ready, go idle: the new row's id. */
          done: async (c: any, n: number, extra: object = {}) => {
            await delegateWave(state, c.chief, c.planner, n, extra);
            const id = workerOn(state, c.planner, n).thread_id as string;
            await readyIdle(state, id);
            return id;
          },
          /** Delegate (must be admitted), then report blocked and go idle. */
          stuck: async (c: any, n: number, extra: object = {}) => {
            await delegateWave(state, c.chief, c.planner, n, extra);
            const id = workerOn(state, c.planner, n).thread_id as string;
            await report(state, id, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
            setLive(state, id, "idle");
            return id;
          },
          /** Unplanned delegation; `replaces` carries the plan or the lack of one. */
          free: (chief: string, extra: object = {}) =>
            tool(state, "chief_delegate", { title: "Free", mission: "Do it.", ...("replaces" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief),
          /** A chief_delegate attempt: the refusal text, or the accepted kind and the launched prompt. */
          delegating: async (label: string, call: () => Promise<unknown>) => {
            const before = state.spawned.length;
            const refusal = await call().then(() => null, (error: Error) => error.message);
            const launched = state.spawned.length - before;
            emit(label, refusal !== null
              ? `refused: ${refusal}${launched ? `\n(launched ${launched} thread(s) anyway)` : ""}`
              : `accepted ${newest().kind ?? "worker"}, launched ${launched}\n${state.spawned.at(-1).prompt}`);
          },
          /** Any other tool attempt: its reply or refusal, then the plan's waivers and worker rows. */
          acting: async (label: string, call: () => Promise<unknown>, planThreadId?: string) => {
            const out = await call().then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            const after = planThreadId === undefined ? "" : `\nwaivers: ${JSON.stringify(JSON.parse(planWaves(state, planThreadId)).map((entry: any) => ({ testsSkipped: entry.testsSkipped, specsSkipped: entry.specsSkipped })))}`
              + `\nworkers: ${JSON.stringify(state.db.prepare(`SELECT thread_id, plan_wave, kind, state FROM managed_threads WHERE role='worker' AND plan_thread_id=? ORDER BY rowid`).all(planThreadId))}`;
            emit(label, `${out}${after}`);
          },
          skipTests: (c: any, n: number) => tool(state, "chief_skip_tests", { planThreadId: c.planner, wave: n, reason: "oracle reason" }, c.chief),
          skipSpecs: (c: any, n: number) => tool(state, "chief_skip_specs", { planThreadId: c.planner, wave: n, reason: "oracle reason" }, c.chief),
          /** Rewrites the planner's stored waves as a plan from before test waves: no test fields. */
          strip: async (c: any, worker: string) => {
            const waves = JSON.parse(planWaves(state, c.planner)).map(({ test, ...rest }: any) => rest);
            state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(waves), c.planner);
            await report(state, worker, { state: "ready", result: `${READY} (re-reported)` });
          },
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };
      const P = (n: number, extra: object = {}) => planWave(n, extra);

      // 1. Legacy plans (no dependsOn: the previous wave is the parent) and independent heads (dependsOn: []).
      await run("legacy plan with no dependsOn", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3)]);
        const w1 = await k.done(c, 1);
        await k.delegating("wave 3 tester replaces wave 1's worker, not its parent", () => k.go(c, 3, { replaces: w1, kind: "tester" }));
        await k.delegating("wave 2 replaces wave 1's worker", () => k.go(c, 2, { replaces: w1 }));
        const w2 = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, w2);
        await k.delegating("wave 3 tester replaces wave 2's worker", () => k.go(c, 3, { replaces: w2 }));
      });
      await run("legacy plan, wave 2 with no replaces", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3)]);
        await k.done(c, 1);
        await k.delegating("wave 2 with no replaces", () => k.go(c, 2));
      });
      await run("independent heads", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])]);
        const w1 = await k.done(c, 1);
        await k.delegating("wave 3, an independent head, with no replaces", () => k.go(c, 3));
        const w3 = workerOn(k.state, c.planner, 3).thread_id;
        await readyIdle(k.state, w3);
        await k.delegating("wave 4 tester replaces wave 1's worker, not its parent", () => k.go(c, 4, { replaces: w1, kind: "tester" }));
        await k.delegating("wave 4 tester replaces wave 3's worker", () => k.go(c, 4, { replaces: w3 }));
        await k.delegating("wave 3 replaces wave 1's worker", () => k.go(c, 3, { replaces: w1 }));
      });

      // 2. Wave range, and an absent (waived) test wave.
      await run("wave range (0 and 9 fail the tool schema first) and an absent test wave", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.delegating("wave 5 of 2", () => k.go(c, 5));
        await k.delegating("wave omitted", () => k.go(c, undefined as any));
        const w1 = await k.done(c, 1);
        await k.acting("skip_tests on the undelegated wave 2", () => k.skipTests(c, 2), c.planner);
        await k.delegating("wave 2 waived before delegation", () => k.go(c, 2, { replaces: w1 }));
        await k.delegating("wave 2 waived before delegation, kind tester with a branch", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
      });

      // 3. explicitKind, and its order against the other faults.
      await run("explicitKind", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.delegating("prior tester, kind omitted", () => k.go(c, 2, { replaces: tester }));
        await k.delegating("prior tester, kind omitted, unknown planThreadId", () => k.go({ ...c, planner: "thr_unknown" }, 1, { replaces: tester }));
        await k.delegating("prior worker, kind omitted, unknown planThreadId", () => k.go({ ...c, planner: "thr_unknown" }, 1, { replaces: w1 }));
        const unreviewed = (await plan(k.state, c.chief, [P(1), P(2), TEST_WAVE(3)])).threadId;
        await k.delegating("prior tester, kind omitted, unreviewed planner", () => k.go({ ...c, planner: unreviewed }, 1, { replaces: tester }));
        await k.delegating("prior worker, kind worker, unreviewed planner", () => k.go({ ...c, planner: unreviewed }, 1, { replaces: w1, kind: "worker" }));
        await k.delegating("no prior, unreviewed planner, wave 5 of 3", () => k.go({ ...c, planner: unreviewed }, 5));
        const other = await start(k.state, "proj_2");
        await k.state.harness.behavior.runCli(["plan", "--title", "Foreign", "--mission", "Propose"], ctxOf(k.state, other.threadId));
        const foreign = (await status(k.state)).threads.filter((row) => row.role === "planner" && row.chiefThreadId === other.threadId).at(-1)!.threadId;
        await k.delegating("prior tester, kind omitted, another Chief's planner", () => k.go({ ...c, planner: foreign }, 1, { replaces: tester }));
        await k.delegating("prior worker, kind worker, another Chief's planner", () => k.go({ ...c, planner: foreign }, 1, { replaces: w1, kind: "worker" }));
        await k.delegating("prior tester, kind omitted, another Chief", () => tool(k.state, "chief_delegate", { title: "x", mission: "y", replaces: tester }, other.threadId));
      });
      await run("explicitKind on a Spec Writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.delegating("prior Spec Writer, kind omitted", () => k.go(c, 1, { replaces: writer }));
        await k.delegating("prior Spec Writer, kind omitted, unknown planThreadId", () => k.go({ ...c, planner: "thr_unknown" }, 1, { replaces: writer }));
      });

      // 4. Spec flow.
      await run("spec flow: first delegation (c)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.delegating("kind worker", () => k.go(c, 1, { kind: "worker" }));
        await k.delegating("kind designer", () => k.go(c, 1, { kind: "designer" }));
        await k.delegating("kind tester", () => k.go(c, 1, { kind: "tester" }));
        await k.delegating("kind tester with a branch", () => k.go(c, 1, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("wave 2 before the writer", () => k.go(c, 2));
        await k.delegating("kind omitted", () => k.go(c, 1));
      });
      await run("spec flow: first delegation with kind spec-writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.delegating("kind spec-writer", () => k.go(c, 1, { kind: "spec-writer" }));
      });
      await run("spec flow: the writer is ready (a2)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.delegating("no replaces", () => k.go(c, 1));
        await k.delegating("replaces the writer, kind tester", () => k.go(c, 2, { replaces: writer, kind: "tester" }));
        await k.delegating("replaces the writer, kind omitted on wave 1", () => k.go(c, 1, { replaces: writer }));
        await k.delegating("kind designer", () => k.go(c, 1, { replaces: writer, kind: "designer" }));
        await k.delegating("repair: kind spec-writer", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
        await k.delegating("hand-off: kind worker", () => k.go(c, 1, { replaces: writer, kind: "worker" }));
      });
      await run("spec flow: the writer is blocked (a2, a)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.stuck(c, 1);
        await k.delegating("kind worker", () => k.go(c, 1, { replaces: writer, kind: "worker" }));
        await k.delegating("kind designer", () => k.go(c, 1, { replaces: writer, kind: "designer" }));
        await k.delegating("no replaces", () => k.go(c, 1));
        await k.delegating("wave 2 tester replaces the blocked writer", () => k.go(c, 2, { replaces: writer, kind: "tester" }));
        await k.delegating("repair: kind spec-writer", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
      });
      await run("spec flow: a fresh plan takes over a blocked Spec Writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.stuck(c, 1);
        const fresh = (await plan(k.state, c.chief, [specImpl(1), TEST_WAVE(2)])).threadId;
        const next = { ...c, planner: fresh };
        await k.delegating("fresh wave 1, kind worker", () => k.go(next, 1, { replaces: writer, kind: "worker" }));
        await k.delegating("fresh wave 2, kind tester", () => k.go(next, 2, { replaces: writer, kind: "tester" }));
        await k.delegating("fresh wave 1, kind spec-writer", () => k.go(next, 1, { replaces: writer, kind: "spec-writer" }));
      });
      await run("spec flow: a fresh plan and a ready Spec Writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        const fresh = (await plan(k.state, c.chief, [specImpl(1), TEST_WAVE(2)])).threadId;
        await k.delegating("fresh wave 1, kind spec-writer", () => k.go({ ...c, planner: fresh }, 1, { replaces: writer, kind: "spec-writer" }));
      });
      await run("spec flow: a fresh plan and a worker that is not the latest writer", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const fresh = (await plan(k.state, c.chief, [specImpl(1), TEST_WAVE(2)])).threadId;
        await k.delegating("fresh wave 1, replaces a plain worker, kind spec-writer", () => k.go({ ...c, planner: fresh }, 1, { replaces: w1, kind: "spec-writer" }));
        await k.delegating("fresh wave 1, replaces a plain worker, kind worker", () => k.go({ ...c, planner: fresh }, 1, { replaces: w1, kind: "worker" }));
      });
      await run("spec flow: an owed ancestor (b)", async (k) => {
        const c = await k.mk([specImpl(1), P(2), TEST_WAVE(3)]);
        const writer = await k.done(c, 1);
        await k.delegating("wave 2 with no replaces", () => k.go(c, 2));
        await k.delegating("wave 2 replaces the writer", () => k.go(c, 2, { replaces: writer }));
        await k.delegating("wave 3 tester with no replaces", () => k.go(c, 3, { kind: "tester" }));
        await k.delegating("wave 3 tester with a branch", () => k.go(c, 3, { kind: "tester", branch: "tests/after-merge" }));
        const worker = await k.done(c, 1, { replaces: writer, kind: "worker" });
        await k.delegating("wave 2 after the writer's worker", () => k.go(c, 2, { replaces: worker }));
      });
      await run("spec flow: an owed ancestor on a legacy chain", async (k) => {
        const c = await k.mk([specImpl(1), P(2), P(3), TEST_WAVE(4)]);
        const writer = await k.done(c, 1);
        await k.delegating("wave 3, two waves below the owed wave", () => k.go(c, 3));
      });
      await run("spec flow: initial and repair (d)", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.delegating("kind spec-writer, no spec chain", () => k.go(c, 1, { replaces: w1, kind: "spec-writer" }));
        await k.delegating("kind spec-writer on a test wave with no spec chain", () => k.go(c, 2, { replaces: w1, kind: "spec-writer" }));
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.delegating("kind spec-writer replacing a tester, no spec chain", () => k.go(c, 2, { replaces: tester, kind: "spec-writer" }));
      });
      await run("spec flow: repair of a spec chain", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        const worker = await k.done(c, 1, { replaces: writer, kind: "worker" });
        const tester = await k.done(c, 2, { replaces: worker, kind: "tester" });
        await k.delegating("kind spec-writer on wave 1 replaces the superseded writer", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
        await k.delegating("kind spec-writer on wave 2 replaces the wave 1 worker", () => k.go(c, 2, { replaces: worker, kind: "spec-writer" }));
        await k.delegating("kind spec-writer on wave 2 with no replaces", () => k.go(c, 2, { kind: "spec-writer" }));
        await k.delegating("kind spec-writer on wave 1 replaces the tester", () => k.go(c, 1, { replaces: tester, kind: "spec-writer" }));
        await k.delegating("test wave repair: kind spec-writer replaces the tester", () => k.go(c, 2, { replaces: tester, kind: "spec-writer" }));
      });
      await run("spec flow: repair of a spec chain's worker", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        const worker = await k.done(c, 1, { replaces: writer, kind: "worker" });
        await k.delegating("repair: kind spec-writer replaces the worker", () => k.go(c, 1, { replaces: worker, kind: "spec-writer" }));
      });
      await run("spec flow: the spec chain's briefs (specDocs, specSources)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.delegating("worker after the writer", () => k.go(c, 1, { replaces: writer, kind: "worker" }));
        const worker = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, worker);
        await k.delegating("tester on the spec chain", () => k.go(c, 2, { replaces: worker }));
        const tester = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, tester);
        await k.delegating("Spec Writer repair on the test wave", () => k.go(c, 2, { replaces: tester, kind: "spec-writer" }));
        await k.delegating("worker fix on the test wave of a spec chain", () => k.go(c, 2, { replaces: tester, kind: "worker" }));
      });
      await run("spec flow: specsSkipped", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.acting("skip_specs wave 1", () => k.skipSpecs(c, 1), c.planner);
        await k.delegating("kind spec-writer on a bypassed wave", () => k.go(c, 1, { kind: "spec-writer" }));
        await k.delegating("kind omitted on a bypassed wave", () => k.go(c, 1));
        const w1 = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, w1);
        await k.delegating("tester after a bypassed wave", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("spec flow: baseline flags", async (k) => {
        const c = await k.mk([baseImpl(1), TEST_WAVE(2)]);
        await k.delegating("Spec Writer on a baseline wave", () => k.go(c, 1));
        const writer = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, writer);
        await k.delegating("Spec Writer repair on a baseline wave", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
        const repair = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, repair);
        await k.delegating("worker on a baseline wave", () => k.go(c, 1, { replaces: repair, kind: "worker" }));
        const worker = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, worker);
        await k.delegating("tester walking a baseline ancestor", () => k.go(c, 2, { replaces: worker }));
      });
      await run("spec flow: a mixed chain", async (k) => {
        const c = await k.mk([specImpl(1), baseImpl(2), TEST_WAVE(3)]);
        const writer1 = await k.done(c, 1);
        const worker1 = await k.done(c, 1, { replaces: writer1, kind: "worker" });
        const writer2 = await k.done(c, 2, { replaces: worker1 });
        const worker2 = await k.done(c, 2, { replaces: writer2, kind: "worker" });
        await k.delegating("tester on a mixed spec chain", () => k.go(c, 3, { replaces: worker2 }));
      });
      await run("spec flow: a Spec Writer on a non-spec wave behind an owed wave", async (k) => {
        const c = await k.mk([specImpl(1), P(2), TEST_WAVE(3)]);
        const writer = await k.done(c, 1);
        await k.delegating("wave 2's Spec Writer on a wave that is not spec", () => k.go(c, 2, { kind: "spec-writer" }));
      });

      // 5. Test waves.
      await run("test wave: hand-off from the parent worker", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const lone = (await delegate(k.state, c.chief, "Lone")).threadId;
        await readyIdle(k.state, lone);
        await k.delegating("no replaces", () => k.go(c, 2));
        await k.delegating("kind tester with no replaces", () => k.go(c, 2, { kind: "tester" }));
        await k.delegating("kind tester, a branch, the tested worker not complete", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("replaces an unrelated worker", () => k.go(c, 2, { replaces: lone, kind: "tester" }));
        await k.delegating("kind worker", () => k.go(c, 2, { replaces: w1, kind: "worker" }));
        await k.delegating("kind designer", () => k.go(c, 2, { replaces: w1, kind: "designer" }));
        await k.delegating("kind omitted", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("test wave: kind tester explicit", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.delegating("kind tester", () => k.go(c, 2, { replaces: w1, kind: "tester" }));
      });
      await run("test wave: a worker fix on the same wave", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.delegating("kind omitted", () => k.go(c, 2, { replaces: tester }));
        await k.delegating("kind designer", () => k.go(c, 2, { replaces: tester, kind: "designer" }));
        await k.delegating("kind tester again", () => k.go(c, 2, { replaces: tester, kind: "tester" }));
        await k.delegating("kind worker", () => k.go(c, 2, { replaces: tester, kind: "worker" }));
        const fix = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, fix);
        await k.delegating("kind omitted after the worker fix", () => k.go(c, 2, { replaces: fix }));
        await k.delegating("kind tester after the worker fix", () => k.go(c, 2, { replaces: fix, kind: "tester" }));
      });
      await run("test wave: afterMerge", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await tool(k.state, "chief_complete", { threadId: w1, skipReview: "merged" }, c.chief);
        await k.delegating("no branch", () => k.go(c, 2, { kind: "tester" }));
        await k.delegating("kind omitted with a branch", () => k.go(c, 2, { branch: "tests/after-merge" }));
        await k.delegating("kind worker with a branch", () => k.go(c, 2, { branch: "tests/after-merge", kind: "worker" }));
        await k.delegating("kind tester with a branch", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
      });
      await run("test wave: a tester on a non-test wave", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3)]);
        const w1 = await k.done(c, 1);
        await k.delegating("wave 2 tester replaces wave 1's worker", () => k.go(c, 2, { replaces: w1, kind: "tester" }));
        await k.delegating("wave 1 tester with no replaces", () => k.go(c, 1, { kind: "tester" }));
      });
      await run("test wave: a tester on a plan with no test wave", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.strip(c, w1);
        await k.delegating("no replaces", () => k.go(c, 2, { kind: "tester" }));
        await k.delegating("a branch and no replaces, the tested worker not complete", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("replaces the worker", () => k.go(c, 2, { replaces: w1, kind: "tester" }));
      });
      await run("test wave: a tester on a plan with no test wave, the worker complete", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.strip(c, w1);
        await tool(k.state, "chief_complete", { threadId: w1, skipReview: "merged" }, c.chief);
        await k.delegating("a branch and no replaces", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("a completed prior replaced by a worker on wave 2", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("test wave: a legacy plan's wave 2 is an ordinary worker", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.strip(c, w1);
        await k.delegating("wave 2 with no kind", () => k.go(c, 2));
        await k.delegating("wave 2 replaces wave 1's worker", () => k.go(c, 2, { replaces: w1 }));
      });

      // 6. Design waves.
      await run("design wave", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.delegating("wave 2 before any designer", () => k.go(c, 2));
        await k.delegating("wave 1, kind omitted", () => k.go(c, 1));
        const designer = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, designer, `${READY}\nArtboards: Checkout`);
        await k.delegating("wave 2 before the owner approves", () => k.go(c, 2, { replaces: designer }));
        await k.delegating("wave 2 with no replaces before the owner approves", () => k.go(c, 2));
        await k.delegating("kind spec-writer on a design wave", () => k.go(c, 1, { replaces: designer, kind: "spec-writer" }));
        await k.delegating("kind tester on a design wave", () => k.go(c, 1, { replaces: designer, kind: "tester" }));
        await tool(k.state, "chief_owner_approval", { workerThreadId: designer, approval: "Looks right, ship it" }, c.chief);
        await k.delegating("wave 2 after approval, replaces the designer", () => k.go(c, 2, { replaces: designer }));
        const w2 = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, w2);
        await k.delegating("tester on a design chain", () => k.go(c, 3, { replaces: w2 }));
      });
      await run("design wave: kind worker and kind designer named", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.delegating("wave 1, kind worker", () => k.go(c, 1, { kind: "worker" }));
        await k.delegating("wave 1, kind designer", () => k.go(c, 1, { kind: "designer" }));
      });
      await run("design wave: wave 2 with no approval after a repeat designer", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.go(c, 1);
        const first = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, first, `${READY}\nArtboards: Checkout`);
        await tool(k.state, "chief_owner_approval", { workerThreadId: first, approval: "Looks right" }, c.chief);
        await k.go(c, 1, { replaces: first });
        const second = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, second, `${READY}\nArtboards: Checkout v2`);
        await k.delegating("wave 2 replaces the unapproved repeat designer", () => k.go(c, 2, { replaces: second }));
        await k.delegating("wave 2 with no replaces, the latest designer unapproved", () => k.go(c, 2));
      });

      // 7. Unplanned work.
      await run("unplanned: Spec Writer hand-off", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.delegating("first delegation: kind spec-writer", () => k.free(chief, { kind: "spec-writer" }));
        const writer = newestId(k.state);
        await readyIdle(k.state, writer);
        await k.delegating("kind omitted", () => k.free(chief, { replaces: writer }));
        await k.delegating("kind tester", () => k.free(chief, { replaces: writer, kind: "tester" }));
        await k.delegating("kind designer", () => k.free(chief, { replaces: writer, kind: "designer" }));
        await k.delegating("kind spec-writer", () => k.free(chief, { replaces: writer, kind: "spec-writer" }));
        await k.delegating("kind worker", () => k.free(chief, { replaces: writer, kind: "worker" }));
      });
      await run("unplanned: Spec Writer not ready", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.free(chief, { kind: "spec-writer" });
        const writer = newestId(k.state);
        await report(k.state, writer, { state: "blocked", result: "Docs unclear", blocker: "Spec delta unclear", recommendation: "Retry" });
        setLive(k.state, writer, "idle");
        await k.delegating("kind worker", () => k.free(chief, { replaces: writer, kind: "worker" }));
        await k.delegating("kind designer", () => k.free(chief, { replaces: writer, kind: "designer" }));
        await k.delegating("kind tester", () => k.free(chief, { replaces: writer, kind: "tester" }));
        await k.delegating("kind spec-writer", () => k.free(chief, { replaces: writer, kind: "spec-writer" }));
      });
      await run("unplanned: tester and the task chain", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.delegating("tester with no prior", () => k.free(chief, { kind: "tester" }));
        await k.free(chief, { title: "Totals", mission: "Fix the totals.", criteria: "Totals never go negative" });
        const worker = newestId(k.state);
        await readyIdle(k.state, worker);
        await k.delegating("tester on the worker", () => k.free(chief, { replaces: worker, kind: "tester" }));
        const tester = newestId(k.state);
        await readyIdle(k.state, tester);
        await k.delegating("Spec Writer on the tester's task chain", () => k.free(chief, { replaces: tester, kind: "spec-writer" }));
        const writer = newestId(k.state);
        await readyIdle(k.state, writer);
        await k.delegating("worker after the chain's Spec Writer", () => k.free(chief, { replaces: writer, kind: "worker" }));
        const fix = newestId(k.state);
        await readyIdle(k.state, fix);
        await k.delegating("tester over a chain with a Spec Writer", () => k.free(chief, { replaces: fix, kind: "tester" }));
      });
      await run("unplanned: a plain worker replaced", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.free(chief, { title: "Totals", mission: "Fix the totals." });
        const worker = newestId(k.state);
        await readyIdle(k.state, worker);
        await k.delegating("kind omitted", () => k.free(chief, { replaces: worker }));
      });
      await run("unplanned: designer", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.delegating("kind designer", () => k.free(chief, { kind: "designer" }));
      });

      // 8. Waivers.
      await run("skip_tests: refusals before delegation", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.acting("wave 1 is not a test wave", () => k.skipTests(c, 1), c.planner);
        await k.acting("wave 5 is out of range", () => k.skipTests(c, 5), c.planner);
        const unreviewed = (await plan(k.state, c.chief, [P(1), P(2), TEST_WAVE(3)])).threadId;
        await k.acting("an unreviewed plan, wave 1 is not a test wave", () => k.skipTests({ ...c, planner: unreviewed }, 1), unreviewed);
        await k.acting("an unreviewed plan, a test wave", () => k.skipTests({ ...c, planner: unreviewed }, 3), unreviewed);
        const other = await start(k.state, "proj_2");
        await k.acting("another Chief's plan", () => tool(k.state, "chief_skip_tests", { planThreadId: c.planner, wave: 2, reason: "oracle reason" }, other.threadId), c.planner);
      });
      await run("skip_tests: before delegation, the parent not ready", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.go(c, 1);
        await k.acting("waive", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: before delegation, the parent ready", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.done(c, 1);
        await k.acting("waive", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat with another reason", () => tool(k.state, "chief_skip_tests", { planThreadId: c.planner, wave: 2, reason: "another reason" }, c.chief), c.planner);
      });
      await run("skip_tests: before delegation, no worker on the parent", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.acting("waive", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: before delegation on a legacy chain and an independent head", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3), P(4, { dependsOn: [] }), TEST_WAVE(5, [4])]);
        await k.done(c, 1);
        await k.acting("waive wave 3, parent wave 2 undelegated", () => k.skipTests(c, 3), c.planner);
        await k.acting("waive wave 5, parent wave 4 undelegated", () => k.skipTests(c, 5), c.planner);
      });
      await run("skip_tests: a busy and a complete latest worker", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.go(c, 2, { replaces: w1 });
        const tester = workerOn(k.state, c.planner, 2).thread_id;
        setLive(k.state, tester, "active");
        await k.acting("the tester is active", () => k.skipTests(c, 2), c.planner);
        await report(k.state, tester, { state: "ready", result: READY });
        setLive(k.state, tester, "idle");
        await k.acting("the tester is idle after a ready report", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat", () => k.skipTests(c, 2), c.planner);
        await tool(k.state, "chief_complete", { threadId: tester, skipReview: "reviewed elsewhere" }, c.chief);
        await k.acting("the tester is complete", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: a complete worker after a waiver, and a busy repeat", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.acting("waive after a tester ran", () => k.skipTests(c, 2), c.planner);
        setLive(k.state, tester, "active");
        await k.acting("repeat while the tester is active", () => k.skipTests(c, 2), c.planner);
        setLive(k.state, tester, "idle");
        await tool(k.state, "chief_complete", { threadId: tester, skipReview: "waived" }, c.chief);
        await k.acting("repeat after the tester completed", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: a blocked tester", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.stuck(c, 2, { replaces: w1 });
        await k.acting("waive after a blocked tester", () => k.skipTests(c, 2), c.planner);
        await k.delegating("kind worker after the waiver on the same wave", () => k.go(c, 2, { replaces: workerOn(k.state, c.planner, 2).thread_id, kind: "worker" }));
      });
      await run("skip_specs: refusals", async (k) => {
        const c = await k.mk([specImpl(1), P(2), TEST_WAVE(3)]);
        await k.acting("wave 2 is not a spec wave", () => k.skipSpecs(c, 2), c.planner);
        await k.acting("wave 3 is a test wave", () => k.skipSpecs(c, 3), c.planner);
        await k.acting("wave 5 is out of range", () => k.skipSpecs(c, 5), c.planner);
        const unreviewed = (await plan(k.state, c.chief, [specImpl(1), P(2), TEST_WAVE(3)])).threadId;
        await k.acting("an unreviewed plan, a spec wave", () => k.skipSpecs({ ...c, planner: unreviewed }, 1), unreviewed);
        await k.acting("an unreviewed plan, wave 2 is not a spec wave", () => k.skipSpecs({ ...c, planner: unreviewed }, 2), unreviewed);
        await k.go(c, 1);
        await k.acting("wave 1 already has its Spec Writer", () => k.skipSpecs(c, 1), c.planner);
      });
      await run("skip_specs: a design wave", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.acting("wave 1 is a design wave", () => k.skipSpecs(c, 1), c.planner);
      });
      await run("skip_specs: idempotent repeats", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.acting("waive", () => k.skipSpecs(c, 1), c.planner);
        await k.acting("repeat, no worker yet", () => k.skipSpecs(c, 1), c.planner);
        await k.go(c, 1);
        await k.acting("repeat, the worker delegated", () => k.skipSpecs(c, 1), c.planner);
      });
      await run("skip_specs: a spec wave with a parent", async (k) => {
        const c = await k.mk([P(1), specImpl(2), TEST_WAVE(3)]);
        await k.acting("waive before wave 1 has a worker", () => k.skipSpecs(c, 2), c.planner);
        await k.done(c, 1);
        await k.acting("repeat with wave 1's worker", () => k.skipSpecs(c, 2), c.planner);
      });
      await run("skip_specs: an independent spec head", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), specImpl(3, { dependsOn: [] }), TEST_WAVE(4, [3])]);
        await k.acting("waive an independent head", () => k.skipSpecs(c, 3), c.planner);
      });
      await run("skip_specs: after the writer's worker", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.done(c, 1, { replaces: writer, kind: "worker" });
        await k.acting("the wave already has workers", () => k.skipSpecs(c, 1), c.planner);
      });

      // 9. Loose paths: accepted today, they stay accepted.
      await run("loose: a completed prior is replaced by a tester after skipReview", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.acting("complete with skipReview", () => tool(k.state, "chief_complete", { threadId: w1, skipReview: "small change" }, c.chief), c.planner);
        await k.delegating("tester replaces the completed worker", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("loose: a review starts after a worker fix on a test wave without a rerun", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        const fix = await k.done(c, 2, { replaces: tester, kind: "worker" });
        await k.acting("review the worker fix", () => tool(k.state, "chief_review", { workerThreadId: fix }, c.chief), c.planner);
      });
      return blocks.join("\n");
    };
    // <plan-admission-oracle-end>

    test("plan admission oracle", async () => {
      const head = await admissionFixture();
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "plan-admission-c8a0d76.txt"), "utf8");
      expect(head).toBe(oracle);
    });

    // ---- Review decisions: characterization on base 4b5ad00 (tests first, before reviewLedger takes the decisions) ----
    // Contract: for each case below, chief_delegate (replaces:), the advisor's and reviewer's alerts, chief_complete,
    // chief_complete with skipReview and chief_review give the outcome saved in __snapshots__/review-decisions-4b5ad00.txt:
    // the refusal text, or the reply, or the alert Chief received. The real handlers run; nothing is observed through a
    // production seam; the storage root is normalized, and the forge is execFileMock (gh pr view / gh pr ready).
    // Timestamps that the consult gate compares are set in SQL, so no case depends on the clock.
    // Regression: moving the replace, in-flight and head-approved decisions changes a refusal sentence or the order of the
    // checks, a rung line, a forge call count, a cleanup line, or which review chief_review reuses.
    // <review-decisions-oracle-begin>
    const reviewDecisionsFixture = async () => {
      const blocks: string[] = [];
      const PR = "https://github.com/acme/shop/pull/8";
      const NO_TESTER = { testsSkipped: "oracle: no tester" };
      const run = async (name: string, body: (k: any) => Promise<void>) => {
        const state = await setup();
        await state.harness.behavior.setSettings({ cleanupApproved: true });
        const lines: string[] = [];
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${text.replaceAll(state.storageRoot, "<storage>")}`);
        const forge = { sha: HEAD_SHA, unreadable: false };
        execFileMock.mockReset();
        execFileMock.mockImplementation(async (file: string, args: string[]) => {
          if (file === "gh" && args[0] === "pr" && args[1] === "view") {
            if (forge.unreadable) throw new Error("gh: forge unreachable");
            return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: forge.sha, baseRefName: "main" }), stderr: "" };
          }
          if (file === "gh" && args[0] === "pr" && args[1] === "ready") return { stdout: "", stderr: "" };
          throw new Error(`unexpected CLI ${file}`);
        });
        const prViews = () => execFileMock.mock.calls.filter(([file, args]) => file === "gh" && args[0] === "pr" && args[1] === "view").length;
        const newestWorker = () => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const k = {
          state, forge, emit,
          chief: async () => (await start(state)).threadId,
          /** Chief plus a planner holding `waves`, approved when it has more than one implementation wave; test waves in `waived` are skipped. */
          mk: async (waves: object[], waived: number[] = []) => {
            const chief = (await start(state)).threadId;
            const planner = (await plan(state, chief, waves)).threadId;
            if (waves.filter((entry: any) => !entry.test).length > 1) await approvePlan(state, chief, planner);
            for (const wave of waived) await tool(state, "chief_skip_tests", { planThreadId: planner, wave, reason: "oracle reason" }, chief);
            return { chief, planner };
          },
          /** Delegates a worker (unplanned unless `extra` carries a plan or replaces), reports ready, goes idle: its id. */
          worker: async (chief: string, extra: object = {}) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra || "planThreadId" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief);
            const id = newestWorker();
            await readyIdle(state, id);
            return id;
          },
          /** Delegates a plan wave, reports ready, goes idle: its id. */
          wave: (c: any, wave: number, extra: object = {}) => k.worker(c.chief, { planThreadId: c.planner, wave, ...extra }),
          /** A plan wave as the server stored one before chains shared a branch: a worker of its own on its own branch, which chief_delegate no longer builds (see legacyWave). */
          legacyWave: async (c: any, wave: number, branch: string) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded oracle fixture", branch }, c.chief);
            const id = newestWorker();
            state.db.prepare("UPDATE managed_threads SET plan_thread_id=?, plan_wave=?, unplanned_reason=NULL WHERE thread_id=?").run(c.planner, wave, id);
            await readyIdle(state, id);
            return id;
          },
          replace: (chief: string, id: string, extra: object = {}) => tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: id, ...extra }, chief),
          /** Runs a call: its reply or its refusal, and how many threads it launched. */
          attempt: async (label: string, call: () => Promise<unknown>) => {
            const before = state.spawned.length;
            const out = await call().then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            emit(label, `${out}\nlaunched: ${state.spawned.length - before}`);
          },
          /** A consult on the worker; its advisor reports `advice` (ready) or only a status (active). */
          consult: async (chief: string, id: string, how: "advice" | "status" = "advice") => {
            await tool(state, "chief_consult", { title: "Advice", mission: "Diagnose", workerThreadId: id }, chief);
            const advisor = (await status(state)).threads.filter((row) => row.role === "advisor" && row.workerThreadId === id).at(-1)!.threadId;
            await report(state, advisor, how === "advice" ? { state: "ready", result: "Try X" } : { state: "active", summary: "Still reading" });
            return advisor;
          },
          /** Pins the times the consult gate compares, as offsets from the prior worker's creation (the server reads that from its row cache, which a SQL edit would not reach). */
          stamp: (prior: string, times: { verdicts: number; advisor: [string, number] }) => {
            const created = (state.db.prepare(`SELECT created_at FROM managed_threads WHERE thread_id=?`).get(prior) as { created_at: number }).created_at;
            state.db.prepare(`UPDATE reviewer_verdicts SET at=?`).run(created + times.verdicts);
            state.db.prepare(`UPDATE managed_threads SET created_at=? WHERE thread_id=?`).run(created + times.advisor[1], times.advisor[0]);
          },
          /** Reviews and rejects `n` times, handing each rejected worker to a fresh one (a consult first from the second): the last worker, ready and idle, and the last alert. */
          rejected: async (chief: string, n: number, first?: string, next: object = {}) => {
            let id = first ?? await k.worker(chief);
            let alert = "";
            for (let round = 1; round <= n; round++) {
              alert = await reviewed(state, chief, id, "request_changes");
              if (round === n) break;
              if (round >= 2) await k.consult(chief, id);
              id = await k.worker(chief, { replaces: id, ...next });
            }
            return { id, alert };
          },
          /** The same rounds over several ready workers reviewed together (the first id is reviewed); each alert is emitted. `fix` hands every worker to a fresh one. */
          rounds: async (label: string, chief: string, ids: string[], n: number, fix: (ids: string[]) => Promise<string[]>) => {
            let current = ids;
            for (let round = 1; round <= n; round++) {
              emit(`${label}: streak ${round}`, await reviewed(state, chief, current[0]!, "request_changes"));
              if (round === n) break;
              if (round >= 2) await k.consult(chief, current[0]!);
              current = await fix(current);
            }
            return current;
          },
          /** A chief_complete attempt: its reply or refusal, the worker's state after it, and the gh pr view calls it made. */
          completing: async (label: string, chief: string, id: string, extra: object = {}) => {
            const before = prViews();
            const out = await tool(state, "chief_complete", { threadId: id, ...extra }, chief).then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            emit(label, `${out}\nstate: ${rowOf(state, id).state}\ngh pr view calls: ${prViews() - before}`);
          },
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };
      const P = (n: number, extra: object = {}) => planWave(n, extra);
      /** Two independent branches (waves 1 and 3), tests waived: one plan review covers both. */
      const branches = (k: any) => k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [2, 4]);
      /** One worker per branch, each on its own task branch (a plan review needs a head or a branch for every target). */
      const startBranches = async (k: any, c: any) => [await k.wave(c, 1, { branch: "feature/a" }), await k.wave(c, 3, { branch: "feature/b" })];
      /** Replaces every branch worker with a fresh one of the same wave. */
      const fixBranches = (k: any, c: any) => async ([a, b]: string[]) => [await k.wave(c, 1, { replaces: a }), await k.wave(c, 3, { replaces: b })];
      /** Two stacked waves (2 builds on 1), tests waived: one review covers both, reviewed from the tip. */
      const stack = (k: any) => k.mk([P(1), P(2), TEST_WAVE(3)], [3]);
      const stacked = async (k: any, c: any) => { const base = await k.wave(c, 1, { branch: "feature/a" }); return [await k.legacyWave(c, 2, "feature/b"), base]; };
      const fixStack = (k: any, c: any) => async ([tip, base]: string[]) => { const fresh = await k.wave(c, 1, { replaces: base }); return [await k.wave(c, 2, { replaces: tip }), fresh]; };

      // 1. Replacement: the ladder.
      for (const streak of [0, 1]) {
        await run(`replacement at streak ${streak}`, async (k) => {
          const chief = await k.chief();
          const { id } = streak ? await k.rejected(chief, streak) : { id: await k.worker(chief) };
          await k.attempt(`replace at streak ${streak}`, () => k.replace(chief, id));
        });
      }
      await run("replacement at streak 2 with no consult", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult after the latest rejection", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        const advisor = await k.consult(chief, id);
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, 2_000] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult before the latest rejection", async (k) => {
        const chief = await k.chief();
        const first = await k.worker(chief);
        await reviewed(k.state, chief, first, "request_changes");
        const advisor = await k.consult(chief, first);
        const { id } = await k.rejected(chief, 1, await k.worker(chief, { replaces: first }));
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, 500] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: status-only consult", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        const advisor = await k.consult(chief, id, "status");
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, 2_000] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult created before the prior worker", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        const advisor = await k.consult(chief, id);
        k.stamp(id, { verdicts: -2_000, advisor: [advisor, -1_000] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult on another branch of the same plan review", async (k) => {
        const c = await branches(k);
        const [a, b] = await k.rounds("rounds", c.chief, await startBranches(k, c), 2, fixBranches(k, c));
        const advisor = await k.consult(c.chief, b);
        k.stamp(a, { verdicts: 1_000, advisor: [advisor, 2_000] });
        await k.attempt("replace branch 1's worker on the consult of branch 3's worker", () => k.replace(c.chief, a));
      });
      await run("replacement at streak 3", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 3);
        await k.attempt("replace without userApprovedRound", () => k.replace(chief, id));
        await k.attempt("replace with userApprovedRound: false", () => k.replace(chief, id, { userApprovedRound: false }));
      });
      await run("replacement at streak 3 with userApprovedRound, no consult after the rejection", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 3);
        const advisor = (await status(k.state)).threads.filter((row) => row.role === "advisor").at(-1)!.threadId;
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, -5_000] });
        await k.attempt("replace with userApprovedRound", () => k.replace(chief, id, { userApprovedRound: true }));
      });
      await run("replacement: an approve between rejections resets the streak", async (k) => {
        const chief = await k.chief();
        const first = await k.worker(chief);
        await reviewed(k.state, chief, first, "request_changes");
        const second = await k.worker(chief, { replaces: first });
        await reviewed(k.state, chief, second, "approve");
        const { id } = await k.rejected(chief, 2, await k.worker(chief, { replaces: second }));
        await k.attempt("replace after reject, approve, reject, reject", () => k.replace(chief, id));
      });

      // 2. Order at the stop rung (and the consult rung): the ladder against the other refusals.
      await run("order: stop rung, prior busy", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 3);
        setLive(k.state, id, "active");
        await k.attempt("replace a busy prior at the stop rung", () => k.replace(chief, id));
      });
      await run("order: consult rung, prior busy", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        setLive(k.state, id, "active");
        await k.attempt("replace a busy prior at the consult rung", () => k.replace(chief, id));
      });
      await run("order: stop rung, tester prior with no kind", async (k) => {
        const chief = await k.chief();
        const tester = await k.worker(chief, { replaces: await k.worker(chief), kind: "tester" });
        const { id } = await k.rejected(chief, 3, tester, { kind: "tester" });
        await k.attempt("replace a tester without kind at the stop rung", () => k.replace(chief, id));
        await k.attempt("replace a tester without kind at the stop rung, user approved", () => k.replace(chief, id, { userApprovedRound: true }));
      });
      await run("order: stop rung, planner refusal", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)], [2]);
        const { id } = await k.rejected(c.chief, 3, await k.wave(c, 1), { planThreadId: c.planner, wave: 1 });
        await k.attempt("replace on a wave out of range at the stop rung", () => k.replace(c.chief, id, { planThreadId: c.planner, wave: 5 }));
        await k.attempt("replace on a wave out of range at the stop rung, user approved", () => k.replace(c.chief, id, { planThreadId: c.planner, wave: 5, userApprovedRound: true }));
      });

      // 3. nextAction: the advisor line.
      for (const streak of [1, 2, 3]) {
        await run(`advisor line at streak ${streak}`, async (k) => {
          const chief = await k.chief();
          const { id } = await k.rejected(chief, streak);
          await k.consult(chief, id);
          k.emit(`the advisor's alert at streak ${streak}`, k.state.sent.at(-1).input[0].text);
        });
      }

      // 4. nextAction: the reviewer's fix, consult and stop lines.
      await run("reviewer lines: plain", async (k) => {
        const chief = await k.chief();
        await k.rounds("plain", chief, [await k.worker(chief)], 3, async ([id]: string[]) => [await k.worker(chief, { replaces: id })]);
      });
      await run("reviewer lines: a plan", async (k) => {
        const c = await branches(k);
        await k.rounds("plan", c.chief, await startBranches(k, c), 3, fixBranches(k, c));
      });
      await run("reviewer lines: stacks", async (k) => {
        const c = await stack(k);
        await k.rounds("stacks", c.chief, await stacked(k, c), 3, fixStack(k, c));
      });

      // 5. chief_complete: what covers the worker.
      await run("complete: no verdict", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await k.completing("no review", chief, id, NO_TESTER);
      });
      await run("complete: request_changes", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewed(k.state, chief, id, "request_changes");
        await k.completing("newest review is request_changes", chief, id, NO_TESTER);
      });
      await run("complete: an approve whose head matches the PR head", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewed(k.state, chief, id, "approve");
        await k.completing("approve at the PR head", chief, id, NO_TESTER);
      });
      await run("complete: an approve whose head does not match", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewed(k.state, chief, id, "approve");
        k.forge.sha = "b".repeat(40);
        await k.completing("approve, the PR moved on", chief, id, NO_TESTER);
      });
      await run("complete: an uppercase recorded head_sha", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewed(k.state, chief, id, "approve");
        k.state.db.prepare(`UPDATE reviewer_verdicts SET head_sha=upper(head_sha)`).run();
        await k.completing("approve recorded in uppercase", chief, id, NO_TESTER);
      });
      await run("complete: an unreadable PR head", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewed(k.state, chief, id, "approve");
        k.forge.unreadable = true;
        await k.completing("approve, gh fails", chief, id, NO_TESTER);
      });
      await run("complete: an approve with no PR", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewed(k.state, chief, id, "approve");
        await k.completing("approve, report unchanged", chief, id, NO_TESTER);
      });
      await run("complete: an approve with no PR, the report moved on", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewed(k.state, chief, id, "approve");
        await readyIdle(k.state, id, "Done again");
        await k.completing("approve, newer report", chief, id, NO_TESTER);
      });
      for (const [label, extra] of [["no PR", {}], ["a PR", { prUrl: PR }]] as const) {
        await run(`complete: the newest approve was recorded on an older chain member, ${label}`, async (k) => {
          const chief = await k.chief();
          const first = await k.worker(chief, extra);
          await reviewed(k.state, chief, first, "approve");
          const second = await k.worker(chief, { replaces: first });
          await k.completing(`the replacement, never reviewed (${label})`, chief, second, NO_TESTER);
        });
      }
      await run("complete: override with a reason", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await k.completing("override, no review", chief, id, { ...NO_TESTER, override: "oracle override" });
      });
      await run("complete: a design wave", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)], [3]);
        const designer = await k.wave(c, 1);
        await k.completing("design wave, no owner approval", c.chief, designer);
        await tool(k.state, "chief_owner_approval", { workerThreadId: designer, approval: "Looks right, ship it" }, c.chief);
        await k.completing("design wave, owner approved", c.chief, designer);
      });
      await run("complete: cleanup line, queued", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewed(k.state, chief, id, "approve");
        await k.completing("approved, cleanup on", chief, id, NO_TESTER);
      });
      await run("complete: cleanup line, unapproved", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await k.completing("skipReview", chief, id, { ...NO_TESTER, skipReview: "oracle skip" });
      });
      await run("complete: cleanup line, off", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewed(k.state, chief, id, "approve");
        await k.state.harness.behavior.setSettings({ cleanupApproved: false });
        await k.completing("approved, cleanup off", chief, id, NO_TESTER);
      });

      // 6. skipReview against an open review.
      await run("skipReview: a busy open review", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await tool(k.state, "chief_review", { workerThreadId: id }, chief);
        await k.completing("skipReview while the reviewer runs", chief, id, { ...NO_TESTER, skipReview: "oracle skip" });
      });
      await run("skipReview: a busy open review on the replaced chain's head", async (k) => {
        const chief = await k.chief();
        const first = await k.worker(chief);
        await tool(k.state, "chief_review", { workerThreadId: first }, chief);
        const second = await k.worker(chief, { replaces: first });
        await k.completing("skipReview of the replacement while the re-pointed reviewer runs", chief, second, { ...NO_TESTER, skipReview: "oracle skip" });
      });
      await run("skipReview: an idle open review", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewed(k.state, chief, id, "request_changes");
        await k.completing("skipReview after the reviewer reported", chief, id, { ...NO_TESTER, skipReview: "oracle skip" });
      });

      // 7. chief_review: an in-flight review is reused.
      const reviewing = async (k: any, label: string, chief: string, id: string) => {
        const before = k.state.spawned.length;
        const review = await chiefReview(k.state, chief, { workerThreadId: id });
        k.emit(label, `created: ${review.created}\nthreadId: ${review.threadId}\ntitle: ${review.title}\nlaunched: ${k.state.spawned.length - before}${review.created ? "" : `\n${review.text}`}`);
        return review;
      };
      await run("chief_review: an in-flight review", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewing(k, "first call", chief, id);
        await reviewing(k, "second call, the reviewer still running", chief, id);
      });
      await run("chief_review: an in-flight plan review", async (k) => {
        const c = await branches(k);
        const [a, b] = await startBranches(k, c);
        await reviewing(k, "first call, from branch 1", c.chief, a);
        await reviewing(k, "second call, from branch 1", c.chief, a);
        await reviewing(k, "third call, from branch 3", c.chief, b);
      });
      await run("chief_review: an idle open review is superseded", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewed(k.state, chief, id, "request_changes");
        await reviewing(k, "call after the reviewer reported", chief, id);
      });
      return blocks.join("\n");
    };
    // <review-decisions-oracle-end>

    test("review decisions oracle", async () => {
      const head = await reviewDecisionsFixture();
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "review-decisions-4b5ad00.txt"), "utf8");
      expect(head).toBe(oracle);
    }, 120_000);

    // Contract: chief_complete's skipReview refusal names the first busy review down the worker's own task chain, own
    // review first, as on base 4b5ad00; chief_review still picks newest first. Regression: sorting the chain's open reviews
    // by age names the newer review of the replaced worker. Unplanned W1 is replaced by W2, then R2 starts on W2 and a
    // newer R1 on W1 (an unplanned review of a replaced worker is allowed), so only a real chain scan names R2.
    test("skipReview on a replacement names its own busy review, not a newer one on the replaced worker", async () => {
      const state = await setup();
      execFileMock.mockReset();
      const chief = (await start(state)).threadId;
      const worker = async (extra: object = {}) => {
        await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra ? {} : { unplannedReason: "Bounded chain fixture" }), ...extra }, chief);
        const id = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        await readyIdle(state, id);
        return id;
      };
      const w1 = await worker();
      const w2 = await worker({ replaces: w1 });
      const r2 = (await chiefReview(state, chief, { workerThreadId: w2 })).threadId;
      const r1 = (await chiefReview(state, chief, { workerThreadId: w1 })).threadId;
      expect(r1).not.toBe(r2);
      // Pin R1 as the newer review in SQL, so the order never depends on the clock.
      state.db.prepare(`UPDATE managed_threads SET created_at=(SELECT created_at FROM managed_threads WHERE thread_id=?)+1000 WHERE thread_id=?`).run(r2, r1);
      const refusal = await tool(state, "chief_complete", { threadId: w2, skipReview: "chain order", testsSkipped: "chain order" }, chief).then(() => "completed", (error: Error) => error.message);
      expect(refusal).toBe(`Refusing to skip the review of ${w2}: review ${r2} is still running; wait for its verdict.`);
    }, 120_000);


    // ---- Reviewer advice: characterization on base 626c3cd (tests first, before planProgress.reviewAdvice takes the repair decision) ----
    // Contract: for each case below, the reviewer's ready-report alert (nextAction forAlert = true, as Chief received it) and the
    // reviewer's chief_roster Pending line (forAlert = false, whole) give the text saved in __snapshots__/reviewer-advice-626c3cd.txt;
    // a null decision shows no Pending line and the alert's fallback. The real handlers run (chief_review, chief_report,
    // chief_roster, chief_delegate); nothing is observed through a production seam. The storage root is normalized and the forge is
    // execFileMock. A reviewer's carried reject_streak is set in SQL before its report (the report adds one), so the rung does not depend
    // on replacement rounds; a streak or verdict edited after the report is read once a later write reloads the row cache.
    // Regression: moving the repair decision changes a sentence, the layout it picks (plan, single, branch), the stack grouping, the
    // tester or spec routes, the rung, or that an approve wins over a streak.
    // Base capture (the same fixture, byte for byte, produced the snapshot on base and is compared on head):
    //   base: 626c3cdf5af8fcbf2e02b0e4e83b537b1813d811, a Worktrunk checkout (since removed) at /Volumes/VuHo_T5/Develop/personal/research/bb-plugin-chief.tester-base2-626c3cd;
    //     runner root = that directory; this server.test.ts with its oracle assertion swapped to write the output; `npx vitest run server.test.ts -t "reviewer advice oracle"` exit 0 (1 passed); `npx tsc --noEmit` exit 0 (0 errors).
    //   head: 6807ccc3e1c5b6601b2def281d4abdc73eed9a07 + this commit's test changes (production tree = e031902), cwd and runner root /Volumes/VuHo_T5/.bb/plugins/environment-worktrunk/host-data/worktrees/thr_qd8mstf97i-1/bb-plugin-chief;
    //     `npx vitest run server.test.ts -t "reviewer advice"` exit 0 (2 passed) against the snapshot copied unchanged from the base run.
    //   fixture block sha256 (between the markers), base and head: cddcc6046b3d7a41fb03cedebb6b2c66e16dd79885e02fa26b4fb23e292f6bd4; snapshot sha256: 49769900d73f6615d01a81303bf0368bd83ff07f3f95ec7e5a3fee9a72895069.
    //   Pending only, not alert: "no verdict" (no accepted report reaches a ready reviewer without a verdict) and "approve carrying streak 3" (an approve report resets the streak before its alert).
    // <reviewer-advice-oracle-begin>
    const reviewerAdviceFixture = async () => {
      const blocks: string[] = [];
      const PR = "https://github.com/acme/shop/pull/8";
      const run = async (name: string, body: (k: any) => Promise<void>) => {
        const state = await setup();
        await state.harness.behavior.setSettings({ cleanupApproved: true });
        const lines: string[] = [];
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${text.replaceAll(state.storageRoot, "<storage>")}`);
        execFileMock.mockReset();
        execFileMock.mockImplementation(async (file: string, args: string[]) => {
          if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: HEAD_SHA, baseRefName: "main" }), stderr: "" };
          if (file === "gh" && args[0] === "pr" && args[1] === "ready") return { stdout: "", stderr: "" };
          throw new Error(`unexpected CLI ${file}`);
        });
        const newestWorker = () => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const k = {
          state, emit,
          chief: async () => (await start(state)).threadId,
          /** Chief plus a planner holding `waves`, approved when it has more than one implementation wave; test waves in `waived` are skipped. */
          mk: async (waves: object[], waived: number[] = []) => {
            const chief = (await start(state)).threadId;
            const planner = (await plan(state, chief, waves)).threadId;
            if (waves.filter((entry: any) => !entry.test).length > 1) await approvePlan(state, chief, planner);
            for (const wave of waived) await tool(state, "chief_skip_tests", { planThreadId: planner, wave, reason: "oracle reason" }, chief);
            return { chief, planner };
          },
          /** Delegates a worker (unplanned unless `extra` carries a plan or replaces), reports ready, goes idle: its id. */
          worker: async (chief: string, extra: object = {}) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra || "planThreadId" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief);
            const id = newestWorker();
            await readyIdle(state, id);
            return id;
          },
          /** A plan wave, reported ready and idle: its id. */
          wave: (c: any, wave: number, extra: object = {}) => k.worker(c.chief, { planThreadId: c.planner, wave, ...extra }),
          /** A plan wave as the server stored one before chains shared a branch: a worker of its own on its own branch. */
          legacyWave: async (c: any, wave: number, branch: string) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded oracle fixture", branch }, c.chief);
            const id = newestWorker();
            state.db.prepare("UPDATE managed_threads SET plan_thread_id=?, plan_wave=?, unplanned_reason=NULL WHERE thread_id=?").run(c.planner, wave, id);
            await readyIdle(state, id);
            return id;
          },
          /** The reviewer's Pending line, whole, or a marker when it has none. */
          pending: async (label: string, chief: string, reviewer: string) => {
            const roster = String(await tool(state, "chief_roster", {}, chief));
            emit(label, roster.split("\n").find((line) => line.includes(`(${reviewer}):`)) ?? "(no Pending line)");
          },
          /** Chief starts a review of `target`; its reviewer reports `verdict` with the carried reject_streak `streak` after the report. Emits the alert and Pending line. */
          judge: async (label: string, chief: string, target: object, v: { verdict?: "approve" | "request_changes"; streak?: number; regression?: boolean } = {}) => {
            const verdict = v.verdict ?? "request_changes";
            await tool(state, "chief_review", target, chief);
            const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer" && row.state !== "complete").at(-1)!.threadId;
            if (v.streak && verdict === "request_changes") state.db.prepare(`UPDATE managed_threads SET reject_streak=? WHERE thread_id=?`).run(v.streak - 1, reviewer);
            await report(state, reviewer, {
              state: "ready", result: "The discount is applied twice", verdict, ...(v.regression ? { regression: true } : {}),
              findings: verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "The discount is applied twice", fix: "Apply it once" }],
            });
            emit(`${label}: alert`, state.sent.at(-1).input[0].text);
            await k.pending(`${label}: Pending`, chief, reviewer);
            return reviewer;
          },
          /** The reviewer reports again (a later report re-reads the persisted state): emits the alert it sent, then the Pending line. */
          again: async (label: string, chief: string, reviewer: string, params: object) => {
            await report(state, reviewer, params);
            emit(`${label}: alert`, state.sent.at(-1).input[0].text);
            await k.pending(`${label}: Pending`, chief, reviewer);
          },
          /** Any later write reloads the row cache, so a SQL edit made after a report is read. */
          reload: (chief: string) => k.worker(chief),
          replace: (chief: string, id: string, extra: object = {}) => tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: id, ...extra }, chief),
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };
      const P = (n: number, extra: object = {}) => planWave(n, extra);
      const FIX = { streak: 1 };
      const CONSULT = { streak: 2 };
      const STOP = { streak: 3 };
      /** Two independent branches (waves 1 and 3), tests waived: one plan review covers both. */
      const branches = (k: any) => k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [2, 4]);
      const startBranches = async (k: any, c: any) => [await k.wave(c, 1, { branch: "feature/a" }), await k.wave(c, 3, { branch: "feature/b" })];
      /** Two stacked legacy waves (2 builds on 1), tests waived: one review covers both, reviewed from the tip. */
      const stack = (k: any) => k.mk([P(1), P(2), TEST_WAVE(3)], [3]);
      const stacked = async (k: any, c: any) => { const base = await k.wave(c, 1, { branch: "feature/a" }); return [await k.legacyWave(c, 2, "feature/b"), base]; };
      /** The stack plus one independent branch (wave 4). */
      const stackAndLoose = (k: any) => k.mk([P(1), P(2), TEST_WAVE(3), P(4, { dependsOn: [] }), TEST_WAVE(5, [4])], [3, 5]);
      const stackedAndLoose = async (k: any, c: any) => [...await stacked(k, c), await k.wave(c, 4, { branch: "feature/c" })];
      /** A plan's tester on wave 2 and a worker fixing it on the same wave (a test wave): [tester, fix]. */
      const testerChain = async (k: any) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const impl = await k.wave(c, 1);
        const tester = await k.wave(c, 2, { replaces: impl });
        return { c, tester, fix: () => k.wave(c, 2, { replaces: tester, kind: "worker" }) };
      };
      /** A plan whose wave 1 has a Spec Writer, tests waived: the writer and its worker. */
      const specChain = async (k: any, waived: number[]) => {
        const c = await k.mk([specImpl(), TEST_WAVE(2)], waived);
        const writer = await k.wave(c, 1);
        const worker = await k.wave(c, 1, { replaces: writer, kind: "worker" });
        return { c, writer, worker };
      };
      const unplannedTester = async (k: any, chief: string) => k.worker(chief, { replaces: await k.worker(chief), kind: "tester" });

      // 1. Approve.
      await run("approve: single managed worker", async (k) => {
        const chief = await k.chief();
        await k.judge("approve", chief, { workerThreadId: await k.worker(chief) }, { verdict: "approve" });
      });
      await run("approve: whole plan, one target already complete", async (k) => {
        const c = await branches(k);
        const [a] = await startBranches(k, c);
        const reviewer = await k.judge("approve", c.chief, { workerThreadId: a }, { verdict: "approve" });
        await tool(k.state, "chief_complete", { threadId: a }, c.chief);
        await k.reload(c.chief);
        await k.pending("after completing the first branch: Pending", c.chief, reviewer);
        await k.again("approved again after completing the first branch", c.chief, reviewer, { state: "ready", result: "The discount is applied twice", verdict: "approve", findings: [] });
      });
      await run("approve: unowned branch", async (k) => {
        const chief = await k.chief();
        await k.judge("approve", chief, { branch: "feature/z" }, { verdict: "approve" });
      });
      await run("approve: a carried reject_streak of 3 still approves", async (k) => {
        const chief = await k.chief();
        const reviewer = await k.judge("approve", chief, { workerThreadId: await k.worker(chief) }, { verdict: "approve" });
        k.state.db.prepare(`UPDATE managed_threads SET reject_streak=3 WHERE thread_id=?`).run(reviewer);
        await k.reload(chief);
        await k.pending("approve carrying streak 3: Pending", chief, reviewer);
        // Pending only: an approve report resets reject_streak to 0 before its alert is built, so no accepted report alerts an approve that carries a streak.
      });

      // 2. request_changes at the fix rung.
      await run("fix: single plain worker", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { workerThreadId: await k.worker(chief) }, FIX);
      });
      await run("fix: single worker, regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { workerThreadId: await k.worker(chief) }, { ...FIX, regression: true });
      });
      await run("fix: single unplanned tester", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { workerThreadId: await unplannedTester(k, chief) }, FIX);
      });
      await run("fix: single plan tester", async (k) => {
        const { c, tester } = await testerChain(k);
        await k.judge("fix", c.chief, { workerThreadId: tester }, FIX);
      });
      await run("fix: single worker on a test wave", async (k) => {
        const { c, fix } = await testerChain(k);
        await k.judge("fix", c.chief, { workerThreadId: await fix() }, FIX);
      });
      await run("fix: single worker on a planned spec chain", async (k) => {
        const { c, worker } = await specChain(k, [2]);
        await k.judge("fix", c.chief, { workerThreadId: worker }, FIX);
      });
      await run("fix: single worker on an unplanned chain with a Spec Writer", async (k) => {
        const chief = await k.chief();
        const writer = await k.worker(chief, { kind: "spec-writer" });
        const worker = await k.worker(chief, { replaces: writer, kind: "worker", unplannedReason: "Bounded oracle fixture" });
        await k.judge("fix", chief, { workerThreadId: worker }, FIX);
      });
      await run("fix: tester on a planned spec chain", async (k) => {
        const { c, worker } = await specChain(k, []);
        await k.judge("fix", c.chief, { workerThreadId: await k.wave(c, 2, { replaces: worker }) }, FIX);
      });
      await run("fix: unowned branch, no pull request", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { branch: "feature/z" }, FIX);
      });
      await run("fix: unowned branch with a pull request", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { pullRequest: PR }, FIX);
      });
      await run("fix: unowned branch, regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { branch: "feature/z" }, { ...FIX, regression: true });
      });
      await run("fix: plan of independent branches", async (k) => {
        const c = await branches(k);
        await k.judge("fix", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, FIX);
      });
      await run("fix: plan of independent branches, regression flagged", async (k) => {
        const c = await branches(k);
        await k.judge("fix", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, { ...FIX, regression: true });
      });
      await run("fix: plan of independent branches, one a tester branch", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [4]);
        const impl = await k.wave(c, 1, { branch: "feature/a" });
        const tester = await k.wave(c, 2, { replaces: impl });
        await k.wave(c, 3, { branch: "feature/b" });
        await k.judge("fix", c.chief, { workerThreadId: tester }, FIX);
      });
      await run("fix: plan of a legacy stack", async (k) => {
        const c = await stack(k);
        await k.judge("fix", c.chief, { workerThreadId: (await stacked(k, c))[0] }, FIX);
      });
      await run("fix: plan of a legacy stack and a loose branch", async (k) => {
        const c = await stackAndLoose(k);
        await k.judge("fix", c.chief, { workerThreadId: (await stackedAndLoose(k, c))[0] }, FIX);
      });
      await run("fix: plan of a legacy stack and a loose branch, regression flagged", async (k) => {
        const c = await stackAndLoose(k);
        await k.judge("fix", c.chief, { workerThreadId: (await stackedAndLoose(k, c))[0] }, { ...FIX, regression: true });
      });

      // 3. The consult rung (carried reject_streak 2).
      await run("consult: plan with stacks", async (k) => {
        const c = await stack(k);
        await k.judge("consult", c.chief, { workerThreadId: (await stacked(k, c))[0] }, CONSULT);
      });
      await run("consult: plan with stacks and a loose branch", async (k) => {
        const c = await stackAndLoose(k);
        await k.judge("consult", c.chief, { workerThreadId: (await stackedAndLoose(k, c))[0] }, CONSULT);
      });
      await run("consult: plan without stacks", async (k) => {
        const c = await branches(k);
        await k.judge("consult", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, CONSULT);
      });
      await run("consult: plan without stacks, one a tester branch", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [4]);
        const impl = await k.wave(c, 1, { branch: "feature/a" });
        const tester = await k.wave(c, 2, { replaces: impl });
        await k.wave(c, 3, { branch: "feature/b" });
        await k.judge("consult", c.chief, { workerThreadId: tester }, CONSULT);
      });
      await run("consult: single managed worker", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { workerThreadId: await k.worker(chief) }, CONSULT);
      });
      await run("consult: single managed worker, regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { workerThreadId: await k.worker(chief) }, { ...CONSULT, regression: true });
      });
      await run("consult: single tested worker", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { workerThreadId: await unplannedTester(k, chief) }, CONSULT);
      });
      await run("consult: single worker on a planned spec chain", async (k) => {
        const { c, worker } = await specChain(k, [2]);
        await k.judge("consult", c.chief, { workerThreadId: worker }, CONSULT);
      });
      await run("consult: unowned branch", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { branch: "feature/z" }, CONSULT);
      });

      // 4. The stop rung (carried reject_streak 3): the same text for every layout.
      await run("stop: single worker", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { workerThreadId: await k.worker(chief) }, STOP);
      });
      await run("stop: plan", async (k) => {
        const c = await branches(k);
        await k.judge("stop", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, STOP);
      });
      await run("stop: unowned branch", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { branch: "feature/z" }, STOP);
      });
      await run("stop: regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { workerThreadId: await k.worker(chief) }, { ...STOP, regression: true });
      });
      await run("stop: a carried reject_streak above 3", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { workerThreadId: await k.worker(chief) }, { streak: 5 });
      });

      // 5. Null: no Pending line, and the alert falls through.
      await run("null: the reviewer has no verdict", async (k) => {
        const chief = await k.chief();
        const reviewer = await k.judge("reported", chief, { workerThreadId: await k.worker(chief) }, FIX);
        k.state.db.prepare(`UPDATE managed_threads SET verdict=NULL WHERE thread_id=?`).run(reviewer);
        await k.reload(chief);
        await k.pending("verdict cleared: Pending", chief, reviewer);
        // Pending only: no accepted report reaches a ready reviewer with no verdict (checkReport refuses a ready reviewer report without one; a blocked report is routed before the reviewer branch), so its alert is not observable.
      });
      await run("null: the covered worker was re-pointed by replaces", async (k) => {
        const chief = await k.chief();
        const worker = await k.worker(chief);
        const reviewer = await k.judge("reported", chief, { workerThreadId: worker }, FIX);
        await k.replace(chief, worker);
        await k.pending("after the replacement: Pending", chief, reviewer);
        await k.again("reported again after the replacement", chief, reviewer, { state: "ready", result: "The discount is applied twice", ...REQUEST_CHANGES });
      });
      await run("null: a plan target was re-pointed by replaces", async (k) => {
        const c = await branches(k);
        const [a, b] = await startBranches(k, c);
        const reviewer = await k.judge("reported", c.chief, { workerThreadId: a }, FIX);
        await k.wave(c, 1, { replaces: a });
        await k.pending("after replacing branch 1: Pending", c.chief, reviewer);
        await k.wave(c, 3, { replaces: b });
        await k.pending("after replacing branch 3: Pending", c.chief, reviewer);
        await k.again("reported again after replacing branch 3", c.chief, reviewer, { state: "ready", result: "The discount is applied twice", ...REQUEST_CHANGES });
      });
      await run("null: every covered worker is complete", async (k) => {
        const chief = await k.chief();
        const worker = await k.worker(chief);
        await tool(k.state, "chief_review", { workerThreadId: worker }, chief);
        await tool(k.state, "chief_complete", { threadId: worker, testsSkipped: "oracle: no tester", override: "oracle override" }, chief);
        const reviewer = (await status(k.state)).threads.filter((row) => row.role === "reviewer").at(-1)!.threadId;
        await report(k.state, reviewer, { state: "ready", result: "The discount is applied twice", ...REQUEST_CHANGES });
        k.emit("reported after the worker completed: alert", k.state.sent.at(-1).input[0].text);
        await k.pending("reported after the worker completed: Pending", chief, reviewer);
      });
      return blocks.join("\n");
    };
    // <reviewer-advice-oracle-end>

    test("reviewer advice oracle", async () => {
      const head = await reviewerAdviceFixture();
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "reviewer-advice-626c3cd.txt"), "utf8");
      expect(head).toBe(oracle);
    }, 180_000);

    // Advice is not permission: the consult advice is the reviewer's instruction, the consult gate on chief_delegate is a separate ledger decision.
    // Regression: a satisfied consult changes the advice sentence, or the advice starts to grant (or withhold) the replacement.
    test("reviewer advice is not permission: the consult sentence stays after the consult, and chief_delegate still gates on the consult", async () => {
      const state = await setup();
      execFileMock.mockReset();
      execFileMock.mockImplementation(async () => { throw new Error("unexpected CLI"); });
      const chief = (await start(state)).threadId;
      const worker = async (extra: object = {}): Promise<string> => {
        await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief);
        const id = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        await readyIdle(state, id);
        return id;
      };
      const pendingLine = async (reviewer: string) => String(await tool(state, "chief_roster", {}, chief)).split("\n").find((line) => line.includes(`(${reviewer}):`));
      const first = await worker();
      await reviewed(state, chief, first, "request_changes");
      const second = await worker({ replaces: first });
      await reviewed(state, chief, second, "request_changes");
      const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!.threadId;
      const advice = await pendingLine(reviewer);
      expect(advice).toContain(`The reviewer still requires changes after 2 consecutive rounds. Call chief_consult (workerThreadId: ${second}) now, before any further delegation`);
      const gate = `The reviewer has requested changes 2 times in a row on ${second}. Call chief_consult (workerThreadId: ${second}) and wait for it to send its advice (a ready or blocked report; a status-only, stopped or completed-unreported consult does not count) before delegating the one more round.`;
      await expect(tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: second }, chief)).rejects.toThrow(gate);

      await tool(state, "chief_consult", { title: "Advice", mission: "Diagnose", workerThreadId: second }, chief);
      const advisor = (await status(state)).threads.filter((row) => row.role === "advisor" && row.workerThreadId === second).at(-1)!.threadId;
      await report(state, advisor, { state: "ready", result: "Try X" });
      const created = (state.db.prepare(`SELECT created_at FROM managed_threads WHERE thread_id=?`).get(second) as { created_at: number }).created_at;
      state.db.prepare(`UPDATE reviewer_verdicts SET at=?`).run(created + 1_000);
      state.db.prepare(`UPDATE managed_threads SET created_at=? WHERE thread_id=?`).run(created + 2_000, advisor);
      expect(await pendingLine(reviewer)).toBe(advice);
      await expect(tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: second }, chief)).resolves.toEqual(expect.any(String));
    }, 120_000);


    // ---- Review attempt: characterization on cf92d9c (tests first, before the review attempt module is extracted) ----
    // Contract: for each case below, the real chief_review handler gives the outcome saved in
    // __snapshots__/review-attempt-cf92d9c.txt: the reply or the refusal, the reviewer's spawn environment, prompt and
    // review-context.md, the reviewer's row identity, its review_targets rows, and any Chief alert. The real handlers run;
    // nothing is observed through a production seam. The forge is execFileMock (gh pr view); git passes through to the real
    // git only in the cases that read a temp repository on the primary host.
    // Normalization is by fixture identity, never first-seen order: each thread id becomes its fixture label (<W1>, <R2>,
    // <chief>, ...; an unlabeled id fails the run), each fixture sha its label (<HEAD_SHA>, <shaB>, <c1>, ... and <label:12>
    // for the 12-character form), the storage root <storage> and the temp repository <repo>. A swapped head or a swapped
    // review changes the bytes.
    // Regression: moving the review attempt changes a reply sentence, the order of two refusals, a brief or context line,
    // the identity a row or a target records, or which review chief_review reuses.
    // <review-attempt-oracle-begin>
    const reviewAttemptFixture = async () => {
      const blocks: string[] = [];
      const PR = "https://github.com/acme/shop/pull/8";
      const PR_A = "https://github.com/acme/shop/pull/11";
      const PR_B = "https://github.com/acme/shop/pull/12";
      const SHA_B = "b".repeat(40);
      const SHA_C = "c".repeat(40);
      const SHA_F = "f".repeat(40);
      const PRIMARY = { config: async () => ({ primaryHostId: "host_1" }), usageLimits: async () => ({}) };
      const REMOTE = { config: async () => ({ primaryHostId: "host_2" }), usageLimits: async () => ({}) };
      const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const realExec = (await import("node:util")).promisify(childProcess.execFile) as (file: string, args: string[], options: object) => Promise<{ stdout: string; stderr: string }>;
      // A temp repository: c0 -> c1 -> c2 on main, a diverged c3 off c0, and origin/main at c0 (there is no remote).
      let built: Promise<{ dir: string; dirs: string[]; c0: string; c1: string; c2: string; c3: string }> | undefined;
      const repo = () => built ??= (async () => {
        const dir = await mkdtemp(join(tmpdir(), "chief-repo-"));
        const git = async (...args: string[]) => (await realExec("git", ["-c", "user.name=oracle", "-c", "user.email=oracle@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir })).stdout.trim();
        const commit = async (files: Record<string, string>, message: string) => {
          for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
          await git("add", "-A");
          await git("commit", "-q", "-m", message);
          return git("rev-parse", "HEAD");
        };
        await git("init", "-q", "-b", "main");
        const c0 = await commit({
          "lib.ts": "export function discount(total: number) {\n  return total * 0.9;\n}\n\nexport function tax(total: number) {\n  return total * 0.2;\n}\n",
          "main.ts": "export function sum(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n",
        }, "c0");
        await git("update-ref", "refs/remotes/origin/main", c0);
        const c1 = await commit({ "main.ts": "export function sum(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n\nexport function total(items: number[]) {\n  return discount(sum(items));\n}\n" }, "c1");
        const c2 = await commit({ "main.ts": "export function sum(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n\nexport function total(items: number[]) {\n  return tax(discount(sum(items)));\n}\n" }, "c2");
        await git("checkout", "-q", "-b", "side", c0);
        const c3 = await commit({ "lib.ts": "export function discount(total: number) {\n  return total * 0.8;\n}\n" }, "c3");
        await git("checkout", "-q", "main");
        return { dir, dirs: [dir, await realpath(dir)], c0, c1, c2, c3 };
      })();

      const reviewerIdsOf = (state: any) => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer' ORDER BY rowid`).all() as { thread_id: string }[]).map((row) => row.thread_id);
      const run = async (name: string, body: (k: any) => Promise<void>, where: "none" | "remote" | "local" = "none") => {
        const local = where === "local" ? await repo() : null;
        const state = await setup(local ? { projectPath: local.dir, system: PRIMARY } : where === "remote" ? { projectPath: "/oracle/checkout", system: REMOTE } : {});
        const lines: string[] = [];
        const names = new Map<string, string>();
        const shas = new Map<string, string>([[HEAD_SHA, "HEAD_SHA"], [SHA_B, "shaB"], [SHA_C, "shaC"], [SHA_F, "shaF"]]);
        if (local) for (const key of ["c0", "c1", "c2", "c3"] as const) shas.set(local[key], key);
        const norm = (text: string) => {
          let out = text.replaceAll(state.storageRoot, "<storage>");
          for (const dir of local?.dirs ?? []) out = out.replaceAll(dir, "<repo>");
          // git's own stderr after the failed ancestry check varies by version; the prefix bytes stay.
          // The write error's own text comes from the fake host (its unstubbed files.remove); the sentence around it stays.
          out = out.replace(/after 3 attempts: .*?\. The reviewer will/, "after 3 attempts: <error>. The reviewer will");
          out = out.replace(/(--is-ancestor [0-9a-f]{40} [0-9a-f]{40}) fatal:[^)]*/g, "$1 <git-error>");
          out = out.replace(/thr_\d+/g, (id) => {
            const label = names.get(id);
            if (!label) throw new Error(`unlabeled thread ${id}`);
            return `<${label}>`;
          });
          for (const [sha, label] of shas) out = out.replaceAll(sha, `<${label}>`).replaceAll(sha.slice(0, 12), `<${label}:12>`);
          return out;
        };
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${norm(text)}`);
        // gh pr view <number>: per-pull-request heads, default HEAD_SHA on feature/x; `unreadable` makes gh fail.
        const forge = { sha: HEAD_SHA, heads: {} as Record<string, { branch: string; sha: string }>, unreadable: new Set<string>() };
        execFileMock.mockReset();
        // Not async: the impact slice reads `.child` off the real git call's promise to kill it on its deadline.
        execFileMock.mockImplementation((file: string, args: string[], options: object) => {
          if (file === "git" && local) return realExec(file, args, options);
          return (async () => {
            if (file === "gh" && args[0] === "pr" && args[1] === "view") {
              if (forge.unreadable.has(args[2]!)) throw new Error("gh: forge unreachable");
              const head = forge.heads[args[2]!] ?? { branch: "feature/x", sha: forge.sha };
              return { stdout: JSON.stringify({ headRefName: head.branch, headRefOid: head.sha, baseRefName: "main" }), stderr: "" };
            }
            throw new Error(`unexpected CLI ${file}`);
          })();
        });
        const reviewerIds = () => reviewerIdsOf(state);
        const newestWorker = () => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const command = (text: string, exitCode: number) => ({ type: "item/completed", seq: 1, data: { item: { type: "commandExecution", command: text, exitCode, status: exitCode ? "failed" : "completed" } } });
        const k = {
          state, forge, emit, local, command,
          label: (id: string, label: string) => { names.set(id, label); return id; },
          chief: async () => { const id = (await start(state)).threadId; names.set(id, "chief"); return id; },
          /** Chief plus a planner holding `waves`, approved when it has more than one implementation wave; test waves in `waived` are skipped. */
          mk: async (waves: object[], waived: number[] = []) => {
            const chief = await k.chief();
            const planner = (await plan(state, chief, waves)).threadId;
            names.set(planner, "P");
            if (waves.filter((entry: any) => !entry.test).length > 1) await approvePlan(state, chief, planner);
            for (const wave of waived) await tool(state, "chief_skip_tests", { planThreadId: planner, wave, reason: "oracle reason" }, chief);
            return { chief, planner };
          },
          /** Delegates a worker (unplanned unless `extra` carries a plan or replaces), reports ready and goes idle unless `ready` is false. */
          worker: async (label: string, chief: string, extra: object = {}, ready = true) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra || "planThreadId" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief);
            const id = k.label(newestWorker(), label);
            if (ready) await readyIdle(state, id);
            return id;
          },
          wave: (label: string, c: any, wave: number, extra: object = {}) => k.worker(label, c.chief, { planThreadId: c.planner, wave, ...extra }),
          /** Two independent branches (waves 1 and 3), tests waived: one plan review covers both. */
          branches: () => k.mk([planWave(1), TEST_WAVE(2), planWave(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [2, 4]),
          /** A review of `id` that Chief does not look at: the reviewer reports `verdict` and goes idle with its row open. */
          reviewed: async (chief: string, id: string, label: string, verdict: "approve" | "request_changes" = "request_changes") => {
            const before = reviewerIds().length;
            await tool(state, "chief_review", { workerThreadId: id }, chief);
            const reviewer = k.label(reviewerIds()[before]!, label);
            await report(state, reviewer, {
              state: "ready", result: "The discount is applied twice", verdict,
              findings: verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "The discount is applied twice", fix: "Apply it once" }],
            });
            return reviewer;
          },
          review: (chief: string, params: object) => () => tool(state, "chief_review", params, chief),
          /** Runs a call and records what it did; `reviewers` labels the reviewers it launched, in order. `fake` runs it on fake timers for the 60 s busy-worker wait. */
          attempt: async (label: string, call: () => Promise<unknown>, options: { reviewers?: string[]; fake?: boolean } = {}) => {
            const before = { spawned: state.spawned.length, sent: state.sent.length, reviewers: reviewerIds().length };
            const settle = call().then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            let out: string;
            if (options.fake) {
              vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
              // Real file and git calls take macrotask turns the fake clock does not wait for: step it until the call settles.
              try {
                let done = false;
                void settle.then(() => { done = true; });
                for (let step = 0; !done; step++) {
                  if (step > 200) throw new Error("the call never settled on the fake clock");
                  await vi.advanceTimersByTimeAsync(1_000);
                  await new Promise((resolve) => setImmediate(resolve));
                }
                out = await settle;
              } finally { vi.useRealTimers(); }
            } else out = await settle;
            const spawns = state.spawned.slice(before.spawned);
            const fresh = reviewerIds().slice(before.reviewers);
            fresh.forEach((id, index) => k.label(id, options.reviewers?.[index] ?? `unlabeled reviewer ${index}`));
            const parts = [out, `launched: ${spawns.length}`];
            for (const [index, id] of fresh.entries()) {
              const spawn = spawns[index];
              const environment = spawn.environment;
              const row = rowOf(state, id);
              const targets = state.db.prepare(`SELECT worker_thread_id, report_seq, head_sha, pr_url, branch FROM review_targets WHERE reviewer_thread_id=? ORDER BY rowid`).all(id) as any[];
              const context = await reviewContextOf(state, id).catch(() => null);
              parts.push(
                `reviewer ${id}`,
                `spawn environment: type=${environment.type} hostId=${environment.hostId ?? "-"} baseBranch=${environment.workspace?.baseBranch?.name ?? "-"} environmentId=${environment.environmentId ?? "-"}`,
                `row: worker_thread_id=${row.worker_thread_id} reviewed_report_seq=${row.reviewed_report_seq} reviewed_head_sha=${row.reviewed_head_sha} branch=${row.branch} pr_url=${row.pr_url} reject_streak=${row.reject_streak}`,
                ...targets.map((target) => `target: worker_thread_id=${target.worker_thread_id} report_seq=${target.report_seq} head_sha=${target.head_sha} pr_url=${target.pr_url} branch=${target.branch}`),
                "prompt:", spawn.prompt,
                "review-context.md:", context ?? "(none)",
              );
            }
            for (const text of state.sent.slice(before.sent).map((sent) => `to ${sent.threadId}: ${sent.input[0].text}`)) parts.push("chief alert:", text);
            parts.push(`reviewers: ${reviewerIds().map((id) => `${id}=${rowOf(state, id).state}/streak ${rowOf(state, id).reject_streak}`).join(", ") || "none"}`);
            emit(label, parts.join("\n"));
          },
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };

      // 1. A single worker: where the reviewer runs and what the reply says about the head.
      await run("single worker, no pull request", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });
      await run("single worker, pull request, head pinned", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });
      await run("single worker, pull request, head unreadable", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        k.forge.unreadable.add("8");
        await k.attempt("review, gh fails", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });

      // 2. Re-review scope.
      await run("re-review: equal head", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        await k.attempt("second review at the same head", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("re-review: different head, no project path", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        k.forge.sha = SHA_B;
        await k.attempt("second review at a new head", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("re-review: different head, checkout on a remote host", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        k.forge.sha = SHA_B;
        await k.attempt("second review at a new head", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      }, "remote");
      await run("re-review: previous verdict, no pull request", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        await k.reviewed(chief, w1, "R1");
        await k.attempt("second review of a worker with no pull request", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("re-review: previous verdict recorded no head", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        k.forge.unreadable.add("8");
        await k.reviewed(chief, w1, "R1");
        k.forge.unreadable.delete("8");
        await k.attempt("second review once the forge answers", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });

      // 3. Plan review (two or more targets).
      await run("plan review: branches with no pull request", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a" });
        await k.wave("W2", c, 3, { branch: "feature/b" });
        await k.attempt("review from branch 1", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
      });
      await run("plan review: a target with no head and no branch", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await k.wave("W2", c, 3);
        await k.attempt("review refused", k.review(c.chief, { workerThreadId: a }));
      });
      await run("plan review: distinct pinned heads and report sequences", async (k) => {
        const c = await k.branches();
        k.forge.heads["11"] = { branch: "feature/a", sha: SHA_B };
        k.forge.heads["12"] = { branch: "feature/b", sha: SHA_C };
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await readyIdle(k.state, a, `${READY} again`);
        const b = await k.wave("W2", c, 3, { branch: "feature/b", prUrl: PR_B });
        await k.attempt("review from branch 1", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
        const reviewer = reviewerIdsOf(k.state)[0]!;
        // Outside the normalization: each row binds its own worker's report and head, and the reviewer row the initiating worker's.
        expect(rowOf(k.state, a).report_seq).toBe(2);
        expect(rowOf(k.state, b).report_seq).toBe(1);
        expect(k.state.db.prepare(`SELECT worker_thread_id, report_seq, head_sha FROM review_targets WHERE reviewer_thread_id=? ORDER BY rowid`).all(reviewer))
          .toEqual([{ worker_thread_id: a, report_seq: 2, head_sha: SHA_B }, { worker_thread_id: b, report_seq: 1, head_sha: SHA_C }]);
        expect(rowOf(k.state, reviewer)).toMatchObject({ worker_thread_id: a, reviewed_report_seq: 2, reviewed_head_sha: SHA_B });
      });
      await run("plan review: one pull request head unreadable, its branch present", async (k) => {
        const c = await k.branches();
        k.forge.heads["11"] = { branch: "feature/a", sha: SHA_B };
        k.forge.unreadable.add("12");
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await readyIdle(k.state, a, `${READY} again`);
        const b = await k.wave("W2", c, 3, { branch: "feature/b", prUrl: PR_B });
        await k.attempt("review from branch 1", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
        const reviewer = reviewerIdsOf(k.state)[0]!;
        expect(k.state.db.prepare(`SELECT worker_thread_id, report_seq, head_sha, branch FROM review_targets WHERE reviewer_thread_id=? ORDER BY rowid`).all(reviewer))
          .toEqual([{ worker_thread_id: a, report_seq: 2, head_sha: SHA_B, branch: "feature/a" }, { worker_thread_id: b, report_seq: 1, head_sha: null, branch: "feature/b" }]);
        expect(rowOf(k.state, reviewer)).toMatchObject({ worker_thread_id: a, reviewed_report_seq: 2, reviewed_head_sha: SHA_B });
      });

      // 4. The impact slice.
      await run("impact slice: skipped with no project path", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { branch: "feature/x" });
        await k.attempt("review of an unpinned branch", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      });
      await run("impact slice: real entries, one target", async (k) => {
        const chief = await k.chief();
        k.forge.heads["8"] = { branch: "feature/x", sha: k.local.c1 };
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      }, "local");
      await run("impact slice: real entries, two targets", async (k) => {
        const c = await k.branches();
        k.forge.heads["11"] = { branch: "feature/a", sha: k.local.c1 };
        k.forge.heads["12"] = { branch: "feature/b", sha: k.local.c2 };
        const a = await k.wave("W1", c, 1, { branch: "feature/a", prUrl: PR_A });
        await k.wave("W2", c, 3, { branch: "feature/b", prUrl: PR_B });
        await k.attempt("plan review", k.review(c.chief, { workerThreadId: a }), { reviewers: ["R1"] });
      }, "local");
      await run("impact slice: unpinned, branch not found locally", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { branch: "feature/none" });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      }, "local");
      await run("impact slice: unpinned, origin/HEAD not set", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { branch: "side" });
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
      }, "local");

      // 5. A branch or pull request no worker owns.
      await run("branch review: by branch", async (k) => {
        const chief = await k.chief();
        await k.attempt("review a branch", k.review(chief, { branch: "feature/z" }), { reviewers: ["R1"] });
      });
      await run("branch review: by pull request, the branch from gh", async (k) => {
        const chief = await k.chief();
        await k.attempt("review a pull request", k.review(chief, { pullRequest: PR }), { reviewers: ["R1"] });
      });
      await run("branch review: by pull request, gh fails", async (k) => {
        const chief = await k.chief();
        k.forge.unreadable.add("8");
        await k.attempt("review a pull request, the raw reference is the branch", k.review(chief, { pullRequest: PR }), { reviewers: ["R1"] });
      });
      await run("branch review: a branch a live worker owns", async (k) => {
        const chief = await k.chief();
        await k.worker("W1", chief, { branch: "feature/owned" });
        await k.attempt("review the owned branch", k.review(chief, { branch: "feature/owned" }));
      });
      await run("branch review: a second call", async (k) => {
        const chief = await k.chief();
        await k.attempt("first call", k.review(chief, { branch: "feature/z" }), { reviewers: ["R1"] });
        await k.attempt("second call", k.review(chief, { branch: "feature/z" }));
      });

      // 6. Concurrency, the context write, supersede and streak, earlier workers.
      await run("concurrency: two chief_review calls on one worker", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.attempt("two concurrent calls", () => Promise.all([k.review(chief, { workerThreadId: w1 })(), k.review(chief, { workerThreadId: w1 })()]).then((replies) => replies.join("\n")), { reviewers: ["R1"] });
      });
      await run("review-context.md write failure", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        // A directory where the file goes makes every atomic rename fail: three attempts (1 s, 2 s backoff), then the alert.
        await mkdir(join(k.state.storageRoot, `thr_${k.state.spawned.length + 1}`, "review-context.md"), { recursive: true });
        await k.attempt("review, the context write fails", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"], fake: true });
      });
      await run("supersede and streak", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        await k.reviewed(chief, w1, "R1");
        await k.attempt("review after R1 rejected", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
      });
      await run("earlier workers: implementer then tester", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, {}, false);
        k.state.seedEvents(w1, [k.command("npm run lint", 0), k.command("npm run build", 1)]);
        await readyIdle(k.state, w1);
        const w2 = await k.worker("W2", chief, { replaces: w1, kind: "tester" }, false);
        k.state.seedEvents(w2, [k.command("npm test", 0)]);
        await readyIdle(k.state, w2);
        await k.attempt("review the tester", k.review(chief, { workerThreadId: w2 }), { reviewers: ["R1"] });
      });

      // 7. Refusals.
      await run("refusal: a busy worker", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, {}, false);
        setLive(k.state, w1, "active");
        await k.attempt("review a worker that has not reported and is active", k.review(chief, { workerThreadId: w1 }));
      });
      for (const field of ["archivedAt", "deletedAt"]) {
        await run(`refusal: a worker with ${field} set`, async (k) => {
          const chief = await k.chief();
          const w1 = await k.worker("W1", chief);
          k.state.live.set(w1, { ...k.state.live.get(w1)!, [field]: 1_700_000_000_000 } as any);
          await k.attempt(`review a worker with ${field}`, k.review(chief, { workerThreadId: w1 }));
        });
      }
      await run("refusal: an id that is not a worker", async (k) => {
        const chief = await k.chief();
        await k.attempt("review Chief itself", k.review(chief, { workerThreadId: chief }));
      });
      await run("refusal: a design wave", async (k) => {
        const c = await k.mk([planWave(1, { design: true }), planWave(2), TEST_WAVE(3)], [3]);
        const designer = await k.wave("W1", c, 1);
        await k.attempt("review a design wave", k.review(c.chief, { workerThreadId: designer }));
      });
      await run("refusal: a superseded worker", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a" });
        await k.wave("W2", c, 1, { replaces: a });
        await k.attempt("review the superseded worker", k.review(c.chief, { workerThreadId: a }));
      });

      // 8. The advisor's adversarial cases.
      // 8.1 Chain order against creation order: a replaced unplanned chain (W1, W2 replaces W1), R2 on W2, then a newer R1 on W1.
      const chain = async (k: any) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief);
        const w2 = await k.worker("W2", chief, { replaces: w1 });
        await k.attempt("review of W2", k.review(chief, { workerThreadId: w2 }), { reviewers: ["R2"] });
        await k.attempt("review of the replaced W1", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R1"] });
        const [r1, r2] = reviewerIdsOf(k.state).slice(-1).concat(reviewerIdsOf(k.state).slice(-2, -1));
        // Pin R1 as the newer review in SQL, so the order never depends on the clock.
        k.state.db.prepare(`UPDATE managed_threads SET created_at=(SELECT created_at FROM managed_threads WHERE thread_id=?)+1000 WHERE thread_id=?`).run(r2, r1);
        return { chief, w2, r1: r1!, r2: r2! };
      };
      await run("chain order: the newer review is busy", async (k) => {
        const { chief, w2 } = await chain(k);
        await k.attempt("chief_review on W2 reuses the newest busy review", k.review(chief, { workerThreadId: w2 }));
        await k.attempt("chief_complete with skipReview on W2 names the first busy review down its own chain", () => tool(k.state, "chief_complete", { threadId: w2, skipReview: "chain order", testsSkipped: "chain order" }, chief));
      });
      await run("chain order: the newer review is idle, the older one busy", async (k) => {
        const { chief, w2, r1 } = await chain(k);
        await report(k.state, r1, { state: "ready", result: "Looks right", ...APPROVE });
        await k.attempt("chief_review on W2 reuses the busy review, not the newer idle one", k.review(chief, { workerThreadId: w2 }));
      });
      // 8.2 Ancestry against a real local repository (c0 -> c1 -> c2, a diverged c3, and a sha the repository does not have).
      for (const [label, previous] of [["an ancestor", "c1"], ["a diverged commit", "c3"], ["a missing commit", "missing"]] as const) {
        await run(`real ancestry: the previous head is ${label}`, async (k) => {
          const chief = await k.chief();
          const w1 = await k.worker("W1", chief, { prUrl: PR });
          k.forge.sha = previous === "missing" ? SHA_F : k.local[previous];
          await k.reviewed(chief, w1, "R1");
          k.forge.sha = k.local.c2;
          await k.attempt("second review pinned at c2", k.review(chief, { workerThreadId: w1 }), { reviewers: ["R2"] });
        }, "local");
      }
      // 8.4 No reusable environment, and the order of the refusals.
      await run("no reusable environment: a single target with a pull request, gh fails", async (k) => {
        const chief = await k.chief();
        const w1 = await k.worker("W1", chief, { prUrl: PR });
        k.forge.unreadable.add("8");
        k.state.live.set(w1, { ...k.state.live.get(w1)!, environmentId: null } as any);
        await k.attempt("review", k.review(chief, { workerThreadId: w1 }));
      });
      await run("refusal order: no reusable environment before a target with no head and no branch", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1);
        await k.wave("W2", c, 3);
        k.state.live.set(a, { ...k.state.live.get(a)!, environmentId: null } as any);
        await k.attempt("plan review", k.review(c.chief, { workerThreadId: a }));
      });
      await run("refusal order: a busy target before a target with no head and no branch", async (k) => {
        const c = await k.branches();
        const a = await k.wave("W1", c, 1, { branch: "feature/a" });
        await k.wave("W2", c, 3);
        setLive(k.state, a, "active");
        await k.attempt("plan review", k.review(c.chief, { workerThreadId: a }), { fake: true });
      });
      return blocks.join("\n");
    };
    // <review-attempt-oracle-end>

    // Plan chains changed one thing of the base snapshot: a pinned reviewer's fetch line now also checks the pinned commit out detached (`git fetch origin <branch> && git checkout --detach <sha>`).
    test("review attempt oracle", async () => {
      const head = await reviewAttemptFixture();
      // The make-native reviewer line follows each of the 31 reviewer prompts' "Classify the change" line; the rest is base's bytes.
      expect(head).toBe(withReviewerLine(await snapshotText("review-attempt-cf92d9c.txt"), 31));
    }, 300_000);

    // A host lookup that never answers no longer holds chief_review (#177): the ancestry check's 20 s deadline covers the
    // lookup, then the impact slice's 30 s deadline covers its own lookup, and the review launches on the whole pull request
    // with both skip reasons. Regression: dropping either deadline holds the call past 50 s (no reviewer, call unsettled).
    test("review attempt: a pending host lookup skips ancestry at 20 s and the slice at 50 s, and chief_review launches", async () => {
      const PR = "https://github.com/acme/shop/pull/8";
      let held = false;
      let lookups = 0;
      const answer = { primaryHostId: "host_1" };
      const state = await setup({
        projectPath: "/oracle/checkout",
        system: { usageLimits: async () => ({}), config: () => held ? new Promise(() => { lookups += 1; }) : Promise.resolve(answer) },
      });
      let sha = HEAD_SHA;
      execFileMock.mockImplementation(async (file: string, args: string[]) => {
        if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: sha, baseRefName: "main" }), stderr: "" };
        throw new Error(`unexpected CLI ${file}`);
      });
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", prUrl: PR }, chief);
      const w1 = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, w1);
      await tool(state, "chief_review", { workerThreadId: w1 }, chief);
      const reviewer = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer'`).get() as any).thread_id as string;
      await report(state, reviewer, { state: "ready", result: "Looks right", ...APPROVE });

      // The second review reaches the ancestry check (the previous head differs from the new one); every host lookup now hangs.
      sha = "b".repeat(40);
      held = true;
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      try {
        let settled = false;
        const call = tool(state, "chief_review", { workerThreadId: w1 }, chief).finally(() => { settled = true; });
        const step = async (seconds: number) => {
          for (let i = 0; i < seconds; i++) {
            await vi.advanceTimersByTimeAsync(1_000);
            await new Promise((resolve) => setImmediate(resolve));
          }
        };
        const reviewers = () => state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'`).get();
        const nextReviewer = `thr_${state.spawned.length + 1}`;
        await step(19); // inside the ancestry deadline: only the ancestry lookup has started
        expect({ lookups, settled, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 1, settled: false, spawned: 3, reviewers: { n: 1 } });
        await step(2); // the ancestry deadline passed at 20 s: the impact slice's own lookup has started
        expect({ lookups, settled, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 2, settled: false, spawned: 3, reviewers: { n: 1 } });
        await step(28); // inside the slice's 30 s deadline (49 s in total): still no reviewer
        expect({ lookups, settled, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 2, settled: false, spawned: 3, reviewers: { n: 1 } });
        await step(2); // the slice's deadline passed at 50 s: the review launches with no host answer
        expect({ lookups, spawned: state.spawned.length, reviewers: reviewers() }).toEqual({ lookups: 2, spawned: 4, reviewers: { n: 2 } });
        const reply = await call;
        expect(reply).toContain(`Impact slice skipped: ${w1}: deadline (30 s) passed.`);
        expect(reply).toContain(`Review scope: ${w1}: whole pull request (deadline (20 s) passed).`);
        const context = await reviewContextOf(state, nextReviewer);
        expect(context).toContain("## The previous review (");
        expect(context).toContain("Skipped: deadline (30 s) passed.");
      } finally { vi.useRealTimers(); }
    }, 120_000);

    // Handler contract: chief_review is Chief-only. The review attempt module no longer guards its caller, so the real
    // handler's requireChiefCaller is the only refusal. Regression: dropping or moving that guard lets a worker (or an
    // unregistered thread) start a reviewer.
    test("review attempt: chief_review is refused for a managed worker and an unregistered caller, with no reviewer started", async () => {
      const state = await setup();
      const chief = (await start(state)).threadId;
      await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture" }, chief);
      const w1 = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as any).thread_id as string;
      await readyIdle(state, w1);
      const spawnedBefore = state.spawned.length;
      const asCaller = (threadId: string) => state.harness.behavior.callAgentTool("chief_review", { workerThreadId: w1 }, { threadId, projectId: "proj_1" });
      await expect(asCaller(w1)).rejects.toThrow("chief_review is for the active Chief only: a managed worker reports ready with chief_report, and Chief starts the review.");
      await expect(asCaller("thr_unregistered")).rejects.toThrow("chief_review is for the active Chief only: ask the active Chief to start it.");
      expect(state.spawned).toHaveLength(spawnedBefore);
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'`).get()).toEqual({ n: 0 });
    });
  });
});

// Forge comments (wave 2): the callers in server.ts reach the outbox through the real gh adapter, so every test routes the
// forge CLI at the execFile boundary. The same assertions hold on the pre-move base (c8a0d76) and on the module.
describe("forge comments", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const PR = "https://github.com/acme/shop/pull/8";
  const markerOf = (key: string) => `<!-- chief:${createHash("sha1").update(key).digest("hex").slice(0, 16)} -->`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (done: () => unknown) => { for (let i = 0; i < 300 && !done(); i += 1) await sleep(5); expect(done()).toBeTruthy(); };
  const call = (state: State, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, projectId: "proj_1" }) as Promise<any>;
  const rows = (state: State) => state.db.prepare(`SELECT * FROM forge_comments ORDER BY created_at, dedupe_key`).all() as any[];
  const rowOf = (state: State, id: string) => state.db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(id) as any;
  const forgeCalls = () => execFileMock.mock.calls.filter(([file, args]) => file === "gh" && args[0] === "api");
  const postCalls = () => forgeCalls().filter(([, args]) => args.includes("POST"));
  const bodyOf = (args: string[]) => args.find((arg) => arg.startsWith("body="))!.slice(5);
  const never = () => new Promise<never>(() => {});
  const bad = () => Object.assign(new Error("gh failed"), { stderr: "HTTP 502 bad gateway" });
  /** gh answers pull-request lookups as the other tests do; `forge` decides what the comment API does. */
  const route = (forge: (args: string[]) => unknown) => execFileMock.mockImplementation(async (file: string, args: string[]) =>
    file === "gh" && args[0] === "api" ? forge(args) : file === "gh" && args[0] === "pr" ? { stdout: ghHead("feature/x") } : { stdout: "" });
  const ISSUE = "https://github.com/acme/shop/issues/7";
  // The pre-move code caches a forge login per host for the whole process, so any case that reaches a login lookup runs on a host
  // of its own: the same assertions then hold on base and on the module, whatever ran before.
  let hostCount = 0;
  const freshHost = () => `forge${hostCount += 1}.example.com`;
  const prOn = (host: string) => `https://${host}/acme/shop/pull/8`;
  type Op = "post" | "scan" | "login";
  const opOf = (args: string[]): Op => args.includes("POST") ? "post" : args.includes("--paginate") ? "scan" : "login";
  const callsOf = (op: Op) => forgeCalls().filter(([, args]) => opOf(args) === op);
  const ANSWERS: Record<Op, unknown> = { post: { stdout: "" }, scan: { stdout: "" }, login: { stdout: "boss\n" } };
  /** Every comment call answers normally, except the operations `override` takes over. */
  const routeOps = (override: Partial<Record<Op, (args: string[]) => unknown>> = {}) =>
    route((args) => (override[opOf(args)] ?? (() => ANSWERS[opOf(args)]))(args));
  /** A comment call that stays unresolved until `release()`, then answers as a healthy forge would. */
  const gate = (op: Op) => { let release!: () => void; const held = new Promise((resolve) => { release = () => resolve(ANSWERS[op]); }); return { held, release }; };
  const alerts = (state: State, text: string) => state.sent.filter((message) => String(message.input?.[0]?.text).includes(text));
  const sentText = (state: State, from: number) => state.sent.slice(from).map((message) => ({ threadId: message.threadId, text: message.input[0].text }));

  async function blockedWorker(state: State, forge: { issueUrl?: string; prUrl?: string } = { prUrl: PR }) {
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix totals", forge);
    return { chief, worker, act: () => call(state, "chief_report", { state: "blocked", result: "Tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" }, worker.threadId) };
  }
  const readyWorker = async (state: State, forge?: { issueUrl?: string; prUrl?: string }) => {
    const { chief, worker } = await blockedWorker(state, forge);
    await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    return { chief, worker };
  };

  /** What a caller owes its own user whatever the forge does: its returned text, its committed state and the full Report to its Chief. */
  type Scenario = {
    chief: string; prefix: string; act: () => Promise<unknown>; result: string;
    /** The managed row the report or completion changes, and the fields it must hold afterwards. */
    row: { id: string; fields: object };
    /** The one Report alert Chief receives, in full; null when the caller sends none. */
    report: { from: string; text: string } | null;
  };
  const CALLERS: [string, (state: State, pr: string) => Promise<Scenario>][] = [
    ["blocked report", async (state, pr) => {
      const { chief, worker, act } = await blockedWorker(state, { prUrl: pr });
      return {
        chief: chief.threadId, prefix: "blocked:", act, result: "Report delivered to Chief.",
        row: { id: worker.threadId, fields: { state: "blocked", last_report_state: "blocked", report_seq: 1, blocker: "Totals test fails", recommendation: "Fix the product code", result: "Tests fail" } },
        report: { from: worker.threadId, text: `[Chief lifecycle alert]\nWorker report from Fix totals (${worker.threadId})\nState: blocked\nBlocked: Totals test fails — decide or escalate to the user.\nBlocker: Totals test fails\nRecommendation: Fix the product code\nResult: Tests fail` },
      };
    }],
    ["reviewer verdict", async (state, pr) => {
      const { chief, worker } = await readyWorker(state, { prUrl: pr });
      const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
      return {
        chief: chief.threadId, prefix: "verdict:", act: () => call(state, "chief_report", { state: "ready", result: "Reviewed", ...APPROVE }, review.threadId), result: "Report delivered to Chief.",
        row: { id: review.threadId, fields: { state: "ready", verdict: "approve", last_report_state: "ready", report_seq: 1, result: "Reviewed" } },
        report: { from: review.threadId, text: `[Chief lifecycle alert]\nReviewer report from Review · Fix totals (${review.threadId})\nState: ready\nVerdict: approve\nVerdict file: ${join(state.storageRoot, "chief", "proj_1", review.threadId, "verdict-1.md")}\nThe reviewer approves. chief_complete (threadId: ${worker.threadId}); it marks the pull request ready. Nits listed with an approve are optional: start no worker round for them alone.\nFull report and last output: bb chief inspect ${review.threadId}\nResult: Reviewed` },
      };
    }],
    ["completion", async (state, pr) => {
      const { chief, worker } = await readyWorker(state, { prUrl: pr });
      return {
        chief: chief.threadId, prefix: "complete:", act: () => completeWorker(state, chief.threadId, worker.threadId),
        result: "Marked “Fix totals” complete without a review (reason recorded).\nIts pull request is marked ready for review.\nNo cleanup: no approving review.",
        row: { id: worker.threadId, fields: { state: "complete", last_report_state: "ready", report_seq: 1, result: `Done${NO_DEVIATIONS}` } },
        report: null,
      };
    }],
  ];
  const reporterOutbox = (state: State, reporter: string) =>
    state.db.prepare(`SELECT dedupe_key, delivered_at FROM alert_outbox WHERE dedupe_key LIKE ?`).all(`${reporter}:report:%`) as { dedupe_key: string; delivered_at: number | null }[];
  /** The caller's own work, as base produces it: asserted while a forge call is unresolved, and again after it settles. */
  function expectRequiredWork(state: State, scenario: Scenario, sentBefore: number, outboxBefore: number) {
    expect(rowOf(state, scenario.row.id)).toMatchObject(scenario.row.fields);
    expect(sentText(state, sentBefore)).toEqual(scenario.report ? [{ threadId: scenario.chief, text: scenario.report.text }] : []);
    if (!scenario.report) return;
    // The full Report replaced its pending fallback in the outbox and was marked delivered.
    const outbox = reporterOutbox(state, scenario.report.from);
    expect(outbox).toHaveLength(outboxBefore + 1);
    expect(outbox.filter((entry) => entry.dedupe_key.includes("pending-"))).toEqual([]);
    expect(outbox.every((entry) => entry.delivered_at)).toBe(true);
  }
  const SEED_ROW = (state: State, chief: string, target: string, attempts: number, mention: number) => {
    const key = `escalate:${chief}:seeded`;
    state.db.prepare(`INSERT INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, attempts, created_at) VALUES (?, 'proj_1', ?, ?, ?, ?, ?, ?)`)
      .run(key, chief, target, `seeded body\n\n${markerOf(key)}`, mention, attempts, Date.now() - 60_000);
    return key;
  };
  // Which comment operation each case holds up: post is the caller's own new row; a leftover row with earlier attempts reaches
  // the marker scan first; a leftover row that wants a mention reaches the login lookup first. Both leftovers sit ahead of the new row.
  const OPS: { op: Op; seed: [attempts: number, mention: number] | null; held: { seeded: number; caller: number; calls: [post: number, scan: number, login: number] }; rejected: { seeded: number; calls: [number, number, number] } }[] = [
    { op: "post", seed: null, held: { seeded: 0, caller: 1, calls: [1, 0, 0] }, rejected: { seeded: 0, calls: [1, 0, 0] } },
    { op: "scan", seed: [1, 0], held: { seeded: 2, caller: 0, calls: [0, 1, 0] }, rejected: { seeded: 2, calls: [1, 1, 0] } },
    { op: "login", seed: [0, 1], held: { seeded: 1, caller: 0, calls: [0, 0, 1] }, rejected: { seeded: 1, calls: [2, 0, 1] } },
  ];
  const SCAN_ARGS = (host: string) => ["api", "--hostname", host, "--paginate", "repos/acme/shop/issues/8/comments", "--jq", ".[].body"];
  const LOGIN_ARGS = (host: string) => ["api", "--hostname", host, "user", "--jq", ".login"];

  // Contract "Required result never waits on optional work (R3)": while a post, a marker scan or a login lookup is unresolved,
  // each caller returns the text it returns on base, holds its committed state, and has delivered its full Report to its Chief.
  // Releasing the call lets delivery resume. Regression: a caller awaits a comment call, the call runs inside the transaction,
  // or the Report is left at its pending fallback.
  describe.each(OPS)("while a comment $op call is unresolved", ({ op, seed, held }) => {
    test.each(CALLERS)("%s returns, commits and reports in full, and delivery resumes on release", async (_name, build) => {
      const state = await setup();
      const hold = gate(op);
      routeOps({ [op]: () => hold.held });
      const host = freshHost();
      const scenario = await build(state, prOn(host));
      const seeded = seed ? SEED_ROW(state, scenario.chief, prOn(host), ...seed) : null;
      const sentBefore = state.sent.length;
      const outboxBefore = scenario.report ? reporterOutbox(state, scenario.report.from).length : 0;
      const rowOfKey = (key: string | undefined) => rows(state).find((row) => row.dedupe_key === key);
      const callerKey = () => rows(state).find((row) => row.dedupe_key.startsWith(scenario.prefix))?.dedupe_key;
      try {
        expect(await scenario.act()).toBe(scenario.result);
        expectRequiredWork(state, scenario, sentBefore, outboxBefore);
        // The stuck call was really reached, and nothing past it ran.
        await until(() => callsOf(op).length === 1);
        await until(() => (rowOfKey(seeded ?? callerKey())?.attempts ?? 0) === (seeded ? held.seeded : held.caller));
        expect([callsOf("post").length, callsOf("scan").length, callsOf("login").length]).toEqual(held.calls);
        expect(rowOfKey(callerKey())).toMatchObject({ attempts: held.caller, posted_at: null, gave_up_at: null });
        // A supervisor tick neither waits for the stuck pass nor starts a second call.
        await state.supervisorCycle();
        expect([callsOf("post").length, callsOf("scan").length, callsOf("login").length]).toEqual(held.calls);
        expectRequiredWork(state, scenario, sentBefore, outboxBefore);
      } finally {
        hold.release();
      }
      await until(() => rows(state).length > 0 && rows(state).every((row) => row.posted_at));
      expectRequiredWork(state, scenario, sentBefore, outboxBefore);
      const callerBody = rowOfKey(callerKey())!.body;
      const seededBody = seed ? `seeded body\n\n${seed[1] ? "@boss\n\n" : ""}${markerOf(seeded!)}` : null;
      expect(postCalls().map(([, args]) => bodyOf(args))).toEqual(seededBody ? [seededBody, callerBody] : [callerBody]);
      if (op === "scan") expect(callsOf("scan").map(([, args]) => args)).toEqual([SCAN_ARGS(host)]);
      if (op === "login") expect(callsOf("login").map(([, args]) => args)).toEqual([LOGIN_ARGS(host)]);
    });
  });

  // Same contract, with every comment call failing: the callers are unchanged, and each row records the failed attempt.
  describe.each(OPS)("while every comment call fails, with a $op operation reached", ({ seed, rejected }) => {
    test.each(CALLERS)("%s returns, commits and reports in full", async (_name, build) => {
      const state = await setup();
      const fail = () => { throw bad(); };
      routeOps({ post: fail, scan: fail, login: fail });
      const host = freshHost();
      const scenario = await build(state, prOn(host));
      const seeded = seed ? SEED_ROW(state, scenario.chief, prOn(host), ...seed) : null;
      const sentBefore = state.sent.length;
      const outboxBefore = scenario.report ? reporterOutbox(state, scenario.report.from).length : 0;
      expect(await scenario.act()).toBe(scenario.result);
      expectRequiredWork(state, scenario, sentBefore, outboxBefore);
      await until(() => rows(state).length > (seed ? 1 : 0) && rows(state).every((row) => row.last_error));
      const caller = rows(state).find((row) => row.dedupe_key.startsWith(scenario.prefix));
      expect(caller).toMatchObject({ attempts: 1, posted_at: null, gave_up_at: null, last_error: expect.stringContaining("502") });
      if (seeded) expect(rows(state).find((row) => row.dedupe_key === seeded)).toMatchObject({ attempts: rejected.seeded, posted_at: null, gave_up_at: null, last_error: expect.stringContaining("502") });
      expect([callsOf("post").length, callsOf("scan").length, callsOf("login").length]).toEqual(rejected.calls);
      expectRequiredWork(state, scenario, sentBefore, outboxBefore);
    });
  });

  // Contract "Equivalence of stored rows": for fixed inputs through the real callers, the stored row and the POSTed comment are
  // these literals (written by hand from the base behaviour, never produced by the code under test): key form, project, thread,
  // target choice, body, mention flag, mention placement and the marker as the last line. The same table runs on base c8a0d76.
  // Regression: any changed title, round, line, detail text, key, target choice or mention position.
  type Golden = { key: string; thread: string; target: string; body: string; mention: 0 | 1; post?: string; path?: string; host?: string };
  const GOLDENS: [string, (state: State) => Promise<{ act: () => Promise<unknown>; golden: Golden }>][] = [
    ["blocked report (target: the pull request over the issue)", async (state) => {
      const { worker, act } = await blockedWorker(state, { issueUrl: ISSUE, prUrl: PR });
      const key = `blocked:${worker.threadId}:1`;
      return { act, golden: { key, thread: worker.threadId, target: PR, mention: 0, body: `**Chief · Blocked** · round 1\n**Blocker:** Totals test fails\n**Recommendation:** Fix the product code\n\n${markerOf(key)}` } };
    }],
    ["reviewer verdict of a worker (request_changes with findings, round and reviewed head)", async (state) => {
      const { chief, worker } = await readyWorker(state, { issueUrl: ISSUE, prUrl: PR });
      const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
      const key = `verdict:${review.threadId}:1:${worker.threadId}`;
      return {
        act: () => call(state, "chief_report", {
          state: "ready", result: "Totals go negative when the discount exceeds the subtotal.", recommendation: "Clamp at zero.", verdict: "request_changes",
          findings: [{ file: "totals.ts", line: 1, severity: "blocking", message: "Totals go negative." }, { file: "totals.ts", line: 9, severity: "nit", message: "Rename tmp." }],
        }, review.threadId),
        golden: {
          key, thread: review.threadId, target: PR, mention: 0,
          body: `**Chief · Review verdict** · round 1\n**Changes requested**\nReviewed head: \`aaaaaaaaaaaa\`\n1 blocking finding, 1 nit\n\n<details><summary>Findings and recommendation</summary>\n\n### Blocking findings\n\n- totals.ts:1 — Totals go negative.\n\n### Nits\n\n- totals.ts:9 — Rename tmp.\n\n### Findings\n\nTotals go negative when the discount exceeds the subtotal.\n\n### Recommendation\n\nClamp at zero.\n\n</details>\n\n${markerOf(key)}`,
        },
      };
    }],
    ["reviewer verdict of a pull request (approve, no worker in the key, no round)", async (state) => {
      const { chief } = await blockedWorker(state);
      const review = await chiefReview(state, chief.threadId, { pullRequest: PR });
      const key = `verdict:${review.threadId}:1`;
      return {
        act: () => call(state, "chief_report", { state: "ready", result: "Reviewed", ...APPROVE }, review.threadId),
        golden: { key, thread: review.threadId, target: PR, mention: 0, body: `**Chief · Review verdict**\n**Approved**\n0 blocking findings, 0 nits\n\n<details><summary>Findings and recommendation</summary>\n\n### Findings\n\nReviewed\n\n</details>\n\n${markerOf(key)}` },
      };
    }],
    ["completion (target: the issue over the pull request)", async (state) => {
      const { chief, worker } = await readyWorker(state, { issueUrl: ISSUE, prUrl: PR });
      const key = `complete:${worker.threadId}`;
      return {
        act: () => completeWorker(state, chief.threadId, worker.threadId),
        golden: {
          key, thread: worker.threadId, target: ISSUE, mention: 0, path: "repos/acme/shop/issues/7/comments",
          body: `**Chief · Completed** · round 1\n**Fix totals**\nPull request: ${PR}\n**Planning skipped:** Bounded test fixture\n**Review skipped:** review is not under test here\n**Tests skipped:** tests are not under test here\n\n<details><summary>Result</summary>\n\nDone\n\n## Deviations from plan\nNone\n\n</details>\n\n${markerOf(key)}`,
        },
      };
    }],
    ["escalation (configured handle: the mention line sits before the marker, the stored body has none)", async (state) => {
      await state.harness.behavior.setSettings({ forgeOwnerHandle: "@boss" });
      const { chief, worker } = await blockedWorker(state);
      const request = "Pick a currency rounding rule.";
      const key = `escalate:${worker.threadId}:${createHash("sha1").update(request).digest("hex").slice(0, 12)}`;
      return {
        // The same request twice: one row, one post.
        act: async () => {
          const first = await call(state, "chief_escalate", { threadId: worker.threadId, request }, chief.threadId);
          const second = await call(state, "chief_escalate", { threadId: worker.threadId, request }, chief.threadId);
          expect([first, second]).toEqual(Array(2).fill(`Queued for ${PR}. Now write the same request in chat under **Need you**.`));
        },
        golden: { key, thread: worker.threadId, target: PR, mention: 1, body: `**Chief · Need you**\n${request}\n\n${markerOf(key)}`, post: `**Chief · Need you**\n${request}\n\n@boss\n\n${markerOf(key)}` },
      };
    }],
    ["escalation (no configured handle: the forge login is the mention)", async (state) => {
      const host = freshHost();
      const { chief, worker } = await blockedWorker(state, { prUrl: prOn(host) });
      const request = "Choose between the two migrations.";
      const key = `escalate:${worker.threadId}:${createHash("sha1").update(request).digest("hex").slice(0, 12)}`;
      return {
        act: () => call(state, "chief_escalate", { threadId: worker.threadId, request }, chief.threadId),
        golden: { key, thread: worker.threadId, target: prOn(host), host, mention: 1, body: `**Chief · Need you**\n${request}\n\n${markerOf(key)}`, post: `**Chief · Need you**\n${request}\n\n@boss\n\n${markerOf(key)}` },
      };
    }],
  ];
  test.each(GOLDENS)("%s stores and posts the golden comment once", async (_name, build) => {
    const state = await setup();
    routeOps();
    const { act, golden } = await build(state);
    await act();
    await until(() => rows(state).length && rows(state).every((row) => row.posted_at));
    expect(rows(state).map(({ dedupe_key, project_id, thread_id, target, body, mention }) => ({ dedupe_key, project_id, thread_id, target, body, mention })))
      .toEqual([{ dedupe_key: golden.key, project_id: "proj_1", thread_id: golden.thread, target: golden.target, body: golden.body, mention: golden.mention }]);
    expect(golden.body.endsWith(`\n\n${markerOf(golden.key)}`)).toBe(true);
    expect(postCalls().map(([file, args]) => [file, args])).toEqual([["gh", ["api", "--hostname", golden.host ?? "github.com", "--method", "POST", golden.path ?? "repos/acme/shop/issues/8/comments", "-f", `body=${golden.post ?? golden.body}`]]]);
    // A later pass finds nothing pending.
    await state.supervisorCycle();
    await sleep(20);
    expect(postCalls()).toHaveLength(1);
  });

  // Contract "Rolled-back transaction writes nothing": the verdict/blocked row is enqueued inside report()'s transaction.
  // Regression: the post is started before the commit, or the row survives the rollback.
  test("a report whose transaction rolls back queues no row and posts nothing", async () => {
    const state = await setup();
    route(() => ({ stdout: "" }));
    const { worker, act } = await blockedWorker(state);
    state.db.exec(`DROP TABLE alert_outbox`);
    await expect(act()).rejects.toThrow();
    await sleep(30);
    expect(rows(state)).toEqual([]);
    expect(forgeCalls()).toHaveLength(0);
    expect(rowOf(state, worker.threadId).state).not.toBe("blocked");
  });

  // Contract "enqueue defers the alert": a queue-write failure never fails the report; Chief hears of it after the commit.
  test("a failed queue write leaves the report intact and alerts Chief", async () => {
    const state = await setup();
    route(() => ({ stdout: "" }));
    const { worker, act } = await blockedWorker(state);
    state.db.exec(`DROP TABLE forge_comments`);
    await act();
    expect(rowOf(state, worker.threadId).state).toBe("blocked");
    await until(() => alerts(state, "Could not queue the forge comment blocked").length);
    expect(alerts(state, "The local record is intact.")).not.toHaveLength(0);
    expect(forgeCalls()).toHaveLength(0);
  });

  // Contract "Exactly one escalation" + inherited limits: a row left at attempts=5 by an earlier process runs again at once
  // as attempt 6 on a fresh instance, scans first, and escalates once with the "after 5 attempts" text. These are limits kept, not fixed.
  test("a row left at 5 attempts retries at once after a restart, escalates once, and is then terminal", async () => {
    const state = await setup();
    const { worker } = await blockedWorker(state);
    const key = `blocked:${worker.threadId}:9`;
    state.db.prepare(`INSERT INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, attempts, created_at) VALUES (?, 'proj_1', ?, ?, ?, 0, 5, ?)`)
      .run(key, worker.threadId, PR, `body\n\n${markerOf(key)}`, Date.now());
    const order: string[] = [];
    route((args) => {
      if (args.includes("POST")) { order.push("post"); throw bad(); }
      order.push("scan");
      return { stdout: "" };
    });
    await state.supervisorCycle();
    await until(() => rows(state)[0]?.gave_up_at);
    expect(order).toEqual(["scan", "post"]);
    expect(rows(state)[0]).toMatchObject({ attempts: 6, posted_at: null });
    await until(() => alerts(state, "after 5 attempts").length === 1);
    await state.supervisorCycle();
    await sleep(30);
    expect(forgeCalls()).toHaveLength(2);
    expect(alerts(state, "after 5 attempts")).toHaveLength(1);
  });

  test("a row that exhausts its attempts for a thread with no Chief is logged as an error, not alerted", async () => {
    const state = await setup();
    const { worker } = await blockedWorker(state);
    state.db.prepare(`UPDATE managed_threads SET chief_thread_id=NULL WHERE thread_id=?`).run(worker.threadId);
    const key = `blocked:${worker.threadId}:9`;
    state.db.prepare(`INSERT INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, attempts, created_at) VALUES (?, 'proj_1', ?, ?, ?, 0, 4, ?)`)
      .run(key, worker.threadId, PR, `body\n\n${markerOf(key)}`, Date.now());
    route((args) => { if (args.includes("POST")) throw bad(); return { stdout: "" }; });
    await state.supervisorCycle();
    await until(() => state.harness.logEntries.some((entry) => entry.level === "error" && entry.message.includes("after 5 attempts")));
    expect(alerts(state, "after 5 attempts")).toHaveLength(0);
  });

  // Contract "Table persistence and migration index": the host hashes each migration statement by index and refuses a mismatch,
  // so the statement list keeps its base prefix byte for byte and forge_comments stays at index 114.
  // The digests were computed on base c8a0d76. Regression: a statement before index 114 moves or changes, or the table text drifts.
  test("the migration prefix and the forge_comments statement match the base bytes", () => {
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(131);
    expect(sha256(JSON.stringify(MIGRATIONS.slice(0, 131)))).toBe("06d2542eb36bce964295e9664ed9ce6670c59f03bf1bd605a5bae6092acfa6ba");
    expect(MIGRATIONS[114]).toMatch(/^CREATE TABLE forge_comments/);
    expect(sha256(MIGRATIONS[114]!)).toBe("a3417ec24942a9bbcebd37d78f81c24adfc436e63223e91291d30553a718982c");
  });

  const upgradeHost = () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade" });
    disposals.push(() => harness.lifecycle.dispose());
    return { bb, db: bb.storage.database() };
  };
  // Contract "Persisted format unchanged": a database migrated before forge_comments upgrades without losing its rows, and the
  // unchanged full statement list replays on the migrated database without error and without changing schema or data.
  // Regression: the upgrade drops or rewrites an existing row, or replaying the same list re-runs or re-records a statement.
  test("a database migrated before forge_comments upgrades with its rows intact, and replaying the full list changes nothing", () => {
    const { bb, db } = upgradeHost();
    bb.storage.migrate(db, MIGRATIONS.slice(0, 114));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='forge_comments'`).get()).toBeUndefined();
    db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, title, state, created_at, updated_at) VALUES ('thr_keep', 'worker', 'proj_1', 'Keep me', 'ready', 1, 2)`).run();

    bb.storage.migrate(db, MIGRATIONS);
    expect(db.prepare(`SELECT name FROM pragma_table_info('forge_comments') ORDER BY cid`).all().map((column: any) => column.name))
      .toEqual(["dedupe_key", "project_id", "thread_id", "target", "body", "mention", "attempts", "last_error", "posted_at", "gave_up_at", "created_at"]);
    // Statements after the table (ALTER managed_threads) ran over the existing row, which kept its values.
    expect(db.prepare(`SELECT thread_id, role, project_id, title, state, created_at, updated_at, plan_issue_url, plan_review FROM managed_threads`).all())
      .toEqual([{ thread_id: "thr_keep", role: "worker", project_id: "proj_1", title: "Keep me", state: "ready", created_at: 1, updated_at: 2, plan_issue_url: null, plan_review: null }]);

    const snapshot = () => {
      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((table) => table.name);
      return {
        schema: db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all(),
        data: Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()])),
      };
    };
    const migrated = snapshot();
    expect(migrated.data._bb_migrations).toHaveLength(MIGRATIONS.length);
    expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();
    expect(snapshot()).toEqual(migrated);
  });

  // The host refuses to start on a statement whose bytes changed at an applied index; that is a separate promise from the replay above.
  test("the host refuses a changed forge_comments statement on a migrated database", () => {
    const { bb, db } = upgradeHost();
    bb.storage.migrate(db, MIGRATIONS);
    const changed = MIGRATIONS.map((statement, index) => index === 114 ? `${statement} ` : statement);
    expect(() => bb.storage.migrate(db, changed)).toThrow(/migration 114 does not match/);
  });
});

// ---- Tool-call stability (plan thr_g9mqzq4cy9, wave 2): preload line, provider env, optional title ----
// Contract: tool-config oracle. The block below was run unchanged against base 7178582 to capture
// __snapshots__/tool-config-7178582.txt; only the storage root is normalized. It builds every role's configuration
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
  const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "tool-config-7178582.txt");
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
  // gains the optional boolean `merge` (tracker spec), the only schema change of that feature.
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
    for (const entry of now.entries) {
      const plainChief = entry.key.includes("| chief |");
      expect(entry.tools.includes("chief_coordinate"), entry.key).toBe(plainChief);
      if (!plainChief) continue;
      expect(entry.tools[entry.tools.indexOf("chief_spawn") + 1], entry.key).toBe("chief_coordinate");
      expect(entry.skills, entry.key).toEqual(["chief", "coordinator"]);
      entry.tools = entry.tools.filter((name) => name !== "chief_coordinate");
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
    now.entries.forEach((entry, index) => {
      const old = base.entries[index]!;
      expect(entry.tools, entry.key).toEqual(old.tools);
      expect(entry.skills, entry.key).toEqual(old.skills);
      expect(preloadLine(old), entry.key).toEqual([]);
      if (!entry.key.includes("| claude-code |")) { expect(entry.instructions, entry.key).toBe(old.instructions); return; }
      if (!entry.tools.length) { expect(entry.instructions, entry.key).toBe(old.instructions); return; }
      expect(preloadLine(entry), entry.key).toHaveLength(1);
      // Allowed differences (d) and (f): the base snapshot predates chief_sync; a plain Chief's preload asks for chief_sync and chief_coordinate on top of it.
      if (entry.key.includes("| chief |")) expect(preloadLine(entry)[0], entry.key).toMatch(new RegExp(`max_results ${old.tools.length + 2}$`));
      const without = entry.instructions!.split("\n").filter((line) => !line.includes("ToolSearch")).join("\n");
      if (entry.instructions!.length < 4096) expect(without, entry.key).toBe(old.instructions);
      else { cut += 1; expect(old.instructions!.startsWith(without), entry.key).toBe(true); }
    });
    // Only Chief's worst case reaches the cut, and it does so for every planner and research combination.
    expect(cut).toBeGreaterThan(0);
    expect(now.entries.filter((entry) => (entry.instructions ?? "").length === 4096).every((entry) => entry.key.startsWith("worst case | chief"))).toBe(true);
  });

  // Contract: no drift. The expected line is rebuilt from each entry's own configured tool names.
  // Regression: a hard-coded or stale tool list in the line, or a line built before the tools were chosen.
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

  // Contract: Chief budget on claude-code. Mirrors the 4096-char test above with the same worst-case inputs.
  // Regression: the preload line pushes a core rule past the cut, or pushes project rules ahead of the core.
  test.each([[5_000, 4], [32_000, 4], [5_000, 5_000]])("claude-code: a %i-char chief.md and a %i-char project name keep the preload line and Chief's core rules inside the 4096-char cut", async (size, nameLength) => {
    const marker = "# Project rules marker";
    const state = await setup({ rules: `${marker}\n${"- Project rule text.\n".repeat(Math.ceil(size / 21))}`.slice(0, size) });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: true });
    const chief = await start(state);
    const { instructions, tools } = await state.harness.behavior.resolveAgentConfiguration(claudeContext(chief.threadId, "N".repeat(nameLength)));
    expect(tools.map((tool) => tool.name)).toContain("chief_plan");
    expect(tools.map((tool) => tool.name)).toContain("chief_research");
    expect(instructions!.length).toBe(4096);
    const coreEnd = instructions!.indexOf("chief_escalate with the thread and the full request");
    expect(coreEnd).toBeGreaterThan(-1);
    expect(instructions!.indexOf(`max_results ${tools.length}`)).toBeGreaterThan(-1);
    expect(instructions!.indexOf("ToolSearch")).toBeLessThan(instructions!.indexOf("Call chief_roster at the start of every turn"));
    for (const part of [
      "# Chief core rules (always apply)", "Call chief_roster at the start of every turn", "never poll managed threads",
      "chief_plan first", "delegate every wave it lists right away",
      "chief_research is optional.", "or the doubtful evidence to chief_review.",
      "Guidance, not a rule", "Chief never edits code",
    ]) expect(instructions).toContain(part);
    expect(instructions!.indexOf(marker)).toBeGreaterThan(coreEnd);
  });

  // Contract: env contribution, this plugin only. The host merges contributions from other plugins (account-pool also
  // contributes ENABLE_TOOL_SEARCH and wins when it is first); this test proves only what Chief itself contributes.
  // Regression: contributing for unmanaged threads, for another provider, or not for a managed role.
  test("Chief's own ENABLE_TOOL_SEARCH contribution: claude-code, managed rows only (not the effective merged environment)", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = ctxOf(state, chief.threadId);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.runCli(["plan", "--title", "Rework", "--mission", "Propose"], opts);
    await state.harness.behavior.runCli(["consult", "--title", "Rework", "--mission", "Explore"], opts);
    await state.harness.behavior.callAgentTool("chief_review", { branch: "feature/x" }, opts);
    // Chief's chief_research spawns a real researcher row pinned to Chief's own provider and model.
    state.live.set(chief.threadId, { ...state.live.get(chief.threadId)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    await state.harness.behavior.callAgentTool("chief_research", { mode: "survey", question: "Who calls this?", items: ["a.ts"] }, opts);
    const managed = (await status(state)).threads.map((row) => row.threadId);
    expect([...new Set((await status(state)).threads.map((row) => row.role))].sort()).toEqual(["advisor", "chief", "planner", "researcher", "reviewer", "worker"]);
    const env = (providerId: string, threadId: string) => state.harness.behavior.resolveProviderEnv(providerId, { threadId, projectId: "proj_1", hostId: "host_1" });
    for (const threadId of managed) {
      expect(await env("claude-code", threadId), threadId).toEqual([expect.objectContaining({ name: "ENABLE_TOOL_SEARCH", value: "false" })]);
      expect(await env("claude-code", threadId)).toHaveLength(1);
      expect(await env("codex", threadId), threadId).toEqual([]);
    }
    expect(managed).toContain(worker.threadId);
    expect(await env("claude-code", "thr_other")).toEqual([]);
  });

  // Contract: README documents the env contribution as best-effort with both gaps (precedence and first session) and
  // names the preload line as the fallback. Guards the documented trade-off, not the surrounding prose.
  test("README documents the ENABLE_TOOL_SEARCH contribution as best-effort, with the precedence gap and the first-session gap", async () => {
    const readme = await readFile(join(dirname(fileURLToPath(import.meta.url)), "README.md"), "utf8");
    const paragraph = readme.split("\n").find((line) => line.includes("ENABLE_TOOL_SEARCH"))!;
    expect(paragraph).toBeDefined();
    expect(paragraph).toMatch(/best-effort/i);
    expect(paragraph).toMatch(/another plugin's provider-env value[^.]*may win/);
    expect(paragraph).toMatch(/first session can start before Chief records the thread/);
    expect(paragraph).toMatch(/preload instruction line is the fallback/);
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

// Chief's checkout is fast-forwarded before a researcher or planner reads it, and their reports say which commit they read.
// Real git runs against local bare remotes; every other CLI is refused. Git goes through execFileMock so each call is recorded
// with the number of threads spawned when it started, and so a test can hold one the way a slow network would.
describe("checkout freshness", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const PRIMARY = { config: async () => ({ primaryHostId: "host_1" }), usageLimits: async () => ({}) };
  const CTX = { projectId: "proj_1" };
  const SURVEY = (question: string) => ({ mode: "survey", question, items: ["a.ts"] });
  const FIRST_LINE = /^Started researcher thread thr_\d+ \(.*\)\. It runs the survey in your checkout and reports through chief_report; the report arrives as a lifecycle alert\. Do not poll: end your turn\.$/;
  const WARNING = /^Did not fast-forward your checkout to origin\/(main|the default branch): .+\. The (researcher|planner) reads it as it is\.$/;

  let realExecPromise: Promise<(file: string, args: string[], options: object) => Promise<{ stdout: string; stderr: string }>> | undefined;
  const realExec = async () => realExecPromise ??= (async () => {
    const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return (await import("node:util")).promisify(childProcess.execFile) as any;
  })();
  const git = async (cwd: string, ...args: string[]) =>
    (await (await realExec())("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();

  /** A bare origin with c0 on main, `chief` (the checkout under test, at c0) and `other` (a second clone that pushes). */
  async function repos() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "chief-fresh-")));
    const origin = join(root, "origin.git");
    await git(root, "init", "-q", "--bare", "-b", "main", origin);
    const other = join(root, "other");
    await git(root, "clone", "-q", origin, other);
    await writeFile(join(other, "a.txt"), "c0\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-q", "-m", "c0");
    await git(other, "push", "-q", "origin", "HEAD:main");
    const chief = join(root, "chief");
    await git(root, "clone", "-q", "-b", "main", origin, chief);
    let n = 0;
    return {
      root, chief, c0: await git(chief, "rev-parse", "HEAD"),
      /** Pushes one more commit to origin/main from `other`; returns its SHA. */
      push: async (file = "a.txt") => {
        await writeFile(join(other, file), `change ${n += 1}\n`);
        await git(other, "add", "-A");
        await git(other, "commit", "-q", "-m", `change ${n}`);
        await git(other, "push", "-q", "origin", "HEAD:main");
        return git(other, "rev-parse", "HEAD");
      },
      head: () => git(chief, "rev-parse", "HEAD"),
    };
  }

  type GitCall = { args: string[]; cwd: string; spawned: number };
  /**
   * A Chief whose environment is the clone `r.chief` (default branch main, on the primary host), plus a recorder for every git call.
   * `projectPath` is the project source path the server compares with Chief's path to decide whether a planner shares it.
   * `hold` may return a promise that delays a git call, or rejects like execFile's killed child; it sees the call's options.
   */
  async function world(opts: { projectPath?: "clone" | string; env?: "all"; r?: Awaited<ReturnType<typeof repos>> } = {}) {
    const r = opts.r ?? await repos();
    const projectPath = opts.projectPath === "clone" ? r.chief : opts.projectPath;
    const state = await setup({ projectPath, system: PRIMARY });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const cfg = { env: { path: r.chief, defaultBranch: "main" } as Record<string, unknown>, hostId: "host_1", everyEnvironment: opts.env === "all" };
    state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
      id: environmentId, hostId: cfg.hostId, workspaceProvisionType: environmentId.startsWith("env_worker") ? "managed-worktree" : null,
      ...(cfg.everyEnvironment || environmentId.startsWith("env_default") ? cfg.env : {}),
    }));
    const chief = (await start(state)).threadId;
    state.live.set(chief, { ...state.live.get(chief)!, providerId: "codex" });
    state.setThreadExecution({ model: "gpt-6-astra" });
    const calls: GitCall[] = [];
    let inflight = 0;
    const hold: { git?: (args: string[], options: any) => Promise<void> | undefined } = {};
    const real = await realExec();
    execFileMock.mockImplementation((file: string, args: string[], options: any) => {
      if (file !== "git") return Promise.reject(new Error(`unexpected CLI ${file}`));
      calls.push({ args, cwd: options.cwd, spawned: state.spawned.length });
      inflight += 1;
      const run = (async () => { await hold.git?.(args, options); return real(file, args, options); })();
      run.then(() => { inflight -= 1; }, () => { inflight -= 1; });
      return run;
    });
    const ctx = { threadId: chief, ...CTX };
    const tool = (name: string, params: object) => state.harness.behavior.callAgentTool(name, params, ctx) as Promise<string>;
    let q = 0;
    const w = {
      r, state, chief, cfg, calls, hold, ctx,
      inflight: () => inflight,
      research: () => tool("chief_research", SURVEY(`Question ${q += 1}`)),
      plan: () => tool("chief_plan", { title: `Plan ${q += 1}`, mission: "Propose how to fix totals" }),
      cliPlan: (...extra: string[]) => state.harness.behavior.runCli(["plan", "--title", `Plan ${q += 1}`, "--mission", "Propose how to fix totals", ...extra], ctx),
      /** Threads spawned by the call under test, excluding Chief itself. */
      spawnedRole: (role: string) => state.spawned.filter((args: any) => args.pluginMetadata?.role === role),
      rows: (role: string) => (state.db.prepare("SELECT thread_id FROM managed_threads WHERE role=? ORDER BY rowid").all(role) as { thread_id: string }[]).map((row) => row.thread_id),
      setLive: (threadId: string, status: string) => state.live.set(threadId, { ...state.live.get(threadId)!, status } as any),
    };
    return w;
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** Exactly the base reply, then one warning line. */
  function expectWarned(reply: string, base: RegExp, reason: RegExp) {
    const lines = reply.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(base);
    expect(lines[1]).toMatch(WARNING);
    expect(lines[1]).toMatch(reason);
  }
  const RESEARCH_BASE = FIRST_LINE;
  const PLAN_BASE = /^Started planner “Plan · Plan \d+” in thread thr_\d+\. Its ready alert lists the wave schedule and the exact next call\.$/;
  const CLI_PLAN_BASE = /^Started planner “Plan · Plan \d+” in thr_\d+\.$/;
  const noWarning = (reply: string, base: RegExp) => { expect(reply).toMatch(base); expect(reply).not.toContain("Did not fast-forward"); };

  const flush = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  };
  /** A git call that never answers on its own: it fails when execFile's `timeout` option elapses, as a killed child does. */
  const killedAfterTimeout = (options: any) => new Promise<void>((_, reject) => setTimeout(() => reject(Object.assign(new Error("Command failed: git (killed after timeout)"), { killed: true })), options.timeout));
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const withFakeTimers = async (body: () => Promise<void>) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try { await body(); } finally { vi.useRealTimers(); }
  };
  /** Starts a tool call and tracks whether it has resolved yet. */
  const track = <T>(promise: Promise<T>) => {
    const box = { done: false, value: undefined as T | undefined, error: undefined as unknown };
    const settled = promise.then((value) => { box.done = true; box.value = value; }, (error) => { box.done = true; box.error = error; });
    return Object.assign(box, { settled });
  };
  /** Spins real event-loop turns until `cond` holds, for up to `ms` of real time. Fake timers never move here, and performance.now is not faked. */
  const until = async (cond: () => boolean, ms = 3_000) => {
    const end = performance.now() + ms;
    while (!cond() && performance.now() < end) await new Promise((resolve) => setImmediate(resolve));
    expect(cond()).toBe(true);
  };

  describe("success", () => {
    test("chief_research fast-forwards a behind clone, spawns the researcher and adds no warning", async () => {
      const w = await world();
      const tip = await w.r.push();
      const reply = await w.research();
      noWarning(reply, RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(w.calls.every((call) => call.cwd === w.r.chief && call.spawned === 1)).toBe(true);
      expect(w.calls.some((call) => call.args[0] === "merge" && call.args.includes("--ff-only"))).toBe(true);
    });

    test("an already current clone is silent and never merges", async () => {
      const w = await world();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(w.calls.some((call) => call.args[0] === "merge")).toBe(false);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("chief_plan in a project whose checkout is Chief's fast-forwards it and adds no warning", async () => {
      const w = await world({ projectPath: "clone" });
      const tip = await w.r.push();
      noWarning(await w.plan(), PLAN_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("chief_plan for a confirmed separate planner checkout runs no git and adds no warning, whatever the host", async () => {
      for (const hostId of ["host_1", "host_2"]) {
        const w = await world({ projectPath: "/elsewhere/worktree-default" });
        w.cfg.hostId = hostId;
        await w.r.push();
        noWarning(await w.plan(), PLAN_BASE);
        expect(w.calls).toEqual([]);
        expect(await w.r.head()).toBe(w.r.c0);
        expect(w.spawnedRole("planner")).toHaveLength(1);
      }
    });
  });

  describe("skip causes never block the spawn", () => {
    test.each([
      ["a dirty clone", async (w: World) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); }, /uncommitted changes/],
      ["a local commit ahead", async (w: World) => {
        await writeFile(join(w.r.chief, "mine.txt"), "mine\n");
        await git(w.r.chief, "add", "-A");
        await git(w.r.chief, "commit", "-q", "-m", "mine");
      }, /1 commit\(s\) not on origin\/main/],
      ["a bad origin", async (w: World) => { await git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git")); }, /git fetch failed/],
      ["a remote host", async (w: World) => { w.cfg.hostId = "host_2"; }, /remote host/],
      ["an environment without a path", async (w: World) => { delete w.cfg.env.path; }, /no checkout path/],
      ["an environment without a default branch", async (w: World) => { delete w.cfg.env.defaultBranch; }, /default branch unknown/],
    ])("chief_research with %s", async (_name, arrange, reason) => {
      const w = await world();
      await w.r.push();
      await arrange(w);
      const head = await w.r.head();
      expectWarned(await w.research(), RESEARCH_BASE, reason);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(head);
      if (/remote host|path|default branch/.test(String(reason))) expect(w.calls).toEqual([]);
    });

    test("an unreadable Chief thread or environment still spawns, with one warning and no git", async () => {
      const w = await world();
      await w.r.push();
      w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); });
      expectWarned(await w.research(), RESEARCH_BASE, /env lookup failed/);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(w.calls).toEqual([]);
    });

    test("an untracked file the fast-forward would overwrite is a merge-failed skip and the researcher still starts", async () => {
      const w = await world();
      await w.r.push("new.txt");
      await writeFile(join(w.r.chief, "new.txt"), "mine\n");
      expectWarned(await w.research(), RESEARCH_BASE, /git merge --ff-only failed/);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("an ignored untracked file that origin adds is not overwritten: merge-failed skip, the file and HEAD stay, the researcher still starts", async () => {
      const w = await world();
      await appendFile(join(w.r.chief, ".git", "info", "exclude"), "local.env\n");
      await writeFile(join(w.r.chief, "local.env"), "SECRET=mine\n");
      await w.r.push("local.env");
      expect(await git(w.r.chief, "status", "--porcelain", "--untracked-files=no")).toBe("");
      expectWarned(await w.research(), RESEARCH_BASE, /git merge --ff-only failed/);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await readFile(join(w.r.chief, "local.env"), "utf8")).toBe("SECRET=mine\n");
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a planner call whose shared checkout is dirty skips with one warning and the planner still starts", async () => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      await writeFile(join(w.r.chief, "a.txt"), "dirty\n");
      expectWarned(await w.plan(), PLAN_BASE, /uncommitted changes/);
      expect(w.spawnedRole("planner")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });
  });

  // chief_sync (PR 183): the Chief-only tool that runs the same fast-forward on Chief's own checkout, through the real tool handler.
  describe("chief_sync", () => {
    const sync = (w: World) => w.state.harness.behavior.callAgentTool("chief_sync", {}, w.ctx) as Promise<string>;
    const SKIPPED = /^Did not fast-forward your checkout to origin\/main: /;

    test("a checkout one commit behind is fast-forwarded and the reply names the old and the new commit", async () => {
      const w = await world();
      const tip = await w.r.push();
      const reply = await sync(w);
      expect(reply).toContain(w.r.c0.slice(0, 12));
      expect(reply).toContain(tip.slice(0, 12));
      expect(reply).not.toContain("Did not fast-forward");
      expect(await w.r.head()).toBe(tip);
      expect(w.calls.some((call) => call.args[0] === "merge" && call.args.includes("--ff-only"))).toBe(true);
    });

    test("an already current checkout names its commit, is no skip and never merges", async () => {
      const w = await world();
      const reply = await sync(w);
      expect(reply).toContain(w.r.c0.slice(0, 12));
      expect(reply).not.toContain("Did not fast-forward");
      expect(w.calls.some((call) => call.args[0] === "merge")).toBe(false);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test.each([
      ["a dirty checkout", async (w: World) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); }, /uncommitted changes/],
      ["a branch with a commit of its own", async (w: World) => {
        await writeFile(join(w.r.chief, "mine.txt"), "mine\n");
        await git(w.r.chief, "add", "-A");
        await git(w.r.chief, "commit", "-q", "-m", "mine");
      }, /1 commit\(s\) not on origin\/main/],
      ["a failing fetch", async (w: World) => { await git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git")); }, /git fetch failed/],
    ])("%s is a warning reply, not an error, and HEAD stays", async (_name, arrange, reason) => {
      const w = await world();
      await w.r.push();
      await arrange(w);
      const head = await w.r.head();
      const reply = await sync(w);
      expect(reply).toMatch(SKIPPED);
      expect(reply).toMatch(reason);
      expect(await w.r.head()).toBe(head);
    });

    test("a running researcher of this Chief is a warning naming it, runs no git and leaves HEAD", async () => {
      const w = await world();
      await w.research();
      const [researcher] = w.rows("researcher");
      w.setLive(researcher!, "active");
      await w.r.push();
      const before = w.calls.length;
      const reply = await sync(w);
      expect(reply).toMatch(SKIPPED);
      expect(reply).toContain(`researcher ${researcher} is still running in it`);
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a running planner that shares Chief's checkout is a warning naming it and leaves HEAD", async () => {
      const w = await world({ projectPath: "clone" });
      await w.plan();
      const [planner] = w.rows("planner");
      w.setLive(planner!, "active");
      await w.r.push();
      const reply = await sync(w);
      expect(reply).toMatch(SKIPPED);
      expect(reply).toContain(`planner ${planner} is still running in it`);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a caller that is not Chief is refused and nothing is fetched or moved", async () => {
      const w = await world();
      const { threadId: worker } = await delegate(w.state, w.chief);
      const tip = await w.r.push();
      const before = w.calls.length;
      const call = (ctx: object) => w.state.harness.behavior.callAgentTool("chief_sync", {}, ctx);
      await expect(call({ threadId: worker, projectId: "proj_1" })).rejects.toThrow(/Chief/);
      await expect(call({ threadId: "thr_unknown", projectId: "proj_1" })).rejects.toThrow(/Chief/);
      await expect(call({ projectId: "proj_1" })).rejects.toThrow(/Chief/);
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).not.toBe(tip);
    });
  });

  describe("busy rule", () => {
    const NOT_BUSY = ["idle", "ready", "blocked"];
    test.each(["active", "starting", "stopping", "pending"])("a researcher of this Chief whose live status is %s makes chief_research skip, and the next researcher still starts", async (status) => {
      const w = await world();
      noWarning(await w.research(), RESEARCH_BASE);
      const [first] = w.rows("researcher");
      w.setLive(first!, status);
      await w.r.push();
      const before = w.calls.length;
      expectWarned(await w.research(), RESEARCH_BASE, new RegExp(`researcher ${first} is still running in it`));
      expect(w.spawnedRole("researcher")).toHaveLength(2);
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test.each(NOT_BUSY)("a researcher whose live status is %s does not block the fast-forward", async (status) => {
      const w = await world();
      await w.research();
      w.setLive(w.rows("researcher")[0]!, status);
      const tip = await w.r.push();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("a researcher whose live read throws counts as running", async () => {
      const w = await world();
      await w.research();
      const [first] = w.rows("researcher");
      await w.r.push();
      w.state.failNextGet(first!);
      expectWarned(await w.research(), RESEARCH_BASE, new RegExp(`researcher ${first} is still running in it`));
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a researcher whose live read times out counts as running; releasing the read later starts no git", async () => {
      const w = await world();
      await w.research();
      const [first] = w.rows("researcher");
      await w.r.push();
      const before = w.calls.length;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let hits = 0;
      w.state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
        if (threadId === first) { hits += 1; await held; }
        const thread = w.state.live.get(threadId);
        if (!thread) throw new Error("not found");
        return thread;
      });
      await withFakeTimers(async () => {
        const call = track(w.research());
        await flush(4_900);
        expect(call.done).toBe(false);
        await flush(200);
        await call.settled;
        expect(hits).toBe(1);
        expectWarned(call.value!, RESEARCH_BASE, new RegExp(`researcher ${first} is still running in it`));
        release();
        await flush(0);
      });
      expect(w.calls).toHaveLength(before);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a researcher of another Chief never counts", async () => {
      const w = await world();
      const other = (await start(w.state, "proj_2")).threadId;
      w.state.live.set(other, { ...w.state.live.get(other)!, providerId: "codex" });
      await w.state.harness.behavior.callAgentTool("chief_research", SURVEY("Other chief question"), { threadId: other, projectId: "proj_2" });
      const foreign = w.state.db.prepare("SELECT thread_id FROM managed_threads WHERE role='researcher' AND chief_thread_id=?").get(other) as { thread_id: string };
      w.setLive(foreign.thread_id, "active");
      const tip = await w.r.push();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("in a researcher call, a running planner whose sharing is unknown blocks", async () => {
      const w = await world();
      expectWarned(await w.plan(), PLAN_BASE, /could not tell whether the planner shares it/);
      const [planner] = w.rows("planner");
      w.setLive(planner!, "active");
      await w.r.push();
      expectWarned(await w.research(), RESEARCH_BASE, new RegExp(`planner ${planner} is still running in it`));
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("in a researcher call, a running planner on a confirmed separate checkout does not block", async () => {
      const w = await world({ projectPath: "/elsewhere/worktree-default" });
      noWarning(await w.plan(), PLAN_BASE);
      w.setLive(w.rows("planner")[0]!, "active");
      const tip = await w.r.push();
      noWarning(await w.research(), RESEARCH_BASE);
      expect(await w.r.head()).toBe(tip);
    });

    test("a running planner that shares Chief's checkout blocks the next chief_plan", async () => {
      const w = await world({ projectPath: "clone" });
      noWarning(await w.plan(), PLAN_BASE);
      w.setLive(w.rows("planner")[0]!, "active");
      await w.r.push();
      const before = w.calls.length;
      expectWarned(await w.plan(), PLAN_BASE, /planner thr_\d+ is still running in it/);
      expect(w.calls).toHaveLength(before);
      expect(w.spawnedRole("planner")).toHaveLength(2);
    });
  });

  describe("ordering: a refused call leaves Chief's checkout and git alone", () => {
    const ctxOf = (w: World) => w.ctx;
    test.each<[string, (w: World) => Promise<unknown>, RegExp]>([
      ["research on a cooling model", async (w) => {
        w.state.db.prepare("INSERT INTO provider_cooldowns (provider_id, model, until_at, reason, updated_at) VALUES ('codex', 'gpt-6-astra', ?, 'x', 0)").run(Date.now() + 600_000);
        return w.research();
      }, /cooling down/],
      ["research switched off", async (w) => {
        await w.state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
        return w.research();
      }, /chief_research is off/],
      ["planning switched off", async (w) => {
        await w.state.harness.behavior.setSettings({ plannerEnabled: false });
        return w.plan();
      }, /./],
      ["a revision of a plan that does not exist", async (w) => w.state.harness.behavior.callAgentTool("chief_plan", { title: "Revise", mission: "Propose again", revises: "thr_missing" }, ctxOf(w)), /./],
    ])("%s", async (_name, act, message) => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      await expect(act(w)).rejects.toThrow(message);
      expect(w.calls).toEqual([]);
      expect(await w.r.head()).toBe(w.r.c0);
      expect(w.spawnedRole("researcher")).toHaveLength(0);
      expect(w.spawnedRole("planner")).toHaveLength(0);
    });
  });

  describe("planner sharing is three-valued, through the chief_plan tool and CLI plan", () => {
    const UNKNOWN = /could not tell whether the planner shares it/;
    const causes: [string, (w: World) => void][] = [
      ["projects.get throws", (w) => { w.state.harness.sdk.stub("projects.get", async () => { throw new Error("project lookup failed"); }); }],
      ["environments.get throws", (w) => { w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); }); }],
      ["environments.get has no path", (w) => { delete w.cfg.env.path; }],
    ];
    describe.each(causes)("%s", (_name, arrange) => {
      test("chief_plan warns once, spawns the planner and runs no git", async () => {
        const w = await world({ projectPath: "clone" });
        await w.r.push();
        arrange(w);
        expectWarned(await w.plan(), PLAN_BASE, UNKNOWN);
        expect(w.spawnedRole("planner")).toHaveLength(1);
        expect(w.calls).toEqual([]);
        expect(await w.r.head()).toBe(w.r.c0);
      });

      test("CLI plan warns once, spawns the planner and runs no git", async () => {
        const w = await world({ projectPath: "clone" });
        await w.r.push();
        arrange(w);
        const result = await w.cliPlan();
        expect(result.exitCode).toBe(0);
        expectWarned(result.stdout!.trim(), CLI_PLAN_BASE, UNKNOWN);
        expect(w.spawnedRole("planner")).toHaveLength(1);
        expect(w.calls).toEqual([]);
        expect(await w.r.head()).toBe(w.r.c0);
      });
    });

    test("CLI plan on a shared checkout fast-forwards it with no warning, and a remote host there is a remote-host warning", async () => {
      const w = await world({ projectPath: "clone" });
      const tip = await w.r.push();
      const ok = await w.cliPlan();
      expect(ok.stdout!.trim()).toMatch(CLI_PLAN_BASE);
      expect(await w.r.head()).toBe(tip);
      w.cfg.hostId = "host_2";
      const before = w.calls.length;
      expectWarned((await w.cliPlan()).stdout!.trim(), CLI_PLAN_BASE, /remote host/);
      expect(w.calls).toHaveLength(before);
    });
  });

  describe("deadlines: settled means stopped", () => {
    const named = (w: World, name: string) => w.calls.filter((call) => call.args[0] === name);

    test("a held git fetch is killed twice, becomes a fetch-failed skip, and no git runs when the researcher starts", async () => {
      const w = await world();
      await w.r.push();
      w.hold.git = (args, options) => (args[0] === "fetch" ? killedAfterTimeout(options) : undefined);
      await withFakeTimers(async () => {
        const call = track(w.research());
        await until(() => named(w, "fetch").length === 1);
        await flush(10_000);
        expect(call.done).toBe(false);
        await until(() => named(w, "fetch").length === 2);
        await flush(10_000);
        await call.settled;
        expect(w.inflight()).toBe(0);
        expectWarned(call.value!, RESEARCH_BASE, /git fetch failed: .*killed after timeout/);
      });
      expect(w.calls.every((call) => call.spawned === 1)).toBe(true);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a held first git command takes two killed tries, then the researcher starts with the failure as the reason", async () => {
      const w = await world();
      w.hold.git = (_args, options) => killedAfterTimeout(options);
      await withFakeTimers(async () => {
        const call = track(w.research());
        await until(() => w.calls.length === 1);
        await flush(10_000);
        await until(() => w.calls.length === 2);
        await flush(10_000);
        await call.settled;
        expect(w.inflight()).toBe(0);
        expectWarned(call.value!, RESEARCH_BASE, /killed after timeout/);
      });
      expect(w.calls.map((call) => call.args[0])).toEqual(["status", "status"]);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
    });

    test.each([
      ["3 s for the HEAD read leaves 9 s: skips before the merge", 3_000, false],
      ["1 s for the HEAD read leaves 11 s: merges", 1_000, true],
    ])("merge budget, %s", async (_name, headMs, merges) => {
      const w = await world();
      const tip = await w.r.push();
      // Each hold moves the clock instead of waiting: status 9 s + fetch 9 s + HEAD read.
      w.hold.git = (args) => {
        if (args[0] === "status" || args[0] === "fetch") vi.setSystemTime(Date.now() + 9_000);
        else if (args[0] === "rev-parse" && args[1] === "HEAD") vi.setSystemTime(Date.now() + headMs);
        return undefined;
      };
      await withFakeTimers(async () => {
        const reply = await w.research();
        if (merges) noWarning(reply, RESEARCH_BASE);
        else expectWarned(reply, RESEARCH_BASE, /timed out before the merge/);
      });
      expect(named(w, "merge")).toHaveLength(merges ? 1 : 0);
      expect(await w.r.head()).toBe(merges ? tip : w.r.c0);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
    });

    test.each([
      ["11 s left at the merge: the retry would start with 1 s, so there is none", 19_000, 1],
      ["30 s left at the merge: the retry starts with 20 s", 0, 2],
    ])("a merge killed at its 10 s timeout, %s", async (_name, usedMs, merges) => {
      const w = await world();
      await w.r.push();
      // The first git call moves the clock instead of waiting, leaving 30 s - usedMs for the merge.
      let moved = false;
      w.hold.git = (args, options) => {
        if (!moved) { moved = true; vi.setSystemTime(Date.now() + usedMs); }
        return args[0] === "merge" ? killedAfterTimeout(options) : undefined;
      };
      await withFakeTimers(async () => {
        const call = track(w.research());
        for (let n = 1; n <= merges; n += 1) {
          await until(() => named(w, "merge").length === n);
          expect(call.done).toBe(false);
          await flush(10_000);
        }
        await call.settled;
        expect(w.inflight()).toBe(0);
        expectWarned(call.value!, RESEARCH_BASE, /git merge --ff-only failed: .*killed after timeout/);
      });
      expect(named(w, "merge")).toHaveLength(merges);
      // Every git call, the merges included, finished before the researcher was launched, and the checkout is untouched.
      expect(w.calls.every((call) => call.spawned === 1)).toBe(true);
      expect(w.spawnedRole("researcher")).toHaveLength(1);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test.each([
      ["chief_research", "researcher", async (w: World) => w.research(), RESEARCH_BASE],
      ["chief_plan", "planner", async (w: World) => w.plan(), PLAN_BASE],
    ] as const)("a held system.config lookup in %s times out after 5 s; releasing it later starts no git", async (_name, role, act, base) => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let hits = 0;
      w.state.harness.sdk.stub("system.config", async () => { hits += 1; await held; return { primaryHostId: "host_1" }; });
      await withFakeTimers(async () => {
        const call = track(act(w));
        await until(() => hits === 1);
        await flush(4_900);
        expect(call.done).toBe(false);
        await flush(200);
        await call.settled;
        expectWarned(call.value!, base, /timed out/);
        release();
        await flush(0);
      });
      expect(w.spawnedRole(role)).toHaveLength(1);
      expect(w.calls).toEqual([]);
      expect(await w.r.head()).toBe(w.r.c0);
    });

    test("a held project lookup in chief_plan times out after 5 s as unknown sharing: warning, planner spawned, no git", async () => {
      const w = await world({ projectPath: "clone" });
      await w.r.push();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let hits = 0;
      // Earlier project reads (name, host) are not part of the freshness call; hold only the one after its system.config read.
      let armed = false;
      w.state.harness.sdk.stub("system.config", async () => { armed = true; return { primaryHostId: "host_1" }; });
      w.state.harness.sdk.stub("projects.get", async () => {
        if (armed) hits += 1;
        if (armed && hits === 1) await held;
        return { id: "proj_1", name: "P", kind: "standard", sources: [{ path: w.r.chief, hostId: "host_1", isDefault: true }] };
      });
      await withFakeTimers(async () => {
        const call = track(w.plan());
        await until(() => hits === 1);
        await flush(5_100);
        await call.settled;
        expectWarned(call.value!, PLAN_BASE, /could not tell whether the planner shares it/);
        release();
        await flush(0);
      });
      expect(w.spawnedRole("planner")).toHaveLength(1);
      expect(w.calls).toEqual([]);
    });
  });

  describe("report stamp, through chief_report", () => {
    const alertText = (w: World) => w.state.sent.at(-1).input[0].text as string;
    const report = (w: World, threadId: string, extra: object = { state: "blocked", blocker: "stuck", recommendation: "retry" }) =>
      w.state.harness.behavior.callAgentTool("chief_report", extra, { threadId, projectId: "proj_1" });
    const stateOf = (w: World, threadId: string) => (w.state.db.prepare("SELECT last_report_state AS s FROM managed_threads WHERE thread_id=?").get(threadId) as { s: string }).s;
    /** The line after `State:` in an alert or report file. */
    const afterState = (text: string) => { const lines = text.split("\n"); return lines[lines.findIndex((line) => line.startsWith("State:")) + 1]; };

    describe.each([["researcher", async (w: World) => { await w.research(); return w.rows("researcher")[0]!; }],
      ["planner", async (w: World) => { await w.plan(); return w.rows("planner")[0]!; }]] as const)("%s", (role, spawn) => {
      test("the alert carries Read at <12 hex> right after State, with no stale clause when origin has not moved", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        await report(w, id);
        expect(alertText(w)).toContain(`State: blocked\nRead at ${w.r.c0.slice(0, 12)}\n`);
        expect(alertText(w)).not.toContain("may be stale");
      });

      test("adds the stale clause exactly when ls-remote returns a different SHA", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        const tip = await w.r.push();
        const spawnCalls = w.calls.length;
        await report(w, id);
        expect(afterState(alertText(w))).toBe(`Read at ${w.r.c0.slice(0, 12)}; main is now ${tip.slice(0, 12)}, so this answer may be stale`);
        expect(await w.r.head()).toBe(w.r.c0);
        expect(w.calls.slice(spawnCalls).map((call) => call.args)).toEqual([["rev-parse", "HEAD"], ["ls-remote", "origin", "refs/heads/main"]]);
      });

      test("keeps the local SHA when ls-remote fails, and the state and alert are still delivered", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        await git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git"));
        await report(w, id);
        expect(afterState(alertText(w))).toBe(`Read at ${w.r.c0.slice(0, 12)}`);
        expect(stateOf(w, id)).toBe("blocked");
      });

      test("a long result puts the same stamp after State in the report file", async () => {
        const w = await world({ projectPath: "clone" });
        const id = await spawn(w);
        const tip = await w.r.push();
        await report(w, id, { state: "blocked", blocker: "stuck", recommendation: "retry", result: "word ".repeat(4_000) });
        const path = /Full report: (\S+)/.exec(alertText(w))![1]!;
        const expected = `Read at ${w.r.c0.slice(0, 12)}; main is now ${tip.slice(0, 12)}, so this answer may be stale`;
        expect(afterState(await readFile(path, "utf8"))).toBe(expected);
        expect(afterState(alertText(w))).toBe(expected);
      });

      test.each([
        ["an environment lookup that throws", (w: World) => { w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); }); }],
        ["an unreadable checkout path", (w: World) => { w.cfg.env.path = join(w.r.root, "missing"); }],
        ["a remote host", (w: World) => { w.cfg.hostId = "host_2"; }],
        ["no default branch", (w: World) => { delete w.cfg.env.defaultBranch; }],
      ])(`%s drops only the stamp from the ${role} report: it is still delivered`, async (_name, arrange) => {
        const w = await world({ projectPath: "clone", env: "all" });
        const id = await spawn(w);
        arrange(w);
        await report(w, id);
        expect(alertText(w)).toMatch(/^\[Chief lifecycle alert\]\n.* report from .*\nState: blocked\n/);
        expect(alertText(w)).not.toContain("Read at");
        expect(stateOf(w, id)).toBe("blocked");
      });
    });

    test("a held ls-remote on a long report: state, seq and pending alert are committed first; after 12 s the alert and the report file both keep Read at <sha> without the comparison", async () => {
      const w = await world();
      await w.research();
      const id = w.rows("researcher")[0]!;
      await w.r.push(); // origin moved, so a working ls-remote would add the comparison clause
      w.hold.git = (args, options) => (args[0] === "ls-remote" ? killedAfterTimeout(options) : undefined);
      const seqOf = () => (w.state.db.prepare("SELECT report_seq AS s FROM managed_threads WHERE thread_id=?").get(id) as { s: number }).s;
      await withFakeTimers(async () => {
        // Longer than SUMMARY_MAX, so a report file is written.
        const call = track(report(w, id, { state: "blocked", blocker: "stuck", recommendation: "retry", result: "word ".repeat(4_000) }));
        await until(() => w.calls.some((c) => c.args[0] === "ls-remote"));
        // Required result first: committed while the optional comparison is still running; no file or full alert yet.
        expect(stateOf(w, id)).toBe("blocked");
        expect(seqOf()).toBe(1);
        expect(w.state.db.prepare("SELECT 1 FROM alert_outbox WHERE dedupe_key LIKE ?").all(`${id}:report:%:pending-1`)).toHaveLength(1);
        expect(w.state.db.prepare("SELECT report_path AS p FROM managed_threads WHERE thread_id=?").get(id)).toEqual({ p: null });
        await flush(10_000);
        expect(call.done).toBe(false);
        await until(() => w.calls.filter((c) => c.args[0] === "ls-remote").length === 2);
        await flush(2_000);
        await call.settled;
        expect(call.error).toBeUndefined();
        expect(w.inflight()).toBe(0);
      });
      const path = /Full report: (\S+)/.exec(alertText(w))![1]!;
      expect(path).toMatch(/report-1\.md$/);
      const stamp = `Read at ${w.r.c0.slice(0, 12)}`;
      expect(afterState(await readFile(path, "utf8"))).toBe(stamp);
      expect(afterState(alertText(w))).toBe(stamp);
      expect(`${alertText(w)}\n${await readFile(path, "utf8")}`).not.toContain("is now");
      expect(stateOf(w, id)).toBe("blocked");
      expect(seqOf()).toBe(1);
      expect(w.state.db.prepare("SELECT report_path AS p FROM managed_threads WHERE thread_id=?").get(id)).toEqual({ p: path });
    });

    test("a held system.config read is bounded to 5 s: no stamp, no git, the report is delivered", async () => {
      const w = await world();
      await w.research();
      const id = w.rows("researcher")[0]!;
      const spawnCalls = w.calls.length;
      let hits = 0;
      w.state.harness.sdk.stub("system.config", async () => { hits += 1; await new Promise(() => undefined); return { primaryHostId: "host_1" }; });
      await withFakeTimers(async () => {
        const call = track(report(w, id));
        await until(() => hits === 1);
        await flush(4_900);
        expect(call.done).toBe(false);
        await flush(200);
        await call.settled;
        expect(call.error).toBeUndefined();
      });
      expect(alertText(w)).not.toContain("Read at");
      expect(w.calls).toHaveLength(spawnCalls);
      expect(stateOf(w, id)).toBe("blocked");
    });

    test("worker, reviewer and advisor alerts are unchanged: no stamp and no git", async () => {
      const w = await world({ projectPath: "clone", env: "all" });
      const delegated = await w.state.harness.behavior.runCli(["delegate", "--title", "Fix totals", "--mission", "Do it", "--unplanned-reason", "stamp test", "--json"], w.ctx);
      const worker = (JSON.parse(delegated.stdout!) as { threadId: string }).threadId;
      await report(w, worker);
      expect(alertText(w)).toContain("State: blocked");
      expect(alertText(w)).not.toContain("Read at");
      await report(w, worker, { state: "ready", result: "Done\n\n## Deviations from plan\nNone" });
      await w.state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker }, w.ctx);
      const reviewer = w.rows("reviewer")[0]!;
      await report(w, reviewer, { state: "ready", result: "Reviewed", verdict: "approve", findings: [] });
      expect(alertText(w)).not.toContain("Read at");
      await w.state.harness.behavior.runCli(["consult", "--title", "Rework", "--mission", "Explore"], w.ctx);
      await report(w, w.rows("advisor")[0]!, { state: "ready", result: "Sound", verdict: "approve" });
      expect(alertText(w)).not.toContain("Read at");
      expect(w.calls.filter((call) => ["ls-remote", "rev-parse"].includes(call.args[0]!))).toEqual([]);
    });
  });

  // Byte-equivalence with base 948c49c (before the fast-forward existed). The golden file was recorded on that commit by
  // running this same describe with ORACLE_OUT set; here the head output of the same fixture must equal it. With ORACLE_OUT
  // set, this describe writes {meta, outputs} to that path instead of comparing.
  describe("checkout equivalence with base 948c49c", () => {
    type Scenario = { name: string; projectPath: "clone" | "/elsewhere/worktree-default"; behind: boolean; call: "research" | "plan" | "cli-plan" | "cli-plan-json" };
    const FIXTURE: Scenario[] = [
      { name: "research, behind clone (fast-forward succeeds)", projectPath: "clone", behind: true, call: "research" },
      { name: "research, current clone", projectPath: "clone", behind: false, call: "research" },
      { name: "chief_plan, shared checkout, behind", projectPath: "clone", behind: true, call: "plan" },
      { name: "chief_plan, shared checkout, current", projectPath: "clone", behind: false, call: "plan" },
      { name: "chief_plan, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", behind: true, call: "plan" },
      { name: "CLI plan text, shared checkout, behind", projectPath: "clone", behind: true, call: "cli-plan" },
      { name: "CLI plan text, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", behind: true, call: "cli-plan" },
      { name: "CLI plan --json, shared checkout, behind", projectPath: "clone", behind: true, call: "cli-plan-json" },
      { name: "CLI plan --json, shared checkout, current", projectPath: "clone", behind: false, call: "cli-plan-json" },
      { name: "CLI plan --json, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", behind: true, call: "cli-plan-json" },
    ];
    const fixtureHash = createHash("sha256").update(JSON.stringify(FIXTURE)).digest("hex");
    const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "checkoutFreshness.oracle.json");

    async function outputs() {
      const out: Record<string, unknown> = {};
      for (const scenario of FIXTURE) {
        const w = await world({ projectPath: scenario.projectPath });
        if (scenario.behind) await w.r.push();
        if (scenario.call === "research") out[scenario.name] = await w.research();
        else if (scenario.call === "plan") out[scenario.name] = await w.plan();
        else {
          const result = await w.cliPlan(...(scenario.call === "cli-plan-json" ? ["--json"] : []));
          out[scenario.name] = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        }
      }
      return out;
    }

    test("tool results and CLI text and --json are byte-identical to the base recording for the same fixture", async () => {
      const actual = await outputs();
      if (process.env.ORACLE_OUT) {
        const meta = {
          cwd: process.cwd(), runnerRoot: dirname(fileURLToPath(import.meta.url)),
          head: await git(process.cwd(), "rev-parse", "HEAD"), fixtureHash, scenarios: FIXTURE.length,
        };
        await writeFile(process.env.ORACLE_OUT, `${JSON.stringify({ meta, outputs: actual }, null, 2)}\n`);
        return;
      }
      const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as { meta: { head: string; fixtureHash: string }; outputs: Record<string, unknown> };
      expect(golden.meta.head).toBe("948c49cb6cac6f2e3066fe0e2164e22c809c8a4f");
      expect(golden.meta.fixtureHash).toBe(fixtureHash);
      expect(actual).toEqual(golden.outputs);
    });
  });

  // Preservation of #181's callers (chief_research, chief_plan, CLI plan) across the chief_sync refactor. The golden file was
  // recorded on base 0e3ab0c by running this same describe there with ORACLE_OUT_FRESH set; here the head output of the same
  // fixture must equal it. Covers success and every skip path, recording reply, HEAD outcome, spawns and the git calls made.
  describe("checkout equivalence with base 0e3ab0c", () => {
    type Run = (w: World) => Promise<unknown>;
    type Scenario = { name: string; projectPath?: "clone" | string; run: Run };
    const ownCommit = async (w: World) => {
      await writeFile(join(w.r.chief, "mine.txt"), "mine\n");
      await git(w.r.chief, "add", "-A");
      await git(w.r.chief, "commit", "-q", "-m", "mine");
    };
    const badOrigin = (w: World) => git(w.r.chief, "remote", "set-url", "origin", join(w.r.root, "gone.git"));
    const cli = async (w: World, ...extra: string[]) => {
      const result = await w.cliPlan(...extra);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    };
    const FIXTURE: Scenario[] = [
      { name: "research, behind (fast-forward)", run: (w) => w.research() },
      { name: "research, current", run: async (w) => { await git(w.r.chief, "pull", "-q", "--ff-only"); return w.research(); } },
      { name: "research, dirty", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return w.research(); } },
      { name: "research, own commit", run: async (w) => { await ownCommit(w); return w.research(); } },
      { name: "research, fetch fails", run: async (w) => { await badOrigin(w); return w.research(); } },
      { name: "research, remote host", run: async (w) => { w.cfg.hostId = "host_2"; return w.research(); } },
      { name: "research, no default branch", run: async (w) => { delete w.cfg.env.defaultBranch; return w.research(); } },
      { name: "research, environment lookup throws", run: async (w) => { w.state.harness.sdk.stub("environments.get", async () => { throw new Error("env lookup failed"); }); return w.research(); } },
      { name: "research, running researcher", run: async (w) => {
        const first = await w.research();
        w.setLive(w.rows("researcher")[0]!, "active");
        await w.r.push();
        return [first, await w.research()];
      } },
      { name: "research, running planner of unknown sharing", run: async (w) => {
        const first = await w.plan();
        w.setLive(w.rows("planner")[0]!, "active");
        await w.r.push();
        return [first, await w.research()];
      } },
      { name: "chief_plan, shared, behind (fast-forward)", projectPath: "clone", run: (w) => w.plan() },
      { name: "chief_plan, shared, current", projectPath: "clone", run: async (w) => { await git(w.r.chief, "pull", "-q", "--ff-only"); return w.plan(); } },
      { name: "chief_plan, shared, dirty", projectPath: "clone", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return w.plan(); } },
      { name: "chief_plan, shared, own commit", projectPath: "clone", run: async (w) => { await ownCommit(w); return w.plan(); } },
      { name: "chief_plan, shared, fetch fails", projectPath: "clone", run: async (w) => { await badOrigin(w); return w.plan(); } },
      { name: "chief_plan, shared, remote host", projectPath: "clone", run: async (w) => { w.cfg.hostId = "host_2"; return w.plan(); } },
      { name: "chief_plan, shared, running planner", projectPath: "clone", run: async (w) => {
        const first = await w.plan();
        w.setLive(w.rows("planner")[0]!, "active");
        await w.r.push();
        return [first, await w.plan()];
      } },
      { name: "chief_plan, shared, running researcher", projectPath: "clone", run: async (w) => {
        const first = await w.research();
        w.setLive(w.rows("researcher")[0]!, "active");
        await w.r.push();
        return [first, await w.plan()];
      } },
      { name: "chief_plan, sharing unknown (projects.get throws)", projectPath: "clone", run: async (w) => {
        w.state.harness.sdk.stub("projects.get", async () => { throw new Error("project lookup failed"); });
        return w.plan();
      } },
      { name: "chief_plan, sharing unknown (environment has no path)", projectPath: "clone", run: async (w) => { delete w.cfg.env.path; return w.plan(); } },
      { name: "chief_plan, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", run: (w) => w.plan() },
      { name: "CLI plan text, shared, behind (fast-forward)", projectPath: "clone", run: (w) => cli(w) },
      { name: "CLI plan text, shared, current", projectPath: "clone", run: async (w) => { await git(w.r.chief, "pull", "-q", "--ff-only"); return cli(w); } },
      { name: "CLI plan text, shared, dirty", projectPath: "clone", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return cli(w); } },
      { name: "CLI plan text, shared, own commit", projectPath: "clone", run: async (w) => { await ownCommit(w); return cli(w); } },
      { name: "CLI plan text, shared, fetch fails", projectPath: "clone", run: async (w) => { await badOrigin(w); return cli(w); } },
      { name: "CLI plan text, shared, remote host", projectPath: "clone", run: async (w) => { w.cfg.hostId = "host_2"; return cli(w); } },
      { name: "CLI plan text, sharing unknown", projectPath: "clone", run: async (w) => { delete w.cfg.env.path; return cli(w); } },
      { name: "CLI plan text, confirmed separate checkout", projectPath: "/elsewhere/worktree-default", run: (w) => cli(w) },
      { name: "CLI plan --json, shared, behind (fast-forward)", projectPath: "clone", run: (w) => cli(w, "--json") },
      { name: "CLI plan --json, shared, dirty", projectPath: "clone", run: async (w) => { await writeFile(join(w.r.chief, "a.txt"), "dirty\n"); return cli(w, "--json"); } },
      { name: "CLI plan --json, sharing unknown", projectPath: "clone", run: async (w) => { delete w.cfg.env.path; return cli(w, "--json"); } },
    ];
    const fixtureHash = createHash("sha256").update(FIXTURE.map((s) => `${s.name}|${s.projectPath}`).join("\n")).digest("hex");
    const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "checkoutFreshness.base0e3ab0c.oracle.json");

    async function outputs() {
      const out: Record<string, unknown> = {};
      for (const scenario of FIXTURE) {
        const w = await world({ projectPath: scenario.projectPath });
        await w.r.push();
        const replies = await scenario.run(w);
        const head = await w.r.head();
        const originMain = await git(w.r.chief, "rev-parse", "origin/main");
        const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).split(w.r.root).join("<root>").replace(/\b[0-9a-f]{40}\b/g, "<sha>"));
        out[scenario.name] = normalize({
          replies,
          head: head === w.r.c0 ? "c0" : head === originMain ? "origin tip" : "local commit",
          threads: { researcher: w.spawnedRole("researcher").length, planner: w.spawnedRole("planner").length },
          gitCalls: w.calls.map((call) => ({ args: call.args, cwd: call.cwd, spawned: call.spawned })),
        });
      }
      return out;
    }

    test("research, chief_plan and CLI plan replies, HEAD, spawns and git calls are identical to base 0e3ab0c for every skip case and the fast-forward", async () => {
      const actual = await outputs();
      if (process.env.ORACLE_OUT_FRESH) {
        const meta = {
          cwd: process.cwd(), runnerRoot: dirname(fileURLToPath(import.meta.url)),
          head: await git(process.cwd(), "rev-parse", "HEAD"), fixtureHash, scenarios: FIXTURE.length,
        };
        await writeFile(process.env.ORACLE_OUT_FRESH, `${JSON.stringify({ meta, outputs: actual }, null, 2)}\n`);
        return;
      }
      const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as { meta: { head: string; fixtureHash: string }; outputs: Record<string, unknown> };
      expect(golden.meta.head).toBe("0e3ab0c4b7f6aa27cd2bba93ef757e19b3a57610");
      expect(golden.meta.fixtureHash).toBe(fixtureHash);
      expect(actual).toEqual(golden.outputs);
    }, 120_000);
  });
});

// ---- Reviewer result (plan thr_hh3bvcnaqs, wave 2, tester A): frozen on base 2351b05 ----
// Contract: docs/specs/report-intake.md baseline (validation, findings trim, ledger, lesson write) and the configure lesson read.
// These two groups run unchanged on base 2351b05 and on every later head; they go through chief_report and configure only.
describe("chief_report reviewer findings acceptance", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const PR = "https://github.com/acme/shop/pull/8";
  const nit = (n = 0) => ({ file: `f${n}.ts`, line: n + 1, severity: "nit", message: `Nit ${n}` });
  const blocking = (extra: object = {}) => ({ file: "totals.ts", line: 1, severity: "blocking", message: "Totals go negative.", ...extra });
  const HEADER = "chief_report was not saved; fix all of these and call it once more:";
  const refusal = (...lines: string[]) => [HEADER, ...lines.map((line) => `- ${line}`)].join("\n");
  const count = (state: State, table: string) => (state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const rowOf = (state: State, id: string) => state.db.prepare("SELECT * FROM managed_threads WHERE thread_id=?").get(id) as any;
  // The six stores a report touches, plus every alert sent to a thread.
  const stores = (state: State, id: string) => {
    const { report_seq, reject_streak, findings, verdict } = rowOf(state, id);
    return {
      report_seq, reject_streak, findings, verdict,
      verdicts: count(state, "reviewer_verdicts"), lessons: count(state, "chief_lessons"),
      alerts: count(state, "alert_outbox"), comments: count(state, "forge_comments"), sent: state.sent.length,
    };
  };
  // gh answers the pull-request lookup, so a verdict on a worker with a PR enqueues a forge comment row.
  const reviewed = async () => {
    execFileMock.mockImplementation(async (file: string, args: string[]) => ({ stdout: file === "gh" && args[0] === "pr" ? ghHead("feature/x") : "" }));
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { prUrl: PR });
    const as = (threadId: string) => ({ threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(worker.threadId));
    const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    const report = (params: object, threadId = review.threadId) => state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...params }, as(threadId)) as Promise<unknown>;
    return { state, chief, worker, review, report };
  };

  // path "array": the array reaches checkReport as sent. path "string": the same shape as a JSON string; used where the tool schema
  // refuses the array form first (see the schema test below: a fractional line and a bad severity), so checkReport is the one under test.
  const long = (n: number) => "x".repeat(n);
  const refused: { name: string; path: "array" | "string"; params: object; lines: string[] }[] = [
    { name: "request_changes with empty findings", path: "array", params: { verdict: "request_changes", findings: [] }, lines: ['verdict is request_changes but findings has no "blocking" entry; add the blocking finding or send approve.'] },
    { name: "request_changes with only nits", path: "array", params: { verdict: "request_changes", findings: [nit(0), nit(1)] }, lines: ['verdict is request_changes but findings has no "blocking" entry; add the blocking finding or send approve.'] },
    { name: "approve with one blocking finding", path: "array", params: { verdict: "approve", findings: [blocking()] }, lines: ['verdict is approve but findings has 1 "blocking" entry; send request_changes or mark them "nit".'] },
    { name: "approve with two blocking findings (plural)", path: "array", params: { verdict: "approve", findings: [blocking(), blocking({ line: 2 })] }, lines: ['verdict is approve but findings has 2 "blocking" entries; send request_changes or mark them "nit".'] },
    { name: "findings missing", path: "array", params: { verdict: "approve" }, lines: ["findings is missing; send [] when there are none."] },
    { name: "line 0", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), line: 0 }] }, lines: ["findings[0].line is 0; send a 1-based integer or omit it."] },
    { name: "line -1", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), line: -1 }] }, lines: ["findings[0].line is -1; send a 1-based integer or omit it."] },
    { name: "line 1.5", path: "string", params: { verdict: "approve", findings: JSON.stringify([{ ...nit(0), line: 1.5 }]) }, lines: ["findings[0].line is 1.5; send a 1-based integer or omit it."] },
    { name: "severity major", path: "string", params: { verdict: "approve", findings: JSON.stringify([{ ...nit(0), severity: "major" }]) }, lines: ['findings[0].severity is "major"; allowed "blocking" or "nit".'] },
    { name: "empty file", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), file: "" }] }, lines: ["findings[0].file is missing or empty; send text."] },
    { name: "whitespace-only file", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), file: "  \t " }] }, lines: ["findings[0].file is missing or empty; send text."] },
    { name: "empty message", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), message: "" }] }, lines: ["findings[0].message is missing or empty; send text."] },
    { name: "whitespace-only message", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), message: " \n " }] }, lines: ["findings[0].message is missing or empty; send text."] },
    { name: "file over 300 after trim", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), file: ` ${long(301)} ` }] }, lines: ["findings[0].file is 301 characters; max 300. Shorten it."] },
    { name: "message over 1000 after trim", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), message: ` ${long(1_001)} ` }] }, lines: ["findings[0].message is 1,001 characters; max 1,000. Shorten it."] },
    { name: "fix over 1000 after trim", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), fix: ` ${long(1_001)} ` }] }, lines: ["findings[0].fix is 1,001 characters; max 1,000. Shorten it."] },
    { name: "41 findings", path: "array", params: { verdict: "approve", findings: Array.from({ length: 41 }, (_, n) => nit(n)) }, lines: ["findings has 41 entries; max 40. Keep the blocking ones and the most useful nits."] },
    { name: "malformed JSON string", path: "string", params: { verdict: "approve", findings: "[{not json" }, lines: ["findings: send an array of {file, line?, severity, message, fix?}."] },
  ];

  test.each(refused)("refuses $name ($path path) and writes nothing", async ({ params, lines }) => {
    const { state, review, report } = await reviewed();
    const before = stores(state, review.threadId);
    await expect(report(params)).rejects.toThrow(refusal(...lines));
    expect(stores(state, review.threadId)).toEqual(before);
    expect(before.report_seq).toBe(0);
  });

  test.each([
    ["a fractional line", { ...nit(0), line: 1.5 }],
    ["a severity outside blocking and nit", { ...nit(0), severity: "major" }],
  ])("the tool schema refuses an array with %s before checkReport runs, and writes nothing", async (_, finding) => {
    const { state, review, report } = await reviewed();
    const before = stores(state, review.threadId);
    await expect(report({ verdict: "approve", findings: [finding] })).rejects.toThrow('tool "chief_report" arguments are invalid: findings: Invalid input');
    expect(stores(state, review.threadId)).toEqual(before);
  });

  test("refuses findings on a non-reviewer report and writes nothing (array path)", async () => {
    const { state, worker } = await reviewed();
    const before = stores(state, worker.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done", findings: [nit(0)] }, { threadId: worker.threadId, projectId: "proj_1" }))
      .rejects.toThrow(refusal("findings is only for a reviewer's ready report (role is worker); remove it."));
    expect(stores(state, worker.threadId)).toEqual(before);
  });

  test("a refused request_changes leaves the streak at 0, and the corrected report then counts as the first rejection", async () => {
    const { state, review, report } = await reviewed();
    await expect(report({ verdict: "request_changes", findings: [nit(0)] })).rejects.toThrow("chief_report was not saved");
    expect(rowOf(state, review.threadId).reject_streak).toBe(0);
    await report({ verdict: "request_changes", findings: [blocking(), nit(0)] });
    expect(rowOf(state, review.threadId)).toMatchObject({ report_seq: 1, reject_streak: 1, verdict: "request_changes" });
  });

  test("accepts 40 findings and stores all of them", async () => {
    const { state, review, report } = await reviewed();
    const list = Array.from({ length: 40 }, (_, n) => nit(n));
    await report({ verdict: "approve", findings: list });
    expect(JSON.parse(rowOf(state, review.threadId).findings)).toEqual(list);
  });

  test("a JSON-string findings gives the same stored findings, verdict file and alert as the same array", async () => {
    const list = [blocking({ line: 3 }), nit(0)];
    const run = async (findings: unknown) => {
      const { state, review, report } = await reviewed();
      await report({ verdict: "request_changes", findings });
      const row = rowOf(state, review.threadId);
      // Thread ids differ per fixture: compare the texts with the ids masked.
      const mask = (text: string) => text.replaceAll(review.threadId, "<reviewer>");
      return { stored: row.findings, file: mask(await readFile(row.verdict_path, "utf8")), alert: mask(state.sent.at(-1).input[0].text).replace(/\S*verdict-1\.md/g, "<file>").replace(/thr_\w+/g, "<id>") };
    };
    const asArray = await run(list);
    const asString = await run(JSON.stringify(list));
    expect(asString.stored).toBe(asArray.stored);
    expect(asString.file.replace(/thr_\w+/g, "<id>")).toBe(asArray.file.replace(/thr_\w+/g, "<id>"));
    expect(asString.alert).toBe(asArray.alert);
    expect(JSON.parse(asArray.stored)).toEqual(list);
  });

  // The array path may be trimmed by the tool schema already; only the JSON-string path reaches the report with the spaces intact.
  test.each(["array", "string"] as const)("stores file, message and fix trimmed, and the verdict file lists them trimmed (%s path)", async (path) => {
    const { state, review, report } = await reviewed();
    const findings = [
      { file: `  ${long(300)}  `, line: 2, severity: "blocking", message: "  Blocking text  ", fix: "  Do this  " },
      { file: "  nit.ts ", severity: "nit", message: "\tNit text\n", fix: "   " },
    ];
    await report({ verdict: "request_changes", findings: path === "string" ? JSON.stringify(findings) : findings });
    const row = rowOf(state, review.threadId);
    expect(JSON.parse(row.findings)).toEqual([
      { file: long(300), line: 2, severity: "blocking", message: "Blocking text", fix: "Do this" },
      { file: "nit.ts", severity: "nit", message: "Nit text", fix: "" },
    ]);
    const file = await readFile(row.verdict_path, "utf8");
    const [blockingPart, nitPart] = file.split("## Nits");
    expect(blockingPart).toContain("## Blocking findings");
    expect(blockingPart).toContain("Blocking text");
    expect(blockingPart).toContain("Do this");
    expect(blockingPart).not.toMatch(/  Blocking text|Blocking text {2}|Do this {2}/);
    expect(nitPart).toContain("nit.ts");
    expect(nitPart).toContain("Nit text");
    expect(nitPart).not.toMatch(/\t|  Nit text|Nit text\n\n\n/);
  });

  test("request_changes writes one reviewer_verdicts row per covered target, adds 1 to reject_streak, and a later approve resets it", async () => {
    const { state, worker, review, report } = await reviewed();
    const verdictRows = () => state.db.prepare("SELECT worker_thread_id, verdict, report_seq FROM reviewer_verdicts WHERE reviewer_thread_id=? ORDER BY id").all(review.threadId);
    const commentsBefore = count(state, "forge_comments");
    await report({ verdict: "request_changes", findings: [blocking(), nit(0)] });
    expect(verdictRows()).toEqual([{ worker_thread_id: worker.threadId, verdict: "request_changes", report_seq: 1 }]);
    expect(rowOf(state, review.threadId).reject_streak).toBe(1);
    expect(count(state, "forge_comments")).toBe(commentsBefore + 1);
    await report({ verdict: "request_changes", findings: [blocking()] });
    expect(rowOf(state, review.threadId).reject_streak).toBe(2);
    expect(verdictRows()).toHaveLength(2);
    await report({ ...APPROVE });
    expect(rowOf(state, review.threadId)).toMatchObject({ reject_streak: 0, verdict: "approve", report_seq: 3 });
    expect(verdictRows().at(-1)).toEqual({ worker_thread_id: worker.threadId, verdict: "approve", report_seq: 3 });
  });
});

describe("reviewer lesson from chief_report to the next reviewer", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const EARLIER = "## Lessons from earlier review rounds";
  const REVIEW = "## Review lessons (known false positives and checks)";
  const as = (threadId: string, projectId = "proj_1") => ({ threadId, projectId });
  const instructionsOf = async (state: State, threadId: string, projectId = "proj_1", pluginMetadata?: object) =>
    (await state.harness.behavior.resolveAgentConfiguration({ ...configurationContext(threadId, projectId), ...(pluginMetadata ? { pluginMetadata } : {}) })).instructions as string;
  const section = (instructions: string, header: string) => instructions.split("\n\n").find((part) => part.startsWith(header));
  const lessonRows = (state: State) => state.db.prepare("SELECT project_id, text, source_thread_id, worker_thread_id, role FROM chief_lessons ORDER BY id").all();

  async function firstReview() {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(worker.threadId));
    const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    const report = (params: object, threadId = review.threadId) => state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...APPROVE, ...params }, as(threadId)) as Promise<unknown>;
    // The next reviewer reviews another worker of the same project.
    const nextReviewer = async () => {
      const other = await delegate(state, chief.threadId, `Other work ${Math.random()}`);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(other.threadId));
      return (await chiefReview(state, chief.threadId, { workerThreadId: other.threadId })).threadId;
    };
    return { state, chief, worker, review, report, nextReviewer };
  }

  test("a reviewer's lesson writes one reviewer-role row and the alert names it", async () => {
    const { state, worker, review, report } = await firstReview();
    await report({ lesson: "Check the discount path before flagging rounding." });
    expect(lessonRows(state)).toEqual([{
      project_id: "proj_1", text: "Check the discount path before flagging rounding.",
      source_thread_id: review.threadId, worker_thread_id: worker.threadId, role: "reviewer",
    }]);
    expect(state.sent.at(-1).input[0].text).toContain("Lesson recorded for future managed threads: Check the discount path before flagging rounding.");
  });

  test("the next reviewer of the project sees it under Review lessons; other roles and other projects do not", async () => {
    const { state, chief, report, nextReviewer } = await firstReview();
    await report({ lesson: "Rounding is by design." });
    const next = await nextReviewer();
    const seen = await instructionsOf(state, next);
    expect(section(seen, REVIEW)).toBe(`${REVIEW}\n- Rounding is by design.`);
    expect(seen).not.toContain(EARLIER);
    const seeded = (role: string) => ({ role, chiefThreadId: chief.threadId });
    for (const role of ["worker", "planner", "advisor"]) {
      const text = await instructionsOf(state, `thr_seed_${role}`, "proj_1", seeded(role));
      expect(text, role).not.toContain("Rounding is by design.");
      expect(text, role).not.toContain(REVIEW);
      expect(text, role).not.toContain(EARLIER);
    }
    const otherProject = await instructionsOf(state, "thr_seed_reviewer", "proj_2", seeded("reviewer"));
    expect(otherProject).not.toContain("Rounding is by design.");
    expect(otherProject).not.toContain(REVIEW);
    // Control: the same seeded reviewer in the lesson's own project does see it.
    expect(await instructionsOf(state, "thr_seed_reviewer", "proj_1", seeded("reviewer"))).toContain("- Rounding is by design.");
  });

  test("an advisor's lesson shows under earlier-review lessons for every managed role, and not under Review lessons", async () => {
    const { state, chief, nextReviewer } = await firstReview();
    await state.harness.behavior.runCli(["consult", "--title", "Rework checkout", "--mission", "Explore a fix for the discount bug"], as(chief.threadId));
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done", lesson: "Plans name their test wave." }, as(advisor.threadId));
    expect(lessonRows(state)).toEqual([expect.objectContaining({ text: "Plans name their test wave.", source_thread_id: advisor.threadId, role: "advisor" })]);
    const seeded = (role: string) => ({ role, chiefThreadId: chief.threadId });
    const next = await nextReviewer();
    const texts: [string, string][] = [["reviewer", await instructionsOf(state, next)]];
    for (const role of ["worker", "planner", "advisor"]) texts.push([role, await instructionsOf(state, `thr_seed_${role}`, "proj_1", seeded(role))]);
    for (const [role, text] of texts) {
      expect(section(text, EARLIER), role).toBe(`${EARLIER}\n- Plans name their test wave.`);
      expect(text, role).not.toContain(REVIEW);
    }
  });

  test("with 12 reviewer lessons the next reviewer sees the newest 10, oldest first", async () => {
    const { state, report, nextReviewer } = await firstReview();
    for (let n = 1; n <= 12; n += 1) await report({ lesson: `Lesson ${String(n).padStart(2, "0")}.` });
    expect(lessonRows(state)).toHaveLength(12);
    const shown = section(await instructionsOf(state, await nextReviewer()), REVIEW)!;
    expect(shown.split("\n")).toEqual([REVIEW, ...Array.from({ length: 10 }, (_, n) => `- Lesson ${String(n + 3).padStart(2, "0")}.`)]);
  });

  test("a lessons section over 3,000 characters is clipped at 3,000", async () => {
    const { state, report, nextReviewer } = await firstReview();
    for (let n = 0; n < 10; n += 1) await report({ lesson: `${n}`.repeat(400) });
    const shown = section(await instructionsOf(state, await nextReviewer()), REVIEW)!;
    expect(shown).toHaveLength(3_000);
    expect(shown.endsWith("…")).toBe(true);
    // Oldest first: the clipped tail is the newest lessons' end, and the oldest lesson is whole.
    expect(shown).toContain(`- ${"0".repeat(400)}\n- ${"1".repeat(400)}`);
    expect(shown).not.toContain("9".repeat(400));
  });

  test("a refused reviewer report with a lesson writes no chief_lessons row", async () => {
    const { state, review, report } = await firstReview();
    await expect(report({ verdict: "approve", findings: [{ file: "totals.ts", severity: "blocking", message: "Bad." }], lesson: "Never recorded." })).rejects.toThrow("chief_report was not saved");
    expect(lessonRows(state)).toEqual([]);
    expect(rowOf(state, review.threadId).report_seq).toBe(0);
  });

  test("a lesson on a non-ready report is refused and writes no row", async () => {
    const { state, review } = await firstReview();
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "blocked", result: "Stuck", blocker: "No access", recommendation: "Grant it", lesson: "Never recorded." }, as(review.threadId)))
      .rejects.toThrow('lesson is only allowed when state is ready (state is "blocked"); remove it.');
    expect(lessonRows(state)).toEqual([]);
  });
});

function rowOf(state: { db: any }, id: string) {
  return state.db.prepare("SELECT * FROM managed_threads WHERE thread_id=?").get(id) as any;
}

// Contract (work-list spec, Contracts that stay): `chief_roster` (Pending block, `todo #N` lines, the `after:` collapse line, "Other Chiefs' todos"),
// `bb chief status` text and JSON, and `handOver`'s move of `chief_todos` and undelivered alerts equal base 310043a9b808607fbc6537c8a7672777b9c24868
// for the same state. The oracle file holds what the scenario below printed at 310043a, captured in a separate checkout of that commit with
// WORKLIST_ORACLE_OUT=<file>; this replay must match it byte for byte on head. Both sides run the same scenario through the real
// `chief_roster` tool and `bb chief status` CLI; the database rows are read back only to see what handOver moved.
// Regression: a roster/status/hand-off byte changing with the panel removal, e.g. the Pending block reading a deleted `todoItems`, a todo not moved to the successor, or an undelivered alert left on the superseded Chief.
const WORKLIST_ORACLE = join(dirname(fileURLToPath(import.meta.url)), "workList.base310043a.oracle.json");
async function workListScenario() {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const state = await setup();
    const out: Array<{ step: string; value: unknown }> = [];
    const norm = (text: string) => text.split(state.storageRoot).join("<storage>");
    const ctx = (threadId: string) => ({ threadId, projectId: "proj_1" });
    const roster = async (threadId: string, params: object = {}) => norm(String(await state.harness.behavior.callAgentTool("chief_roster", params, ctx(threadId))));
    const cli = async (args: string[], context?: ReturnType<typeof ctx>) => {
      const result = await state.harness.behavior.runCli(["status", "--project", "proj_1", ...args], context);
      return { exitCode: result.exitCode, stdout: norm(result.stdout ?? ""), stderr: norm(result.stderr ?? "") };
    };
    const record = async (step: string, ...chiefs: string[]) => {
      for (const chief of chiefs) {
        out.push({ step: `${step}: roster of ${chief}`, value: await roster(chief) });
        out.push({ step: `${step}: roster of ${chief} with waiting and complete`, value: await roster(chief, { includeWaiting: true, includeComplete: true }) });
      }
      out.push({ step: `${step}: bb chief status`, value: await cli([]) });
      out.push({ step: `${step}: bb chief status --json`, value: await cli(["--json"]) });
    };

    const a = await start(state);
    const b = JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!) as { threadId: string };
    await record("two Chiefs, no todos", a.threadId, b.threadId);

    await roster(a.threadId, { todo: { text: "Alpha" } });
    await roster(a.threadId, { todo: { text: "Bravo", after: "user signs" } });
    await roster(a.threadId, { todo: { text: "Charlie", after: "PR #42 merges" } });
    await roster(b.threadId, { todo: { text: "Delta" } });
    await record("todos added, after: collapsed", a.threadId, b.threadId);

    await roster(a.threadId, { todo: { id: 1, text: "Alpha, renamed", after: "" } });
    await roster(a.threadId, { todo: { id: 2, state: "done" } });
    await roster(a.threadId, { todo: { id: 3, state: "dropped" } });
    await record("todos updated and closed", a.threadId, b.threadId);

    const worker = await delegate(state, a.threadId, "Fix checkout totals");
    state.failNextSend(); // the report alert stays undelivered, so the hand-off has one to move
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for the successor" }, ctx(worker.threadId));
    await record("a ready worker and an undelivered alert", a.threadId, b.threadId);

    const handOffState = (step: string) => {
      out.push({ step: `${step}: chief_todos rows`, value: state.db.prepare(`SELECT id, project_id, chief_thread_id, text, after, state FROM chief_todos ORDER BY id`).all() });
      out.push({ step: `${step}: alert_outbox rows`, value: (state.db.prepare(`SELECT dedupe_key, target_thread_id, source_thread_id, delivered_at IS NOT NULL AS delivered FROM alert_outbox ORDER BY dedupe_key`).all() as any[])
        .map((row) => ({ ...row, dedupe_key: row.dedupe_key.replace(/:[0-9a-f]{16}$/, ":<hash>") })) }); // the key's tail hashes the storage path, which differs per run
      out.push({ step: `${step}: alert messages sent`, value: state.sent.map((message) => ({ threadId: message.threadId, text: norm(message.input[0].text) })) });
    };
    const archive = async (threadId: string) => {
      state.live.set(threadId, { ...state.live.get(threadId)!, archivedAt: Date.now() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(threadId)! });
      await state.supervisorCycle();
    };

    handOffState("before any hand-off");
    // Chief A ends while Chief B is live: its todos and undelivered alert move to B.
    await archive(a.threadId);
    handOffState("A archived, hand-off to B");
    await record("after the hand-off to B", b.threadId); // A is complete: only an active Chief may call chief_roster
    // Chief B ends with no other live Chief: a replacement Chief is spawned and receives them.
    await archive(b.threadId);
    const replacement = (await status(state)).threads.filter((row) => row.role === "chief" && ![a.threadId, b.threadId].includes(row.threadId)).map((row) => row.threadId);
    out.push({ step: "B archived: the replacement Chief threads", value: replacement });
    handOffState("B archived, hand-off to the replacement");
    await record("after the hand-off to the replacement", ...replacement);
    return `${JSON.stringify(out, null, 2)}\n`;
  } finally {
    vi.useRealTimers();
  }
}

describe("work list: base 310043a oracle", () => {
  test.runIf(process.env.WORKLIST_ORACLE_OUT)("capture the oracle (run at 310043a)", async () => {
    await writeFile(process.env.WORKLIST_ORACLE_OUT!, await workListScenario());
  });

  test.skipIf(process.env.WORKLIST_ORACLE_OUT)("roster, bb chief status and the hand-off equal base on the same scenario", async () => {
    expect(await workListScenario()).toBe(await readFile(WORKLIST_ORACLE, "utf8"));
  });
});

describe("tracker integration", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const P = { projectId: "proj_1" };
  const BB = process.env.BB_CLI ?? "bb";
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = (state: State, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, ...P }) as Promise<any>;
  const sha12 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
  const until = async (done: () => unknown) => { for (let i = 0; i < 300 && !done(); i += 1) await sleep(5); expect(done()).toBeTruthy(); };
  afterEach(() => { vi.useRealTimers(); });

  /** `bb tasks`, faked behind execFileMock: an in-memory tracker. gh answers as the forge-comment tests' does. */
  function tasksCli(options: { hang?: boolean } = {}) {
    const tasks = new Map<string, { description: string; comments: { id: string; kind: string; body: string; createdAt: string }[] }>();
    const calls: string[][] = [];
    const attachments: { task: string; name: string; content: string }[] = [];
    let tick = 0;
    const stamp = () => new Date(1_800_000_000_000 + (tick += 1_000)).toISOString();
    const ok = (body: object = {}) => ({ stdout: JSON.stringify({ ok: true, ...body }), stderr: "" });
    const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
    const addComment = (task: string, body: string) => {
      const comment = { id: `c${++tick}`, kind: "user", body, createdAt: stamp() };
      tasks.get(task)!.comments.push(comment);
      return comment;
    };
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === "gh") return args[0] === "pr" ? { stdout: ghHead("feature/x"), stderr: "" } : { stdout: args.includes("POST") || args.includes("--paginate") ? "" : "boss\n", stderr: "" };
      if (file !== BB || args[0] !== "tasks") return { stdout: "", stderr: "" };
      const a = args.slice(1, -1);
      calls.push(a);
      if (options.hang) return new Promise<never>(() => {});
      const [verb, id] = a;
      switch (verb) {
        case "create": { const task = `task_${tasks.size + 1}`; tasks.set(task, { description: flag(a, "--description"), comments: [] }); return ok({ task: { id: task } }); }
        case "list": return ok({ tasks: [...tasks].map(([task, value]) => ({ id: task, description: value.description })) });
        case "show": return ok({ task: { id, description: tasks.get(id!)!.description }, comments: tasks.get(id!)!.comments });
        case "comment": return ok({ comment: { id: addComment(id!, flag(a, "--body")).id } });
        case "attachment": attachments.push({ task: a[2]!, name: flag(a, "--name"), content: await readFile(flag(a, "--file"), "utf8") }); return ok();
        case "label": return a[1] === "list" ? ok({ labels: [] }) : ok();
        case "update": if (a.includes("--description")) tasks.get(id!)!.description = flag(a, "--description"); return ok();
        default: return ok();
      }
    });
    return {
      calls, attachments, tasks,
      /** The owner's reply on a task. */
      owner: (task: string, body: string) => addComment(task, body),
      of: (verb: string) => calls.filter((a) => a[0] === verb),
      statuses: () => calls.filter((a) => a[0] === "update" && a.includes("--status")).map((a) => a[a.indexOf("--status") + 1]!),
    };
  }
  type Tasks = ReturnType<typeof tasksCli>;

  const on = (state: State) => state.harness.behavior.setSettings({ plannerEnabled: true, tracker: "bb-tasks", trackerProjects: "proj_1=ABC" });
  /** Supervisor passes until the tracker has made no new call for one more pass. */
  async function settled(state: State, tasks: Tasks) {
    let last = -1;
    for (let i = 0; i < 30; i += 1) {
      await state.supervisorCycle();
      await sleep(25);
      if (tasks.calls.length === last) return;
      last = tasks.calls.length;
    }
    throw new Error("the tracker never went quiet");
  }
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const chiefCtx = (chief: string) => ({ threadId: chief, ...P });
  const plan = (state: State, chief: string, args: string[] = []) =>
    state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", ...args], chiefCtx(chief));
  const planners = async (state: State) => (await status(state)).threads.filter((row) => row.role === "planner").map((row) => row.threadId);
  const WAVES = [{ body: PLAN_FIXTURE }, TEST_WAVE(2)];
  // Only a plan of more than one implementation wave gets its one advisor review.
  const MULTI = [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)];
  const ready = (state: State, planner: string, waves: object[] = WAVES) => call(state, "chief_report", { state: "ready", result: "Waves written.", plan: waves }, planner);
  async function delegateTo(state: State, chief: string, args: string[]) {
    const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], chiefCtx(chief));
    expect(result.exitCode, result.stderr).toBe(0);
    return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
  }
  /** Ready report, an approving review, then Chief completes the worker. */
  async function approveAndComplete(state: State, chief: string, worker: string) {
    await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker);
    const review = await chiefReview(state, chief, { workerThreadId: worker });
    await call(state, "chief_report", { state: "ready", result: "Checked", ...APPROVE }, review.threadId);
    await call(state, "chief_complete", { threadId: worker }, chief);
  }
  const decisionBody = (n: number, request: string) =>
    `**Decision #${n}** (Chief)\n\n${request}\n\nAnswer with a comment; start it with #${n} when several decisions are open.\n\nchief-decision:${sha12(request)}`;
  const answerAlerts = (state: State) => state.sent.filter((message) => String(message.input?.[0]?.text).includes("The owner answered decision"));

  // Contract (tracker spec, Bootstrap + Mirroring): from an empty store a new plan becomes one task: created with the unit marker as
  // the last description line, the planner attached, status planning (todo), in that order, and only on a supervisor pass.
  // Regression: a tool that calls the CLI itself; a second create; attach before create; a wrong first status.
  test("tracker integration: a plan creates one task, attaches its planner and sets planning, on supervisor passes only", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [planner] = await planners(state);
    await until(() => state.db.prepare("SELECT 1 FROM tracker_units").get());
    expect(tasks.calls).toEqual([]);
    await settled(state, tasks);
    expect(tasks.calls).toEqual([
      ["status"],
      ["create", "--project", "ABC", "--title", "Rework checkout", "--description", `Propose how to fix totals\n\nchief-unit:${sha12(planner!)}`],
      ["attach", "task_1", "--thread", planner],
      ["update", "task_1", "--status", "todo"],
    ]);
    expect(state.db.prepare("SELECT task_id, create_state, status FROM tracker_units").all()).toEqual([{ task_id: "task_1", create_state: "sent", status: "planning" }]);
  });

  // Contract (spec, Mirroring + Planned unit): a revision creates no task; its planner is attached and the first planner detached after
  // that attach; the status follows the effective (revised) plan: working once its wave is delegated, done only when that plan is absorbed.
  // Regression: a second task for the revision; detach before the successor's attach; done while a wave is still open.
  test("tracker integration: a revision creates no task and the status follows the revised plan to done", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [first] = await planners(state);
    await ready(state, first!, MULTI);
    await call(state, "chief_consult", { planThreadId: first, title: "Plan", mission: "Review this plan before delegation" }, chief);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!.threadId;
    await call(state, "chief_report", { state: "ready", result: "Merge the waves", verdict: "request_changes" }, advisor);
    await plan(state, chief, ["--revises", first!]);
    const revised = (await planners(state)).find((id) => id !== first)!;
    await ready(state, revised);
    await settled(state, tasks);
    expect(tasks.of("create")).toHaveLength(1);
    expect(tasks.of("attach").map((a) => a[3])).toEqual([first, revised]);
    expect(tasks.calls.findIndex((a) => a[0] === "attach" && a[3] === revised)).toBeLessThan(tasks.calls.findIndex((a) => a[0] === "detach" && a[3] === first));
    expect(tasks.statuses()).toEqual(["todo"]);

    const wave1 = await delegateTo(state, chief, ["--plan-thread", revised, "--wave", "1"]);
    const wave2 = await delegateTo(state, chief, ["--replaces", wave1, "--plan-thread", revised, "--wave", "2"]);
    await settled(state, tasks);
    expect(tasks.statuses()).toEqual(["todo", "in_progress"]);

    await approveAndComplete(state, chief, wave2);
    await settled(state, tasks);
    expect(tasks.statuses()).toEqual(["todo", "in_progress", "done"]);
    expect(tasks.of("create")).toHaveLength(1);
  });

  // Contract (spec, Mirroring): a plan advisor's escalation posts its decision on the task of the plan it reviews, not on a new task.
  test("tracker integration: a plan advisor's chief_escalate posts on the plan's task", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [planner] = await planners(state);
    await ready(state, planner!, MULTI);
    await call(state, "chief_consult", { planThreadId: planner, title: "Plan", mission: "Review this plan before delegation" }, chief);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!.threadId;
    await call(state, "chief_escalate", { threadId: advisor, request: "Split the plan in two?" }, chief);
    await settled(state, tasks);
    expect(tasks.of("create")).toHaveLength(1);
    expect(tasks.of("comment")).toEqual([["comment", "task_1", "--body", decisionBody(1, "Split the plan in two?"), "--author", "Chief"]]);
  });

  // Contract (spec, Mirroring + Unplanned unit): an unplanned delegation creates a working task; a replaces: successor is attached and
  // the predecessor detached after that attach; the unit stays working until the tip completes.
  // Regression: a completed predecessor finishing the unit; detach before attach; a second task for the successor.
  test("tracker integration: an unplanned delegation makes a task; replaces attaches the successor then detaches the predecessor", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    const first = await delegate(state, chief);
    await settled(state, tasks);
    expect(tasks.calls.map((a) => a[0])).toEqual(["status", "create", "attach", "update"]);
    expect(tasks.of("create")[0]![4]).toBe("Fix checkout totals");
    expect(tasks.statuses()).toEqual(["in_progress"]);

    const second = await delegate(state, chief, "Fix checkout totals", { replaces: first.threadId });
    await settled(state, tasks);
    const at = (verb: string, thread: string) => tasks.calls.findIndex((a) => a[0] === verb && a[3] === thread);
    expect(at("attach", second.threadId)).toBeGreaterThan(-1);
    expect(at("detach", first.threadId)).toBeGreaterThan(at("attach", second.threadId));
    expect(tasks.of("create")).toHaveLength(1);
    expect(tasks.statuses()).toEqual(["in_progress"]);

    await completeWorker(state, chief, second.threadId);
    await settled(state, tasks);
    expect(tasks.statuses()).toEqual(["in_progress", "done"]);
  });

  const ISSUE = "https://github.com/acme/shop/issues/7";
  const norm = (state: State, text: string) => text.replaceAll(state.storageRoot, "<root>");
  const taskOf = (tasks: Tasks, root: string) => [...tasks.tasks].find(([, task]) => task.description.endsWith(`chief-unit:${sha12(root)}`))![0];

  /** One scripted run through the real tool callers: a plan and its report, an unplanned worker reviewed and approved, two escalations. */
  async function reportsScenario(state: State) {
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [planner] = await planners(state);
    const out: string[] = [];
    out.push(await ready(state, planner!));
    const worker = (await delegate(state, chief, "Fix totals", { issueUrl: ISSUE })).threadId;
    out.push(await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker));
    const review = await chiefReview(state, chief, { workerThreadId: worker });
    out.push(review.text, await call(state, "chief_report", { state: "ready", result: "Reviewed", ...APPROVE }, review.threadId));
    out.push(await call(state, "chief_escalate", { threadId: worker, request: "Which total rule?" }, chief));
    out.push(await call(state, "chief_escalate", { threadId: worker, request: "May I merge?", merge: true }, chief));
    await until(() => !state.db.prepare("SELECT 1 FROM forge_comments WHERE posted_at IS NULL AND gave_up_at IS NULL").get());
    return { chief, planner: planner!, worker, review: review.threadId, out };
  }
  const forgeCalls = () => execFileMock.mock.calls.filter(([file]) => file === "gh").map(([file, args]) => JSON.stringify([file, args]));
  /** The scenario on a fresh host, tracker off or on, then everything the owner sees. */
  async function parity(trackerOn: boolean) {
    execFileMock.mockReset();
    const state = await setup();
    const tasks = tasksCli();
    if (trackerOn) await on(state); else await state.harness.behavior.setSettings({ plannerEnabled: true });
    const run = await reportsScenario(state);
    await settled(state, tasks);
    const n = (text: string) => norm(state, text);
    return {
      state, tasks, run,
      seen: {
        out: run.out.map((text) => n(String(text))),
        alerts: state.sent.map((message) => [message.threadId, n(message.input[0].text)]),
        forge: (state.db.prepare("SELECT dedupe_key, target, body, mention FROM forge_comments ORDER BY dedupe_key").all() as object[]).map((row) => JSON.parse(n(JSON.stringify(row)))),
        gh: forgeCalls().map(n),
      },
    };
  }

  // Contract (spec, Off, unmapped, and unavailable + Mirroring): with the tracker off nothing is written or run; switched on, every
  // tool result, alert (text and order), forge comment and gh call equals the tracker-off run of the same scenario.
  // Regression: a tracker hook that changes a result string, delays or reorders an alert, or adds a forge comment; tracker rows or a CLI run while off.
  test("tracker integration: results, alerts and forge comments equal the tracker-off run, which writes no tracker row and runs no tracker CLI", async () => {
    const off = await parity(false);
    expect(off.tasks.calls).toEqual([]);
    expect([off.state.db.prepare("SELECT count(*) AS n FROM tracker_units").get(), off.state.db.prepare("SELECT count(*) AS n FROM tracker_receipts").get()]).toEqual([{ n: 0 }, { n: 0 }]);
    const onRun = await parity(true);
    expect(onRun.tasks.calls.length).toBeGreaterThan(0);
    expect(onRun.seen).toEqual(off.seen);
  });

  // Contract (spec, Mirroring): a planner's ready report attaches plan-N.md, a reviewer verdict attaches verdict-<seq>.md to the reviewed
  // worker's unit, with the files' content; the payload is NULL once the receipt is sent. chief_escalate posts one decision; merge: true none.
  // Regression: files attached to the wrong unit; a payload kept; a decision posted for a merge request.
  test("tracker integration: plan and verdict files reach their units; an escalation posts one decision and merge: true none", async () => {
    const { state, tasks, run } = await parity(true);
    const onDisk = (id: string, name: string) => readFile(join(state.storageRoot, "chief", "proj_1", id, name), "utf8");
    const files = (root: string) => tasks.attachments.filter((a) => a.task === taskOf(tasks, root));
    expect(files(run.planner)).toEqual([
      { task: taskOf(tasks, run.planner), name: "plan-1.md", content: await onDisk(run.planner, "plan-1.md") },
      { task: taskOf(tasks, run.planner), name: "plan-2.md", content: await onDisk(run.planner, "plan-2.md") },
    ]);
    expect(files(run.worker)).toEqual([{ task: taskOf(tasks, run.worker), name: "verdict-1.md", content: await onDisk(run.review, "verdict-1.md") }]);
    expect(state.db.prepare("SELECT state, payload FROM tracker_receipts WHERE kind='file'").all()).toEqual(Array(3).fill({ state: "sent", payload: null }));
    expect(tasks.of("comment")).toEqual([["comment", taskOf(tasks, run.worker), "--body", decisionBody(1, "Which total rule?"), "--author", "Chief"]]);
  });

  /** An unplanned worker with one open decision per request, posted to its task. */
  async function decided(state: State, tasks: Tasks, requests: string[]) {
    const chief = (await start(state)).threadId;
    const worker = (await delegate(state, chief, "Fix totals")).threadId;
    for (const request of requests) await call(state, "chief_escalate", { threadId: worker, request }, chief);
    await settled(state, tasks);
    return { chief, worker, task: taskOf(tasks, worker) };
  }
  const ANSWERED = (n: number, comment: string) => `The owner answered decision #${n} on tracker task “Fix totals”:\n${comment}\nTreat this as the owner's answer to that Need you request.`;

  // Contract (spec, Answers): an owner comment on the task reaches Chief as exactly one alert, however often the poll sees it; the
  // decision flag is raised by the decision and lowered by its answer.
  // Regression: a second alert on a later poll; an answer that never reaches Chief; a flag left raised.
  test("tracker integration: an owner comment on the task gives Chief exactly one alert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const { chief, task } = await decided(state, tasks, ["Pick A or B?"]);
    expect(tasks.of("comment")).toEqual([["comment", task, "--body", decisionBody(1, "Pick A or B?"), "--author", "Chief"]]);
    expect(tasks.of("update").filter((a) => a.includes("--add-label"))).toHaveLength(1);
    expect(answerAlerts(state)).toHaveLength(0);
    tasks.owner(task, "Option A");
    for (let i = 0; i < 3; i += 1) { advance(61_000); await settled(state, tasks); }
    expect(answerAlerts(state).map((message) => [message.threadId, message.input[0].text])).toEqual([[chief, `[Chief lifecycle alert]\n${ANSWERED(1, "Option A")}`]]);
    expect(tasks.of("update").filter((a) => a.includes("--remove-label"))).toHaveLength(1);
  });

  // Contract (spec, Answers reasons): the answer rides the existing outbox, so a hand-off sends an undelivered answer to the replacement Chief.
  // Regression: an answer stranded on the superseded Chief.
  test("tracker integration: after a Chief hand-over a pending answer goes to the replacement Chief", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const { chief, task } = await decided(state, tasks, ["Pick A or B?"]);
    tasks.owner(task, "Option A");
    state.failNextSend();
    advance(61_000);
    await state.supervisorCycle();
    const pending = () => state.db.prepare("SELECT target_thread_id, delivered_at FROM alert_outbox WHERE dedupe_key LIKE '%:answer'").get() as { target_thread_id: string; delivered_at: number | null } | undefined;
    await until(() => pending());
    expect(pending()).toEqual({ target_thread_id: chief, delivered_at: null });
    state.addLive("thr_adopted", "proj_1");
    expect((await state.harness.behavior.runCli(["adopt", "--thread", "thr_adopted"])).exitCode).toBe(0);
    await state.supervisorCycle();
    await until(() => pending()?.delivered_at);
    expect(pending()!.target_thread_id).toBe("thr_adopted");
    expect(answerAlerts(state).map((message) => [message.threadId, message.input[0].text])).toEqual([["thr_adopted", `[Chief lifecycle alert]\n${ANSWERED(1, "Option A")}`]]);
  });

  // Contract (spec, Answers reasons): each decision's answer has its own alert kind, so two answers to two decisions on one thread both
  // survive an unreachable Chief and both are delivered by the outbox retry.
  // Regression: the later answer evicting the earlier undelivered one (same-kind eviction of writeAlert).
  test("tracker integration: two answers to two decisions survive an unreachable Chief and both are delivered by retryAlerts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const { chief, task } = await decided(state, tasks, ["Pick A or B?", "Ship now or later?"]);
    tasks.owner(task, "#1 Option A");
    tasks.owner(task, "#2 Later");
    state.failNextSend();
    state.failNextSend();
    advance(61_000);
    await state.supervisorCycle();
    const rows = () => state.db.prepare("SELECT target_thread_id, delivered_at, attempts FROM alert_outbox WHERE dedupe_key LIKE '%:answer' ORDER BY dedupe_key").all() as { target_thread_id: string; delivered_at: number | null; attempts: number }[];
    await until(() => rows().length === 2 && rows().every((row) => row.attempts === 1));
    expect(rows().map((row) => [row.target_thread_id, row.delivered_at])).toEqual([[chief, null], [chief, null]]);
    expect(answerAlerts(state)).toHaveLength(0);
    await state.supervisorCycle();
    await until(() => rows().every((row) => row.delivered_at));
    expect(answerAlerts(state).map((message) => message.input[0].text).sort()).toEqual([
      `[Chief lifecycle alert]\n${ANSWERED(1, "#1 Option A")}`, `[Chief lifecycle alert]\n${ANSWERED(2, "#2 Later")}`,
    ]);
  });

  // Contract (spec, Unit of work; recovery of a thread whose launch has not inserted its row): a spawn-seeded recovery has no pull request
  // or branch, so it inserts a row only when none exists once its lookup returns. A follow-up whose launch row (with its PR and branch)
  // landed while the lookup awaited stays on the earlier unit: its report files and decisions reach the original task, and no task is added.
  // The three callers of that recovery are the worker's own chief_report (reportIntake), chief_research (managedRow) and Chief's
  // chief_inspect (resolveTarget). launched: false is the control: with no launch, recovery still inserts the row.
  // Regression: an unconditional recovery insert at any one of them, which upserts the keys to null so the thread drops out of its unit.
  describe.each<[string, "worker" | "chief", string, object, string | undefined]>([
    ["chief_report (reportIntake)", "worker", "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, undefined],
    ["chief_research (managedRow)", "worker", "chief_research", { mode: "survey", question: "Who calls this?", items: ["a.ts"] }, "not available to a managed worker"],
    ["chief_inspect (resolveTarget)", "chief", "chief_inspect", {}, undefined],
  ])("stale spawn recovery through %s", (_name, caller, tool, params, rejection) => {
    test.each([true, false])("launch row landed during the lookup: %s", async (launched) => {
      const hold = { id: "", gate: Promise.resolve(), entered: () => {}, taken: false };
      const state = await setup({ onPluginMetadata: async (id) => { if (id === hold.id && !hold.taken) { hold.taken = true; hold.entered(); await hold.gate; } } });
      const tasks = tasksCli();
      await on(state);
      const chief = (await start(state)).threadId;
      const keys = { prUrl: "https://github.com/acme/shop/pull/1", branch: "feature/x" };
      const first = (await delegate(state, chief, "Fix checkout totals", keys)).threadId;
      await completeWorker(state, chief, first);
      await settled(state, tasks);
      expect(tasks.of("create")).toHaveLength(1);

      // The follow-up's thread exists and is ours, but its launch has not inserted a row yet.
      const id = `thr_${state.spawned.length + 1}`;
      state.addLive(id, "proj_1", "Follow-up", "chief");
      state.live.get(id)!.parentThreadId = chief;
      state.seedPluginMetadata(id, { role: "worker", chiefThreadId: chief });
      let release!: () => void;
      hold.id = id;
      hold.gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { hold.entered = resolve; });
      const callerId = caller === "chief" ? chief : id;
      const stale = call(state, tool, caller === "chief" ? { threadId: id } : params, callerId).then(() => undefined, (error: Error) => error);
      await entered;
      if (launched) expect((await delegate(state, chief, "Fix checkout totals", keys)).threadId).toBe(id);
      release();
      const error = await stale;
      if (rejection) expect(error?.message).toContain(rejection); else expect(error).toBeUndefined();

      const row = () => state.db.prepare("SELECT role, pr_url, branch FROM managed_threads WHERE thread_id=?").get(id);
      if (!launched) {
        expect(row()).toEqual({ role: "worker", pr_url: null, branch: null });
        return;
      }
      expect(row()).toEqual({ role: "worker", pr_url: keys.prUrl, branch: keys.branch });
      // Later work of the follow-up lands on the original task: its reviewer's verdict file and its decision.
      if (tool !== "chief_report") await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, id);
      const review = await chiefReview(state, chief, { workerThreadId: id });
      await call(state, "chief_report", { state: "ready", result: "Checked", ...APPROVE }, review.threadId);
      await call(state, "chief_escalate", { threadId: id, request: "Which total rule?" }, chief);
      await settled(state, tasks);
      expect(tasks.of("create")).toHaveLength(1);
      expect([...tasks.tasks.keys()]).toEqual(["task_1"]);
      expect(tasks.of("attach").filter((a) => a[3] === id)).toEqual([["attach", "task_1", "--thread", id]]);
      expect(tasks.attachments.map((a) => [a.task, a.name])).toEqual([["task_1", "verdict-1.md"]]);
      expect(tasks.of("comment").map((a) => a[1])).toEqual(["task_1", "task_1"]);
      expect(tasks.of("comment").map((a) => a[3])).toEqual([expect.stringContaining(`chief-request:${id}`), decisionBody(1, "Which total rule?")]);
    });
  });

  // Contract (spec, Failure handling): a bb tasks CLI that never resolves blocks none of chief_plan, chief_delegate, chief_report, chief_escalate.
  // Regression: a tool or report that awaits the adapter hangs here (the race names the tool that did).
  test("tracker integration: a bb tasks CLI that never resolves blocks no tool", async () => {
    const state = await setup();
    const tasks = tasksCli({ hang: true });
    await on(state);
    const chief = (await start(state)).threadId;
    const within = async (name: string, run: () => Promise<unknown>) => {
      const result = await Promise.race([run(), sleep(1_500).then(() => `BLOCKED: ${name}`)]);
      expect(result, `${name} waited for the tracker`).not.toBe(`BLOCKED: ${name}`);
      return result;
    };
    await within("chief_plan", () => plan(state, chief));
    const [planner] = await planners(state);
    await until(() => state.db.prepare("SELECT 1 FROM tracker_units").get());
    await state.supervisorCycle();
    await until(() => tasks.calls.length > 0);
    const worker = await within("chief_delegate", () => delegate(state, chief, "Fix totals", { issueUrl: ISSUE })) as { threadId: string };
    await within("chief_report", () => ready(state, planner!));
    await within("chief_report (worker)", () => call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker.threadId));
    await within("chief_escalate", () => call(state, "chief_escalate", { threadId: worker.threadId, request: "Which total rule?" }, chief));
    expect(tasks.calls).toEqual([["status"]]);
  });
});

// Byte-equivalence with base 310043a (before the tracker existed). The golden file tracker.base310043a.oracle.json was recorded on that
// commit by running the scenario block below, extracted verbatim between its markers, with ORACLE_OUT_TRACKER set. Here the head
// output of the same fixture, in each mode that must behave as "off", must equal it. With ORACLE_OUT_TRACKER set, this describe
// writes {meta, outputs} to that path instead of comparing.
// ==== TRACKER-ORACLE-SCENARIO-BEGIN ====
const TRACKER_ORACLE_BB = process.env.BB_CLI ?? "bb";
const TRACKER_ORACLE_FIXTURE = [
  "chief start; chief plan --title 'Rework checkout' --mission 'Propose how to fix totals'",
  "planner chief_report ready with plan [PLAN_FIXTURE, TEST_WAVE(2)]",
  "chief delegate wave 1 (--plan-thread, --wave 1, --issue-url)",
  "wave 1 chief_report ready; chief_escalate 'Which total rule?'",
  "chief delegate wave 2 (--replaces wave 1); worker report; chief review; reviewer chief_report approve; chief_complete wave 2",
  "resolveAgentConfiguration: the chief tool list with its parameter schemas",
  "supervisor cycles, then everything the owner or the host saw: results, alerts, forge comments, exec'd commands",
];
type TrackerOracleMode = { settings: Record<string, unknown>; bbTasks: "none" | "unavailable" };
async function trackerOracleRun(mode: TrackerOracleMode) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  execFileMock.mockReset();
  execFileMock.mockImplementation(async (file: string, args: string[]) => {
    if (file === "gh") return args[0] === "pr" ? { stdout: ghHead("feature/x"), stderr: "" } : { stdout: args.includes("POST") || args.includes("--paginate") ? "" : "boss\n", stderr: "" };
    if (file === TRACKER_ORACLE_BB && args[0] === "tasks") throw new Error("bb tasks is unavailable");
    return { stdout: "", stderr: "" };
  });
  const state = await setup();
  await state.harness.behavior.setSettings({ plannerEnabled: true, ...mode.settings });
  const norm = (text: string) => text.replaceAll(state.storageRoot, "<root>");
  const results: unknown[] = [];
  const cli = async (chief: string, args: string[]) => {
    const result = await state.harness.behavior.runCli(args, { threadId: chief, projectId: "proj_1" });
    results.push({ args: args.map(norm), exitCode: result.exitCode, stdout: norm(String(result.stdout)), stderr: norm(String(result.stderr)) });
    return result;
  };
  const tool = async (threadId: string, name: string, params: object) => {
    const result = await state.harness.behavior.callAgentTool(name, params, { threadId, projectId: "proj_1" });
    results.push({ tool: name, threadId, result: norm(JSON.stringify(result)) });
    return result as any;
  };
  const chief = (await start(state)).threadId;
  await cli(chief, ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"]);
  const planner = (await status(state)).threads.find((row) => row.role === "planner")!.threadId;
  await tool(planner, "chief_report", { state: "ready", result: "Waves written.", plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2)] });
  const delegateWave = async (args: string[]) => JSON.parse((await cli(chief, ["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"])).stdout!) as { threadId: string };
  const wave1 = (await delegateWave(["--plan-thread", planner, "--wave", "1", "--issue-url", "https://github.com/acme/shop/issues/7"])).threadId;
  const finish = async (worker: string) => {
    await tool(worker, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` });
    const review = await chiefReview(state, chief, { workerThreadId: worker });
    results.push({ review: norm(JSON.stringify(review)) });
    await tool(review.threadId, "chief_report", { state: "ready", result: "Checked", ...APPROVE });
  };
  await tool(wave1, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` });
  await tool(chief, "chief_escalate", { threadId: wave1, request: "Which total rule?" });
  const wave2 = (await delegateWave(["--replaces", wave1, "--plan-thread", planner, "--wave", "2"])).threadId;
  await finish(wave2);
  await tool(chief, "chief_complete", { threadId: wave2 });
  const config = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief));
  const tools = JSON.parse(JSON.stringify(config.tools)) as { name: string }[];
  for (let i = 0; i < 4; i += 1) { await state.supervisorCycle(); await sleep(25); }
  for (let i = 0; i < 300 && state.db.prepare("SELECT 1 FROM forge_comments WHERE posted_at IS NULL AND gave_up_at IS NULL").get(); i += 1) await sleep(5);
  return {
    results,
    tools,
    alerts: state.sent.map((message) => [message.threadId, norm(String(message.input?.[0]?.text))]),
    forge: (state.db.prepare("SELECT dedupe_key, project_id, thread_id, target, body, mention, attempts, posted_at IS NOT NULL AS posted, gave_up_at IS NOT NULL AS gave_up FROM forge_comments ORDER BY dedupe_key").all() as object[])
      .map((row) => JSON.parse(norm(JSON.stringify(row)))),
    exec: execFileMock.mock.calls.map(([file, args]: [string, string[]]) => [file, args.map(norm)] as [string, string[]]),
  };
}
// ==== TRACKER-ORACLE-SCENARIO-END ====

describe("tracker off-mode equivalence with base 310043a", () => {
  const fixtureHash = createHash("sha256").update(JSON.stringify(TRACKER_ORACLE_FIXTURE)).digest("hex");
  const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "tracker.base310043a.oracle.json");
  type Golden = { meta: { head: string; fixtureHash: string; cwd: string; runnerRoot: string; scenarios: number }; outputs: Awaited<ReturnType<typeof trackerOracleRun>> };
  const statusProbe: [string, string[]] = [TRACKER_ORACLE_BB, ["tasks", "status", "--json"]];

  // Capture: runs on the base checkout only, where the settings below are unknown and ignored.
  test.runIf(process.env.ORACLE_OUT_TRACKER)("records the base output of the fixture", async () => {
    const outputs = await trackerOracleRun({ settings: {}, bbTasks: "none" });
    const { promisify } = await import("node:util");
    const real = promisify((await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFile);
    const head = (await real("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
    const meta = { cwd: process.cwd(), runnerRoot: dirname(fileURLToPath(import.meta.url)), head, fixtureHash, scenarios: TRACKER_ORACLE_FIXTURE.length };
    await writeFile(process.env.ORACLE_OUT_TRACKER!, `${JSON.stringify({ meta, outputs }, null, 2)}\n`);
  });

  // Contract (spec, Off, unmapped, and unavailable): with tracker=none, with bb-tasks on an unmapped project, and with a mapped project
  // whose bb tasks is unavailable, every chief_* result, alert (text and order), forge comment and exec'd command is byte-identical to
  // base 310043a for the same fixture, through the real tool callers. Only the new optional `merge` field of chief_escalate is excluded
  // from the tool schemas; the one extra exec allowed is the `bb tasks status --json` probe, and only when the project is mapped.
  // Regression: a tracker hook that changes a result string, alert, forge comment or schema, or that runs a CLI while off or unmapped.
  test.skipIf(process.env.ORACLE_OUT_TRACKER)("tool results, alerts, forge comments, commands and tool schemas equal the base recording for tracker none, unmapped and unavailable", async () => {
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as Golden;
    expect(golden.meta.head).toBe("310043a9b808607fbc6537c8a7672777b9c24868");
    expect(golden.meta.fixtureHash).toBe(fixtureHash);
    const withoutMerge = (outputs: Golden["outputs"]) => {
      const escalate = outputs.tools.find((tool) => tool.name === "chief_escalate") as any;
      expect(JSON.stringify(escalate)).toContain("merge");
      // Authorized Coordinator deltas (COORD-2/5/6), each asserted exactly, then removed: chief_coordinate; chief_spawn's optional projectId;
      // chief_escalate's optional threadId and its one added description sentence.
      const coordinate = outputs.tools.find((tool) => tool.name === "chief_coordinate");
      expect(coordinate).toBeDefined();
      const spawn = JSON.parse(JSON.stringify(outputs.tools.find((tool) => tool.name === "chief_spawn")));
      expect(spawn.inputSchema.properties.projectId.description).toBe("Coordinator only: the project the new Chief works in. Defaults to your own project.");
      expect(spawn.inputSchema.required).not.toContain("projectId");
      delete spawn.inputSchema.properties.projectId;
      const stripped = JSON.parse(JSON.stringify(escalate, (key, value) => (key === "merge" ? undefined : value)));
      const SENTENCE = " Omit threadId only when no managed thread concerns the request yet.";
      expect(stripped.inputSchema.required).not.toContain("threadId");
      stripped.inputSchema.required = ["threadId", ...stripped.inputSchema.required];
      expect(stripped.description.endsWith(SENTENCE)).toBe(true);
      stripped.description = stripped.description.slice(0, -SENTENCE.length);
      return { ...outputs, tools: outputs.tools.filter((tool) => tool !== coordinate).map((tool) => (tool === escalate ? stripped : tool.name === "chief_spawn" ? spawn : tool)) };
    };
    // [name, mode, whether the supervisor's one cached availability probe is expected]: off never probes; unmapped may (the probe runs before
    // any unit is read); a mapped project with units must.
    const modes: [string, TrackerOracleMode, "never" | "may" | "must"][] = [
      ["tracker=none", { settings: { tracker: "none" }, bbTasks: "none" }, "never"],
      ["bb-tasks, project not mapped", { settings: { tracker: "bb-tasks", trackerProjects: "proj_other=ABC" }, bbTasks: "none" }, "may"],
      ["bb-tasks, mapped, bb tasks unavailable", { settings: { tracker: "bb-tasks", trackerProjects: "proj_1=ABC" }, bbTasks: "unavailable" }, "must"],
    ];
    for (const [name, mode, probe] of modes) {
      const actual = await trackerOracleRun(mode);
      const extra = actual.exec.filter(([file, args]) => file === statusProbe[0] && args[0] === "tasks");
      expect(extra.every((call) => JSON.stringify(call) === JSON.stringify(statusProbe)), `${name}: the only extra exec is bb tasks status --json`).toBe(true);
      expect(probe === "never" ? extra.length === 0 : probe === "must" ? extra.length > 0 : true, `${name}: probe count ${extra.length}`).toBe(true);
      const rest = { ...actual, exec: actual.exec.filter((call) => !extra.includes(call)) };
      const baseSchemas = golden.outputs.tools;
      expect({ ...withoutMerge(rest), tools: undefined }, name).toEqual({ ...golden.outputs, tools: undefined });
      expect(withoutMerge(rest).tools, `${name}: tool schemas`).toEqual(baseSchemas);
    }
  });
});

// docs/specs/coordinator.md (COORD-1..COORD-10). Every case below comes from that spec and the plan contracts, not from server.ts.
describe("Coordinator", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const call = (state: S, tool: string, params: object, threadId: string, projectId = "proj_1") =>
    state.harness.behavior.callAgentTool(tool, params, { threadId, projectId }) as Promise<string>;
  const cli = (state: S, args: string[], threadId?: string, projectId = "proj_1") =>
    state.harness.behavior.runCli(args, threadId ? { threadId, projectId } : { projectId });
  /** A fresh Chief row with no handover: `bb chief create`. */
  async function make(state: S, projectId = "proj_1") {
    const result = await cli(state, ["create", "--project", projectId, "--json"], undefined, projectId);
    expect(result.exitCode, result.stderr).toBe(0);
    return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
  }
  async function coordinator(state: S, projectId = "proj_1") {
    const id = await make(state, projectId);
    await call(state, "chief_coordinate", {}, id, projectId);
    return id;
  }
  async function spawnChild(state: S, parent: string, params: Record<string, unknown> = {}, projectId = "proj_1") {
    const text = await call(state, "chief_spawn", { request: "Do the task", context: "Goal: done", ...params }, parent, projectId);
    return { text, id: /in thread (thr_\w+)/.exec(text)![1]! };
  }
  const row = (state: S, id: string) => rowOf(state, id) as any;
  const kinds = (state: S) => state.db.prepare(`SELECT dedupe_key AS key, source_thread_id AS source, target_thread_id AS target, delivered_at IS NOT NULL AS delivered FROM alert_outbox WHERE dedupe_key LIKE '%:coordinator-%' ORDER BY rowid`).all() as
    { key: string; source: string; target: string; delivered: number }[];
  const doneKeys = (state: S) => kinds(state).filter((alert) => alert.key.includes(":coordinator-done:"));
  const needYouKeys = (state: S) => kinds(state).filter((alert) => alert.key.includes(":coordinator-need-you:"));
  const idle = async (state: S, id: string) => {
    state.live.set(id, { ...state.live.get(id)!, status: "idle" });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(id)!, lastAssistantText: "done" });
    await settle();
  };
  const sentToCoordinator = (state: S, id: string) => state.sent.filter((message) => message.threadId === id);

  describe("migrations (COORD-10)", () => {
    // Fingerprint of the 134 statements at base 95aa7df (JSON.stringify sha256), taken from an untouched base checkout.
    const BASE_MIGRATIONS = { length: 134, sha256: "c5053c8e7deaa962bd2bf6a221c05b8f5918c6bcd22dd1e7f653b67f319c0795" };

    test("the base statements are unchanged and the two Coordinator columns are appended", () => {
      const prefix = MIGRATIONS.slice(0, BASE_MIGRATIONS.length);
      expect(createHash("sha256").update(JSON.stringify(prefix)).digest("hex")).toBe(BASE_MIGRATIONS.sha256);
      expect(MIGRATIONS.slice(BASE_MIGRATIONS.length)).toEqual([
        "ALTER TABLE managed_threads ADD COLUMN coordinator INTEGER",
        "ALTER TABLE managed_threads ADD COLUMN coordinator_thread_id TEXT",
      ]);
    });

    test("a fresh database has both columns; a database at the base migrations keeps its rows with NULL columns", async () => {
      const fresh = await setup();
      const columns = (db: any) => (db.prepare("PRAGMA table_info(managed_threads)").all() as { name: string }[]).map((c) => c.name);
      expect(columns(fresh.db)).toEqual(expect.arrayContaining(["coordinator", "coordinator_thread_id"]));

      const { bb } = createFakePluginHost({ pluginId: "chief-upgrade-coord" });
      const db = bb.storage.database();
      bb.storage.migrate(db, MIGRATIONS.slice(0, BASE_MIGRATIONS.length));
      expect(columns(db)).not.toContain("coordinator");
      const insert = db.prepare("INSERT INTO managed_threads (thread_id, role, project_id, title, state, created_at, updated_at) VALUES (?, ?, 'proj_1', ?, ?, 1, 1)");
      insert.run("thr_old_chief", "chief", "Chief", "idle");
      insert.run("thr_old_worker", "worker", "Worker", "active");
      bb.storage.migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT thread_id, role, state, coordinator, coordinator_thread_id FROM managed_threads ORDER BY thread_id").all()).toEqual([
        { thread_id: "thr_old_chief", role: "chief", state: "idle", coordinator: null, coordinator_thread_id: null },
        { thread_id: "thr_old_worker", role: "worker", state: "active", coordinator: null, coordinator_thread_id: null },
      ]);
      expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();
    });
  });

  describe("upgrade (COORD-1)", () => {
    test("an idle Chief becomes a Coordinator once; a repeat changes nothing", async () => {
      const state = await setup();
      const chief = await make(state);
      const text = await call(state, "chief_coordinate", {}, chief);
      expect(text).toContain("one-way");
      expect(text).toContain("chief_attach");
      expect(row(state, chief)).toMatchObject({ role: "chief", coordinator: 1, coordinator_thread_id: null });
      const before = state.db.prepare("SELECT * FROM managed_threads ORDER BY thread_id").all();
      expect(await call(state, "chief_coordinate", {}, chief)).toBe("Already a Coordinator.");
      expect(state.db.prepare("SELECT * FROM managed_threads ORDER BY thread_id").all()).toEqual(before);
    });

    test("an open todo does not block the upgrade and stays", async () => {
      const state = await setup();
      const chief = await make(state);
      await call(state, "chief_roster", { todo: { text: "Remember the milk" } }, chief);
      await call(state, "chief_coordinate", {}, chief);
      expect(row(state, chief).coordinator).toBe(1);
      expect(state.db.prepare("SELECT chief_thread_id, state FROM chief_todos").all()).toEqual([{ chief_thread_id: chief, state: "open" }]);
    });

    test("open managed work blocks the upgrade, ready and blocked count, and the message lists the row ids", async () => {
      const state = await setup();
      const chief = await make(state);
      const first = await delegate(state, chief, "First");
      const second = await delegate(state, chief, "Second");
      await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, first.threadId);
      await call(state, "chief_report", { state: "blocked", blocker: "Need a key", recommendation: "Ask the owner" }, second.threadId);
      expect(row(state, first.threadId).last_report_state).toBe("ready");
      await expect(call(state, "chief_coordinate", {}, chief)).rejects.toThrow(new RegExp(`${first.threadId}.*${second.threadId}|${second.threadId}.*${first.threadId}`));
      expect(row(state, chief).coordinator).toBeNull();
      await completeWorker(state, chief, first.threadId);
      await completeWorker(state, chief, second.threadId);
      await call(state, "chief_coordinate", {}, chief);
      expect(row(state, chief).coordinator).toBe(1);
    });

    test("a child Chief, an inactive Chief and a non-Chief caller are refused and nothing changes", async () => {
      const state = await setup();
      const parent = await coordinator(state);
      const child = (await spawnChild(state, parent)).id;
      await expect(call(state, "chief_coordinate", {}, child)).rejects.toThrow(parent);
      expect(row(state, child)).toMatchObject({ coordinator: null, coordinator_thread_id: parent });

      const archived = await make(state);
      state.db.prepare("UPDATE managed_threads SET state='archived' WHERE thread_id=?").run(archived);
      const worker = await delegate(state, await make(state), "Work");
      for (const caller of [archived, worker.threadId, "thr_unknown"]) {
        await expect(call(state, "chief_coordinate", {}, caller)).rejects.toThrow("requires an active registered Chief");
      }
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE coordinator=1").get()).toEqual({ n: 1 });
    });

    test("nothing clears the Coordinator flag: lifecycle events, the supervisor and bb chief start", async () => {
      const state = await setup();
      const chief = await coordinator(state);
      await idle(state, chief);
      state.live.set(chief, { ...state.live.get(chief)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(chief)! });
      await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(chief)!, lastAssistantText: "boom" });
      await state.supervisorCycle();
      await start(state);
      expect(row(state, chief).coordinator).toBe(1);
    });
  });

  describe("purity (COORD-2)", () => {
    // The refused list is COORD-2's own list.
    const REFUSED: Array<[string, object]> = [
      ["chief_plan", { title: "T", mission: "M" }],
      ["chief_consult", { title: "T", mission: "M" }],
      ["chief_delegate", { title: "T", mission: "M", unplannedReason: "r" }],
      ["chief_forge_init", { title: "T" }],
      ["chief_review", { branch: "b" }],
      ["chief_inspect", { threadId: "thr_x" }],
      ["chief_continue", { threadId: "thr_x", instruction: "go" }],
      ["chief_stop", { threadId: "thr_x" }],
      ["chief_complete", { threadId: "thr_x" }],
      ["chief_owner_approval", { workerThreadId: "thr_x", approval: "ok" }],
      ["chief_skip_tests", { planThreadId: "thr_x", wave: 1, reason: "r" }],
      ["chief_skip_specs", { planThreadId: "thr_x", wave: 1, reason: "r" }],
      ["chief_escalate", { request: "help" }],
      ["chief_sync", {}],
      ["chief_research", { mode: "survey", question: "q", items: ["a"] }],
    ];

    test("a Coordinator is configured with exactly chief_roster, chief_spawn and chief_attach, and no skills", async () => {
      const state = await setup();
      const id = await coordinator(state);
      const configuration = await state.harness.behavior.resolveAgentConfiguration(configurationContext(id));
      expect(configuration.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["chief_attach", "chief_roster", "chief_spawn"]);
      expect(configuration.skills).toEqual([]);
    });

    test.each(REFUSED)("%s refuses a Coordinator before it does anything", async (tool, params) => {
      const state = await setup();
      const id = await coordinator(state);
      const rows = state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get();
      const spawned = state.spawned.length;
      await expect(call(state, tool, params, id)).rejects.toThrow(/not available to a Coordinator.*ask the child Chief that owns the work/i);
      await expect(call(state, tool, params, id)).rejects.toThrow(/planner, worker, reviewer, tester, advisor or researcher/);
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get()).toEqual(rows);
      expect(state.spawned.length).toBe(spawned);
    });

    test("the same tools still work for a plain Chief (the refusal is the Coordinator's alone)", async () => {
      const state = await setup();
      const chief = await make(state);
      await expect(call(state, "chief_inspect", { threadId: "thr_x" }, chief)).rejects.toThrow("No managed thread thr_x for this Chief");
      expect(await call(state, "chief_sync", {}, chief)).not.toMatch(/Coordinator/);
    });

    test.each([
      [["plan", "--title", "T", "--mission", "M"]],
      [["consult", "--title", "T", "--mission", "M"]],
      [["delegate", "--title", "T", "--mission", "M", "--unplanned-reason", "r", "--json"]],
      [["stop", "thr_x"]],
      [["inspect", "thr_x"]],
      [["continue", "thr_x", "--instruction", "go"]],
      [["complete", "thr_x"]],
    ])("bb chief %j refuses a Coordinator with the same message", async (args) => {
      const state = await setup();
      const id = await coordinator(state);
      const result = await cli(state, args, id);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/not available to a Coordinator.*ask the child Chief that owns the work/i);
      expect(state.spawned.filter((spawn) => spawn.pluginMetadata?.role === "worker" || spawn.pluginMetadata?.role === "planner")).toEqual([]);
    });

    test("chief_report, chief_log and a repeated chief_coordinate keep their ordinary results for a Coordinator", async () => {
      const state = await setup();
      const plain = await make(state);
      const id = await coordinator(state);
      const outcome = async (caller: string) => call(state, "chief_report", { state: "ready", result: "x" }, caller).then((text) => text, (error: Error) => `throw ${error.message}`);
      const normalize = (text: string, caller: string) => text.split(caller).join("<caller>");
      expect(normalize(await outcome(id), id)).toBe(normalize(await outcome(plain), plain));
      expect(await call(state, "chief_log", {}, id)).toBe("Not part of a plan run.");
      expect(await call(state, "chief_coordinate", {}, id)).toBe("Already a Coordinator.");
    });

    test("routing never lands on a Coordinator, even when it is the newest Chief of the project", async () => {
      const state = await setup();
      const only = await coordinator(state);
      // A project whose only Chief is a Coordinator: start makes a plain Chief and leaves the Coordinator alone.
      const first = await start(state);
      expect(first).toMatchObject({ created: true });
      expect(first.threadId).not.toBe(only);
      expect(row(state, only)).toMatchObject({ coordinator: 1, state: expect.not.stringMatching(/complete|archived/) });
      // The Coordinator is now newer than the plain Chief; start and an operator delegate still pick the plain Chief.
      const newer = await coordinator(state);
      expect(await start(state)).toEqual({ threadId: first.threadId, created: false });
      const worker = await delegate(state, first.threadId, "Plain work");
      await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
      const operator = await cli(state, ["delegate", "--title", "Shell work", "--mission", "M", "--unplanned-reason", "r", "--json"]);
      expect(operator.exitCode, operator.stderr).toBe(0);
      const shellWorker = JSON.parse(operator.stdout!).threadId as string;
      expect([row(state, worker.threadId).chief_thread_id, row(state, shellWorker).chief_thread_id]).toEqual([first.threadId, first.threadId]);
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE chief_thread_id IN (?, ?)").get(only, newer)).toEqual({ n: 0 });
    });
  });

  describe("ownership (COORD-3)", () => {
    test("bb chief adopt of a Coordinator fails and changes nothing: the active Chief keeps its work, todo and undelivered alert", async () => {
      const state = await setup();
      const plain = (await start(state)).threadId;
      const worker = await delegate(state, plain);
      await call(state, "chief_roster", { todo: { text: "Keep me" } }, plain);
      state.failNextSend();
      await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker.threadId);
      const id = await coordinator(state);
      const snapshot = () => ({
        rows: state.db.prepare("SELECT thread_id, state, chief_thread_id, coordinator, coordinator_thread_id FROM managed_threads ORDER BY thread_id").all(),
        todos: state.db.prepare("SELECT chief_thread_id, state FROM chief_todos").all(),
        pending: state.db.prepare("SELECT dedupe_key, target_thread_id FROM alert_outbox WHERE delivered_at IS NULL ORDER BY dedupe_key").all(),
      });
      const before = snapshot();
      expect((before.pending as any[]).some((alert) => alert.target_thread_id === plain)).toBe(true);
      const result = await cli(state, ["adopt", "--thread", id]);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain("Coordinator");
      expect(snapshot()).toEqual(before);
      expect(row(state, plain).state).not.toBe("complete");
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE chief_thread_id=?").get(id)).toEqual({ n: 0 });
    });

    test("an archived Chief's open work, todos and alerts go to a plain Chief, never to a Coordinator in the same project", async () => {
      const state = await setup();
      const old = (await start(state)).threadId;
      const worker = await delegate(state, old);
      await call(state, "chief_roster", { todo: { text: "Carry me" } }, old);
      const id = await coordinator(state);
      state.live.set(old, { ...state.live.get(old)!, archivedAt: Date.now() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(old)! });
      await state.supervisorCycle();
      const owner = row(state, worker.threadId).chief_thread_id as string;
      expect(row(state, old).state).toBe("complete");
      expect(owner).not.toBe(old);
      expect(owner).not.toBe(id);
      expect(row(state, owner)).toMatchObject({ role: "chief", coordinator: null });
      expect(state.db.prepare("SELECT chief_thread_id FROM chief_todos").all()).toEqual([{ chief_thread_id: owner }]);
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE chief_thread_id=?").get(id)).toEqual({ n: 0 });
      expect(row(state, id)).toMatchObject({ coordinator: 1, state: expect.not.stringMatching(/complete|archived/) });
    });

    test("re-adopting a linked child keeps its Coordinator link", async () => {
      const state = await setup();
      const parent = await coordinator(state);
      const child = (await spawnChild(state, parent, { projectId: "proj_2" })).id;
      expect(row(state, child).coordinator_thread_id).toBe(parent);
      const result = await cli(state, ["adopt", "--thread", child]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(row(state, child)).toMatchObject({ role: "chief", coordinator_thread_id: parent });
    });
  });

  describe("attach (COORD-4)", () => {
    const reload = (state: S, caller: string) => call(state, "chief_roster", { todo: { text: "reload" } }, caller);

    test("one result line per id: every outcome, in any project, never touching chief_thread_id", async () => {
      const state = await setup();
      const parent = await coordinator(state);
      const other = await coordinator(state, "proj_2");
      const owner = await make(state);
      const worker = (await delegate(state, owner, "Plain work")).threadId;
      const archived = await make(state);
      const finished = await make(state);
      const linkedElsewhere = (await spawnChild(state, other, {}, "proj_2")).id;
      const mine = (await spawnChild(state, parent)).id;
      const sameProject = await make(state);
      const otherProject = await make(state, "proj_2");
      state.db.prepare("UPDATE managed_threads SET state='archived' WHERE thread_id=?").run(archived);
      state.db.prepare("UPDATE managed_threads SET state='complete' WHERE thread_id=?").run(finished);
      await reload(state, parent);
      const before = row(state, mine);
      const ids = [parent, worker, "thr_nowhere", archived, finished, other, linkedElsewhere, mine, sameProject, otherProject];
      const lines = (await call(state, "chief_attach", { threadIds: ids }, parent)).split("\n");
      expect(lines).toEqual([
        `${parent}: not attached: is you.`,
        `${worker}: not attached: is not a Chief row: run \`bb chief adopt --thread ${worker}\` first.`,
        "thr_nowhere: not attached: is not a Chief row: run `bb chief adopt --thread thr_nowhere` first.",
        `${archived}: not attached: is archived.`,
        `${finished}: not attached: is complete.`,
        `${other}: not attached: is a Coordinator.`,
        `${linkedElsewhere}: not attached: already belongs to Coordinator ${other}.`,
        `${mine}: already attached (no change).`,
        `${sameProject}: attached.`,
        `${otherProject}: attached.`,
      ]);
      expect(row(state, mine)).toEqual(before);
      for (const id of [sameProject, otherProject]) expect(row(state, id)).toMatchObject({ coordinator_thread_id: parent, chief_thread_id: null, coordinator: null });
      expect(row(state, linkedElsewhere).coordinator_thread_id).toBe(other);
      expect(row(state, other).coordinator_thread_id).toBeNull();
      expect(row(state, parent).coordinator_thread_id).toBeNull();
    });

    test("a repeated attach is a no-op line and writes nothing", async () => {
      const state = await setup();
      const parent = await coordinator(state);
      const chief = await make(state);
      await call(state, "chief_attach", { threadIds: [chief] }, parent);
      const before = state.db.prepare("SELECT * FROM managed_threads ORDER BY thread_id").all();
      expect(await call(state, "chief_attach", { threadIds: [chief, chief] }, parent)).toBe(`${chief}: already attached (no change).`);
      expect(state.db.prepare("SELECT * FROM managed_threads ORDER BY thread_id").all()).toEqual(before);
    });

    test("two Coordinators attaching the same Chief at once leave exactly one link", async () => {
      const state = await setup();
      const first = await coordinator(state);
      const second = await coordinator(state);
      const chief = await make(state);
      const results = await Promise.all([call(state, "chief_attach", { threadIds: [chief] }, first), call(state, "chief_attach", { threadIds: [chief] }, second)]);
      expect(results.filter((line) => line.endsWith(": attached."))).toHaveLength(1);
      const winner = row(state, chief).coordinator_thread_id as string;
      expect([first, second]).toContain(winner);
      expect(results.find((line) => !line.endsWith(": attached."))).toBe(`${chief}: not attached: already belongs to Coordinator ${winner}.`);
    });

    test("only an active Coordinator may attach, and 1 to 20 ids are accepted", async () => {
      const state = await setup();
      const plain = await make(state);
      const parent = await coordinator(state);
      await expect(call(state, "chief_attach", { threadIds: [plain] }, plain)).rejects.toThrow("for a Coordinator only");
      await expect(call(state, "chief_attach", { threadIds: [] }, parent)).rejects.toThrow("invalid");
      await expect(call(state, "chief_attach", { threadIds: Array.from({ length: 21 }, (_, i) => `thr_${i}`) }, parent)).rejects.toThrow("invalid");
      expect((await call(state, "chief_attach", { threadIds: Array.from({ length: 20 }, (_, i) => `thr_none${i}`) }, parent)).split("\n")).toHaveLength(20);
    });
  });
});
