import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { MIGRATIONS } from "./src/db/migrations";
import { loadBaseBuild } from "./scripts/loadBaseBuild";
import { ATTACH_DEFINITION, acceptCoreRuleTrim, acceptPlanningLine, acceptEvidenceOnlyDelta, acceptRetestDelta, acceptSpecLaneWording } from "./test/specLaneWording";
import { acceptReviewerToolDelta } from "./test/reviewerToolDelta";
import { PRELOAD_OLD_TAIL, acceptRosterOthersDelta, chiefPreloadTail } from "./test/toolConfigFixture";
import { CLOSE_OUT, NO_DEVIATIONS, completeWorker, configurationContext, delegate, disposeAll, rowOf, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
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

      const plain = await make(state);
      const plainChild = await spawnChild(state, plain);
      expect(plainChild.text).toContain("is not your managed work");
      expect(plainChild.text).not.toMatch(/linked|Coordinator/);
      const plainBrief = await readFile(join(state.storageRoot, plainChild.id, "brief.md"), "utf8");
      expect(plainBrief).toContain(`Handed off by Chief ${plain}`);
      expect(plainBrief).not.toMatch(/Coordinator/);
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
    const key = (child: string, request: string) => `${child}:coordinator-need-you:${createHash("sha1").update(request).digest("hex").slice(0, 12)}`;
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
    });

    test("a chat-only escalation (planner with no tracking issue) and one without a threadId each alert once", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const { coord, child } = await linked(state);
      const planned = await cli(state, ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], child);
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
    /** A worker reviewed and approved, with a reviewer that is still running when the worker completes. */
    async function reviewedWorker(state: S, child: string) {
      const worker = (await delegate(state, child, "Fix totals")).threadId;
      await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker);
      await call(state, "chief_review", { workerThreadId: worker }, child);
      const reviewer = ((await state.harness.behavior.callRpc("status", null)) as any).threads.find((thread: any) => thread.role === "reviewer" && thread.workerThreadId === worker).threadId as string;
      await call(state, "chief_report", { state: "ready", result: "Checked", verdict: "approve", findings: [] }, reviewer);
      state.live.set(reviewer, { ...state.live.get(reviewer)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(reviewer)! });
      await call(state, "chief_complete", { threadId: worker, testsSkipped: CLOSE_OUT.testsSkipped }, child);
      await settle();
      return { worker, reviewer };
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
      expect(message.input[0].text).toContain("chief_roster");

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

    test("attaching an idle, finished Chief gives exactly one done alert through the sweep the link starts; a repeat attach gives none", async () => {
      const state = await setup();
      const plain = await make(state);
      const worker = (await delegate(state, plain, "Fix totals")).threadId;
      await completeWorker(state, plain, worker);
      await idle(state, plain);
      expect(kinds(state)).toEqual([]); // unlinked: nobody to alert
      const coord = await coordinator(state);
      expect(await call(state, "chief_attach", { threadIds: [plain] }, coord)).toBe(`${plain}: attached.`);
      await settle();
      expect(doneKeys(state)).toEqual([{ key: `${plain}:coordinator-done:${worker}`, source: plain, target: coord, delivered: 1 }]);
      expect(await call(state, "chief_attach", { threadIds: [plain] }, coord)).toBe(`${plain}: already attached (no change).`);
      await settle();
      expect(doneKeys(state)).toHaveLength(1);
      expect(doneAlerts(state, coord)).toHaveLength(1);
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
      expect(text.startsWith("## Children\n")).toBe(true);
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
      const text = await call(state, "chief_roster", {}, coord);
      expect(text.length).toBeLessThanOrEqual(6_000);
      expect(text.startsWith("## Children\n")).toBe(true);
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

  // Differential: ONE fixture function runs against the 95aa7df source (git archive of the base commit, own source root) and this checkout,
  // and the plain-Chief outputs are compared. Expected head = base output with exactly the authorized deltas applied, each asserted exactly.
  describe("plain Chief is preserved against base 95aa7df (differential)", () => {
    const BASE_SHA = "95aa7dfd881578003751fff808c5843e5416dd49";
    const HEAD_ROOT = dirname(fileURLToPath(import.meta.url));
    const git = async (...args: string[]) => {
      const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return real.execFileSync("git", ["-C", HEAD_ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
    };
    let baseAvailable = false;
    type Tool = { name: string; description: string; inputSchema: { properties: Record<string, any>; required?: string[] } };
    type Config = { tools: Tool[]; skills: string[]; instructions: string };
    type Captured = {
      meta: { sourceRoot: string; sha: string; cwd: string; fixtureHash: string; migrations: number };
      migrations: string[]; roster: string; spawn: { text: string; brief: string }; escalate: string;
      configure: Record<"codex" | "claude-code", Config>; linkedChild?: Record<"codex" | "claude-code", Config>;
    };

    const configureFor = (state: S, id: string, provider: "codex" | "claude-code") => {
      const context = configurationContext(id);
      return (state.harness.behavior.resolveAgentConfiguration({ ...context, provider: { ...context.provider, id: provider } }) as Promise<Config>)
        .then((config) => JSON.parse(JSON.stringify(config)) as Config); // drops the tools' executable parts; the schemas remain
    };
    // The fixture: a plain Chief with a ready worker, a blocked worker, a todo and a pending alert. Written once; it runs unchanged on both builds.
    async function fixture(module: typeof plugin, minted: Pick<Captured["meta"], "sourceRoot" | "sha">, linked: boolean): Promise<Omit<Captured, "meta" | "migrations"> & { ids: string[] }> {
      const state = await setup({ module, rules: "# Project rules marker\n- Keep rules small." });
      const chief = await make(state);
      const ready = await delegate(state, chief, "Ready work");
      await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, ready.threadId);
      const blocked = await delegate(state, chief, "Blocked work");
      await call(state, "chief_report", { state: "blocked", blocker: "Missing staging credentials", recommendation: "Ask the user" }, blocked.threadId);
      await call(state, "chief_roster", { todo: { text: "Follow up with the owner" } }, chief);
      const escalate = await call(state, "chief_escalate", { threadId: blocked.threadId, request: "Which staging account do we use?" }, chief);
      const roster = await call(state, "chief_roster", {}, chief);
      const spawned = await call(state, "chief_spawn", { title: "Side task", request: "Do the task", context: "Goal: done" }, chief);
      const spawnedId = /in thread (thr_\w+)/.exec(spawned)![1]!;
      const brief = await readFile(join(state.storageRoot, spawnedId, "brief.md"), "utf8");
      const configure = { codex: await configureFor(state, chief, "codex"), "claude-code": await configureFor(state, chief, "claude-code") };
      let linkedChild: Captured["linkedChild"];
      if (linked) {
        const coord = await coordinator(state);
        const child = (await spawnChild(state, coord)).id;
        linkedChild = { codex: await configureFor(state, child, "codex"), "claude-code": await configureFor(state, child, "claude-code") };
      }
      void minted;
      // Each build's temp storage root is the only run-specific text; the rest must match byte for byte.
      const stable = (text: string) => text.replaceAll(state.storageRoot, "<storage>");
      return { roster: stable(roster), spawn: { text: spawned, brief: stable(brief) }, escalate: stable(escalate), configure, linkedChild, ids: [chief, ready.threadId, blocked.threadId, spawnedId] };
    }
    const capture = async (module: { default: typeof plugin; MIGRATIONS: string[] }, sourceRoot: string, sha: string, linked: boolean): Promise<Captured> => ({
      meta: { sourceRoot, sha, cwd: process.cwd(), fixtureHash: createHash("sha256").update(fixture.toString()).digest("hex"), migrations: module.MIGRATIONS.length },
      migrations: module.MIGRATIONS,
      ...(await fixture(module.default, { sourceRoot, sha }, linked)),
    });

    let base: Captured;
    let head: Captured;
    beforeAll(async () => {
      baseAvailable = await git("cat-file", "-t", BASE_SHA).then((type) => type === "commit", () => false);
      if (!baseAvailable) return;
      const { sourceRoot, module: baseModule } = await loadBaseBuild(HEAD_ROOT, BASE_SHA);
      base = await capture(baseModule as any, sourceRoot, BASE_SHA, false);
      head = await capture({ default: plugin, MIGRATIONS }, HEAD_ROOT, await git("rev-parse", "HEAD"), true);
      console.info(`preservation-evidence ${JSON.stringify({ base: base.meta, head: head.meta, scope: "plain Chief is preserved against base 95aa7df (differential)", runnerRoot: process.cwd() })}`);
    }, 120_000);
    const requireBase = () => { if (!baseAvailable) throw new Error(`base commit ${BASE_SHA} is not in this clone: fetch it (git fetch origin ${BASE_SHA}) to run the preservation comparison`); };

    test("both builds ran the same fixture from their own source roots", () => {
      requireBase();
      expect(base.meta.sha).toBe(BASE_SHA);
      expect(base.meta.sourceRoot).not.toBe(head.meta.sourceRoot);
      expect(base.meta.fixtureHash).toBe(head.meta.fixtureHash);
      expect(head.meta.sha).toMatch(/^[0-9a-f]{40}$/);
    });

    test("MIGRATIONS: the base array is an unchanged prefix of head, followed by the two Coordinator ALTERs and the retest_skipped ALTER", () => {
      requireBase();
      expect(head.migrations.slice(0, base.migrations.length)).toEqual(base.migrations);
      // Append only: the observability waves add entries after these three.
      const added = head.migrations.slice(base.migrations.length, base.migrations.length + 3);
      expect(head.migrations.length).toBeGreaterThanOrEqual(base.migrations.length + 3);
      for (const statement of added.slice(0, 2)) expect(statement).toMatch(/^ALTER TABLE \w+ ADD COLUMN .*(coordinator)/is);
      expect(added[2]).toBe("ALTER TABLE managed_threads ADD COLUMN retest_skipped TEXT");
    });

    test("roster: a plain Chief's roster is byte-identical to base", () => {
      requireBase();
      expect(head.roster).toBe(base.roster);
      expect(base.roster).toContain("Blocked work");
      expect(base.roster).toContain("Follow up with the owner");
    });

    test("chief_spawn result and brief.md, and chief_escalate with a threadId, are byte-identical to base", () => {
      requireBase();
      expect(head.spawn).toEqual(base.spawn);
      expect(head.escalate).toBe(base.escalate);
    });

    test.each(["codex", "claude-code"] as const)("%s configure: a plain unlinked Chief = base plus exactly the authorized deltas", (provider) => {
      requireBase();
      const [was, now] = [base.configure[provider], structuredClone(head.configure[provider])];
      const returnedNames = head.configure[provider].tools.map((tool) => tool.name);
      // chief_coordinate sits right after chief_spawn and chief_attach (#213, exact definition) right after chief_coordinate; the coordinator skill is added; all asserted, then dropped.
      const names = now.tools.map((tool) => tool.name);
      expect(names[names.indexOf("chief_spawn") + 1]).toBe("chief_coordinate");
      expect(names[names.indexOf("chief_coordinate") + 1]).toBe("chief_attach");
      const attach = now.tools.find((tool) => tool.name === "chief_attach")!;
      expect({ description: attach.description, inputSchema: attach.inputSchema }).toEqual(ATTACH_DEFINITION);
      // Remove only the one checked chief_attach; a duplicate stays and fails the exact tools equality below.
      now.tools.splice(names.indexOf("chief_coordinate") + 1, 1);
      now.tools = now.tools.filter((tool) => tool.name !== "chief_coordinate");
      expect(now.skills).toEqual([...was.skills, "coordinator"]);
      now.skills = was.skills;
      // chief_spawn gains the optional projectId; chief_escalate's threadId becomes optional with one more sentence.
      const spawn = now.tools.find((tool) => tool.name === "chief_spawn")!;
      expect(spawn.inputSchema.properties.projectId.description).toBe("Coordinator only: the project the new Chief works in. Defaults to your own project.");
      expect(spawn.inputSchema.required ?? []).not.toContain("projectId");
      delete spawn.inputSchema.properties.projectId;
      const escalate = now.tools.find((tool) => tool.name === "chief_escalate")!;
      const oldEscalate = was.tools.find((tool) => tool.name === "chief_escalate")!;
      const SENTENCE = " Omit threadId only when no managed thread concerns the request yet.";
      expect(oldEscalate.inputSchema.required).toContain("threadId");
      expect(escalate.inputSchema.required).toEqual(oldEscalate.inputSchema.required!.filter((field) => field !== "threadId"));
      expect(escalate.description).toBe(oldEscalate.description + SENTENCE);
      escalate.inputSchema.required = oldEscalate.inputSchema.required;
      escalate.description = oldEscalate.description;
      // Plan 2 contract 6: the Spec Writer wording of chief_delegate, chief_complete and chief_skip_specs moved; asserted, then restored to base.
      for (const tool of now.tools) acceptSpecLaneWording(tool, was.tools.find((entry) => entry.name === tool.name), tool.name);
      // Retest debt: chief_review gains the optional retestSkipped field and a description sentence; asserted, then restored to base.
      for (const tool of now.tools) acceptReviewerToolDelta(tool, was.tools.find((entry) => entry.name === tool.name), tool.name);
      for (const tool of now.tools) acceptRetestDelta(tool, was.tools.find((entry) => entry.name === tool.name), tool.name);
      // #214: chief_delegate gains the optional evidenceOnly boolean; asserted, then removed.
      for (const tool of now.tools) acceptEvidenceOnlyDelta(tool, tool.name);
      // "Chief keeps tool search": chief_roster gains the optional includeOthers boolean and one description clause; asserted, then restored to base.
      for (const tool of now.tools) acceptRosterOthersDelta(tool, tool.name);
      expect(now.tools).toEqual(was.tools);
      // Instructions: only the claude-code preload line changes: `query "+chief", max_results N` becomes the exact select: list of every returned tool in the host's order; codex is byte-identical.
      now.instructions = acceptCoreRuleTrim(acceptPlanningLine(now.instructions, was.instructions), was.instructions);
      const preload = (config: Config) => config.instructions.split("\n").filter((line) => line.includes("ToolSearch"));
      if (provider === "codex") expect(preload(was)).toEqual([]);
      else expect(preload(was)).toHaveLength(1);
      expect(now.instructions).toBe(provider === "codex" ? was.instructions : swapPreload(was.instructions, returnedNames));
      expect(now.skills).toEqual(was.skills);
    });

    // The base text with its `query "+chief", max_results N` preload line swapped for the exact select: list of `returned` (an assertion that the line was the keyword form).
    const swapPreload = (text: string, returned: string[]) => text.split("\n").map((line) => {
      if (!line.includes("ToolSearch")) return line;
      expect(line).toMatch(PRELOAD_OLD_TAIL);
      return line.replace(PRELOAD_OLD_TAIL, chiefPreloadTail(returned));
    }).join("\n");

    test.each(["codex", "claude-code"] as const)("%s configure: a linked child = base plus exactly one Coordinator line (no chief_coordinate, no coordinator skill)", (provider) => {
      requireBase();
      const [was, child] = [base.configure[provider], head.linkedChild![provider]];
      expect(child.skills).toEqual(was.skills);
      expect(child.tools.map((tool) => tool.name)).toEqual(was.tools.map((tool) => tool.name));
      const lines = child.instructions.split("\n");
      const added = lines.filter((line) => /^Coordinator thr_\w+ supervises you: call chief_escalate before every Need you/.test(line));
      expect(added).toHaveLength(1);
      const expected = provider === "codex" ? was.instructions : swapPreload(was.instructions, child.tools.map((tool) => tool.name));
      expect(acceptCoreRuleTrim(acceptPlanningLine(lines.filter((line) => line !== added[0]).join("\n"), was.instructions), was.instructions).split("\n")).toEqual(expected.split("\n"));
    });
  });

  describe("configure (COORD-9)", () => {
    const configure = (state: S, id: string, provider: "codex" | "claude-code" = "codex") => {
      const context = configurationContext(id);
      return state.harness.behavior.resolveAgentConfiguration({ ...context, provider: { ...context.provider, id: provider } }) as Promise<{ tools: { name: string }[]; skills: string[]; instructions: string }>;
    };
    const MARKER = "# Project rules marker";
    // Chief's own budget for the core rules (keeps the rules small), not the SDK cut. The exact select: preload line (about 600 characters for a plain Chief) moved it from 4096/4000.
    const CHIEF_BUDGET = 5_000;
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
        expect(instructions).toContain("Call chief_roster at the start of every turn: its Children block is your work list.");
        expect(instructions).not.toContain("# Chief core rules");
        expect(instructions).not.toContain("# Chief operating rules");
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

    test.each(["codex", "claude-code"] as const)("%s: a linked child is a plain Chief minus chief_coordinate and chief_attach, plus exactly one escalate line", async (provider) => {
      const state = await setup({ rules: `${MARKER}\n- Keep rules small.` });
      const plain = await make(state);
      const coord = await coordinator(state);
      const child = (await spawnChild(state, coord)).id;
      const [plainConfig, childConfig] = [await configure(state, plain, provider), await configure(state, child, provider)];
      expect(plainConfig.instructions.length).toBeLessThan(CHIEF_BUDGET);
      expect(plainConfig.skills).toEqual(["chief", "coordinator"]);
      expect(childConfig.skills).toEqual(["chief"]);
      expect(childConfig.tools.map((tool) => tool.name)).toEqual(plainConfig.tools.map((tool) => tool.name).filter((name) => name !== "chief_coordinate" && name !== "chief_attach"));
      const lines = childConfig.instructions.split("\n");
      const added = lines.filter((line) => line.startsWith("Coordinator "));
      expect(added).toEqual([`Coordinator ${coord} supervises you: call chief_escalate before every Need you, without threadId when no managed thread concerns it yet.`]);
      // The plain Chief's text, except that its preload line asks for the child's tools only (the plain line's two extra names, chief_coordinate and chief_attach, are gone).
      const names = (config: typeof plainConfig) => config.tools.map((tool) => tool.name);
      const expected = plainConfig.instructions.split("\n").map((line) => line.includes("ToolSearch") ? line.replace(/select:\S+$/, chiefPreloadTail(names(childConfig))) : line);
      expect(lines.filter((line) => !line.startsWith("Coordinator "))).toEqual(expected);
      const preloadOf = (config: typeof plainConfig) => config.instructions.split("\n").filter((line) => line.includes("ToolSearch"));
      if (provider === "claude-code") {
        expect(preloadOf(plainConfig)).toHaveLength(1);
        expect(preloadOf(plainConfig)[0]!.endsWith(chiefPreloadTail(names(plainConfig)))).toBe(true);
        expect(preloadOf(childConfig)[0]!.endsWith(chiefPreloadTail(names(childConfig)))).toBe(true);
        expect(preloadOf(childConfig)[0]).not.toContain("chief_coordinate");
        expect(preloadOf(childConfig)[0]).not.toContain("chief_attach");
      } else expect(preloadOf(childConfig)).toEqual([]);
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

    test("the coordinator skill declares the name the plain Chief's configure lists", async () => {
      const skill = await readFile(join(dirname(fileURLToPath(import.meta.url)), "skills", "coordinator", "SKILL.md"), "utf8");
      expect(skill.startsWith("---\nname: coordinator\n")).toBe(true);
    });
  });
});
