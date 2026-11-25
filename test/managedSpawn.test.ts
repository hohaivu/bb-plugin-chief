import { describe, expect, test } from "vitest";
import { createManagedSpawn, worktreeEnvironment } from "../src/research/managedSpawn";

function setup(syncBranch: (projectId: string, branch: string) => Promise<void>) {
  const order: string[] = [];
  const { launch } = createManagedSpawn({
    bb: { sdk: { threads: { spawn: async () => { order.push("spawn"); return { id: "thr_new", status: "running" }; } } } } as never,
    db: {} as never,
    spawnExecution: async () => ({}),
    ensureSection: async () => "sec_1",
    readRules: async () => undefined,
    lifecycleOwner: async () => ({}),
    insertThread: () => undefined,
    persistBrief: async () => undefined,
    syncBranch: async (...args) => { order.push(`sync:${args.join(":")}`); await syncBranch(...args); },
  });
  const run = (environment: unknown) => launch(
    { execution: {}, sectionId: "sec_1" },
    { projectId: "proj", environment: environment as never, title: "t", prompt: "p" },
    { role: "worker", chiefThreadId: "thr_chief" },
  );
  return { order, run };
}

describe("managedSpawn launch branch sync", () => {
  test("syncs a named-branch managed worktree before the spawn, and still spawns when the sync resolves", async () => {
    const { order, run } = setup(async () => undefined);
    await run(worktreeEnvironment("h", "feat"));
    expect(order).toEqual(["sync:proj:feat", "spawn"]);
  });

  test.each([
    ["default base", worktreeEnvironment("h")],
    ["reuse", { type: "reuse", threadId: "thr_old" }],
    ["project-default", { type: "project-default" }],
  ])("never syncs a %s environment", async (_name, environment) => {
    const { order, run } = setup(async () => undefined);
    await run(environment);
    expect(order).toEqual(["spawn"]);
  });
});
