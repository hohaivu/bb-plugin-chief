import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { delegate, disposals, disposeAll, setup, start } from "./test/harness";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (docs/specs/observability.md, "Durable brief"; plan-1 "Contracts to verify"), proven through the SDK harness's real reload:
// BB runs the new generation's factory while the old one is still live, disposes the old one, activates the new one and only then starts
// its background services. A brief a reload interrupted is replayed once, by the new generation's `brief-replay` service, never by its factory.
const PROMPT = "# Brief\n\n  indented line with trailing space \nünïcode ✓\n";
const e409 = () => new Error("HTTP 409: Thread environment is unavailable");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const EVENTUALLY = { timeout: 10_000, interval: 25 };

type State = Awaited<ReturnType<typeof setup>>;
type Generation = { bb: any; harness: any };
const storageCopy = (state: State, threadId: string) => join(state.storageRoot, threadId, "brief.md");
const artifactCopy = (state: State, threadId: string) => join(state.storageRoot, "chief", "proj_1", threadId, "brief.md");
const exists = (path: string) => access(path).then(() => true, () => false);
const rowsOf = (db: any) => db.prepare(`SELECT thread_id, project_id, prompt FROM pending_briefs`).all();
const dbOf = (generation: Generation) => generation.bb.storage.database();
// The storage copy's warning: it alone meets 409 here, so it alone is still retrying when its generation is disposed.
const warningsAbout = (generation: { harness: any }, threadId: string) =>
  generation.harness.logEntries.filter((entry: { level: string; message: string }) => entry.level === "warn" && entry.message.startsWith(`Could not write ${threadId}'s brief:`)).length;
/** Both brief copies of the thread hold exactly `prompt` and the pending row is gone from `db`. */
async function expectLanded(state: State, db: any, threadId: string, prompt: string) {
  await vi.waitFor(async () => {
    expect(await readFile(storageCopy(state, threadId), "utf8")).toBe(prompt);
    expect(await readFile(artifactCopy(state, threadId), "utf8")).toBe(prompt);
    expect(rowsOf(db)).toEqual([]);
  }, EVENTUALLY);
}
/** The harness's own first generation, with `provisioning` standing for a thread environment that answers HTTP 409. */
function world(seedRow?: { threadId: string }) {
  const control = { provisioning: true, storageLocationCalls: new Map<string, number>() };
  const ready = setup({
    onStorageLocation: (threadId) => {
      control.storageLocationCalls.set(threadId, (control.storageLocationCalls.get(threadId) ?? 0) + 1);
      if (control.provisioning) throw e409();
    },
    seed: seedRow ? ({ db }) => { db.prepare(`INSERT INTO pending_briefs (thread_id, project_id, prompt, at) VALUES (?, ?, ?, ?)`).run(seedRow.threadId, "proj_1", PROMPT, 1); } : undefined,
  });
  return { control, ready };
}
/** reload keeps every generation's disposer so disposeAll cleans the last one's storage too. */
async function reloadTo(from: Generation, factory: (bb: any) => Promise<unknown> = plugin): Promise<Generation> {
  const next = await from.harness.lifecycle.reload(factory) as Generation;
  disposals.push(() => next.harness.lifecycle.dispose());
  return next;
}

describe("brief replay across a plugin reload", () => {
  test("startup preseed: the factory alone does not replay a held brief; the brief-replay service does, once, then idles until abort", async () => {
    const { control, ready } = world({ threadId: "thr_seed" });
    const state = await ready;
    control.provisioning = false;
    await sleep(100);
    expect(await exists(storageCopy(state, "thr_seed"))).toBe(false);
    expect(await exists(artifactCopy(state, "thr_seed"))).toBe(false);
    expect(rowsOf(state.db)).toEqual([{ thread_id: "thr_seed", project_id: "proj_1", prompt: PROMPT }]);

    const service = state.harness.behavior.runService("brief-replay");
    let settled = false;
    void service.done.then(() => { settled = true; });
    await expectLanded(state, state.db, "thr_seed", PROMPT);
    await sleep(100);
    expect(settled).toBe(false);
    service.controller.abort();
    await service.done;
    expect(settled).toBe(true);
  });

  test("an old generation's enqueue after the candidate's factory ran is replayed by the candidate's service, and the old writer settling later leaves the candidate's row alone", async () => {
    const { control, ready } = world();
    const state = await ready;
    const chief = await start(state);
    let enqueued!: { threadId: string };
    const candidate = await reloadTo(state, async (bb) => {
      await plugin(bb);
      // The candidate's factory has run, the old generation is still live: it spawns, and its persistBrief meets a provisioning environment.
      enqueued = await delegate(state, chief.threadId);
    });
    const prompt = state.spawned.at(-1).prompt as string;
    expect(prompt).toContain("Correct and verify totals");
    expect(rowsOf(dbOf(candidate))).toEqual([{ thread_id: enqueued.threadId, project_id: "proj_1", prompt }]);
    expect(await exists(storageCopy(state, enqueued.threadId))).toBe(false);

    const service = candidate.harness.behavior.runService("brief-replay");
    // The old generation's retry fires on its stale handle and ends its writes; the candidate's replay is still retrying under 409.
    await vi.waitFor(() => expect(warningsAbout(state, enqueued.threadId)).toBe(1), EVENTUALLY);
    expect(rowsOf(dbOf(candidate))).toEqual([{ thread_id: enqueued.threadId, project_id: "proj_1", prompt }]);
    expect(await exists(storageCopy(state, enqueued.threadId))).toBe(false);

    control.provisioning = false;
    await expectLanded(state, dbOf(candidate), enqueued.threadId, prompt);
    service.controller.abort();
    await service.done;
  }, 30_000);

  test("an old writer that settles while the candidate is being built clears its own row; the candidate's service then rewrites nothing", async () => {
    const { control, ready } = world();
    const state = await ready;
    const chief = await start(state);
    let threadId!: string;
    const candidate = await reloadTo(state, async (bb) => {
      await plugin(bb);
      ({ threadId } = await delegate(state, chief.threadId));
      control.provisioning = false; // the old writer's 1 s retry now succeeds, while it is still live
      await vi.waitFor(async () => {
        expect(await exists(storageCopy(state, threadId))).toBe(true);
        expect(await exists(artifactCopy(state, threadId))).toBe(true);
        expect(state.db.prepare(`SELECT thread_id FROM pending_briefs`).all()).toEqual([]);
      }, EVENTUALLY);
    });
    const prompt = state.spawned.at(-1).prompt as string;
    const before = [await stat(storageCopy(state, threadId)), await stat(artifactCopy(state, threadId))].map((s) => s.mtimeMs);
    const calls = control.storageLocationCalls.get(threadId);

    const service = candidate.harness.behavior.runService("brief-replay");
    await sleep(150);
    await expectLanded(state, dbOf(candidate), threadId, prompt);
    expect([await stat(storageCopy(state, threadId)), await stat(artifactCopy(state, threadId))].map((s) => s.mtimeMs)).toEqual(before);
    expect(control.storageLocationCalls.get(threadId)).toBe(calls);
    service.controller.abort();
    await service.done;
  }, 30_000);

  test("a replay interrupted by a further reload: the third generation's service replays it, both copies land and the row is gone", async () => {
    const { control, ready } = world({ threadId: "thr_seed" });
    const first = await ready;
    first.harness.behavior.runService("brief-replay"); // generation 1 replays and meets 409
    await vi.waitFor(() => expect(control.storageLocationCalls.get("thr_seed")).toBeGreaterThan(0), EVENTUALLY);

    const second = await reloadTo(first);
    second.harness.behavior.runService("brief-replay"); // generation 2 replays the row generation 1 left, and meets 409 too
    await vi.waitFor(() => expect(control.storageLocationCalls.get("thr_seed")).toBeGreaterThan(2), EVENTUALLY);
    expect(rowsOf(dbOf(second))).toEqual([{ thread_id: "thr_seed", project_id: "proj_1", prompt: PROMPT }]);

    const third = await reloadTo(second);
    expect(rowsOf(dbOf(third))).toEqual([{ thread_id: "thr_seed", project_id: "proj_1", prompt: PROMPT }]);
    control.provisioning = false;
    const service = third.harness.behavior.runService("brief-replay");
    await expectLanded(first, dbOf(third), "thr_seed", PROMPT);
    // The disposed generations' retries end on their stale handles without touching the landed brief.
    await vi.waitFor(() => {
      expect(warningsAbout(first, "thr_seed")).toBe(1);
      expect(warningsAbout(second, "thr_seed")).toBe(1);
    }, EVENTUALLY);
    await expectLanded(first, dbOf(third), "thr_seed", PROMPT);
    service.controller.abort();
    await service.done;
  }, 30_000);
});
