import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { MIGRATIONS } from "../src/db/migrations";
import { forgeAnswers, forged, startGate } from "./gateForge";
import { CLOSE_OUT, NO_DEVIATIONS, completeWorker, configurationContext, delegate, disposeAll, elapse, readyAction, rowOf, setup, start, status, wave } from "./harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);
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

    test("the base statements are unchanged; the two Coordinator columns, then the retest_skipped column, are appended", () => {
      const prefix = MIGRATIONS.slice(0, BASE_MIGRATIONS.length);
      expect(createHash("sha256").update(JSON.stringify(prefix)).digest("hex")).toBe(BASE_MIGRATIONS.sha256);
      // Append only: later waves (observability) add entries after these three; only the first three are pinned here.
      expect(MIGRATIONS.slice(BASE_MIGRATIONS.length, BASE_MIGRATIONS.length + 3)).toEqual([
        "ALTER TABLE managed_threads ADD COLUMN coordinator INTEGER",
        "ALTER TABLE managed_threads ADD COLUMN coordinator_thread_id TEXT",
        "ALTER TABLE managed_threads ADD COLUMN retest_skipped TEXT",
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

    describe("title rename", () => {
      const titleOf = (state: S, id: string) => ({ row: row(state, id).title as string, thread: state.live.get(id)!.title as string });

      test("the title's leading Chief becomes Coordinator in the row and the thread, and the rest stays", async () => {
        const state = await setup();
        const chief = await make(state);
        const plain = await make(state);
        const before = titleOf(state, chief);
        expect(before.row).toMatch(/^Chief · .+/);
        expect(before.thread).toBe(before.row);
        await call(state, "chief_coordinate", {}, chief);
        const rest = before.row.slice("Chief".length);
        expect(titleOf(state, chief)).toEqual({ row: `Coordinator${rest}`, thread: `Coordinator${rest}` });
        // A Chief that does not upgrade keeps its title.
        expect(titleOf(state, plain).row).toMatch(/^Chief · /);
        expect(titleOf(state, plain).thread).toBe(titleOf(state, plain).row);
      });

      test("a repeated chief_coordinate does not rename again or double the prefix", async () => {
        const state = await setup();
        const chief = await make(state);
        await call(state, "chief_coordinate", {}, chief);
        const renamed = titleOf(state, chief);
        // The owner renames the thread by hand; a repeat call must not touch it, nor the row.
        state.live.set(chief, { ...state.live.get(chief)!, title: "Renamed by owner" });
        await call(state, "chief_coordinate", {}, chief);
        expect(titleOf(state, chief)).toEqual({ row: renamed.row, thread: "Renamed by owner" });
        expect(renamed.row.match(/Coordinator/g)).toHaveLength(1);
      });

      test("a failed thread rename only warns: the upgrade stands and the row has the new title", async () => {
        const state = await setup();
        const chief = await make(state);
        const old = titleOf(state, chief);
        state.failNextUpdate(chief);
        await expect(call(state, "chief_coordinate", {}, chief)).resolves.toContain("one-way");
        expect(row(state, chief)).toMatchObject({ coordinator: 1, title: `Coordinator${old.row.slice("Chief".length)}` });
        expect(state.live.get(chief)!.title).toBe(old.thread);
        expect(state.harness.logEntries.some((entry) => entry.level === "warn" && entry.message.includes(chief))).toBe(true);
        expect(await call(state, "chief_coordinate", {}, chief)).toBe("Already a Coordinator.");
      });

      test("a refused upgrade (open managed work) leaves the title alone", async () => {
        const state = await setup();
        const chief = await make(state);
        await delegate(state, chief, "Busy");
        const before = titleOf(state, chief);
        await expect(call(state, "chief_coordinate", {}, chief)).rejects.toThrow("still owns open managed threads");
        expect(titleOf(state, chief)).toEqual(before);
      });
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
      ["chief_plan", { undesignedReason: "small fix", title: "T", mission: "M" }],
      ["chief_consult", { title: "T", mission: "M", planThreadId: "thr_x" }],
      ["chief_delegate", { title: "T", mission: "M", unplannedReason: "r" }],
      ["chief_forge_init", { title: "T" }],
      ["chief_review", { branch: "b" }],
      ["chief_inspect", { threadId: "thr_x" }],
      ["chief_continue", { threadId: "thr_x", instruction: "go" }],
      ["chief_stop", { threadId: "thr_x" }],
      ["chief_complete", { threadId: "thr_x" }],
      ["chief_owner_approval", { workerThreadId: "thr_x", approval: "ok" }],
      ["chief_skip_specs", { planThreadId: "thr_x", wave: 1, reason: "r" }],
      ["chief_escalate", { request: "help" }],
      ["chief_sync", {}],
      ["chief_research", { question: "q", design: false }],
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
      // The refusal is a failed call like any other: ledgered with the tool name, while the caller still gets the refusal itself.
      expect(state.db.prepare("SELECT detail FROM chief_events WHERE kind='tool_error'").all()).toContainEqual({ detail: expect.stringContaining(`${tool}: `) });
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
      [["plan", "--title", "T", "--mission", "M", "--undesigned-reason", "small fix"]],
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

  describe("spawn link (COORD-5)", () => {
    const counts = (state: S) => ({
      rows: (state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get() as { n: number }).n,
      spawned: state.spawned.length,
    });

    test("a Coordinator's spawn is linked at insert, in its own project or in another; the other project's Chief is untouched", async () => {
      const state = await setup();
      const other = await make(state, "proj_2");
      const otherBefore = { ...row(state, other) };
      const coord = await coordinator(state, "proj_1");

      const own = await spawnChild(state, coord, {}, "proj_1");
      expect(row(state, own.id)).toMatchObject({ role: "chief", project_id: "proj_1", coordinator: null, coordinator_thread_id: coord });
      expect(own.text).toContain(`project proj_1`);

      const far = await spawnChild(state, coord, { projectId: "proj_2" }, "proj_1");
      expect(row(state, far.id)).toMatchObject({ role: "chief", project_id: "proj_2", coordinator: null, coordinator_thread_id: coord });
      expect(far.text).toContain(`project proj_2`);
      expect(row(state, other)).toEqual(otherBefore);
      expect(state.spawned.at(-1).projectId).toBe("proj_2");
    });

    test("an unknown projectId leaves no thread and no row", async () => {
      const state = await setup({ missingProjects: ["proj_missing"] });
      const coord = await coordinator(state);
      const before = counts(state);
      await expect(call(state, "chief_spawn", { request: "x", context: "y", projectId: "proj_missing" }, coord)).rejects.toThrow("No project proj_missing.");
      expect(counts(state)).toEqual(before);
    });

    test("a plain Chief may not pass projectId, and nothing is created", async () => {
      const state = await setup();
      const chief = await make(state);
      const before = counts(state);
      await expect(call(state, "chief_spawn", { request: "x", context: "y", projectId: "proj_2" }, chief)).rejects.toThrow("for a Coordinator only");
      expect(counts(state)).toEqual(before);
    });

    test("todoId with another project is refused before anything is created; in its own project the todo moves", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      await call(state, "chief_roster", { todo: { text: "Remember the milk" } }, coord);
      const todoId = (state.db.prepare("SELECT id FROM chief_todos").get() as { id: number }).id;
      const before = counts(state);
      await expect(call(state, "chief_spawn", { request: "x", context: "y", projectId: "proj_2", todoId }, coord)).rejects.toThrow("todos belong to one project");
      expect(counts(state)).toEqual(before);
      expect(state.db.prepare("SELECT chief_thread_id FROM chief_todos").get()).toEqual({ chief_thread_id: coord });

      const child = await spawnChild(state, coord, { todoId });
      expect(child.text).toContain(`Todo #${todoId} moved to it.`);
      expect(state.db.prepare("SELECT chief_thread_id FROM chief_todos").get()).toEqual({ chief_thread_id: child.id });
    });

    test("the linked wording reaches the result and brief.md; a plain Chief's text and brief carry none of it", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = await spawnChild(state, coord, { projectId: "proj_2" });
      expect(child.text).toContain("linked as your child");
      const brief = await readFile(join(state.storageRoot, child.id, "brief.md"), "utf8");
      expect(brief).toContain(`Handed off by Coordinator ${coord}`);
      expect(brief).toContain("supervises you");
      expect(brief).toContain("chief_escalate");
      expect(brief).toContain(`Answer each message it sends you by running \`bb thread tell ${coord}\` with your answer, not only in this thread.`);
      expect(brief).toContain(`Owner's decision (relayed by Coordinator):`);
      expect(brief).not.toContain("never through the Coordinator");

      const plain = await make(state);
      const plainChild = await spawnChild(state, plain);
      expect(plainChild.text).toContain("is not your managed work");
      expect(plainChild.text).not.toMatch(/linked|Coordinator/);
      const plainBrief = await readFile(join(state.storageRoot, plainChild.id, "brief.md"), "utf8");
      expect(plainBrief).toContain(`Handed off by Chief ${plain}`);
      expect(plainBrief).not.toMatch(/Coordinator/);
      expect(plainBrief).not.toContain(`Owner's decision (relayed by Coordinator):`);
      expect(row(state, plainChild.id)).toMatchObject({ coordinator: null, coordinator_thread_id: null });
    });

    test("a child's own spawn is a plain Chief: unlinked, and it cannot be nested", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = await spawnChild(state, coord);
      const grandchild = await spawnChild(state, child.id);
      expect(row(state, grandchild.id)).toMatchObject({ coordinator: null, coordinator_thread_id: null });
      expect(grandchild.text).toContain("is not your managed work");
      expect(await call(state, "chief_coordinate", {}, child.id).catch((error: Error) => error.message)).toContain(coord);
      expect(row(state, child.id)).toMatchObject({ coordinator: null, coordinator_thread_id: coord });
    });
  });

  describe("Need-you alert (COORD-6)", () => {
    const PR = "https://github.com/acme/shop/pull/8";
    const key = (child: string, request: string, cycle = 0) => `${child}:coordinator-need-you:${createHash("sha1").update(request).digest("hex").slice(0, 12)}:${cycle}`;
    /** A Coordinator with one linked child Chief. */
    async function linked(state: S) {
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      return { coord, child };
    }

    test("an escalation about a worker with a pull request alerts the Coordinator once, and the forge post still queues", async () => {
      const state = await setup();
      const { coord, child } = await linked(state);
      const worker = await delegate(state, child, "Fix totals", { prUrl: PR });
      const request = "Pick a currency rounding rule.";
      const text = await call(state, "chief_escalate", { threadId: worker.threadId, request }, child);
      expect(text).toBe(`Queued for ${PR}. Now write the same request in chat under **Need you**.`);
      await settle();
      expect(needYouKeys(state)).toEqual([{ key: key(child, request), source: child, target: coord, delivered: 1 }]);
      const [message] = sentToCoordinator(state, coord).filter((sent) => String(sent.input[0].text).includes(request));
      expect(message.senderThreadId).toBe(child);
      expect(message.input[0].text).toContain(`about worker “Fix totals” (${worker.threadId})`);
      expect(message.input[0].text).toContain(`The owner answers it in ${child}`);
      expect(message.input[0].text).toContain(`bb thread tell ${child}`);
      expect(message.input[0].text).toContain(`Owner's decision (relayed by Coordinator):`);
    });

    test("a chat-only escalation (planner with no tracking issue) and one without a threadId each alert once", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const { coord, child } = await linked(state);
      const planned = await cli(state, ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"], child);
      expect(planned.exitCode, planned.stderr).toBe(0);
      const planner = (await state.harness.behavior.callRpc("status", null) as any).threads.find((thread: any) => thread.role === "planner" && thread.chiefThreadId === child).threadId as string;
      const chatOnly = "No pull request or issue to post on; write the request in chat only.";

      expect(await call(state, "chief_escalate", { threadId: planner, request: "Which scope for the plan?" }, child)).toBe(chatOnly);
      expect(await call(state, "chief_escalate", { threadId: undefined, request: "Which team owns this?" }, child)).toBe(chatOnly);
      await settle();
      expect(needYouKeys(state).map((alert) => alert.key).sort()).toEqual([key(child, "Which scope for the plan?"), key(child, "Which team owns this?")].sort());
      const texts = sentToCoordinator(state, coord).map((sent) => String(sent.input[0].text));
      expect(texts.find((text) => text.includes("Which scope for the plan?"))).toMatch(new RegExp(`about planner “[^”]*Rework checkout” \\(${planner}\\)`));
      expect(texts.find((text) => text.includes("Which team owns this?"))).not.toContain(" about ");
    });

    test("an identical repeat adds no row and no message; a different request adds one", async () => {
      const state = await setup();
      const { coord, child } = await linked(state);
      for (const request of ["Which team owns this?", "Which team owns this?"]) await call(state, "chief_escalate", { request }, child);
      await settle();
      expect(needYouKeys(state)).toHaveLength(1);
      expect(sentToCoordinator(state, coord).filter((sent) => String(sent.input[0].text).includes("Which team owns this?"))).toHaveLength(1);
      await call(state, "chief_escalate", { request: "Which branch?" }, child);
      await settle();
      expect(needYouKeys(state)).toHaveLength(2);
    });

    test("a Chief with no Coordinator writes no alert; a Coordinator cannot escalate", async () => {
      const state = await setup();
      const plain = await make(state);
      await call(state, "chief_escalate", { request: "Which team owns this?" }, plain);
      const coord = await coordinator(state, "proj_2");
      await expect(call(state, "chief_escalate", { request: "Mine" }, coord, "proj_2")).rejects.toThrow("not available to a Coordinator");
      await settle();
      expect(kinds(state)).toEqual([]);
    });

    test("an alert that cannot be written does not fail the escalation", async () => {
      const state = await setup();
      const { child } = await linked(state);
      state.db.exec("ALTER TABLE alert_outbox RENAME TO alert_outbox_hidden");
      try {
        expect(await call(state, "chief_escalate", { request: "Which team owns this?" }, child)).toBe("No pull request or issue to post on; write the request in chat only.");
      } finally {
        state.db.exec("ALTER TABLE alert_outbox_hidden RENAME TO alert_outbox");
      }
      expect(kinds(state)).toEqual([]);
    });

    test("a failed send leaves the row pending with an attempt; a repeat of that request neither deletes nor duplicates it", async () => {
      const state = await setup();
      const { child } = await linked(state);
      state.failNextSend();
      await call(state, "chief_escalate", { request: "Which team owns this?" }, child);
      await settle();
      const pending = () => state.db.prepare("SELECT dedupe_key, attempts, delivered_at FROM alert_outbox WHERE dedupe_key LIKE '%:coordinator-%'").all();
      expect(pending()).toEqual([{ dedupe_key: key(child, "Which team owns this?"), attempts: 1, delivered_at: null }]);
      await call(state, "chief_escalate", { request: "Which team owns this?" }, child);
      await settle();
      expect(pending()).toEqual([{ dedupe_key: key(child, "Which team owns this?"), attempts: 1, delivered_at: null }]);
    });

    test("a duplicate of a delivered alert never deletes a different pending one (A delivered, B pending, A again)", async () => {
      const state = await setup();
      const { child } = await linked(state);
      await call(state, "chief_escalate", { request: "A" }, child);
      await settle();
      state.failNextSend();
      await call(state, "chief_escalate", { request: "B" }, child);
      await settle();
      await call(state, "chief_escalate", { request: "A" }, child);
      await settle();
      expect(needYouKeys(state).map((alert) => [alert.key, alert.delivered])).toEqual(expect.arrayContaining([[key(child, "A"), 1], [key(child, "B"), 0]]));
      expect(needYouKeys(state)).toHaveLength(2);
    });

    test("a duplicate of a pending alert leaves exactly the two pending ones (A pending, B pending, A again)", async () => {
      const state = await setup();
      const { child } = await linked(state);
      for (const request of ["A", "B", "A"]) {
        state.failNextSend();
        await call(state, "chief_escalate", { request }, child);
        await settle();
      }
      expect(needYouKeys(state).map((alert) => [alert.key, alert.delivered]).sort()).toEqual([[key(child, "A"), 0], [key(child, "B"), 0]].sort());
    });
  });

  describe("done alert (COORD-7)", () => {
    const stateOfRow = (state: S, id: string) => row(state, id).state as string;
    /** A linked child Chief with one completed worker (not yet idle). */
    async function withDone(state: S) {
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const worker = (await delegate(state, child, "Fix totals")).threadId;
      await completeWorker(state, child, worker);
      return { coord, child, worker };
    }
    const doneAlerts = (state: S, coord: string) => sentToCoordinator(state, coord).filter((sent) => String(sent.input[0].text).includes("finished its work"));
    const todo = (state: S, child: string, params: object) => call(state, "chief_roster", { todo: params }, child);
    /** A worker whose gate reviewer approved and is running again when the worker completes (override). */
    async function reviewedWorker(state: S, child: string) {
      forgeAnswers(state);
      const worker = (await delegate(state, child, "Fix totals", forged())).threadId;
      await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker);
      const { reviewerId: reviewer } = await startGate(state, child, worker);
      await call(state, "chief_report", { state: "ready", result: "Checked", verdict: "approve", findings: [] }, reviewer!);
      state.live.set(reviewer!, { ...state.live.get(reviewer!)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer!)! });
      // A running reviewer holds the gate, so Chief closes the worker out with override and the reviewer is absorbed.
      await call(state, "chief_complete", { threadId: worker, override: "the reviewer is still running" }, child);
      await settle();
      return { worker, reviewer: reviewer! };
    }

    test("idle with every owned thread complete alerts once; repeated idle, sweep and reconcile add nothing; a new completed round adds one", async () => {
      const state = await setup();
      const { coord, child, worker } = await withDone(state);
      expect(doneKeys(state)).toEqual([]); // complete but not idle yet
      await idle(state, child);
      expect(doneKeys(state)).toEqual([{ key: `${child}:coordinator-done:${worker}`, source: child, target: coord, delivered: 1 }]);
      const [message] = doneAlerts(state, coord);
      expect(message.senderThreadId).toBe(child);
      expect(message.input[0].text).toContain(child);
      expect(message.input[0].text).toContain("finished its work. Outcome: “Fix totals”");

      await idle(state, child);
      await state.supervisorCycle();
      await call(state, "chief_roster", {}, child);
      await settle();
      expect(doneKeys(state)).toHaveLength(1);
      expect(doneAlerts(state, coord)).toHaveLength(1);

      const second = (await delegate(state, child, "Second round")).threadId;
      await completeWorker(state, child, second);
      await idle(state, child);
      expect(doneKeys(state).map((alert) => alert.key).sort()).toEqual([`${child}:coordinator-done:${worker}`, `${child}:coordinator-done:${second}`].sort());
      expect(doneAlerts(state, coord)).toHaveLength(2);
    });

    test("no alert while a managed row is open, a todo is open (waiting or not), or nothing was ever completed; each condition lifts it", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      await idle(state, child);
      expect(doneKeys(state)).toEqual([]); // no completed row

      const open = (await delegate(state, child, "Still open")).threadId;
      await completeWorker(state, child, (await delegate(state, child, "Finished")).threadId);
      await idle(state, child);
      expect(doneKeys(state)).toEqual([]); // an open row remains

      await todo(state, child, { text: "Later", after: "the release" });
      await completeWorker(state, child, open);
      await idle(state, child);
      expect(doneKeys(state)).toEqual([]); // every row is complete, but a waiting todo is open
      const waiting = (state.db.prepare("SELECT id FROM chief_todos").get() as { id: number }).id;
      await todo(state, child, { text: "Now" });
      await todo(state, child, { id: waiting, state: "dropped" });
      await idle(state, child);
      expect(doneKeys(state)).toEqual([]); // an open todo remains
      const now = (state.db.prepare("SELECT id FROM chief_todos WHERE state='open'").get() as { id: number }).id;
      await todo(state, child, { id: now, state: "done" });
      await idle(state, child);
      expect(doneKeys(state)).toHaveLength(1);
    });

    test.each(["thread.active", "thread.failed", "thread.archived", "thread.deleted"])("a %s event for a finished child is not a done alert", async (event) => {
      const state = await setup();
      const { child } = await withDone(state);
      state.live.set(child, { ...state.live.get(child)!, status: event === "thread.active" ? "active" : "idle" } as any);
      await state.harness.behavior.emitThreadEvent(event as any, { thread: state.live.get(child)!, lastAssistantText: "x", error: null });
      await settle();
      expect(doneKeys(state)).toEqual([]);
    });

    test("an inactive Coordinator receives no done alert", async () => {
      const state = await setup();
      const { coord, child } = await withDone(state);
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(coord)! });
      await settle();
      expect(stateOfRow(state, coord)).toBe("archived");
      await idle(state, child);
      expect(doneKeys(state)).toEqual([]);
    });

    test("an absorbed reviewer that completes in a later sweep gives one alert then, not before", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const { reviewer } = await reviewedWorker(state, child);
      await idle(state, child);
      expect(stateOfRow(state, reviewer)).toBe("active");
      expect(doneKeys(state)).toEqual([]);
      state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "idle" });
      await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
      await settle();
      expect(stateOfRow(state, reviewer)).toBe("complete");
      expect(doneKeys(state)).toHaveLength(1);
    });

    test("a transient threads.get failure delays the alert; the next sweep gives exactly one", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const { reviewer } = await reviewedWorker(state, child);
      await idle(state, child);
      state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "idle" });
      state.failNextGet(reviewer);
      await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(reviewer)!, lastAssistantText: "done" });
      await settle();
      expect(stateOfRow(state, reviewer)).toBe("idle");
      expect(doneKeys(state)).toEqual([]);
      await idle(state, child); // a later sweep reads the reviewer again
      expect(stateOfRow(state, reviewer)).toBe("complete");
      expect(doneKeys(state)).toHaveLength(1);
    });

    test("a missed idle event is recovered by reconcile and its sweep: one alert", async () => {
      const state = await setup();
      const { coord, child } = await withDone(state);
      state.live.set(child, { ...state.live.get(child)!, status: "idle" }); // the host never delivered thread.idle
      expect(doneKeys(state)).toEqual([]);
      await state.supervisorCycle();
      await settle();
      expect(stateOfRow(state, child)).toBe("idle");
      expect(doneKeys(state)).toHaveLength(1);
      await state.supervisorCycle();
      await settle();
      expect(doneAlerts(state, coord)).toHaveLength(1);
    });

    test("attaching an idle, finished Chief sends no done alert (its round is recorded as delivered); the next completed round alerts once", async () => {
      const state = await setup();
      const plain = await make(state);
      const worker = (await delegate(state, plain, "Fix totals")).threadId;
      await completeWorker(state, plain, worker);
      await idle(state, plain);
      expect(kinds(state)).toEqual([]); // unlinked: nobody to alert
      const coord = await coordinator(state);
      expect(await call(state, "chief_attach", { threadIds: [plain] }, coord)).toBe(`${plain}: attached.`);
      await settle();
      await state.supervisorCycle();
      await settle();
      expect(doneKeys(state)).toEqual([{ key: `${plain}:coordinator-done:${worker}`, source: plain, target: coord, delivered: 1 }]);
      expect(doneAlerts(state, coord)).toEqual([]);
      expect(await call(state, "chief_attach", { threadIds: [plain] }, coord)).toBe(`${plain}: already attached (no change).`);
      await settle();
      expect(doneAlerts(state, coord)).toEqual([]);

      const second = (await delegate(state, plain, "Second round")).threadId;
      await completeWorker(state, plain, second);
      await idle(state, plain);
      expect(doneKeys(state).map((alert) => alert.key)).toEqual([`${plain}:coordinator-done:${worker}`, `${plain}:coordinator-done:${second}`]);
      expect(doneAlerts(state, coord)).toHaveLength(1);
      expect(String(doneAlerts(state, coord)[0]!.input[0].text)).toContain("“Second round”");
    });

    test("Need-you and done alerts never evict each other while pending", async () => {
      const state = await setup();
      const { child } = await withDone(state);
      state.failNextSend();
      await call(state, "chief_escalate", { request: "First question" }, child);
      await settle();
      state.failNextSend();
      await idle(state, child);
      state.failNextSend();
      await call(state, "chief_escalate", { request: "Second question" }, child);
      await settle();
      expect(kinds(state).map((alert) => [alert.key.split(":")[1], alert.delivered]).sort()).toEqual([["coordinator-done", 0], ["coordinator-need-you", 0], ["coordinator-need-you", 0]]);
    });
  });

  describe("roster (COORD-8)", () => {
    test("the Children block lists each child across projects with its own Pending lines and todos; unlinked Chiefs are absent", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const near = (await spawnChild(state, coord, { title: "Near child" })).id;
      const far = (await spawnChild(state, coord, { title: "Far child", projectId: "proj_2" }, "proj_1")).id;
      const stranger = await make(state);
      const worker = await delegate(state, near, "Near worker");
      await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker.threadId);
      await call(state, "chief_roster", { todo: { text: "Far todo" } }, far, "proj_2");
      await call(state, "chief_roster", { todo: { text: "Own todo" } }, coord);
      const text = await call(state, "chief_roster", {}, coord);
      expect(text.startsWith("Decisions: $BB_THREAD_STORAGE/decisions.md\n## Children\n")).toBe(true);
      expect(text).toMatch(new RegExp(`^- “[^”]*Near child” \\(${near}\\) · project proj_1 · \\w+$`, "m"));
      expect(text).toMatch(new RegExp(`^- “[^”]*Far child” \\(${far}\\) · project proj_2 · \\w+$`, "m"));
      expect(text).not.toContain(stranger);
      const [nearBlock, farBlock] = [text.indexOf(`(${near})`), text.indexOf(`(${far})`)];
      const nearLines = text.slice(nearBlock, farBlock);
      const farLines = text.slice(farBlock);
      expect(nearLines).toContain("Near worker");
      expect(nearLines).not.toContain("Far todo");
      expect(farLines).toContain("Far todo");
      expect(farLines).not.toContain("Near worker");
      // Each child's lines are indented under its header; the Coordinator's own Pending block follows the Children block.
      expect(nearLines).toMatch(/\n {2}\S/);
      // The Coordinator's todo is another Chief's todo to its same-project child: by default it is one count line there (not its text), and not counted under the other project's child.
      expect(nearLines).not.toContain("Own todo");
      expect(nearLines).toContain("1 other-Chief todo (#2) hidden: not your work. chief_roster includeOthers: true lists them.");
      expect(farLines.slice(0, farLines.indexOf("\nPending:\n- todo"))).not.toContain("other-Chief todo (#2)");
      expect(text.endsWith(`Pending:\n- todo #2: Own todo`)).toBe(true);
      // includeOthers: true expands every child block back to the tagged todo lines.
      const expanded = await call(state, "chief_roster", { includeOthers: true }, coord);
      const expandedNear = expanded.slice(expanded.indexOf(`(${near})`), expanded.indexOf(`(${far})`));
      expect(expandedNear).toContain("Own todo");
      expect(expandedNear).not.toContain("hidden: not your work");
      expect(expanded.slice(expanded.indexOf(`(${far})`))).toContain("Far todo");
    });

    test("the Coordinator's own Pending block folds a child's todo into one count line; includeOthers: true lists it", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord, { title: "Only child" })).id;
      await call(state, "chief_roster", { todo: { text: "Child todo" } }, child);
      await call(state, "chief_roster", { todo: { text: "Coordinator todo" } }, coord);
      const ownBlock = (text: string) => text.slice(text.lastIndexOf("\nPending:\n") + 1);
      const collapsed = ownBlock(await call(state, "chief_roster", {}, coord));
      expect(collapsed).toBe("Pending:\n- todo #2: Coordinator todo\n- 1 other-Chief todo (#1) hidden: not your work. chief_roster includeOthers: true lists them.");
      const expanded = ownBlock(await call(state, "chief_roster", { includeOthers: true }, coord));
      expect(expanded).toContain(`- todo #1 (Chief ${child}): Child todo`);
      expect(expanded).not.toContain("hidden: not your work");
    });

    test("a Coordinator with no children says how to get some", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      expect(await call(state, "chief_roster", {}, coord)).toContain("No child Chiefs. Attach ones the owner names with chief_attach, or start one with chief_spawn.");
    });

    test("many children and long Pending lists stay within 6000 characters", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      for (let index = 0; index < 20; index += 1) {
        const child = (await spawnChild(state, coord, { title: `Child ${index}` })).id;
        for (let item = 0; item < 3; item += 1) await call(state, "chief_roster", { todo: { text: `Todo ${index}.${item} ${"x".repeat(300)}` } }, child);
      }
      const path = "Decisions: $BB_THREAD_STORAGE/decisions.md\n";
      const text = await call(state, "chief_roster", {}, coord);
      expect(text.length).toBeLessThanOrEqual(6_000);
      expect(text.startsWith(`${path}## Children\n`)).toBe(true);
      // The Coordinator's own Pending block and a decisions.md write-failure note survive the crowded Children block.
      state.failWritesMatching(/decisions\.md/);
      const failed = await call(state, "chief_roster", { todo: { text: "Own todo" } }, coord);
      state.failWritesMatching(null);
      expect(failed.length).toBeLessThanOrEqual(6_000);
      expect(failed.startsWith(path)).toBe(true);
      expect(failed).toMatch(/Note: decisions\.md was not updated \(see the plugin log\)\.\nPending:\n- todo #\d+: Own todo/);
    });

    // The Children block is clipped to what the own Pending block and the failure note leave. Each child line is clipped to its share of 4,000 characters,
    // so the blocks fit 6,000 at any size up to 4,000 children. At 4,001 the share is 0, clip() then keeps every line whole, and only that clip keeps the output in the cap.
    test("a Coordinator's own Pending block and failure note survive an overflowing Children block", { timeout: 30_000 }, async () => {
      const state = await setup();
      const coord = await coordinator(state);
      await spawnChild(state, coord, { title: "Seed child" });
      const insert = state.db.prepare("INSERT INTO managed_threads (thread_id, role, project_id, title, state, status, coordinator_thread_id, created_at, updated_at) VALUES (?, 'chief', 'proj_1', ?, 'active', 'idle', ?, 1, 1)");
      for (let index = 0; index < 4_001; index += 1) insert.run(`thr_crowd${index}`, `Crowd ${index}`, coord);
      for (let item = 0; item < 3; item += 1) await call(state, "chief_roster", { todo: { text: `Own todo ${item} ${"x".repeat(80)}` } }, coord);
      state.failWritesMatching(/decisions\.md/);
      const text = await call(state, "chief_roster", { todo: { text: "Last own todo" } }, coord);
      state.failWritesMatching(null);
      const own = text.slice(text.lastIndexOf("\nPending:\n") + 1);
      expect(text.length).toBeLessThanOrEqual(6_000);
      expect(text.startsWith("Decisions: $BB_THREAD_STORAGE/decisions.md\n## Children\n")).toBe(true);
      expect(text).toContain(`\nNote: decisions.md was not updated (see the plugin log).\nPending:\n`);
      // The own block fits whole: all three todos and the last one, exactly as the Pending block renders them.
      expect(own).toBe(`Pending:\n${[1, 2, 3].map((n) => `- todo #${n}: Own todo ${n - 1} ${"x".repeat(80)}`).join("\n")}\n- todo #4: Last own todo`);
    });
  });

  describe("plain Chief chief_spawn is unchanged from base 95aa7df", () => {
    // Literals copied from base server.ts (spawn result, handoffSection): runnable on the base checkout too.
    test("the result and brief.md are byte-identical", async () => {
      const state = await setup();
      const plain = await make(state);
      const text = await call(state, "chief_spawn", { title: "Side task", request: "Do the task", context: "Goal: done" }, plain);
      const id = /in thread (thr_\w+)/.exec(text)![1]!;
      expect(text).toBe(`Started Chief “Side task” in thread ${id}. It owns this task now and is not your managed work: it is not in your roster, sends you no alerts, and you cannot inspect or steer it.`);
      expect(await readFile(join(state.storageRoot, id, "brief.md"), "utf8")).toBe([
        "## Handed-off task",
        `Handed off by Chief ${plain}. It keeps no link to you: it will not see your roster or alerts, and you do not report to it.`,
        "",
        "### Owner's request (verbatim)",
        "Do the task",
        "",
        "### Context",
        "Goal: done",
        "",
        "Own this task through completion under your normal rules. Start with chief_roster. Plan it with your own chief_plan when planning applies; the handing-off Chief's planners, workers and reviewers stay with it, so their plan, report and verdict files are evidence only. Then forge, delegate, review and complete. The handoff is evidence, not proof. This handoff is saved at $BB_THREAD_STORAGE/brief.md; re-read it after any context compaction.",
      ].join("\n"));
    });
  });

  describe("configure (COORD-9)", () => {
    const configure = (state: S, id: string, provider: "codex" | "claude-code" = "codex") => {
      const context = configurationContext(id);
      return state.harness.behavior.resolveAgentConfiguration({ ...context, provider: { ...context.provider, id: provider } }) as Promise<{ tools: { name: string }[]; skills: string[]; instructions: string }>;
    };
    const MARKER = "# Project rules marker";
    // Chief's own budget for the core rules (keeps the rules small), not the SDK cut. The exact select: preload line (about 600 characters for a plain Chief) moved it from 4096/4000.
    // CRISPY stages 1-3 add 364 characters to the research paragraph and the planner order line of a planning-and-research Chief; the budget grew by the same rounded amount (5,300 to 5,700).
    // The hook-safe fold wave's Fresh worker rule (plan wave 1 step 1, verbatim) is 363 characters longer than the rule this budget was set with; the budget grew by the same rounded amount.
    // The one-gate review rules (W1-W5) added about 200 more characters; the budget grew by the same rounded amount.
    // CRISPY research rules added about 400 more characters on top of the one-gate growth; the budget grew by the same rounded amount.
    const CHIEF_BUDGET = 6_000;
    const GREETING = "You are the registered Coordinator for Asha: you supervise child Chiefs in any project, not managed threads.";

    test.each([["short chief.md", `${MARKER}\n- Keep rules small.`, false], ["32,000-char chief.md", `${MARKER}\n${"- Project rule text.\n".repeat(1_600)}`.slice(0, 32_000), true]])(
      "a Coordinator gets the Coordinator rules with a %s last, within the 32768-char cut, and no Chief rules", async (_label, rules, reachesCap) => {
        const state = await setup({ rules });
        const coord = await coordinator(state);
        const { tools, skills, instructions } = await configure(state, coord);
        expect(tools.map((tool) => tool.name).sort()).toEqual(["chief_attach", "chief_roster", "chief_spawn"]);
        expect(skills).toEqual([]);
        expect(instructions.length).toBeLessThanOrEqual(32768);
        if (reachesCap) expect(instructions.length).toBe(32768);
        expect(instructions.startsWith(`${GREETING}\n`)).toBe(true);
        expect(instructions).toContain("Call chief_roster at the start of every turn, and again after any compaction (also re-read $BB_THREAD_STORAGE/brief.md then, when it exists): its Children block is your work list.");
        expect(instructions).not.toContain("# Chief core rules");
        expect(instructions).not.toContain("# Chief operating rules");
        expect(instructions).toContain(`Owner's decision (relayed by Coordinator):`);
        expect(instructions).toContain("bb thread tell");
        expect(instructions).not.toContain("Never answer or relay");
        expect(instructions.indexOf(MARKER)).toBeGreaterThan(instructions.indexOf("never poll children."));
      });

    test("a Coordinator with no chief.md gets neither project rules nor the built-in Chief rules", async () => {
      const state = await setup();
      const { instructions } = await configure(state, await coordinator(state));
      expect(instructions).not.toContain("# Chief operating rules");
      expect(instructions.endsWith("never poll children.")).toBe(true);
    });

    test("claude-code: a Coordinator's preload line asks for exactly its three tools", async () => {
      const state = await setup();
      const { tools, instructions } = await configure(state, await coordinator(state), "claude-code");
      const line = instructions.split("\n").find((text) => text.includes("ToolSearch"))!;
      expect(tools).toHaveLength(3);
      expect(line.endsWith("ToolSearch call: select:mcp__bb-bridge__chief_roster,mcp__bb-bridge__chief_spawn,mcp__bb-bridge__chief_attach")).toBe(true);
      expect(instructions).not.toMatch(/\+chief|max_results/);
    });

    test.each(["codex", "claude-code"] as const)("%s: a linked Chief omits the coordination and attachment tools", async (provider) => {
      const state = await setup({ rules: `${MARKER}\n- Keep rules small.` });
      const plain = await make(state);
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const [plainConfig, childConfig] = [await configure(state, plain, provider), await configure(state, child, provider)];
      expect(childConfig.skills).not.toContain("coordinator");
      expect(childConfig.tools.map((tool) => tool.name)).toEqual(plainConfig.tools.map((tool) => tool.name).filter((name) => name !== "chief_coordinate" && name !== "chief_attach"));
      expect(childConfig.instructions).toContain(coord);
      const preloads = [...childConfig.instructions.matchAll(/\bselect:(mcp__bb-bridge__\w+(?:,mcp__bb-bridge__\w+)*)/g)];
      if (provider === "claude-code") {
        expect(preloads).toHaveLength(1);
        expect(preloads[0]![1]!.split(",").map((id) => id.replace(/^mcp__bb-bridge__/, "")).sort()).toEqual(childConfig.tools.map((tool) => tool.name).sort());
      } else {
        expect(preloads).toHaveLength(0);
      }
    });

    // The SDK cuts instructions at 32768 chars; the core rules (the last, mandatory one is the Need-you escalation) go before the project rules, so they must end inside the cut even for the longest supported inputs.
    // The CHIEF_BUDGET bound below is Chief's own budget for the core rules (keeps the rules small), not the SDK cut.
    test("claude-code, planning and research on, linked child, 14-char Coordinator id, 40-char project name: the core rules, Need-you rule included, end inside the 5000-char core-rules budget", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const idPadding = 14 - coord.length; // the harness ids are short; the real ones are 14 chars (thr_ + 10), and the Coordinator line carries the id once
      const name = "P".repeat(40);
      const resolve = async (id: string) => {
        const context = configurationContext(id, "proj_1", name);
        return (await state.harness.behavior.resolveAgentConfiguration({ ...context, provider: { ...context.provider, id: "claude-code" } })) as { tools: { name: string }[]; instructions: string };
      };
      const [linked, plain] = [await resolve(child), await resolve(await make(state))];
      for (const config of [linked, plain]) {
        const names = config.tools.map((tool) => tool.name);
        expect(names).toContain("chief_plan");
        expect(names).toContain("chief_research");
        expect(config.instructions).toContain(`registered Chief supervisor for ${name}.`);
      }
      expect(linked.instructions).toContain(`Coordinator ${coord} supervises you: call chief_escalate before every Need you`);
      const NEED_YOU_END = "call chief_escalate with the thread and the full request.";
      const coreEnd = (text: string) => text.indexOf(NEED_YOU_END) + NEED_YOU_END.length;
      expect(linked.instructions.indexOf("# Chief core rules")).toBeGreaterThan(0);
      expect(linked.instructions.indexOf(NEED_YOU_END)).toBeGreaterThan(0);
      expect(idPadding).toBeGreaterThanOrEqual(0);
      expect(coreEnd(linked.instructions) + idPadding).toBeLessThanOrEqual(CHIEF_BUDGET);
      expect(coreEnd(plain.instructions)).toBeLessThanOrEqual(coreEnd(linked.instructions));
      expect(coreEnd(plain.instructions)).toBeLessThan(CHIEF_BUDGET);
    });

    test("a plain Chief has 18 tools, a child Chief 16 and a Coordinator 3, with planning and research on", async () => {
      const state = await setup();
      const plain = await make(state);
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const count = async (id: string) => (await configure(state, id)).tools.length;
      expect([await count(plain), await count(child), await count(coord)]).toEqual([18, 16, 3]);
    });

  });

  describe("alert outbox delivery (COORD-11)", () => {
    const sha = (text: string, length: number) => createHash("sha1").update(text).digest("hex").slice(0, length);
    const markerOf = (key: string) => `[alert ${sha(key, 10)}]`;
    const outbox = (state: S, key: string) => state.db.prepare("SELECT * FROM alert_outbox WHERE dedupe_key=?").get(key) as { message: string; attempts: number; delivered_at: number | null; last_error: string | null; last_attempt_at: number | null };
    const textsTo = (state: S, target: string) => state.sent.filter((message) => message.threadId === target).map((message) => String(message.input[0].text));
    /** A row as an older build or a crash between the write and the send leaves it. */
    function seedRow(state: S, key: string, source: string, target: string, over: { message?: string; attempts?: number; ageMs?: number; lastAttemptAgeMs?: number } = {}) {
      const now = Date.now();
      state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(key, target, source, over.message ?? `[Chief lifecycle alert]\nseeded ${key}\n${markerOf(key)}`, now - (over.ageMs ?? 0), over.attempts ?? 0, over.lastAttemptAgeMs === undefined ? null : now - over.lastAttemptAgeMs);
    }
    /** A plain Chief that owns a worker: its source rows are never Coordinator kinds, so they retry without a cap. */
    async function plainWithWorker(state: S) {
      const chief = await make(state);
      return { chief, worker: (await delegate(state, chief, "Fix totals")).threadId };
    }
    async function linked(state: S) {
      const coord = await coordinator(state);
      return { coord, child: (await spawnChild(state, coord)).id };
    }
    const escalate = async (state: S, child: string, request: string) => { await call(state, "chief_escalate", { request }, child); await settle(); };
    const needYouKey = (child: string, request: string, cycle = 0) => `${child}:coordinator-need-you:${sha(request, 12)}:${cycle}`;

    test("a worker's ready alert with a 5000-character result is stored with the marker last, within 3000 characters, keeps its action line and report path whole, and is sent as stored", async () => {
      const state = await setup();
      const { chief, worker } = await plainWithWorker(state);
      await call(state, "chief_report", { state: "ready", summary: "S".repeat(800), result: `${"R".repeat(5_000)}${NO_DEVIATIONS}` }, worker);
      await settle();
      const stored = state.db.prepare("SELECT dedupe_key, message FROM alert_outbox WHERE source_thread_id=? AND message LIKE '%State: ready%'").get(worker) as { dedupe_key: string; message: string };
      const reportPath = row(state, worker).report_path as string;
      expect(reportPath).toBeTruthy();
      expect(stored.message.length).toBeLessThanOrEqual(3_000);
      expect(stored.message.endsWith(`\n${markerOf(stored.dedupe_key)}`)).toBe(true);
      expect(stored.message.split("\n")).toContain(readyAction(worker));
      expect(stored.message).toContain(reportPath);
      expect(textsTo(state, chief)).toContain(stored.message);
    });

    test.each([["queued message", "queue"], ["recent event", "event"]])("a failed send counts one attempt before it is made; once BB shows the %s with the marker inside rewrapped text, the retry marks it delivered and sends nothing", async (_label, where) => {
      const state = await setup();
      const { coord, child } = await linked(state);
      const request = "Which team owns this?";
      state.failNextSend();
      await escalate(state, child, request);
      const key = needYouKey(child, request);
      expect(outbox(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
      expect(outbox(state, key).last_attempt_at).toBeGreaterThan(0);
      const rewrapped = `Message from ${child}:\n${outbox(state, key).message}\n(forwarded)`;
      if (where === "queue") state.seedQueuedMessage(coord, rewrapped);
      else state.seedEvents(coord, [{ type: "item/completed", seq: 1, createdAt: Date.now(), data: { item: { type: "userMessage", content: [{ type: "text", text: rewrapped }] } } }]);
      elapse(31_000);
      await state.supervisorCycle();
      expect(outbox(state, key)).toMatchObject({ attempts: 1, last_error: null });
      expect(outbox(state, key).delivered_at).not.toBeNull();
      expect(textsTo(state, coord).filter((text) => text.includes(request))).toEqual([]);
    });

    test("a retry that finds no marker in the queue or events sends the stored text again", async () => {
      const state = await setup();
      const { coord, child } = await linked(state);
      const request = "Which team owns this?";
      state.failNextSend();
      await escalate(state, child, request);
      state.seedQueuedMessage(coord, `[alert ${"0".repeat(10)}] some other alert`);
      elapse(31_000);
      await state.supervisorCycle();
      expect(textsTo(state, coord)).toContain(outbox(state, needYouKey(child, request)).message);
      expect(outbox(state, needYouKey(child, request)).delivered_at).not.toBeNull();
    });

    test("a row stored before markers is matched by its exact text: queued means delivered without a send; absent means it is sent with its text unchanged", async () => {
      const state = await setup();
      const { chief: seen, worker: seenWorker } = await plainWithWorker(state);
      const { chief: lost, worker: lostWorker } = await plainWithWorker(state);
      const legacy = (worker: string) => `[Chief lifecycle alert]\nWorker ${worker} reported (written before markers).`;
      seedRow(state, `${seenWorker}:legacy-kind:1`, seenWorker, seen, { message: legacy(seenWorker), attempts: 1, lastAttemptAgeMs: 60_000 });
      seedRow(state, `${lostWorker}:legacy-kind:1`, lostWorker, lost, { message: legacy(lostWorker), attempts: 1, lastAttemptAgeMs: 60_000 });
      state.seedQueuedMessage(seen, legacy(seenWorker));
      await state.supervisorCycle();
      expect(outbox(state, `${seenWorker}:legacy-kind:1`)).toMatchObject({ attempts: 1 });
      expect(outbox(state, `${seenWorker}:legacy-kind:1`).delivered_at).not.toBeNull();
      expect(textsTo(state, seen)).toEqual([]);
      expect(textsTo(state, lost)).toEqual([legacy(lostWorker)]);
      expect(outbox(state, `${lostWorker}:legacy-kind:1`)).toMatchObject({ attempts: 2 });
    });

    test("a failed alert waits 30 s, then 60 s, between sends; a call before its backoff sends nothing", async () => {
      const state = await setup();
      const { coord, child } = await linked(state);
      const request = "Which team owns this?";
      const key = needYouKey(child, request);
      state.failNextSend();
      state.failNextSend();
      await escalate(state, child, request);
      const attempts = async (afterMs: number) => { elapse(afterMs); await state.supervisorCycle(); return outbox(state, key).attempts; };
      expect(await attempts(0)).toBe(1);
      expect(await attempts(29_000)).toBe(1);
      expect(await attempts(2_000)).toBe(2); // 31 s after the first attempt: failed again
      expect(await attempts(31_000)).toBe(2); // 62 s after the first attempt, 31 s after the second: still inside its 60 s
      expect(await attempts(30_000)).toBe(3); // 61 s after the second attempt
      expect(outbox(state, key).delivered_at).not.toBeNull();
      expect(textsTo(state, coord).filter((text) => text.includes(request))).toHaveLength(1);
    });

    test("a row never attempted is not picked by the supervisor until it is 60 s old", async () => {
      const state = await setup();
      const { chief, worker } = await plainWithWorker(state);
      const key = `${worker}:legacy-kind:1`;
      seedRow(state, key, worker, chief);
      await state.supervisorCycle();
      expect(textsTo(state, chief)).toEqual([]);
      elapse(59_000);
      await state.supervisorCycle();
      expect(textsTo(state, chief)).toEqual([]);
      elapse(2_000);
      await state.supervisorCycle();
      expect(textsTo(state, chief)).toEqual([outbox(state, key).message]);
    });

    test.each([[9, true], [10, false]])("a Coordinator row at %i attempts is retried: %s", async (attempts, retried) => {
      const state = await setup();
      const { coord, child } = await linked(state);
      const key = `${child}:coordinator-ended:archived`;
      seedRow(state, key, child, coord, { attempts, lastAttemptAgeMs: 2_000_000 });
      await state.supervisorCycle();
      expect(textsTo(state, coord).filter((text) => text.includes(markerOf(key)))).toHaveLength(retried ? 1 : 0);
      expect(outbox(state, key).attempts).toBe(retried ? attempts + 1 : attempts);
    });

    test("a worker alert has no attempt cap: it is retried at 10 attempts and at 25", async () => {
      const state = await setup();
      const { chief, worker } = await plainWithWorker(state);
      for (const attempts of [10, 25]) seedRow(state, `${worker}:legacy-kind:${attempts}`, worker, chief, { attempts, lastAttemptAgeMs: 2_000_000 });
      await state.supervisorCycle();
      expect(textsTo(state, chief)).toHaveLength(2);
    });

    test("a gone notice that always fails stops at exactly 10 attempts through the supervisor, alertSelf and sweep", async () => {
      const state = await setup();
      const { coord, child } = await linked(state);
      for (let index = 0; index < 14; index += 1) state.failNextSend();
      state.live.set(coord, { ...state.live.get(coord)!, archivedAt: new Date().toISOString() }); // reconcile reads the host's state, which must agree with the event
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(coord)! });
      await settle();
      const key = `${child}:coordinator-gone:${coord}`;
      expect(outbox(state, key).attempts).toBe(1);
      for (let cycle = 0; cycle < 15; cycle += 1) {
        elapse(1_900_000);
        await state.supervisorCycle();
      }
      expect(outbox(state, key)).toMatchObject({ attempts: 10, delivered_at: null });
      expect(textsTo(state, child)).toEqual([]);
    });

    test("a worker stall alert whose send failed is settled as stale once the worker leaves its cycle, and is never sent", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ stallMinutes: "1" });
      const { chief, worker } = await plainWithWorker(state);
      const t0 = Date.now();
      state.live.set(worker, { ...state.live.get(worker)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(worker)! });
      state.failNextSend();
      elapse(61_000);
      await state.supervisorCycle();
      const key = `${worker}:stall:${row(state, worker).active_cycle}`;
      expect(outbox(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
      state.live.set(worker, { ...state.live.get(worker)!, status: "idle" });
      await state.harness.behavior.emitThreadEvent("thread.idle", { thread: state.live.get(worker)!, lastAssistantText: "done" });
      elapse(31_000);
      await state.supervisorCycle();
      expect(outbox(state, key).delivered_at).not.toBeNull();
      expect(outbox(state, key).last_error).toMatch(/^stale: /);
      expect(textsTo(state, chief).filter((text) => text.includes(markerOf(key)))).toEqual([]);
      expect(Date.now()).toBeGreaterThan(t0);
    });
  });

  describe("child signals to the Coordinator (COORD-6, COORD-12)", () => {
    const sha12 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
    const PR = "https://github.com/acme/shop/pull/8";
    const activate = async (state: S, id: string) => {
      state.live.set(id, { ...state.live.get(id)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(id)! });
      await settle();
    };
    const fail = async (state: S, id: string) => {
      state.live.set(id, { ...state.live.get(id)!, status: "error" });
      await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(id)!, error: null });
      await settle();
    };
    const end = async (state: S, id: string, event: "thread.archived" | "thread.deleted") => {
      state.live.set(id, { ...state.live.get(id)!, ...(event === "thread.archived" ? { archivedAt: new Date().toISOString() } : { deletedAt: new Date().toISOString() }) });
      await state.harness.behavior.emitThreadEvent(event, { thread: state.live.get(id)! });
      await settle();
    };
    const keysOf = (state: S, kind: string) => kinds(state).filter((alert) => alert.key.includes(`:coordinator-${kind}:`)).map((alert) => alert.key);
    const linked = async (state: S) => {
      const coord = await coordinator(state);
      return { coord, child: (await spawnChild(state, coord)).id };
    };

    describe("need-you receipt per child turn", () => {
      test("the same request twice in one turn is one row and one message; after the child's next turn it is a second row and a second message", async () => {
        const state = await setup();
        const { coord, child } = await linked(state);
        const request = "Which team owns this?";
        const sends = () => sentToCoordinator(state, coord).filter((sent) => String(sent.input[0].text).includes(request)).length;
        const cycle = row(state, child).active_cycle as number;
        await call(state, "chief_escalate", { request }, child);
        await call(state, "chief_escalate", { request }, child);
        await settle();
        expect(keysOf(state, "need-you")).toEqual([`${child}:coordinator-need-you:${sha12(request)}:${cycle}`]);
        expect(sends()).toBe(1);

        await activate(state, child);
        await idle(state, child);
        expect(row(state, child).active_cycle).toBe(cycle + 1);
        await call(state, "chief_escalate", { request }, child);
        await settle();
        expect(keysOf(state, "need-you")).toEqual([`${child}:coordinator-need-you:${sha12(request)}:${cycle}`, `${child}:coordinator-need-you:${sha12(request)}:${cycle + 1}`]);
        expect(sends()).toBe(2);
      });

      test("the message carries the pull request of the concerned thread as its own line; a chat-only message carries none", async () => {
        const state = await setup();
        const { coord, child } = await linked(state);
        const worker = await delegate(state, child, "Fix totals", { prUrl: PR });
        await call(state, "chief_escalate", { threadId: worker.threadId, request: "Pick a rounding rule." }, child);
        await call(state, "chief_escalate", { request: "Which team owns this?" }, child);
        await settle();
        const text = (needle: string) => String(sentToCoordinator(state, coord).find((sent) => String(sent.input[0].text).includes(needle))!.input[0].text);
        expect(text("Pick a rounding rule.").split("\n")).toContain(`PR: ${PR}`);
        expect(text("Which team owns this?")).not.toContain("PR:");
      });

      const legacyKey = (child: string, request: string) => `${child}:coordinator-need-you:${sha12(request)}`;
      const seedLegacy = (state: S, coord: string, child: string, request: string) => {
        const key = legacyKey(child, request);
        const message = `[Coordinator alert]\nChild Chief ${child} is blocked on a Need you:\n${request}\nThe owner answers it in ${child}.\n[alert ${createHash("sha1").update(key).digest("hex").slice(0, 10)}]`;
        state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?)").run(key, coord, child, message, Date.now() - 120_000, Date.now() - 120_000);
        return { key, message };
      };

      test("a need-you row written before the cycle suffix is still delivered while the child stays linked to that Coordinator, whatever its cycle", async () => {
        const state = await setup();
        const { coord, child } = await linked(state);
        for (let turn = 0; turn < 3; turn += 1) { await activate(state, child); await idle(state, child); }
        expect(row(state, child).active_cycle).toBeGreaterThanOrEqual(3);
        const { key, message } = seedLegacy(state, coord, child, "Which team owns this?");
        await state.supervisorCycle();
        expect(sentToCoordinator(state, coord).map((sent) => String(sent.input[0].text))).toEqual([message]);
        expect(state.db.prepare("SELECT delivered_at, last_error FROM alert_outbox WHERE dedupe_key=?").get(key)).toMatchObject({ last_error: null });
      });

      test("a need-you row written before the cycle suffix is never sent once its Coordinator is archived and another one took the child over", async () => {
        const state = await setup();
        const { coord, child } = await linked(state);
        seedLegacy(state, coord, child, "Which team owns this?");
        await end(state, coord, "thread.archived");
        const successor = await coordinator(state);
        expect(await call(state, "chief_attach", { threadIds: [child] }, successor)).toBe(`${child}: attached.`);
        elapse(31_000);
        await state.supervisorCycle();
        expect(state.sent.filter((sent) => String(sent.input[0].text).includes("Which team owns this?"))).toEqual([]);
      });
    });

    describe("Chief active cycle", () => {
      test("an active event counts one cycle and stamps active_since; a repeat changes neither; idle clears active_since; the next active counts again", async () => {
        const state = await setup();
        const { child } = await linked(state);
        elapse(0);
        const start = row(state, child).active_cycle as number;
        await activate(state, child);
        const first = row(state, child);
        expect(first).toMatchObject({ active_cycle: start + 1, state: "active" });
        expect(first.active_since).toBe(Date.now());
        elapse(5_000);
        await activate(state, child);
        expect(row(state, child)).toMatchObject({ active_cycle: start + 1, active_since: first.active_since });
        await idle(state, child);
        expect(row(state, child)).toMatchObject({ active_cycle: start + 1, active_since: null, state: "idle" });
        await activate(state, child);
        expect(row(state, child)).toMatchObject({ active_cycle: start + 2 });
      });

      test("reconcile that finds a Chief active counts one cycle, once however many cycles follow", async () => {
        const state = await setup();
        const { child } = await linked(state);
        const start = row(state, child).active_cycle as number;
        state.live.set(child, { ...state.live.get(child)!, status: "active" }); // the host never delivered thread.active
        await state.supervisorCycle();
        await state.supervisorCycle();
        expect(row(state, child)).toMatchObject({ state: "active", active_cycle: start + 1 });
        expect(row(state, child).active_since).not.toBeNull();
      });
    });

    describe("failed, ended and stalled (COORD-12)", () => {
      test("a failed child alerts once per cycle: a repeat adds none, a new turn that fails again adds one", async () => {
        const state = await setup();
        const { coord, child } = await linked(state);
        await activate(state, child);
        const cycle = row(state, child).active_cycle as number;
        await fail(state, child);
        await fail(state, child);
        expect(keysOf(state, "failed")).toEqual([`${child}:coordinator-failed:${cycle}`]);
        expect(sentToCoordinator(state, coord).filter((sent) => String(sent.input[0].text).includes("failed"))).toHaveLength(1);
        await activate(state, child);
        await fail(state, child);
        expect(keysOf(state, "failed")).toEqual([`${child}:coordinator-failed:${cycle}`, `${child}:coordinator-failed:${cycle + 1}`]);
      });

      test.each(["thread.archived", "thread.deleted"] as const)("a %s child alerts once for that state", async (event) => {
        const state = await setup();
        const { coord, child } = await linked(state);
        const state_ = event === "thread.archived" ? "archived" : "deleted";
        await end(state, child, event);
        await end(state, child, event);
        await state.supervisorCycle();
        expect(keysOf(state, "ended")).toEqual([`${child}:coordinator-ended:${state_}`]);
        expect(sentToCoordinator(state, coord).filter((sent) => String(sent.input[0].text).includes(`was ${state_}`))).toHaveLength(1);
      });

      describe("stalled", () => {
        const THRESHOLD = 60_000;
        /** An idle child that owns one ready worker, quiet since now. */
        async function idleWithReadyWorker(state: S) {
          await state.harness.behavior.setSettings({ stallMinutes: "1" });
          const { coord, child } = await linked(state);
          const worker = (await delegate(state, child, "Fix totals")).threadId;
          await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker);
          await activate(state, child);
          await idle(state, child);
          elapse(0);
          return { coord, child, worker };
        }
        const stalled = (state: S) => keysOf(state, "stalled");

        test("an idle child with open work, no busy row, no Need you and a quiet threshold alerts once for that cycle", async () => {
          const state = await setup();
          const { child } = await idleWithReadyWorker(state);
          elapse(THRESHOLD - 1_000);
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([]);
          elapse(2_000);
          await state.supervisorCycle();
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([`${child}:coordinator-stalled:${row(state, child).active_cycle}:idle`]);
        });

        test("an idle child whose only open work is a ready todo alerts; one whose only open work waits on an after: condition does not", async () => {
          const state = await setup();
          await state.harness.behavior.setSettings({ stallMinutes: "1" });
          const { child } = await linked(state);
          await activate(state, child);
          await idle(state, child);
          await call(state, "chief_roster", { todo: { text: "Later", after: "the release" } }, child);
          elapse(0);
          elapse(THRESHOLD + 1_000);
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([]);
          await call(state, "chief_roster", { todo: { text: "Now" } }, child);
          elapse(THRESHOLD + 1_000);
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([`${child}:coordinator-stalled:${row(state, child).active_cycle}:idle`]);
        });

        test.each([
          ["a busy owned row", async (state: S, ctx: { child: string; worker: string }) => { await activate(state, ctx.worker); }],
          ["a starting owned row", async (state: S, ctx: { worker: string }) => { state.live.set(ctx.worker, { ...state.live.get(ctx.worker)!, status: "starting" }); await state.supervisorCycle(); }],
          ["a Need you in this cycle", async (state: S, ctx: { child: string }) => { await call(state, "chief_escalate", { request: "Which team owns this?" }, ctx.child); await settle(); }],
          ["no open work (the worker is complete)", async (state: S, ctx: { child: string; worker: string }) => { await completeWorker(state, ctx.child, ctx.worker); }],
        ])("an idle child past the threshold gets no stalled alert with %s", async (_label, block) => {
          const state = await setup();
          const ctx = await idleWithReadyWorker(state);
          await block(state, ctx);
          elapse(THRESHOLD + 1_000);
          // Backdate every row's last change: the blocker alone, not a recent update, must hold the alert back.
          state.db.prepare("UPDATE managed_threads SET updated_at = updated_at - ?").run(THRESHOLD + 1_000);
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([]);
        });

        test("an active child alerts once per cycle at exactly the threshold, not a millisecond before; a later turn alerts again", async () => {
          const state = await setup();
          await state.harness.behavior.setSettings({ stallMinutes: "1" });
          const { child } = await linked(state);
          elapse(0);
          await activate(state, child);
          const cycle = row(state, child).active_cycle as number;
          elapse(THRESHOLD - 1);
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([]);
          elapse(1);
          await state.supervisorCycle();
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([`${child}:coordinator-stalled:${cycle}:active`]);
          await idle(state, child);
          await activate(state, child);
          elapse(THRESHOLD);
          await state.supervisorCycle();
          expect(stalled(state)).toEqual([`${child}:coordinator-stalled:${cycle}:active`, `${child}:coordinator-stalled:${cycle + 1}:active`]);
        });

        test("the worker stall loop still skips Chiefs: an active Chief past twice the threshold gets no stall row or message, while a worker in the same state does", async () => {
          const state = await setup();
          await state.harness.behavior.setSettings({ stallMinutes: "1" });
          const plain = await make(state);
          const worker = (await delegate(state, plain, "Fix totals")).threadId;
          elapse(0);
          await activate(state, plain);
          await activate(state, worker);
          elapse(2 * THRESHOLD + 1_000);
          await state.supervisorCycle();
          const stallKeys = (state.db.prepare("SELECT dedupe_key AS key FROM alert_outbox WHERE dedupe_key LIKE '%:stall:%'").all() as { key: string }[]).map((alert) => alert.key);
          expect(stallKeys.filter((key) => key.startsWith(`${worker}:`)).length).toBeGreaterThan(0);
          expect(stallKeys.filter((key) => key.startsWith(`${plain}:`))).toEqual([]);
          expect(state.sent.filter((sent) => String(sent.input[0].text).includes(`Chief “`) && String(sent.input[0].text).includes("has been active for"))).toEqual([]);
        });
      });
    });
  });

  describe("done alert content (COORD-7)", () => {
    const outcomeOf = (text: string) => text.slice(text.indexOf("Outcome: ") + "Outcome: ".length, text.lastIndexOf("\n[alert "));
    async function finishedRounds(state: S, titles: string[], over: { prUrl?: string } = {}) {
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      elapse(0);
      for (const title of titles) {
        await completeWorker(state, child, (await delegate(state, child, title, over)).threadId);
        elapse(1_000);
      }
      await idle(state, child);
      return { coord, child };
    }
    const doneText = (state: S, coord: string) => String(sentToCoordinator(state, coord).find((sent) => String(sent.input[0].text).includes("finished its work"))!.input[0].text);

    test("the outcome lists the newest three completed titles and leaves the oldest out", async () => {
      const state = await setup();
      const { coord } = await finishedRounds(state, ["Round A", "Round B", "Round C", "Round D"]);
      const outcome = outcomeOf(doneText(state, coord));
      expect(outcome).toContain("“Round B”");
      expect(outcome.indexOf("“Round D”")).toBeLessThan(outcome.indexOf("“Round C”"));
      expect(outcome.indexOf("“Round C”")).toBeLessThan(outcome.indexOf("“Round B”"));
      expect(outcome).not.toContain("Round A");
    });

    test("three long titles with pull request links give an outcome of at most 300 characters, each title cut to 80", async () => {
      const state = await setup();
      const long = (letter: string) => `${letter}${"x".repeat(149)}`;
      const { coord } = await finishedRounds(state, [long("A"), long("B"), long("C")], { prUrl: "https://github.com/acme/shop/pull/8" });
      const text = doneText(state, coord);
      const outcome = outcomeOf(text);
      expect(outcome.length).toBeLessThanOrEqual(300);
      expect(outcome).toContain("Cxxx");
      expect(outcome).not.toContain(long("C").slice(0, 100));
      expect(text.length).toBeLessThanOrEqual(3_000);
    });

    test("an undelivered done alert is replaced by the next round's: only the newest key stays, and it is delivered", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const first = (await delegate(state, child, "First round")).threadId;
      await completeWorker(state, child, first);
      state.failNextSend();
      await idle(state, child);
      expect(doneKeys(state)).toEqual([{ key: `${child}:coordinator-done:${first}`, source: child, target: coord, delivered: 0 }]);
      elapse(1_000);
      const second = (await delegate(state, child, "Second round")).threadId;
      await completeWorker(state, child, second);
      await idle(state, child);
      expect(doneKeys(state)).toEqual([{ key: `${child}:coordinator-done:${second}`, source: child, target: coord, delivered: 1 }]);
    });
  });

  describe("retry freshness (COORD-12a)", () => {
    const sha12 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
    const marker = (key: string) => `[alert ${createHash("sha1").update(key).digest("hex").slice(0, 10)}]`;
    const activate = async (state: S, id: string) => {
      state.live.set(id, { ...state.live.get(id)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(id)! });
      await settle();
    };
    const stored = (state: S, key: string) => state.db.prepare("SELECT attempts, delivered_at, last_error FROM alert_outbox WHERE dedupe_key=?").get(key) as { attempts: number; delivered_at: number | null; last_error: string | null };
    const sends = (state: S, key: string) => state.sent.filter((sent) => String(sent.input[0].text).includes(marker(key))).length;
    type Pending = { key: string; change: () => Promise<void> };

    /** Each case leaves one failed, undelivered Coordinator alert (one attempt) and a `change` that makes its condition false. */
    const cases: [string, (state: S) => Promise<Pending>][] = [
      ["need-you: the child began a new turn", async (state) => {
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        const cycle = row(state, child).active_cycle as number;
        state.failNextSend();
        await call(state, "chief_escalate", { request: "Which team owns this?" }, child);
        await settle();
        return { key: `${child}:coordinator-need-you:${sha12("Which team owns this?")}:${cycle}`, change: async () => { await activate(state, child); await idle(state, child); } };
      }],
      ["done: the child took on new open work", async (state) => {
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        const worker = (await delegate(state, child, "Fix totals")).threadId;
        await completeWorker(state, child, worker);
        state.failNextSend();
        await idle(state, child);
        return { key: `${child}:coordinator-done:${worker}`, change: async () => { await delegate(state, child, "Another round"); } };
      }],
      ["failed: the child went active again", async (state) => {
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        await activate(state, child);
        const cycle = row(state, child).active_cycle as number;
        state.failNextSend();
        state.live.set(child, { ...state.live.get(child)!, status: "error" });
        await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(child)!, error: null });
        await settle();
        return { key: `${child}:coordinator-failed:${cycle}`, change: async () => { await activate(state, child); } };
      }],
      ["stalled (active): the turn ended", async (state) => {
        await state.harness.behavior.setSettings({ stallMinutes: "1" });
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        elapse(0);
        await activate(state, child);
        const cycle = row(state, child).active_cycle as number;
        elapse(60_000);
        state.failNextSend();
        await state.supervisorCycle();
        return { key: `${child}:coordinator-stalled:${cycle}:active`, change: async () => { await idle(state, child); } };
      }],
      ["stalled (idle): the child asked the owner", async (state) => {
        await state.harness.behavior.setSettings({ stallMinutes: "1" });
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        const worker = (await delegate(state, child, "Fix totals")).threadId;
        await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker);
        await activate(state, child);
        await idle(state, child);
        elapse(0);
        elapse(61_000);
        state.failNextSend();
        await state.supervisorCycle();
        return { key: `${child}:coordinator-stalled:${row(state, child).active_cycle}:idle`, change: async () => { await call(state, "chief_escalate", { request: "Which team owns this?" }, child); await settle(); } };
      }],
    ];

    test.each(cases)("%s: the retry settles it as stale and sends nothing; unchanged, the same retry sends it", async (_label, build) => {
      const control = await setup();
      const kept = await build(control);
      expect(stored(control, kept.key)).toMatchObject({ attempts: 1, delivered_at: null });
      elapse(31_000);
      await control.supervisorCycle();
      expect(stored(control, kept.key).delivered_at).not.toBeNull();
      expect(stored(control, kept.key).last_error).toBeNull();
      expect(sends(control, kept.key)).toBe(1);

      const state = await setup();
      const pending = await build(state);
      expect(stored(state, pending.key)).toMatchObject({ attempts: 1, delivered_at: null });
      await pending.change();
      elapse(31_000);
      await state.supervisorCycle();
      expect(stored(state, pending.key)).toMatchObject({ attempts: 1 });
      expect(stored(state, pending.key).delivered_at).not.toBeNull();
      expect(stored(state, pending.key).last_error).toMatch(/^stale: /);
      expect(sends(state, pending.key)).toBe(0);
    });

    test("an ended alert is historical: it is still sent after its child was superseded by a successor", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      await delegate(state, child, "Fix totals");
      state.failNextSend();
      state.live.set(child, { ...state.live.get(child)!, archivedAt: Date.now() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(child)! });
      await settle();
      const key = `${child}:coordinator-ended:archived`;
      expect(stored(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
      await state.supervisorCycle();
      expect(row(state, child).state).toBe("complete");
      elapse(31_000);
      await state.supervisorCycle();
      expect(stored(state, key).last_error).toBeNull();
      expect(stored(state, key).delivered_at).not.toBeNull();
      expect(sends(state, key)).toBe(1);
      expect(state.sent.filter((sent) => sent.threadId === coord && String(sent.input[0].text).includes(marker(key)))).toHaveLength(1);
    });
  });

  describe("notices to children (COORD-13)", () => {
    const archive = async (state: S, id: string) => {
      state.live.set(id, { ...state.live.get(id)!, archivedAt: new Date().toISOString() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(id)! });
      await settle();
    };
    const noticesTo = (state: S, id: string) => state.sent.filter((sent) => sent.threadId === id && String(sent.input[0].text).startsWith("[Coordinator notice]"));
    const marker = (key: string) => `[alert ${createHash("sha1").update(key).digest("hex").slice(0, 10)}]`;
    const outbox = (state: S, key: string) => state.db.prepare("SELECT attempts, delivered_at, last_error FROM alert_outbox WHERE dedupe_key=?").get(key) as { attempts: number; delivered_at: number | null; last_error: string | null };

    test("attaching a Chief sends it one notice naming its Coordinator, with no sender; attaching again sends none", async () => {
      const state = await setup();
      const plain = await make(state);
      const coord = await coordinator(state);
      await call(state, "chief_attach", { threadIds: [plain] }, coord);
      await call(state, "chief_attach", { threadIds: [plain] }, coord);
      await settle();
      const notices = noticesTo(state, plain);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.senderThreadId).toBeUndefined();
      expect(String(notices[0]!.input[0].text)).toContain(coord);
      expect(String(notices[0]!.input[0].text)).toContain("chief_escalate");
      expect(String(notices[0]!.input[0].text)).toContain(`Answer each one by running bb thread tell ${coord} with your answer, not only in your own thread.`);
      expect(String(notices[0]!.input[0].text)).not.toContain("No reply needed");
      expect(String(notices[0]!.input[0].text)).toContain(`Owner's decision (relayed by Coordinator):`);
      expect(String(notices[0]!.input[0].text).endsWith(marker(`${plain}:coordinator-attached:${coord}`))).toBe(true);
    });

    test("a pending attached notice is settled stale, and never sent, once another Coordinator took the child over", async () => {
      const state = await setup();
      const plain = await make(state);
      const first = await coordinator(state);
      state.failNextSend();
      await call(state, "chief_attach", { threadIds: [plain] }, first);
      await settle();
      const key = `${plain}:coordinator-attached:${first}`;
      expect(outbox(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
      await archive(state, first);
      const second = await coordinator(state);
      expect(await call(state, "chief_attach", { threadIds: [plain] }, second)).toBe(`${plain}: attached.`);
      await settle();
      elapse(31_000);
      await state.supervisorCycle();
      expect(outbox(state, key).delivered_at).not.toBeNull();
      expect(outbox(state, key).last_error).toMatch(/^stale: /);
      expect(state.sent.filter((sent) => String(sent.input[0].text).includes(marker(key)))).toEqual([]);
      expect(noticesTo(state, plain).map((sent) => String(sent.input[0].text)).some((text) => text.includes(second))).toBe(true);
    });

    test("when its Coordinator is archived an active child gets one notice that names chief_attach; later cycles add none", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      await archive(state, coord);
      await state.supervisorCycle();
      await state.supervisorCycle();
      const notices = noticesTo(state, child);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.senderThreadId).toBeUndefined();
      expect(String(notices[0]!.input[0].text)).toContain("chief_attach");
      expect(String(notices[0]!.input[0].text)).toContain(coord);
      expect(String(notices[0]!.input[0].text).endsWith(marker(`${child}:coordinator-gone:${coord}`))).toBe(true);
    });

    test("a pending gone notice is settled stale once another Coordinator attaches the child", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      state.failNextSend();
      await archive(state, coord);
      const key = `${child}:coordinator-gone:${coord}`;
      expect(outbox(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
      const second = await coordinator(state);
      expect(await call(state, "chief_attach", { threadIds: [child] }, second)).toBe(`${child}: attached.`);
      await settle();
      elapse(31_000);
      await state.supervisorCycle();
      expect(outbox(state, key).delivered_at).not.toBeNull();
      expect(outbox(state, key).last_error).toMatch(/^stale: /);
      expect(state.sent.filter((sent) => String(sent.input[0].text).includes(marker(key)))).toEqual([]);
    });
  });

  describe("handover keeps work with its Coordinator (COORD-5)", () => {
    const archive = async (state: S, id: string) => {
      state.live.set(id, { ...state.live.get(id)!, archivedAt: new Date().toISOString() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(id)! });
      await settle();
    };
    /** Coordinator C in proj_1 with child X (proj_1) that owns one open worker. */
    async function orphaned(state: S) {
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord, { title: "Checkout" })).id;
      const worker = (await delegate(state, child, "Fix totals")).threadId;
      return { coord, child, worker };
    }
    const rosterOf = (state: S, coord: string) => call(state, "chief_roster", {}, coord);

    test("no other project Chief: the supervisor starts a successor that stays C's child and takes the work; the old row is closed", async () => {
      const state = await setup();
      const { coord, child, worker } = await orphaned(state);
      await archive(state, child);
      await state.supervisorCycle();
      const successor = row(state, worker).chief_thread_id as string;
      expect(successor).not.toBe(child);
      expect(row(state, successor)).toMatchObject({ role: "chief", coordinator_thread_id: coord, coordinator: null });
      expect(row(state, child).state).toBe("complete");
      const roster = await rosterOf(state, coord);
      expect(roster).toContain(`(${successor})`);
      expect(roster).not.toContain(`(${child})`);
      expect(roster).toContain("closed: 1");
    });

    test("an unlinked project Chief receives the work and becomes C's child, keeping its own work", async () => {
      const state = await setup();
      const { coord, child, worker } = await orphaned(state);
      const project = await make(state);
      const own = (await delegate(state, project, "Own work")).threadId;
      await archive(state, child);
      await state.supervisorCycle();
      expect(row(state, worker).chief_thread_id).toBe(project);
      expect(row(state, own).chief_thread_id).toBe(project);
      expect(row(state, project)).toMatchObject({ coordinator_thread_id: coord, coordinator: null });
      expect(row(state, child).state).toBe("complete");
      expect(await rosterOf(state, coord)).toContain(`(${project})`);
    });

    test("a project Chief linked to another Coordinator is not given the work: a dedicated successor is started and the other Coordinator's child is untouched", async () => {
      const state = await setup();
      const { coord, child, worker } = await orphaned(state);
      const other = await coordinator(state, "proj_2");
      const foreign = (await spawnChild(state, other, { projectId: "proj_1" }, "proj_2")).id;
      const before = { ...row(state, foreign) };
      await call(state, "chief_roster", { decision: { text: "carry me" } }, child);
      await archive(state, child);
      await state.supervisorCycle();
      const successor = row(state, worker).chief_thread_id as string;
      // The dedicated successor (replaceChief's hand-over) gets the orphan's decisions.
      const successorFile = join(state.storageRoot, successor, "decisions.md");
      for (let i = 0; i < 200 && !(await readFile(successorFile, "utf8").catch(() => "")).includes("carry me"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await readFile(successorFile, "utf8")).toContain("carry me");
      expect(successor).not.toBe(foreign);
      expect(successor).not.toBe(child);
      expect(row(state, successor)).toMatchObject({ role: "chief", coordinator_thread_id: coord });
      expect(row(state, foreign)).toMatchObject({ role: "chief", project_id: "proj_1", title: before.title, coordinator_thread_id: other, chief_thread_id: before.chief_thread_id });
      expect(state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE chief_thread_id=?").get(foreign)).toEqual({ n: 0 });
      expect(row(state, child).state).toBe("complete");
      const otherRoster = await rosterOf(state, other);
      expect(otherRoster).toContain(`(${foreign})`);
      expect(otherRoster).not.toContain("closed:");
    });

    test("a superseded child sends no failed, ended or stalled alert afterwards", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ stallMinutes: "1" });
      const { child } = await orphaned(state);
      await archive(state, child);
      await state.supervisorCycle();
      expect(row(state, child).state).toBe("complete");
      const known = kinds(state).map((alert) => alert.key);
      for (const event of ["thread.failed", "thread.archived"] as const) {
        state.live.set(child, { ...state.live.get(child)!, status: "error" });
        await state.harness.behavior.emitThreadEvent(event, { thread: state.live.get(child)!, error: null });
        await settle();
      }
      elapse(3_600_000);
      await state.supervisorCycle();
      expect(kinds(state).map((alert) => alert.key).filter((key) => key.includes(`${child}:coordinator-`) && !known.includes(key))).toEqual([]);
    });

    test("bb chief adopt refuses a thread linked to a Coordinator that the project's Chief does not share: nothing changes and the thread is not renamed", async () => {
      const state = await setup();
      const other = await coordinator(state, "proj_2");
      const foreign = (await spawnChild(state, other, { projectId: "proj_1" }, "proj_2")).id;
      const plain = await make(state);
      const worker = (await delegate(state, plain, "Plain work")).threadId;
      const snapshot = () => ({
        rows: state.db.prepare("SELECT thread_id, state, chief_thread_id, coordinator_thread_id FROM managed_threads ORDER BY thread_id").all(),
        title: state.live.get(foreign)!.title,
      });
      const before = snapshot();
      const result = await cli(state, ["adopt", "--thread", foreign]);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toContain(other);
      expect(snapshot()).toEqual(before);
      expect(row(state, worker).chief_thread_id).toBe(plain);
    });

    test("bb chief adopt of a fresh thread in a Coordinator's child's project takes the child's work and keeps its Coordinator", async () => {
      const state = await setup();
      const { coord, child, worker } = await orphaned(state);
      state.addLive("thr_fresh", "proj_1");
      const result = await cli(state, ["adopt", "--thread", "thr_fresh"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(row(state, worker).chief_thread_id).toBe("thr_fresh");
      expect(row(state, "thr_fresh")).toMatchObject({ role: "chief", coordinator_thread_id: coord });
      expect(row(state, child).state).toBe("complete");
    });

    test("a Chief whose Coordinator is archived can be attached by another Coordinator; one whose Coordinator is live cannot", async () => {
      const state = await setup();
      const first = await coordinator(state);
      const child = (await spawnChild(state, first)).id;
      const second = await coordinator(state);
      expect(await call(state, "chief_attach", { threadIds: [child] }, second)).toBe(`${child}: not attached: already belongs to Coordinator ${first}.`);
      expect(row(state, child).coordinator_thread_id).toBe(first);
      await archive(state, first);
      expect(await call(state, "chief_attach", { threadIds: [child] }, second)).toBe(`${child}: attached.`);
      expect(row(state, child).coordinator_thread_id).toBe(second);
    });
  });

  describe("roster signals (COORD-8)", () => {
    const header = (text: string, id: string) => text.split("\n").find((line) => line.includes(`(${id})`))!;
    const activate = async (state: S, id: string) => {
      state.live.set(id, { ...state.live.get(id)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(id)! });
      await settle();
    };

    test("a child that asked the owner this turn shows when, until it starts its next turn", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const asking = (await spawnChild(state, coord, { title: "Asking" })).id;
      const quiet = (await spawnChild(state, coord, { title: "Quiet" })).id;
      await idle(state, asking);
      await idle(state, quiet);
      elapse(0);
      await call(state, "chief_escalate", { request: "Which team owns this?" }, asking);
      await settle();
      const at = (state.db.prepare("SELECT created_at FROM alert_outbox WHERE dedupe_key LIKE '%:coordinator-need-you:%'").get() as { created_at: number }).created_at;
      const roster = await call(state, "chief_roster", {}, coord);
      expect(header(roster, asking)).toMatch(new RegExp(` · needs the owner since ${new Date(at).toISOString().replace(/[.]/g, "\\.")}$`));
      expect(header(roster, quiet)).not.toContain("needs the owner");
      await activate(state, asking);
      expect(header(await call(state, "chief_roster", {}, coord), asking)).not.toContain("needs the owner");
      await idle(state, asking);
      expect(header(await call(state, "chief_roster", {}, coord), asking)).not.toContain("needs the owner");
    });

    test("an archived child is left out of the list and counted as closed", async () => {
      const state = await setup();
      const coord = await coordinator(state);
      const kept = (await spawnChild(state, coord, { title: "Kept" })).id;
      const gone = (await spawnChild(state, coord, { title: "Gone" })).id;
      state.live.set(gone, { ...state.live.get(gone)!, archivedAt: new Date().toISOString() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(gone)! });
      await settle();
      const roster = await call(state, "chief_roster", {}, coord);
      expect(roster).toContain(`(${kept})`);
      expect(roster).not.toContain(`(${gone})`);
      expect(roster).toContain("closed: 1");
      expect(await call(state, "chief_roster", {}, coord)).not.toContain("closed: 2");
    });
  });

  describe("goal on upgrade (COORD-1)", () => {
    const briefPath = (state: S, id: string) => join(state.storageRoot, id, "brief.md");
    const GOAL = "Keep the checkout and loyalty teams moving in parallel; ask me before touching billing.";

    test("a goal is written to brief.md under the Coordinator heading, verbatim; no goal writes no file", async () => {
      const state = await setup();
      const withGoal = await make(state);
      const text = await call(state, "chief_coordinate", { goal: GOAL }, withGoal);
      expect(text).toContain("now a Coordinator");
      const brief = await readFile(briefPath(state, withGoal), "utf8");
      expect(brief).toContain("## Coordinator brief");
      expect(brief).toContain(GOAL);
      const without = await make(state);
      await call(state, "chief_coordinate", {}, without);
      await expect(readFile(briefPath(state, without), "utf8")).rejects.toThrow();
    });

    test("a repeated call answers Already a Coordinator and leaves brief.md as it was", async () => {
      const state = await setup();
      const id = await make(state);
      await call(state, "chief_coordinate", { goal: GOAL }, id);
      const before = await readFile(briefPath(state, id), "utf8");
      expect(await call(state, "chief_coordinate", { goal: "A different goal." }, id)).toBe("Already a Coordinator.");
      expect(await readFile(briefPath(state, id), "utf8")).toBe(before);
    });

    test("a brief.md write that fails is reported, and the upgrade stands", async () => {
      const state = await setup();
      const id = await make(state);
      state.failWritesMatching(/brief\.md/);
      const text = await call(state, "chief_coordinate", { goal: GOAL }, id);
      state.failWritesMatching(null);
      expect(text).toContain("brief.md not saved");
      expect(row(state, id).coordinator).toBe(1);
    });

    test.each([["4000 characters", "g".repeat(4_000), true], ["4001 characters", "g".repeat(4_001), false], ["only spaces", "   ", false]])("a goal of %s is %s", async (_label, goal, accepted) => {
      const state = await setup();
      const id = await make(state);
      if (accepted) {
        await call(state, "chief_coordinate", { goal }, id);
        expect(row(state, id).coordinator).toBe(1);
      } else {
        await expect(call(state, "chief_coordinate", { goal }, id)).rejects.toThrow();
        expect(row(state, id).coordinator).toBeFalsy();
      }
    });
  });

  describe("owner boundaries after review (COORD-5, COORD-11, COORD-12a)", () => {
    const sha = (text: string, length: number) => createHash("sha1").update(text).digest("hex").slice(0, length);
    const marker = (key: string) => `[alert ${sha(key, 10)}]`;
    const stored = (state: S, key: string) => state.db.prepare("SELECT attempts, delivered_at, last_error FROM alert_outbox WHERE dedupe_key=?").get(key) as { attempts: number; delivered_at: number | null; last_error: string | null };
    const sentWith = (state: S, needle: string) => state.sent.filter((sent) => String(sent.input[0].text).includes(needle));
    const activate = async (state: S, id: string) => {
      state.live.set(id, { ...state.live.get(id)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(id)! });
      await settle();
    };
    const end = async (state: S, id: string, event: "thread.archived" | "thread.deleted") => {
      state.live.set(id, { ...state.live.get(id)!, ...(event === "thread.archived" ? { archivedAt: new Date().toISOString() } : { deletedAt: new Date().toISOString() }) });
      await state.harness.behavior.emitThreadEvent(event, { thread: state.live.get(id)! });
      await settle();
    };
    const REQUEST = "Which team owns this?";
    const needYou = (child: string, cycle: number) => `${child}:coordinator-need-you:${sha(REQUEST, 12)}:${cycle}`;

    describe("a pending Coordinator receipt to a dead Coordinator is settled stale and never sent", () => {
      test.each([
        ["archived", async (state: S, coord: string) => { await end(state, coord, "thread.archived"); }],
        ["deleted", async (state: S, coord: string) => { await end(state, coord, "thread.deleted"); }],
        ["archived, then the child taken over by another Coordinator", async (state: S, coord: string, child: string) => {
          await end(state, coord, "thread.archived");
          const successor = await coordinator(state);
          expect(await call(state, "chief_attach", { threadIds: [child] }, successor)).toBe(`${child}: attached.`);
        }],
      ])("a failed need-you whose Coordinator was %s: the next due retry through the supervisor sets delivered_at, last_error starts stale:, and nothing is sent", async (_label, kill) => {
        const state = await setup();
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        const key = needYou(child, row(state, child).active_cycle);
        state.failNextSend();
        await call(state, "chief_escalate", { request: REQUEST }, child);
        await settle();
        expect(stored(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
        await kill(state, coord, child);
        elapse(31_000);
        await state.supervisorCycle();
        expect(stored(state, key)).toMatchObject({ attempts: 1 });
        expect(stored(state, key).delivered_at).not.toBeNull();
        expect(stored(state, key).last_error).toMatch(/^stale: /);
        expect(sentWith(state, marker(key))).toEqual([]);
      });

      test("a receipt never attempted (attempts 0) whose Coordinator is dead is settled stale by the supervisor, not sent", async () => {
        const state = await setup();
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        await end(state, coord, "thread.archived");
        const key = needYou(child, row(state, child).active_cycle);
        state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts) VALUES (?, ?, ?, ?, ?, 0)")
          .run(key, coord, child, `[Coordinator alert]\nchild asks\n${marker(key)}`, Date.now() - 120_000);
        await state.supervisorCycle();
        expect(stored(state, key).delivered_at).not.toBeNull();
        expect(stored(state, key).last_error).toMatch(/^stale: /);
        expect(sentWith(state, marker(key))).toEqual([]);
      });

      test("an ended receipt to a dead Coordinator is never sent either", async () => {
        const state = await setup();
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        await end(state, coord, "thread.archived");
        const key = `${child}:coordinator-ended:archived`;
        state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
          .run(key, coord, child, `[Coordinator alert]\nended\n${marker(key)}`, Date.now() - 3_600_000, Date.now() - 3_600_000);
        await state.supervisorCycle();
        expect(sentWith(state, marker(key))).toEqual([]);
      });
    });

    describe("a failed worker stall alert is re-entered through the supervisor", () => {
      test("nothing is sent and stall_alerted_cycle stays unmarked before the backoff; at the backoff it is sent once and marked", async () => {
        const state = await setup();
        await state.harness.behavior.setSettings({ stallMinutes: "1" });
        const chief = await make(state);
        const worker = (await delegate(state, chief, "Fix totals")).threadId;
        elapse(0);
        await activate(state, worker);
        const cycle = row(state, worker).active_cycle as number;
        const key = `${worker}:stall:${cycle}`;
        const unmarked = row(state, worker).stall_alerted_cycle;
        expect(unmarked).not.toBe(cycle);
        const toChief = () => sentWith(state, marker(key)).filter((sent) => sent.threadId === chief);
        state.failNextSend();
        elapse(60_000);
        await state.supervisorCycle();
        expect(stored(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
        for (const afterMs of [0, 15_000, 14_999]) {
          elapse(afterMs);
          await state.supervisorCycle();
          await state.supervisorCycle();
          expect(stored(state, key)).toMatchObject({ attempts: 1, delivered_at: null });
          expect(row(state, worker).stall_alerted_cycle).toBe(unmarked);
          expect(toChief()).toEqual([]);
        }
        elapse(1); // exactly 30 s after the failed attempt
        await state.supervisorCycle();
        await state.supervisorCycle();
        expect(stored(state, key)).toMatchObject({ attempts: 2 });
        expect(stored(state, key).delivered_at).not.toBeNull();
        expect(row(state, worker).stall_alerted_cycle).toBe(cycle);
        expect(toChief()).toHaveLength(1);
      });
    });

    describe("handover to an existing Chief of the same Coordinator", () => {
      test("the orphan's work moves to the sibling child that is already linked to C; the sibling keeps its own work, link and row; no Chief is started", async () => {
        const state = await setup();
        const coord = await coordinator(state);
        const orphan = (await spawnChild(state, coord, { title: "Orphan" })).id;
        const sibling = (await spawnChild(state, coord, { title: "Sibling" })).id;
        const orphanWork = (await delegate(state, orphan, "Orphan work")).threadId;
        const siblingWork = (await delegate(state, sibling, "Sibling work")).threadId;
        const spawnedBefore = state.spawned.length;
        await end(state, orphan, "thread.archived");
        await state.supervisorCycle();
        expect(state.spawned).toHaveLength(spawnedBefore);
        expect(row(state, orphanWork).chief_thread_id).toBe(sibling);
        expect(row(state, siblingWork).chief_thread_id).toBe(sibling);
        expect(row(state, sibling)).toMatchObject({ role: "chief", coordinator_thread_id: coord, state: expect.not.stringMatching(/^(complete|archived|deleted)$/) });
        expect(row(state, orphan).state).toBe("complete");
        const roster = await call(state, "chief_roster", {}, coord);
        expect(roster).toContain(`(${sibling})`);
        expect(roster).not.toContain(`(${orphan})`);
      });
    });

    describe("a legacy need-you row after its source child was superseded", () => {
      test("the retry settles it stale and sends nothing", async () => {
        const state = await setup();
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord, { title: "Checkout" })).id;
        await delegate(state, child, "Fix totals");
        await end(state, child, "thread.archived");
        await state.supervisorCycle();
        expect(row(state, child).state).toBe("complete");
        const key = `${child}:coordinator-need-you:${sha(REQUEST, 12)}`;
        state.db.prepare("INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at, attempts, last_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?)")
          .run(key, coord, child, `[Coordinator alert]\n${REQUEST}\n${marker(key)}`, Date.now() - 120_000, Date.now() - 120_000);
        await state.supervisorCycle();
        expect(stored(state, key)).toMatchObject({ attempts: 1 });
        expect(stored(state, key).delivered_at).not.toBeNull();
        expect(stored(state, key).last_error).toMatch(/^stale: /);
        expect(sentWith(state, REQUEST)).toEqual([]);
      });
    });
  });
});
