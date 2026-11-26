import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { completeWorker, delegate, disposeAll, execFileMock, setup, start } from "./harness";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (docs/specs/observability.md, "Completion snapshot"): a worker's completion records its head, base and final diff
// (or why there is none) and its brief, BEFORE the completion write that queues cleanup; it never refuses completion.
type State = Awaited<ReturnType<typeof setup>>;
const PATCH = "diff --git a/totals.ts b/totals.ts\n--- a/totals.ts\n+++ b/totals.ts\n@@ -1 +1 @@\n-const total = subtotal;\n+const total = subtotal - discount;\n";
const SHA = "a".repeat(40);

/** Stands in for the project checkout's git: every call is answered here, none runs. `fail` names a subcommand that rejects. */
function git(options: { fail?: string; patch?: string; onDiff?: () => void } = {}) {
  const calls: string[][] = [];
  const handler = async (args: string[]) => {
    calls.push(args);
    if (args[0] === options.fail) throw new Error(`git ${args[0]} failed: no route to origin`);
    if (args[0] === "symbolic-ref") return "origin/main\n";
    if (args[0] === "rev-parse") return `${SHA}\n`;
    if (args[0] === "diff") { options.onDiff?.(); return options.patch ?? PATCH; }
    return "";
  };
  execFileMock.mockImplementation(async (file: string, args: string[]) => ({ stdout: file === "git" ? await handler(args) : "", stderr: "" }));
  return calls;
}

async function world(options: Parameters<typeof setup>[0] = { projectPath: "/repo/proj1" }, primaryHostId = "host_1") {
  const state = await setup(options);
  state.harness.sdk.stub("system.config", async () => ({ primaryHostId }));
  state.harness.sdk.stub("files.read", async ({ path }: { path: string }) => ({ content: await readFile(path, "utf8") }));
  return state;
}
const snapshot = (state: State, threadId: string) => state.db.prepare(`SELECT * FROM chief_completions WHERE thread_id=?`).get(threadId) as any;
const stateOf = (state: State, threadId: string) => (state.db.prepare(`SELECT state FROM managed_threads WHERE thread_id=?`).get(threadId) as { state: string }).state;

async function workerOnBranch(state: State) {
  const chief = (await start(state)).threadId;
  const worker = (await delegate(state, chief, "Fix totals", { branch: "feature/x" })).threadId;
  // launch no longer waits for the brief: let its background write land before the worker completes.
  await vi.waitFor(() => access(join(state.storageRoot, "chief", "proj_1", worker, "brief.md")));
  return { chief, worker, complete: () => completeWorker(state, chief, worker) };
}

describe("completion snapshot", () => {
  test("is taken before the worker is marked complete, and records head, base, the diff file and the brief", async () => {
    const state = await world();
    const seen: string[] = [];
    const calls = git({ onDiff: () => seen.push(stateOf(state, worker)) });
    const { worker, complete } = await workerOnBranch(state);
    await complete();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe("complete");
    expect(stateOf(state, worker)).toBe("complete");
    const row = snapshot(state, worker);
    expect(row).toMatchObject({ diff_state: "ok", diff_note: null, base: "origin/main", head_sha: SHA });
    expect(await readFile(row.diff_path, "utf8")).toBe(PATCH);
    expect(await readFile(row.brief_path, "utf8")).toContain("Correct and verify totals");
    // Only origin refs are read, and only through fetch/diff: nothing writes to the project checkout.
    expect(calls.some((args) => args[0] === "diff" && args.includes(`origin/main...${SHA}`))).toBe(true);
  });

  test("a diff over 500,000 characters is clipped to it and marked truncated", async () => {
    const state = await world();
    git({ patch: "+".repeat(500_010) });
    const { worker, complete } = await workerOnBranch(state);
    await complete();
    const row = snapshot(state, worker);
    expect(row).toMatchObject({ diff_state: "truncated" });
    expect(row.diff_note).toMatch(/500000/);
    expect((await readFile(row.diff_path, "utf8")).length).toBe(500_000);
  });

  test.each([
    ["the fetch fails", "fetch", /could not fetch origin\/feature\/x/],
    ["the diff command fails", "diff", /git diff failed/],
  ])("%s: the snapshot is unavailable with the reason, the brief is still kept and completion succeeds", async (_name, fail, note) => {
    const state = await world();
    git({ fail });
    const { worker, complete } = await workerOnBranch(state);
    await complete();
    expect(stateOf(state, worker)).toBe("complete");
    const row = snapshot(state, worker);
    expect(row).toMatchObject({ diff_state: "unavailable", diff_path: null });
    expect(row.diff_note).toMatch(note);
    expect(await readFile(row.brief_path, "utf8")).toContain("Correct and verify totals");
  });

  test.each([
    ["the checkout is on another host", { projectPath: "/repo/proj1" }, "host_elsewhere", /remote host/],
    ["the project has no local checkout", {}, "host_1", /no local checkout/],
  ])("%s: unavailable with the reason and no git call", async (_name, options, host, note) => {
    const state = await world(options, host);
    const calls = git();
    const { worker, complete } = await workerOnBranch(state);
    await complete();
    expect(stateOf(state, worker)).toBe("complete");
    expect(snapshot(state, worker)).toMatchObject({ diff_state: "unavailable", diff_path: null, diff_note: expect.stringMatching(note) });
    expect(calls).toEqual([]);
  });
});
