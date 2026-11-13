import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { disposeAll, setup, start } from "./test/harness";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// A Chief spawned by chief_spawn runs in the spawning thread's permission mode; an unknown mode leaves the project default.
describe("spawned Chief permission mode", () => {
  type S = Awaited<ReturnType<typeof setup>>;
  const spawnFrom = async (state: S, caller: string) => {
    await state.harness.behavior.callAgentTool("chief_spawn", { request: "Do the task", context: "Goal: done" }, { threadId: caller, projectId: "proj_1" });
    return state.spawned.at(-1);
  };

  test("a Chief spawned from a thread in mode X is spawned with permissionMode X", async () => {
    const state = await setup();
    const caller = (await start(state)).threadId;
    state.setCallerPermissionMode("full");
    expect(await spawnFrom(state, caller)).toMatchObject({ pluginMetadata: { role: "chief" }, permissionMode: "full" });
  });

  test.each([
    ["the lookup returns no options", (state: S) => state.setThreadExecution(undefined)],
    ["the lookup fails", (state: S) => state.failExecutionLookups()],
  ])("%s: the spawned Chief gets no permissionMode", async (_name, arrange) => {
    const state = await setup();
    const caller = (await start(state)).threadId;
    state.setCallerPermissionMode("full");
    arrange(state);
    const input = await spawnFrom(state, caller);
    expect(input).toMatchObject({ pluginMetadata: { role: "chief" } });
    expect(input).not.toHaveProperty("permissionMode");
  });

  test("a Chief started with no spawning thread gets no permissionMode", async () => {
    const state = await setup();
    state.setCallerPermissionMode("full");
    await start(state);
    expect(state.spawned.at(-1)).toMatchObject({ pluginMetadata: { role: "chief" } });
    expect(state.spawned.at(-1)).not.toHaveProperty("permissionMode");
  });
});
