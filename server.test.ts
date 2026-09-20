import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin, { capDiff, MIGRATIONS } from "./server";
import { metricKeys } from "./jev/types";

const jev = vi.hoisted(() => ({ pingGateway: vi.fn(), runEvaluation: vi.fn() }));
vi.mock("./jev/gateway", () => jev);

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
  let patch = "diff --git a/totals.ts b/totals.ts\n+const total = subtotal - discount;";
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
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_1" }),
        diffFiles: async () => ({ outcome: "available", files: [{ path: "totals.ts" }] }),
        diffPatch: async () => ({ outcome: "available", patches: [{ patch, truncated: false }] }),
      },
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
    setPatch(next: string) { patch = next; },
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

async function delegate(
  state: Awaited<ReturnType<typeof setup>>,
  chiefThreadId: string,
  title = "Fix checkout totals",
  tier?: "junior" | "senior",
  forge?: { branch?: string; issueUrl?: string; prUrl?: string },
) {
  const result = await state.harness.behavior.runCli([
    "delegate", "--title", title, "--mission", "Correct and verify totals", "--criteria", "Regression passes",
    ...(tier ? ["--tier", tier] : []),
    ...(forge?.branch ? ["--branch", forge.branch] : []),
    ...(forge?.issueUrl ? ["--issue-url", forge.issueUrl] : []),
    ...(forge?.prUrl ? ["--pr-url", forge.prUrl] : []),
    "--json",
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
    expect(state.spawned.at(-1).prompt).toContain("Remain review-only");
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

  test("sends the finished reviewer back after the worker fixes what it found", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const ready = async () => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Ready for review",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.emitThreadEvent("thread.idle", {
        thread: state.live.get(worker.threadId)!,
        lastAssistantText: "done",
      });
    };
    await ready();
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Totals are off by the discount", verdict: "request_changes",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    await state.harness.behavior.runCli(["continue", worker.threadId, "--instruction", "Fix the discount"]);

    await ready();

    // One reviewer, but it must be asked again — a fix cycle cannot ship unreviewed.
    expect(state.spawned.filter((entry) => entry.title === "Review · Fix checkout totals")).toHaveLength(1);
    expect(state.sent.filter((entry) => entry.threadId === reviewer.threadId).at(-1).input[0].text)
      .toContain("Re-check the current worktree");
    expect(state.sent.at(-1).input[0].text).toContain("re-check the latest changes");
  });

  test("routes on a reviewer's structured verdict and names a pair that stops converging", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const ready = async () => {
      await state.harness.behavior.callAgentTool("chief_report", {
        state: "ready", result: "Ready for review",
      }, { threadId: worker.threadId, projectId: "proj_1" });
      await state.harness.behavior.emitThreadEvent("thread.idle", {
        thread: state.live.get(worker.threadId)!,
        lastAssistantText: "done",
      });
    };
    await ready();
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer.threadId)! });

    // A rejection must be a field, not prose Chief has to parse back out.
    await expect(state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice",
    }, { threadId: reviewer.threadId, projectId: "proj_1" })).rejects.toThrow(/verdict/);

    const reject = async () => state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "The discount is still applied twice", verdict: "request_changes",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    await reject();
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: request_changes");
    expect(state.sent.at(-1).input[0].text).toContain("Continue the worker");
    expect(state.sent.at(-1).input[0].text).not.toContain("not converging");
    expect(JSON.stringify(await state.harness.behavior.callAgentTool(
      "chief_inspect", { threadId: reviewer.threadId }, { threadId: chief.threadId },
    ))).toContain("Verdict: request_changes");

    // Second round on the same objection: Chief is told to escalate, not to fund a third.
    await state.harness.behavior.runCli(["continue", worker.threadId, "--instruction", "Fix the discount"]);
    await ready();
    await reject();
    expect(state.sent.at(-1).input[0].text).toContain("not converging");
    expect(state.sent.at(-1).input[0].text).toContain("escalate to the user");
  });

  test("tells Chief to complete work its reviewer approved", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Ready for review",
    }, { threadId: worker.threadId, projectId: "proj_1" });
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(worker.threadId)!,
      lastAssistantText: "done",
    });
    const reviewer = (await status(state)).threads.find((row) => row.role === "reviewer")!;
    await state.harness.behavior.callAgentTool("chief_report", {
      state: "ready", result: "Confirmed against the regression test", verdict: "approve",
    }, { threadId: reviewer.threadId, projectId: "proj_1" });
    expect(state.sent.at(-1).input[0].text).toContain("Verdict: approve");
    expect(state.sent.at(-1).input[0].text).toContain("mark the pull request ready");
  });

  test("hands the reviewer the brief and report the work was judged against", async () => {
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
    const review = state.spawned.find((entry: any) => entry.title === "Review · Fix checkout totals");
    // Without the brief the reviewer scores the change against a standard nobody set.
    expect(review.prompt).toContain("Correct and verify totals");
    expect(review.prompt).toContain("Regression passes");
    expect(review.prompt).toContain("Totals fixed and covered by a test");
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

  test("tells Jev when the diff it scores was cut short", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const review = JSON.parse((await state.harness.behavior.runCli(["review", worker.threadId, "--json"])).stdout!);
    jev.pingGateway.mockResolvedValue(undefined);
    // Stored and re-read on the next pass, so it has to satisfy the real schema.
    jev.runEvaluation.mockResolvedValue({
      metrics: Object.fromEntries(metricKeys.map((key) => [
        key,
        key === "correctness" ? { applicable: true, score: 8, confidence: 0.8 } : { applicable: false },
      ])),
      priorities: [],
    });
    await state.harness.behavior.setSettings({ jevApiKey: "gw_key" });
    expect((await state.harness.behavior.callRpc("jevCheck", null)).ok).toBe(true);
    await state.harness.behavior.setSettings({ jevEnabled: true });

    await state.harness.behavior.callAgentTool("chief_score", { baseBranch: "main" }, { threadId: review.threadId });
    expect(jev.runEvaluation.mock.calls.at(-1)![1]).not.toHaveProperty("diffTruncated");

    // A diff cut to fit reads as missing implementation unless the scorer is told.
    state.setPatch("x".repeat(200 * 1024));
    await state.harness.behavior.callAgentTool("chief_score", { baseBranch: "main" }, { threadId: review.threadId });
    expect(jev.runEvaluation.mock.calls.at(-1)![1].diffTruncated).toContain("cut to fit");
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
    expect(chief.tools.map((tool) => tool.name)).toEqual(["chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_review", "chief_complete"]);
    expect(chief.skills).toEqual(["chief"]);
    expect(worker.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    expect(worker.skills).toEqual(["chief-worker"]);
    expect(ordinary.tools).toEqual([]);
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
    expect(script).toContain("git commit-tree");
    expect(script).toContain("CHIEF_FORGE branch=%s");
    // A worker must never be able to open branches and pull requests of its own.
    const worker = await delegate(state, chief.threadId);
    await expect(state.harness.behavior.callAgentTool(
      "chief_forge_init", { title: "Sneak one in" }, { threadId: worker.threadId, projectId: "proj_1" },
    )).rejects.toThrow(/active registered Chief/);
  });

  test("says the tier policy and the project rules once", async () => {
    const state = await setup();
    const chief = await start(state);
    const prompt = state.spawned[0].prompt as string;
    // Both live in what bb.agents.configure puts into every Chief turn: the chief
    // skill and the rules. A second copy in the spawn prompt is one that can drift.
    expect(prompt).not.toContain("## Project rules");
    expect(prompt).not.toContain("high blast radius");
    expect(prompt).toContain("chief_forge_init");
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configured.instructions).toContain("Chief operating rules");
  });

  test("counts how often each Jev dimension abstained instead of scoring", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    const review = JSON.parse((await state.harness.behavior.runCli(["review", worker.threadId, "--json"])).stdout!);
    jev.pingGateway.mockResolvedValue(undefined);
    jev.runEvaluation.mockResolvedValue({
      metrics: Object.fromEntries(metricKeys.map((key) => [
        key,
        key === "correctness" ? { applicable: true, score: 8, confidence: 0.8 } : { applicable: false },
      ])),
      priorities: [],
    });
    await state.harness.behavior.setSettings({ jevApiKey: "gw_key" });
    expect((await state.harness.behavior.callRpc("jevCheck", null)).ok).toBe(true);
    await state.harness.behavior.setSettings({ jevEnabled: true });
    await state.harness.behavior.callAgentTool("chief_score", { baseBranch: "main" }, { threadId: review.threadId });

    const stats = JSON.parse((await state.harness.behavior.runCli(["jev-stats", "--json"])).stdout!) as
      { metric: string; samples: number; abstainedPercent: number; meanScore: number | null }[];
    expect(stats).toHaveLength(metricKeys.length);
    expect(stats.find((row) => row.metric === "correctness")).toMatchObject({ samples: 1, abstainedPercent: 0, meanScore: 8 });
    expect(stats.find((row) => row.metric === "projectStructure")).toMatchObject({ abstainedPercent: 100, meanScore: null });
    expect((await state.harness.behavior.runCli(["jev-stats"])).stdout).toContain("abstained");
  });

  test("keeps planning off until the setting turns it on", async () => {
    const state = await setup();
    const chief = await start(state);
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configured.tools.map((tool) => tool.name)).not.toContain("chief_plan");
    await expect(state.harness.behavior.callAgentTool("chief_plan", {
      title: "Rework checkout", mission: "Propose how to fix totals",
    }, { threadId: chief.threadId, projectId: "proj_1" })).rejects.toThrow(/Planning is off/);
    expect(state.spawned).toHaveLength(1);
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
    expect(spawned.prompt).toContain("do not create, modify, or delete files");
    expect(JSON.stringify(plan)).toContain("Read its plan before delegating");

    const planner = (await status(state)).threads.find((row) => row.role === "planner")!;
    expect(planner.chiefThreadId).toBe(chief.threadId);
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    expect(configured.tools.map((tool) => tool.name)).toContain("chief_plan");
    expect(configured.instructions).toContain("chief_plan first");
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
      state: "ready", result: "Change totals.ts, then cover it with a test",
    }, { threadId: planner.threadId, projectId: "proj_1" });

    const reported = state.sent.at(-1).input[0].text;
    // Not "Worker report": Chief has to see which role spoke.
    expect(reported).toContain("Planner report");
    expect(reported).toContain("chief_delegate with the agreed plan");

    // A plan is not work: going idle must not start a reviewer on it.
    await state.harness.behavior.emitThreadEvent("thread.idle", {
      thread: state.live.get(planner.threadId)!,
      lastAssistantText: "plan ready",
    });
    expect(state.spawned.some((entry) => String(entry.title).startsWith("Review · "))).toBe(false);

    // Chief stays read-only with the planner unless it says otherwise.
    await state.harness.behavior.runCli(["continue", planner.threadId, "--instruction", "Name the test file"]);
    expect(state.sent.at(-1).input[0].text).toContain("Remain read-only");
  });

  test("upgrading an existing database keeps its rows and admits the planner role", async () => {
    // The rebuild that widens the role CHECK drops live tables, so the upgrade
    // path is driven here against a real database rather than only a fresh one.
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade" });
    disposals.push(() => harness.lifecycle.dispose());
    const db = bb.storage.database();
    const beforePlanner = MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("'planner'")));
    bb.storage.migrate(db, beforePlanner);

    db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, chief_thread_id, title, state, created_at, updated_at)
      VALUES ('thr_old', 'worker', 'proj_1', 'thr_chief', 'Existing work', 'ready', 1, 2)`).run();
    db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES ('host_1', 'senior', 'codex', 'gpt-6-astra', 'high', 3)`).run();

    bb.storage.migrate(db, MIGRATIONS);

    expect(db.prepare(`SELECT title, state, chief_thread_id FROM managed_threads WHERE thread_id='thr_old'`).get())
      .toEqual({ title: "Existing work", state: "ready", chief_thread_id: "thr_chief" });
    expect(db.prepare(`SELECT model, reasoning_level FROM chief_models WHERE host_id='host_1' AND role='senior'`).get())
      .toEqual({ model: "gpt-6-astra", reasoning_level: "high" });
    // Widening that CHECK is the whole point of the rebuild.
    expect(() => db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, title, state, created_at, updated_at)
      VALUES ('thr_plan', 'planner', 'proj_1', 'Plan · Rework checkout', 'idle', 4, 4)`).run()).not.toThrow();
    // Dropping the table dropped its index; the roster scan needs it back.
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='managed_threads_chief'`).get())
      .toBeTruthy();
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
      hostId: "host_1", role: "senior",
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
      hostId: "host_1", role: "senior",
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
        junior: null,
        senior: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
        reviewer: null,
      },
      unusable: [],
    }]);

    await state.harness.behavior.callRpc("setRoleModel", { hostId: "host_1", role: "senior", selection: null });
    const cleared = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(cleared.hosts[0]!.selections.senior).toBeNull();
  });

  test("scans a machine's provider once no matter how many roles picked it", async () => {
    const state = await setup();
    for (const role of ["chief", "junior", "senior", "reviewer"]) {
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
    await delegate(state, chief.threadId, "Fix checkout totals", undefined, {
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
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", undefined, { branch: "feature/fix-checkout-totals" });

    // A second worktree cannot check the branch out, so this has to fail here, not in git.
    const result = await state.harness.behavior.runCli([
      "delegate", "--title", "Fix checkout totals again", "--mission", "Correct and verify totals",
      "--branch", "feature/fix-checkout-totals", "--json",
    ], { threadId: chief.threadId, projectId: "proj_1" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already carries the active worker");
    expect(state.spawned).toHaveLength(2);

    // Once that worker is complete the branch is free again.
    await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker.threadId, result: "Landed" }, { threadId: chief.threadId, projectId: "proj_1" });
    await delegate(state, chief.threadId, "Fix checkout totals follow-up", undefined, { branch: "feature/fix-checkout-totals" });
    expect(state.spawned).toHaveLength(3);
  });

  test("tells the worker the forge is Chief's even when only a pull request was created", async () => {
    const state = await setup();
    const chief = await start(state);
    // Branch creation can fail after the draft PR exists; the constraint still has to reach the worker.
    await delegate(state, chief.threadId, "Fix checkout totals", undefined, { prUrl: "https://github.com/acme/shop/pull/8" });
    expect(state.spawned[1].prompt).toContain("## Git workflow");
    expect(state.spawned[1].prompt).toContain("https://github.com/acme/shop/pull/8");
    expect(state.spawned[1].prompt).toContain("Do not create, merge, or mark ready any pull request");
  });

  test("records the branch and forge links on the thread and shows them in the roster and inspect", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", undefined, {
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
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", undefined, {
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
    expect(roster).toContain("worker (senior)");
  });

  test("defaults an unspecified delegation to the senior tier", async () => {
    const state = await setup();
    const chief = await start(state);
    await delegate(state, chief.threadId);
    const roster = await state.harness.behavior.callAgentTool("chief_roster", {}, { threadId: chief.threadId, projectId: "proj_1" });
    expect(JSON.stringify(roster)).toContain("worker (senior)");
  });

  test("spawns a junior delegation on the junior model selection", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "junior",
      selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    await delegate(state, chief.threadId, "Fix typo", "junior");
    expect(state.spawned[1]).toMatchObject({ providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" });
  });

  test("falls back to the BB default when a junior pick leaves the machine's catalog, never to the senior pick", async () => {
    const state = await setup();
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "junior",
      selection: { providerId: "codex", model: "gpt-5-retired", reasoningLevel: "high" },
    });
    await state.harness.behavior.callRpc("setRoleModel", {
      hostId: "host_1", role: "senior",
      selection: { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    });
    const chief = await start(state);
    await delegate(state, chief.threadId, "Fix typo", "junior");
    expect(state.spawned[1]).not.toHaveProperty("providerId");
    expect(state.spawned[1]).not.toHaveProperty("model");

    const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
    expect(configuration.hosts[0]!.unusable).toEqual(["junior"]);
  });

  test("migration rewrites an existing worker model pick to senior, preserving provider/model/reasoning", async () => {
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

    const rewritten = db.prepare(`SELECT provider_id, model, reasoning_level FROM chief_models WHERE host_id=? AND role=?`).get("host_1", "senior");
    expect(rewritten).toEqual({ provider_id: "codex", model: "gpt-6-astra", reasoning_level: "high" });
    const stale = db.prepare(`SELECT * FROM chief_models WHERE role=?`).get("worker");
    expect(stale).toBeUndefined();
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

  test("keeps Jev scoring off until a check succeeds for the current key and model", async () => {
    const state = await setup();
    const chiefId = (await start(state)).threadId;
    const worker = await delegate(state, chiefId);
    const review = JSON.parse((await state.harness.behavior.runCli(["review", worker.threadId, "--json"])).stdout!);

    // Turning the toggle on without a passing check is a claim, not a gate pass.
    await state.harness.behavior.setSettings({ jevApiKey: "gw_key", jevEnabled: true });
    expect(await state.harness.behavior.callRpc("jevStatus", null)).toMatchObject({ hasKey: true, verified: false, enabled: false });
    const ungated = await state.harness.behavior.resolveAgentConfiguration(configurationContext(review.threadId));
    expect(ungated.tools.map((tool) => tool.name)).toEqual(["chief_report"]);
    await expect(state.harness.behavior.callAgentTool("chief_score", { baseBranch: "main" }, { threadId: review.threadId }))
      .rejects.toThrow(/Jev scoring is off/);
  });

  test("keeps a byte-safe prefix of a patch too large to fit whole", async () => {
    // A single oversized patch used to be dropped outright, handing Jev an empty
    // diff to score and persisting the meaningless result.
    const huge = { patch: "a".repeat(5_000), truncated: false };
    const alone = capDiff([huge], 1_000);
    expect(alone.truncated).toBe(true);
    expect(Buffer.byteLength(alone.diff, "utf8")).toBe(1_000);

    // Whatever fits stays whole; the overflowing patch contributes its prefix, and the
    // joining newline is charged against the budget rather than spilling past it.
    const mixed = capDiff([{ patch: "abc", truncated: false }, huge], 1_000);
    expect(mixed.diff.startsWith("abc\n")).toBe(true);
    expect(Buffer.byteLength(mixed.diff, "utf8")).toBe(1_000);

    // No combination of whole and cut patches may exceed the cap.
    for (const cap of [1, 2, 4, 7, 64, 999]) {
      for (const input of [[huge], [{ patch: "abc", truncated: false }, huge], [{ patch: "ab", truncated: false }, { patch: "cd", truncated: false }]]) {
        expect(Buffer.byteLength(capDiff(input, cap).diff, "utf8")).toBeLessThanOrEqual(cap);
      }
    }

    // Cutting inside a multi-byte character drops it rather than mangling it.
    const multibyte = capDiff([{ patch: "\u00e9".repeat(10), truncated: false }], 5);
    expect(multibyte.diff).toBe("\u00e9\u00e9");

    // collectDiff rejects this rather than scoring nothing.
    expect(capDiff([{ patch: "", truncated: false }], 1_000).diff).toBe("");
  });

  test("imports only public SDK surfaces", async () => {
    const result = await experimental_scanPublicSdkOnly(dirname(fileURLToPath(import.meta.url)), { allow: [/^vitest$/, /^react$/, /^@testing-library\/react$/, /^ai$/, /^@ai-sdk\//] });
    expect(result.violations).toEqual([]);
    expect(result.privateDependencies).toEqual([]);
  });
});
