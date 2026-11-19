import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { bounded } from "../src/runtime/exec";
import { HEAD_SHA, configurationContext, delegate, disposeAll, execFileMock, rowOf, setup, start } from "./harness";
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

const absorbedResearcher = (db: any, id: string) => db.prepare("INSERT INTO managed_threads (thread_id, role, project_id, title, state, status, created_at, updated_at) VALUES (?, 'researcher', 'proj_1', ?, 'ready', 'idle', 1, 1)").run(id, id);

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
    const chief = await start(state);
    const reading = parked();
    let reads = 0;
    state.harness.sdk.stub("projects.fileContent", async () => { reads += 1; await reading.hold(); return { content: "custom rules LATE_RULES_MARKER" }; });
    await abandon(state, reading.hit);
    reading.release();
    await pause();
    // Right away, before any other refresh: the synchronous configuration read must not see the late rules.
    const instructions = (await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId)) as { instructions: string }).instructions;
    expect(instructions).not.toContain("LATE_RULES_MARKER");
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

  const researcherStates = (state: Awaited<ReturnType<typeof setup>>) => state.db.prepare("SELECT thread_id, state FROM managed_threads WHERE role='researcher' ORDER BY thread_id").all();

  test("a sweep started by the tick's own reconcile write reads and completes nothing after abandonment", async () => {
    const reads: string[] = [];
    const first = parked();
    const state = await setup({ seed: ({ db }) => { absorbedResearcher(db, "thr_t"); absorbedResearcher(db, "thr_r2"); } });
    const base = state.live.values().next().value;
    let tReads = 0;
    // Live thr_t reports another parent, so the tick's reconcile writes it; that write's reload starts the sweep, whose first read (the second read of thr_t) is parked.
    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId !== "thr_t" && threadId !== "thr_r2") return state.live.get(threadId);
      reads.push(threadId);
      if (threadId === "thr_t" && ++tReads === 2) await first.hold();
      return { ...base, id: threadId, status: "idle", archivedAt: null, deletedAt: null, parentThreadId: "thr_other_parent" };
    });
    await abandon(state, first.hit);
    const readsAtAbandon = reads.length;
    const alertsAtAbandon = state.db.prepare("SELECT COUNT(*) AS n FROM alert_outbox").get();
    first.release();
    await pause(100);
    expect(reads).toHaveLength(readsAtAbandon);
    expect(researcherStates(state)).toEqual([{ thread_id: "thr_r2", state: "ready" }, { thread_id: "thr_t", state: "ready" }]);
    expect(state.db.prepare("SELECT COUNT(*) AS n FROM alert_outbox").get()).toEqual(alertsAtAbandon);
  }, STOP_GRACE_MS + 5_000);

  test("the tick joining an independent sweep flight queues no pass that reads after abandonment, and the independent pass is not cut off", async () => {
    const reads: string[] = [];
    const first = parked();
    const state = await setup({ seed: ({ db }) => { absorbedResearcher(db, "thr_r1"); absorbedResearcher(db, "thr_r2"); } });
    const base = state.live.values().next().value;
    let calls = 0;
    let released = false;
    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId !== "thr_r1" && threadId !== "thr_r2") return state.live.get(threadId);
      if (released) reads.push(threadId);
      // The very first read is the independent flight's: held, and answered busy, so thr_r1 stays open.
      const busy = ++calls === 1;
      if (busy) await first.hold();
      return { ...base, id: threadId, status: busy ? "active" : "idle", archivedAt: null, deletedAt: null };
    });
    await state.harness.behavior.emitThreadEvent("thread.idle", { thread: base, lastAssistantText: "done" });
    await first.hit;
    const service = state.harness.behavior.runService("supervisor");
    await pause(100); // the tick's reconcile finished and its sweep joined the flight, queueing a tick-only pass
    service.controller.abort();
    await service.done;
    released = true;
    first.release();
    await pause(100);
    // The independent pass ran to the end (it read and completed thr_r2); the tick-only queued pass was skipped (thr_r1 was not read again).
    expect(reads).toEqual(["thr_r2"]);
    expect(researcherStates(state)).toEqual([{ thread_id: "thr_r1", state: "ready" }, { thread_id: "thr_r2", state: "complete" }]);
  }, STOP_GRACE_MS + 5_000);

  test("an independent request and the tick's request queued in the same pass run it unsignalled after abandonment", async () => {
    const reads: string[] = [];
    const first = parked();
    const state = await setup({ seed: ({ db }) => { absorbedResearcher(db, "thr_r1"); absorbedResearcher(db, "thr_r2"); } });
    const base = state.live.values().next().value;
    let calls = 0;
    let released = false;
    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId !== "thr_r1" && threadId !== "thr_r2") return state.live.get(threadId);
      if (released) reads.push(threadId);
      const busy = ++calls === 1;
      if (busy) await first.hold();
      return { ...base, id: threadId, status: busy ? "active" : "idle", archivedAt: null, deletedAt: null };
    });
    const idle = () => state.harness.behavior.emitThreadEvent("thread.idle", { thread: base, lastAssistantText: "done" });
    await idle();
    await first.hit;
    const service = state.harness.behavior.runService("supervisor");
    await pause(100); // the tick's sweep joined the flight and queued its pass
    await idle(); // an independent request joins the same queued pass
    service.controller.abort();
    await service.done;
    released = true;
    first.release();
    await pause(100);
    // The shared queued pass is independent work: it ran to the end and completed thr_r1 as well.
    expect(reads).toEqual(["thr_r2", "thr_r1"]);
    expect(researcherStates(state)).toEqual([{ thread_id: "thr_r1", state: "complete" }, { thread_id: "thr_r2", state: "complete" }]);
  }, STOP_GRACE_MS + 5_000);

  test("requests during a flight collapse into one more pass, and only one flight runs at a time", async () => {
    let active = 0;
    let peak = 0;
    const reads: string[] = [];
    const first = parked();
    const state = await setup({ seed: ({ db }) => absorbedResearcher(db, "thr_r1") });
    const base = state.live.values().next().value;
    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId !== "thr_r1") return state.live.get(threadId);
      reads.push(threadId);
      active += 1; peak = Math.max(peak, active);
      if (reads.length === 1) await first.hold();
      active -= 1;
      return { ...base, id: threadId, status: "active", archivedAt: null, deletedAt: null }; // busy: the row stays open, every pass reads it again
    });
    const idle = () => state.harness.behavior.emitThreadEvent("thread.idle", { thread: base, lastAssistantText: "done" });
    await idle();
    await first.hit;
    await idle(); await idle(); await idle();
    first.release();
    await pause(100);
    expect(reads).toHaveLength(2); // the flight's pass plus one collapsed pass
    expect(peak).toBe(1);
  });

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

type S = Awaited<ReturnType<typeof setup>>;
const call = (state: S, tool: string, params: object, threadId: string, projectId = "proj_1") =>
  state.harness.behavior.callAgentTool(tool, params, { threadId, projectId }) as Promise<string>;
const makeChief = async (state: S, projectId = "proj_1") => {
  const result = await state.harness.behavior.runCli(["create", "--project", projectId, "--json"], { projectId });
  expect(result.exitCode, result.stderr).toBe(0);
  return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
};
const makeCoordinator = async (state: S, projectId = "proj_1") => {
  const id = await makeChief(state, projectId);
  await call(state, "chief_coordinate", {}, id, projectId);
  return id;
};
const spawnChild = async (state: S, parent: string, params: Record<string, unknown> = {}, projectId = "proj_1") =>
  /in thread (thr_\w+)/.exec(await call(state, "chief_spawn", { request: "Do the task", context: "Goal: done", ...params }, parent, projectId))![1]!;
const archive = async (state: S, id: string) => {
  state.live.set(id, { ...state.live.get(id)!, archivedAt: new Date().toISOString() });
  await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(id)! });
  await pause(30);
};
const row = (state: S, id: string) => rowOf(state, id);
const pendingMarkers = (state: S) => state.db.prepare("SELECT key, value FROM plugin_meta WHERE key LIKE 'pending_handover:%' ORDER BY key").all();
const decisionsOf = async (state: S, id: string) => {
  const file = join(state.storageRoot, id, "decisions.md");
  for (let i = 0; i < 200 && !(await readFile(file, "utf8").catch(() => "")).includes("carry me"); i++) await pause(5);
  return readFile(file, "utf8").catch(() => "");
};

describe("an abandoned supervisor tick's Chief spawn", () => {
  /** A harness whose spawns wait on `gate.current` while it is set; make it only after the setup spawns. */
  const gated = async (autoSpawn = true) => {
    const gate: { current: ReturnType<typeof parked> | null } = { current: null };
    const state = await setup({ onSpawn: async () => { await gate.current?.hold(); } });
    if (autoSpawn) {
      // chiefProject first, then autoSpawn: the settings change itself starts no Chief.
      await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
      await state.harness.behavior.setSettings({ chiefProject: "proj_1", autoSpawn: true });
    }
    return { state, gate };
  };

  test("a late spawn for an archived project Chief records only the row and a pending marker; the next live tick hands over once", async () => {
    const { state, gate } = await gated(false);
    const old = (await start(state)).threadId;
    const worker = (await delegate(state, old, "Fix totals")).threadId;
    await call(state, "chief_roster", { decision: { text: "carry me" } }, old);
    await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
    await state.harness.behavior.setSettings({ chiefProject: "proj_1", autoSpawn: true });
    await archive(state, old);
    const spawnedBefore = state.spawned.length;
    gate.current = parked();
    await abandon(state, gate.current.hit);
    const held = gate.current;
    gate.current = null;
    held.release();
    await pause(100);

    expect(state.spawned).toHaveLength(spawnedBefore + 1);
    const next = (state.db.prepare("SELECT thread_id FROM managed_threads WHERE role='chief' AND thread_id<>? ORDER BY created_at DESC, rowid DESC").get(old) as { thread_id: string }).thread_id;
    expect(row(state, next).state).toBe("starting");
    expect(pendingMarkers(state)).toEqual([{ key: `pending_handover:${next}`, value: old }]);
    expect(row(state, old).state).not.toBe("complete");
    expect(row(state, worker).chief_thread_id).toBe(old);
    expect(await readFile(join(state.storageRoot, next, "decisions.md"), "utf8").catch(() => "")).not.toContain("carry me");

    await state.supervisorCycle();
    expect(state.spawned).toHaveLength(spawnedBefore + 1); // the live tick adopted the late Chief: no second
    expect(row(state, worker).chief_thread_id).toBe(next);
    expect(row(state, old).state).toBe("complete");
    expect(pendingMarkers(state)).toEqual([]);
    expect(await decisionsOf(state, next)).toContain("carry me");
    await state.supervisorCycle();
    expect(state.spawned).toHaveLength(spawnedBefore + 1);
    expect(row(state, worker).chief_thread_id).toBe(next);
  }, STOP_GRACE_MS + 10_000);

  test("a late replacement for an orphaned child Chief is adopted by the next live tick, which moves its work and decisions", async () => {
    const { state, gate } = await gated(false);
    const coord = await makeCoordinator(state);
    const child = await spawnChild(state, coord, { title: "Checkout" });
    const worker = (await delegate(state, child, "Fix totals")).threadId;
    const other = await makeCoordinator(state, "proj_2");
    const foreign = await spawnChild(state, other, { projectId: "proj_1" }, "proj_2");
    const foreignBefore = { ...row(state, foreign) };
    await call(state, "chief_roster", { decision: { text: "carry me" } }, child);
    await archive(state, child);
    const spawnedBefore = state.spawned.length;
    gate.current = parked();
    await abandon(state, gate.current.hit);
    const held = gate.current;
    gate.current = null;
    held.release();
    await pause(100);

    expect(state.spawned).toHaveLength(spawnedBefore + 1);
    const markers = pendingMarkers(state) as { key: string; value: string }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.value).toBe(child);
    const next = markers[0]!.key.slice("pending_handover:".length);
    expect(row(state, worker).chief_thread_id).toBe(child);
    expect(row(state, child).state).not.toBe("complete");

    await state.supervisorCycle();
    expect(state.spawned).toHaveLength(spawnedBefore + 1);
    expect(row(state, worker).chief_thread_id).toBe(next);
    expect(row(state, next)).toMatchObject({ role: "chief", coordinator_thread_id: coord });
    expect(row(state, child).state).toBe("complete");
    expect(pendingMarkers(state)).toEqual([]);
    expect(await decisionsOf(state, next)).toContain("carry me");
    expect(row(state, foreign)).toMatchObject({ coordinator_thread_id: other, title: foreignBefore.title, chief_thread_id: foreignBefore.chief_thread_id });
  }, STOP_GRACE_MS + 10_000);

  test("a live tick drops every marker it cannot hand over, and moves no work for them", async () => {
    const state = await setup();
    const coordA = await makeCoordinator(state);
    const coordB = await makeCoordinator(state, "proj_2");
    const childA = await spawnChild(state, coordA, { title: "A" });
    const childB = await spawnChild(state, coordB, { title: "B", projectId: "proj_1" }, "proj_2");
    const plain = await makeChief(state);
    const lateDead = await makeChief(state);
    await archive(state, lateDead);
    const marker = state.db.prepare("INSERT INTO plugin_meta (key, value) VALUES (?, ?)");
    marker.run("pending_handover:thr_missing_next", plain);
    marker.run(`pending_handover:${lateDead}`, plain); // the late Chief is dead
    marker.run(`pending_handover:${plain}`, "thr_missing_prev"); // previous is missing
    marker.run(`pending_handover:${childA}`, coordA); // previous is a Coordinator
    marker.run(`pending_handover:${childB}`, childA); // two Coordinators' children
    const workers = await Promise.all([plain, childA, childB].map(async (chief) => [chief, (await delegate(state, chief, `Work of ${chief}`)).threadId] as const));
    await state.supervisorCycle();
    expect(pendingMarkers(state)).toEqual([]);
    for (const [chief, worker] of workers) expect(row(state, worker).chief_thread_id).toBe(chief);
  });
});

describe("an abandoned supervisor tick's host and notice lookups", () => {
  test("starts no host lookup or spawn when the project read inside projectHostId returns after abandonment", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ chiefProject: "proj_1" });
    await state.harness.behavior.setSettings({ chiefProject: "proj_1", autoSpawn: true });
    const reading = parked();
    let projectGets = 0;
    let hostLists = 0;
    // spawnChief reads the project twice: projectName first, then projectHostId (the second read), whose answer carries no source, so it would fall back to hosts.list.
    state.harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => {
      if (++projectGets === 2) await reading.hold();
      return { id: projectId, name: "Project" };
    });
    state.harness.sdk.stub("hosts.list", async () => { hostLists += 1; return []; });
    await abandon(state, reading.hit);
    reading.release();
    await pause();
    expect(hostLists).toBe(0);
    expect(state.spawned).toHaveLength(0);
    expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE role='chief'").get()).toEqual({ n: 0 });

    // A caller without a stop signal keeps the default-host fallback.
    await state.supervisorCycle();
    expect(hostLists).toBeGreaterThan(0);
    expect(state.spawned).toHaveLength(1);
  }, STOP_GRACE_MS + 5_000);

  test("a Coordinator-gone notice is neither created nor sent by a sweep pass the abandoned tick owned, and is sent by the next live tick", async () => {
    const first = parked();
    const state = await setup({ seed: ({ db }) => absorbedResearcher(db, "thr_t") });
    const base = state.live.values().next().value;
    const coord = await makeCoordinator(state);
    const child = await spawnChild(state, coord);
    await archive(state, coord);
    const key = `${child}:coordinator-gone:${coord}`;
    const notices = () => state.sent.filter((sent) => sent.threadId === child && String(sent.input[0].text).includes("chief_attach"));
    expect(notices()).toHaveLength(1);
    // Forget the notice the archive sent, so only a sweep pass can send it again.
    state.db.prepare("DELETE FROM alert_outbox WHERE dedupe_key=?").run(key);
    state.sent.length = 0;
    let tReads = 0;
    // As in the reconcile-write test: live thr_t reports another parent, the write's reload starts the tick's sweep, and that sweep's first read is parked.
    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId !== "thr_t") return state.live.get(threadId);
      if (++tReads === 2) await first.hold();
      return { ...base, id: threadId, status: "idle", archivedAt: null, deletedAt: null, parentThreadId: "thr_other_parent" };
    });
    await abandon(state, first.hit);
    first.release();
    await pause(100);
    expect(notices()).toEqual([]);
    expect(state.db.prepare("SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key=?").get(key)).toEqual({ n: 0 });

    state.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => state.live.get(threadId) ?? { ...base, id: threadId, status: "idle", archivedAt: null, deletedAt: null });
    await state.supervisorCycle();
    await pause(100);
    expect(notices()).toHaveLength(1);
    expect(state.db.prepare("SELECT attempts, delivered_at IS NOT NULL AS delivered FROM alert_outbox WHERE dedupe_key=?").get(key)).toEqual({ attempts: 1, delivered: 1 });
  }, STOP_GRACE_MS + 5_000);
});
