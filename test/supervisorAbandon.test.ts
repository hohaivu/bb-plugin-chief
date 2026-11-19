import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { bounded } from "../src/runtime/exec";
import { HEAD_SHA, disposeAll, execFileMock, setup, start } from "./harness";
import { gateWorld } from "./gateWorld";
import { provideSdk } from "./sdk";
import { STOP_GRACE_MS } from "../src/runtime/lifecycle";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contract COORD-12b: a supervisor tick abandoned after STOP_GRACE_MS starts no new operation (alert send, archive, section create,
// further read) and writes nothing from a result that arrives later. Each test parks one call, lets the grace expire, releases the call, and
// checks that the continuation did nothing.
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const parked = () => {
  let release!: (value?: unknown) => void;
  let reached!: () => void;
  const hit = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  return { hit, release, hold: () => { reached(); return held; } };
};
/** Runs the supervisor until `hit`, aborts it, and returns once the grace has abandoned the tick. */
async function abandon(state: Awaited<ReturnType<typeof setup>>, hit: Promise<void>) {
  const service = state.harness.behavior.runService("supervisor");
  await hit;
  service.controller.abort();
  await service.done;
}

describe("an abandoned supervisor tick", () => {
  test("bounded never starts its call under an already aborted signal", async () => {
    const call = vi.fn(async () => 1);
    const controller = new AbortController();
    controller.abort();
    await expect(bounded(call, 1_000, controller.signal)).rejects.toThrow("abandoned");
    expect(call).not.toHaveBeenCalled();
  });

  test("starts no send and counts no attempt for a previously attempted alert whose marker probe is still pending", async () => {
    const state = await setup();
    const chief = await start(state);
    state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .run("test:probe", chief.threadId, chief.threadId, "retried alert", Date.now() - 600_000, Date.now() - 600_000);
    const probe = parked();
    const sends: string[] = [];
    state.harness.sdk.stub("threads.queuedMessages.list", probe.hold);
    state.harness.sdk.stub("threads.send", async (args: any) => { sends.push(args.input[0].text); return { ok: true, delivery: "sent" }; });
    await abandon(state, probe.hit);
    probe.release([]);
    await pause();
    expect(sends).toEqual([]);
    expect(state.db.prepare("SELECT attempts, delivered_at FROM alert_outbox WHERE dedupe_key='test:probe'").get()).toEqual({ attempts: 1, delivered_at: null });

    // The row stays retryable: the next supervisor sends it.
    state.harness.sdk.stub("threads.queuedMessages.list", async () => []);
    await state.supervisorCycle();
    expect(sends).toHaveLength(1);
    expect(state.db.prepare("SELECT delivered_at FROM alert_outbox WHERE dedupe_key='test:probe'").get()).not.toEqual({ delivered_at: null });
  }, STOP_GRACE_MS + 5_000);

  test("starts no archive when its scope read returns safe after abandonment, and leaves the job untouched", async () => {
    const world = await gateWorld({ cleanup: true });
    const gated = await world.passed("Fix");
    await world.complete(gated.worker.threadId);
    const scope = parked();
    world.state.harness.sdk.stub("threads.childSummary", async () => { await scope.hold(); return { unarchivedDescendantCount: 0 }; });
    await abandon(world.state, scope.hit);
    scope.release();
    await pause();
    expect(world.state.archivedThreads).toEqual([]);
    expect(world.state.db.prepare("SELECT step, attempts, last_error FROM cleanup_jobs WHERE thread_id=?").get(gated.worker.threadId))
      .toEqual({ step: "archive", attempts: 0, last_error: null });
  }, STOP_GRACE_MS + 5_000);

  test("starts no second sweep read after its first read returns", async () => {
    const reads: string[] = [];
    const first = parked();
    let armed = false;
    const state = await setup({
      seed: ({ db }) => {
        const insert = db.prepare("INSERT INTO managed_threads (thread_id, role, project_id, title, state, status, created_at, updated_at) VALUES (?, 'researcher', 'proj_1', ?, 'ready', 'idle', 1, 1)");
        insert.run("thr_r1", "First"); insert.run("thr_r2", "Second");
      },
    });
    const base = state.harness.sdk;
    // The tick's rules read is the last step of reconcile, right before the sweep.
    base.stub("projects.fileContent", async () => { armed = true; throw new Error("no rules file"); });
    const live = new Map<string, any>(["thr_r1", "thr_r2"].map((id) => [id, { ...state.live.values().next().value, id, status: "idle", archivedAt: null, deletedAt: null }]));
    base.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (!live.has(threadId)) return state.live.get(threadId);
      if (armed) reads.push(threadId);
      if (armed && threadId === "thr_r1") await first.hold();
      return live.get(threadId);
    });
    await abandon(state, first.hit);
    first.release();
    await pause();
    expect(reads).toEqual(["thr_r1"]);
    expect(state.db.prepare("SELECT thread_id, state FROM managed_threads WHERE role='researcher' ORDER BY thread_id").all())
      .toEqual([{ thread_id: "thr_r1", state: "ready" }, { thread_id: "thr_r2", state: "ready" }]);
  }, STOP_GRACE_MS + 5_000);

  test("creates no section when its section list returns after abandonment", async () => {
    const state = await setup();
    const listing = parked();
    let creates = 0;
    state.harness.sdk.stub("threadSections.list", async () => { await listing.hold(); return []; });
    state.harness.sdk.stub("threadSections.create", async () => { creates += 1; return { id: "sec_x", name: "Chief", createdAt: 1, updatedAt: 1 }; });
    await abandon(state, listing.hit);
    listing.release();
    await pause();
    expect(creates).toBe(0);
  }, STOP_GRACE_MS + 5_000);

  test("spawns no Chief when a section list parked inside spawnChief returns after abandonment", async () => {
    const state = await setup();
    // chiefProject first, then autoSpawn: the settings change itself starts no Chief.
    await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
    await state.harness.behavior.setSettings({ chiefProject: "proj_1", autoSpawn: true });
    const listing = parked();
    state.harness.sdk.stub("threadSections.list", async () => { await listing.hold(); return []; });
    await abandon(state, listing.hit);
    listing.release();
    await pause();
    expect(state.spawned).toHaveLength(0);
    expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE role='chief'").get()).toEqual({ n: 0 });
  }, STOP_GRACE_MS + 5_000);

  test("writes no rules cache when a rules read returns after abandonment", async () => {
    const state = await setup();
    await start(state);
    const reading = parked();
    let reads = 0;
    state.harness.sdk.stub("projects.fileContent", async () => { reads += 1; await reading.hold(); return { content: "custom rules" }; });
    await abandon(state, reading.hit);
    reading.release();
    await pause();
    // A later ordinary read must reach the SDK again: the abandoned read cached nothing.
    const before = reads;
    state.harness.sdk.stub("projects.fileContent", async () => { reads += 1; throw new Error("no rules file"); });
    await state.supervisorCycle();
    expect(reads).toBeGreaterThan(before);
  }, STOP_GRACE_MS + 5_000);

  test("bounded rejects at once when its callback aborts synchronously and never settles, and leaves no listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const started = Date.now();
    await expect(bounded(() => { controller.abort(); return new Promise<never>(() => {}); }, 5_000, controller.signal)).rejects.toThrow("abandoned");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  for (const attempts of [0, 9]) {
    test(`keeps an abandoned send's attempt budget at ${attempts}, flags it uncertain, and retries that row after a marker probe`, async () => {
      const state = await setup();
      const chief = await start(state);
      const key = "test:abandoned";
      state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(key, chief.threadId, chief.threadId, "abandoned alert", Date.now() - 86_400_000, attempts, Date.now() - 86_400_000);
      const sending = parked();
      let probes = 0;
      state.harness.sdk.stub("threads.queuedMessages.list", async () => { probes += 1; return []; });
      state.harness.sdk.stub("threads.send", async () => { sending.hold(); return new Promise(() => {}); });
      await abandon(state, sending.hit);
      await pause();
      const row = () => state.db.prepare("SELECT attempts, uncertain, delivered_at, last_error FROM alert_outbox WHERE dedupe_key=?").get(key) as any;
      expect(row()).toEqual({ attempts, uncertain: 1, delivered_at: null, last_error: "abandoned" });

      // Backoff follows the attempt count; age the row so the retry is due.
      state.db.prepare("UPDATE alert_outbox SET last_attempt_at=? WHERE dedupe_key=?").run(Date.now() - 86_400_000, key);
      const probesBefore = probes;
      const sends: string[] = [];
      state.harness.sdk.stub("threads.send", async (args: any) => { sends.push(args.input[0].text); return { ok: true, delivery: "sent" }; });
      await state.supervisorCycle();
      // The uncertain row is probed before it is sent, even at attempts 0.
      expect(probes).toBeGreaterThan(probesBefore);
      expect(sends).toHaveLength(1);
      expect(row().delivered_at).not.toBeNull();
    }, STOP_GRACE_MS + 5_000);
  }

  test("a no-argument sweep joining the supervisor's flight still runs its queued pass after abandonment", async () => {
    const reads: string[] = [];
    const first = parked();
    let armed = false;
    const state = await setup({
      seed: ({ db }) => {
        db.prepare("INSERT INTO managed_threads (thread_id, role, project_id, title, state, status, created_at, updated_at) VALUES (?, 'researcher', 'proj_1', ?, 'ready', 'idle', 1, 1)").run("thr_r1", "First");
      },
    });
    const base = state.live.values().next().value;
    // The tick's rules read is the last step of reconcile, right before the sweep.
    state.harness.sdk.stub("projects.fileContent", async () => { armed = true; throw new Error("no rules file"); });
    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId !== "thr_r1") return state.live.get(threadId);
      if (armed) { reads.push(threadId); if (reads.length === 1) await first.hold(); }
      return { ...base, id: threadId, status: "idle", archivedAt: null, deletedAt: null };
    });
    const service = state.harness.behavior.runService("supervisor");
    await first.hit;
    // An independent idle event asks for a sweep while the tick's is parked: it queues one more pass.
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: base, lastAssistantText: "done" });
    service.controller.abort();
    await service.done;
    first.release();
    await pause(100);
    expect(reads).toEqual(["thr_r1", "thr_r1"]);
  }, STOP_GRACE_MS + 5_000);

  test("a no-argument section caller joining an abandoned supervisor flight gets its own live flight", async () => {
    const state = await setup();
    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ ...state.live.values().next().value, id: threadId, projectId: "proj_1", status: "idle" }));
    const listing = parked();
    let lists = 0;
    state.harness.sdk.stub("threadSections.list", async () => { lists += 1; if (lists === 1) await listing.hold(); return []; });
    state.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_ordinary", name: "Chief", createdAt: 1, updatedAt: 1 }));
    const service = state.harness.behavior.runService("supervisor");
    await listing.hit;
    state.addLive("thr_adopted", "proj_1");
    const adopting = state.harness.behavior.runCli(["adopt", "--thread", "thr_adopted"]);
    service.controller.abort();
    await service.done;
    listing.release();
    expect((await adopting).exitCode).toBe(0);
    expect(state.db.prepare("SELECT value FROM plugin_meta WHERE key='section_id'").get()).toEqual({ value: "sec_ordinary" });
  }, STOP_GRACE_MS + 5_000);

  test("reads rules for the projects it saw before its settings read, not for a project that joined meanwhile", async () => {
    const settingsRead = parked();
    let holdNext = false;
    const state = await setup({
      module: async (bb: any) => plugin(Object.create(bb, {
        settings: {
          value: {
            define: (descriptors: any) => {
              const settings = bb.settings.define(descriptors);
              return Object.create(settings, { get: { value: async () => { if (holdNext) { holdNext = false; await settingsRead.hold(); } return settings.get(); } } });
            },
          },
        },
      })) as any,
    });
    await start(state);
    holdNext = true;
    const reads: string[] = [];
    const service = state.harness.behavior.runService("supervisor");
    await settingsRead.hit;
    await start(state, "proj_second");
    state.harness.sdk.stub("projects.fileContent", async ({ projectId }: { projectId: string }) => { reads.push(projectId); throw new Error("no rules file"); });
    settingsRead.release();
    await pause(100);
    service.controller.abort();
    await service.done;
    // The tick's project set is the one it captured before the settings read, as on the base.
    expect(reads).toEqual(["proj_1"]);
  }, STOP_GRACE_MS + 5_000);
});

// The forge lookup is parked with a merged answer: it is released only after the tick was abandoned.
const PR_A = "https://github.com/acme/shop/pull/1";
function parkForge() {
  const lookup = parked();
  const original = execFileMock.getMockImplementation()!;
  execFileMock.mockImplementation((file: string, args: string[], ...rest: any[]) => file === "gh" && args.includes("state,headRefOid")
    ? Object.assign(lookup.hold().then(() => ({ stdout: JSON.stringify({ state: "MERGED", headRefOid: HEAD_SHA }), stderr: "" })), { child: { kill: () => undefined } })
    : original(file, args, ...rest));
  return lookup;
}
const jobs = (world: Awaited<ReturnType<typeof gateWorld>>) => world.state.db.prepare("SELECT thread_id, step, outcome FROM cleanup_jobs ORDER BY rowid").all();

describe("an abandoned supervisor tick's cleanup", () => {
  test("enqueues no job for a thread without pull requests when the lookup before it was interrupted", async () => {
    const world = await gateWorld({ cleanup: true });
    for (const forge of [{ prUrl: PR_A }, {}]) {
      const { worker } = await world.passed("Fix", forge);
      await world.complete(worker.threadId);
    }
    const lookup = parkForge();
    await abandon(world.state, lookup.hit);
    lookup.release();
    await pause();
    expect(jobs(world)).toEqual([]);
  }, STOP_GRACE_MS + 5_000);

  test("does not run a following job with no managed row when the lookup of the job before it was interrupted", async () => {
    const world = await gateWorld({ cleanup: true });
    const { threadId } = await world.worker("Fix", { prUrl: PR_A });
    const insert = world.state.db.prepare("INSERT INTO cleanup_jobs (thread_id, chief_thread_id, project_id, step, step_at, created_at, updated_at) VALUES (?, ?, 'proj_1', 'archive', ?, ?, ?)");
    const now = Date.now();
    insert.run(threadId, world.chief, now, now, now);
    insert.run("thr_no_managed_row", world.chief, now, now + 1, now + 1);
    const lookup = parkForge();
    await abandon(world.state, lookup.hit);
    lookup.release();
    await pause();
    expect(jobs(world)).toEqual([{ thread_id: threadId, step: "archive", outcome: null }, { thread_id: "thr_no_managed_row", step: "archive", outcome: null }]);
  }, STOP_GRACE_MS + 5_000);
});
