import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createReportIntake, type ReportIntakeAdapters } from "./src/report/reportIntake";
import { createReviewLedger } from "./src/review/reviewLedger";
import { MIGRATIONS } from "./src/db/migrations";
import type { ManagedRow, ReportParams } from "./src/types";
import { createThreadStore, type ThreadInsert } from "./src/db/threadStore";

// Contract (docs/specs/report-intake.md, Target): createReportIntake(adapters).report is the one owner of chief_report
// acceptance and publication. Required state commits in one store.batch before any optional step (Next line, recorded
// commands, verdict file, stamp, report file), the guarded attach always runs once, and a refusal writes nothing.
// The real thread store and review ledger run on SQLite with the plugin's real migrations. The other adapters are
// recording fakes; the forge comment content and the alert outbox belong to server.ts, so their fakes write a row
// into a scratch table / alert_outbox only so that "committed" can be read back.

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
});

let hostCount = 0;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const never = () => new Promise<never>(() => {});

function world(over: Partial<ReportIntakeAdapters> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: `intake-${++hostCount}` });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  db.prepare(`CREATE TABLE fake_comments (reviewer_thread_id TEXT, seq INTEGER, verdict TEXT)`).run();
  const store = createThreadStore<ManagedRow>(db, { onReload() {} });
  const realLedger = createReviewLedger<ManagedRow>(db, store.get, store, { busy: () => false });

  const log: string[] = [];
  const writes: { name: string; content: string }[] = [];
  const attached: unknown[][] = [];
  const delivered: { key: string; message: string }[] = [];
  const warned: string[] = [];
  const tracked: { thread: string; files: { name: string; content: string }[]; logBefore: string[] }[] = [];
  const planLog: unknown[] = [];
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const rowOf = (id: string) => db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(id) as Record<string, unknown>;
  /** What is readable at this moment: the report counter and the required rows. */
  const committed = (id: string) => `seq=${rowOf(id)?.report_seq} lessons=${count("chief_lessons")} verdicts=${count("reviewer_verdicts")} comments=${count("fake_comments")} pending=${count("alert_outbox")}`;
  const stores = () => ({
    managed: db.prepare(`SELECT * FROM managed_threads ORDER BY thread_id`).all(),
    lessons: db.prepare(`SELECT * FROM chief_lessons`).all(),
    verdicts: db.prepare(`SELECT * FROM reviewer_verdicts`).all(),
    alerts: db.prepare(`SELECT * FROM alert_outbox`).all(),
    comments: db.prepare(`SELECT * FROM fake_comments`).all(),
    planLog: [...planLog],
  });

  const pendingRows = new Map<string, ThreadInsert<ManagedRow["role"], ManagedRow["state"]>>();
  const adapters: ReportIntakeAdapters = {
    db,
    store: {
      ...store,
      batch: (fn) => { log.push("batch:start"); const result = store.batch(fn); log.push("batch:end"); return result; },
      reserveReport: (report) => { log.push(`reserveReport lessons=${count("chief_lessons")}`); return store.reserveReport(report); },
      attachReportFiles: (...args) => { log.push("attachReportFiles"); attached.push(args); store.attachReportFiles(...args); },
    },
    ledger: {
      ...realLedger,
      recordVerdict: (row, verdict, seq, now) => { log.push(`recordVerdict lessons=${count("chief_lessons")} verdicts=${count("reviewer_verdicts")}`); realLedger.recordVerdict(row, verdict, seq, now); },
    },
    lookupRow: async (id) => { log.push("lookupRow"); const row = store.get(id); return row ? { row } : { pending: pendingRows.get(id) }; },
    writePlan: async (_id, _project, _plan, mirrorFor) => { log.push(mirrorFor ? "writePlan(mirror)" : "writePlan"); return [{ path: "/plans/plan-1.md" }, { path: "/plans/plan-2.md" }]; },
    writeArtifact: async (id, _project, name, content) => { log.push(`writeArtifact ${name} [${committed(id)}]`); writes.push({ name, content }); return `/storage/${id}/${name}`; },
    writeAlert: (row, key, message) => {
      log.push(`writeAlert ${key}`);
      db.prepare(`INSERT INTO alert_outbox (dedupe_key, target_thread_id, source_thread_id, message, created_at) VALUES (?, ?, ?, ?, ?)`).run(`${row.thread_id}:${key}`, row.chief_thread_id, row.thread_id, message, 1);
    },
    alertChief: async (_row, key, message) => { log.push("alertChief"); delivered.push({ key, message }); return true; },
    enqueueVerdictComments: (row, seq, verdict) => {
      log.push(`enqueueVerdictComments lessons=${count("chief_lessons")} verdicts=${count("reviewer_verdicts")}`);
      db.prepare(`INSERT INTO fake_comments VALUES (?, ?, ?)`).run(row.thread_id, seq, verdict);
    },
    enqueueBlockedComment: () => { log.push("enqueueBlockedComment"); },
    appendPlanLog: (_row, entries) => { log.push("appendPlanLog"); planLog.push(...entries); },
    actionLine: () => { log.push("actionLine"); return "Next: continue."; },
    recordedCommands: async () => { log.push("recordedCommands"); return []; },
    reportStamp: async () => { log.push("reportStamp"); return "Read at abc1234"; },
    trackFiles: (row, files) => { tracked.push({ thread: row.thread_id, files, logBefore: [...log] }); },
    warn: (message) => { warned.push(message); },
    ...over,
  };
  const intake = createReportIntake(adapters);

  let clock = 0;
  const seed = (threadId: string, role: ManagedRow["role"], over: Partial<ThreadInsert<ManagedRow["role"], ManagedRow["state"]>> = {}, columns: Record<string, unknown> = {}) => {
    store.insert({ threadId, role, projectId: "proj", chiefThreadId: "chief1", title: threadId, state: "active", ...over });
    db.prepare(`UPDATE managed_threads SET created_at=? WHERE thread_id=?`).run(++clock, threadId);
    for (const [column, value] of Object.entries(columns)) db.prepare(`UPDATE managed_threads SET ${column}=? WHERE thread_id=?`).run(value, threadId);
    store.reload?.();
  };
  /** A reviewer r1 for worker w1, with one review target. */
  const seedReviewer = () => {
    seed("w1", "worker");
    seed("r1", "reviewer", { workerThreadId: "w1" });
    db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha) VALUES ('r1', 'w1', 1, 'abc')`).run();
  };
  return { db, store, intake, log, writes, attached, delivered, warned, tracked, planLog, count, rowOf, stores, seed, seedReviewer, pendingRows };
}

const finding = { file: "a.ts", line: 3, severity: "blocking", message: "wrong" } as const;
const REQUEST_CHANGES: ReportParams = { state: "ready", verdict: "request_changes", result: "Blocking problem in a.ts.", findings: [finding], lesson: "Check the lease before release." };
const APPROVE: ReportParams = { state: "ready", verdict: "approve", result: "Ships.", findings: [] };

describe("owner order: required state commits before any optional step", () => {
  test("a reviewer request_changes report with a lesson runs lookup, one batch, then the optional steps in order", async () => {
    const w = world();
    w.seedReviewer();

    const received = await w.intake.report("r1", REQUEST_CHANGES, "proj");

    expect(received).toBe(true);
    // Each write adapter logs what is already readable when it runs: the lesson follows reserveReport and precedes the ledger.
    expect(w.log).toEqual([
      "lookupRow",
      "batch:start",
      "reserveReport lessons=0",
      "recordVerdict lessons=1 verdicts=0",
      "enqueueVerdictComments lessons=1 verdicts=1",
      "writeAlert report:1:pending-1",
      "batch:end",
      "actionLine",
      "writeArtifact verdict-1.md [seq=1 lessons=1 verdicts=1 comments=1 pending=1]",
      "attachReportFiles",
      "alertChief",
    ]);
    expect(w.db.prepare(`SELECT project_id, text, source_thread_id, worker_thread_id, role FROM chief_lessons`).all())
      .toEqual([{ project_id: "proj", text: "Check the lease before release.", source_thread_id: "r1", worker_thread_id: "w1", role: "reviewer" }]);
    expect(w.rowOf("r1")).toMatchObject({ report_seq: 1, verdict: "request_changes", reject_streak: 1, verdict_path: "/storage/r1/verdict-1.md", report_path: null });
    expect(w.attached).toEqual([["r1", 1, 0, "/storage/r1/verdict-1.md", null]]);
    expect(w.delivered).toHaveLength(1);
    expect(w.delivered[0]!.key).toMatch(/^report:1:[0-9a-f]{16}$/);
  });

  test("a failed verdict write never removes the committed rows; attach runs once without a path and the alert says so", async () => {
    const w = world({ writeArtifact: async () => { throw new Error("disk full"); } });
    w.seedReviewer();

    await expect(w.intake.report("r1", REQUEST_CHANGES, "proj")).resolves.toBe(true);

    expect(w.rowOf("r1")).toMatchObject({ report_seq: 1, state: "ready", verdict: "request_changes", reject_streak: 1, verdict_path: null });
    expect(w.count("chief_lessons")).toBe(1);
    expect(w.count("reviewer_verdicts")).toBe(1);
    expect(w.count("fake_comments")).toBe(1);
    expect(w.db.prepare(`SELECT dedupe_key FROM alert_outbox`).all()).toEqual([{ dedupe_key: "r1:report:1:pending-1" }]);
    expect(w.attached).toEqual([["r1", 1, 0, null, null]]);
    expect(w.delivered[0]!.message).toContain("Full report: could not write verdict-1.md (see the plugin log)");
    expect(w.warned).toEqual(["Could not write r1's verdict file: Error: disk full"]);
  });

  test.each([
    {
      name: "the verdict file",
      seed: (w: ReturnType<typeof world>) => w.seedReviewer(),
      thread: "r1",
      params: REQUEST_CHANGES,
      over: { writeArtifact: never },
      rows: { lessons: 1, verdicts: 1, comments: 1 },
    },
    {
      name: "the recorded commands",
      seed: (w: ReturnType<typeof world>) => w.seed("w1", "worker"),
      thread: "w1",
      params: { state: "ready", result: "Done." } as ReportParams,
      over: { recordedCommands: never },
      rows: { lessons: 0, verdicts: 0, comments: 0 },
    },
    {
      name: "the checkout stamp",
      seed: (w: ReturnType<typeof world>) => w.seed("s1", "researcher"),
      thread: "s1",
      params: { state: "ready", result: "Found it." } as ReportParams,
      over: { reportStamp: never },
      rows: { lessons: 0, verdicts: 0, comments: 0 },
    },
    {
      name: "the report file",
      seed: (w: ReturnType<typeof world>) => w.seed("w1", "worker"),
      thread: "w1",
      params: { state: "ready", result: "x".repeat(900) } as ReportParams,
      over: { writeArtifact: never },
      rows: { lessons: 0, verdicts: 0, comments: 0 },
    },
  ])("while $name never settles, the report columns, rows and pending alert are already committed", async ({ seed, thread, params, over, rows }) => {
    const w = world(over);
    seed(w);
    const settled = vi.fn();

    void w.intake.report(thread, params, "proj").then(settled, settled);
    await flush();

    expect(settled).not.toHaveBeenCalled();
    expect(w.rowOf(thread)).toMatchObject({ report_seq: 1, state: "ready", last_report_state: "ready" });
    expect(w.count("chief_lessons")).toBe(rows.lessons);
    expect(w.count("reviewer_verdicts")).toBe(rows.verdicts);
    expect(w.count("fake_comments")).toBe(rows.comments);
    expect(w.db.prepare(`SELECT dedupe_key FROM alert_outbox`).all()).toEqual([{ dedupe_key: `${thread}:report:1:pending-1` }]);
    // Nothing optional has finished: no attach and no delivery yet.
    expect(w.attached).toEqual([]);
    expect(w.delivered).toEqual([]);
    expect(w.log.indexOf("batch:end")).toBeGreaterThan(-1);
  });

  test("one transaction: a throw in a forge comment write rolls back the report, lesson, verdict rows and pending alert", async () => {
    const w = world({ enqueueVerdictComments: () => { throw new Error("comment write failed"); } });
    w.seedReviewer();
    const before = w.stores();

    await expect(w.intake.report("r1", REQUEST_CHANGES, "proj")).rejects.toThrow("comment write failed");

    expect(w.stores()).toEqual(before);
    expect(w.log).not.toContain("actionLine");
    expect(w.attached).toEqual([]);
    expect(w.delivered).toEqual([]);
  });
});

describe("await order by role", () => {
  test("a worker's long ready report: batch, Next line, recorded commands, report file, attach with seq and rev, delivery", async () => {
    const w = world();
    w.seed("w1", "worker", {}, { result_rev: 2 });

    await w.intake.report("w1", { state: "ready", result: "x".repeat(900) }, "proj");

    expect(w.log).toEqual([
      "lookupRow",
      "batch:start",
      "reserveReport lessons=0",
      "recordVerdict lessons=0 verdicts=0",
      "writeAlert report:1:pending-1",
      "batch:end",
      "actionLine",
      "recordedCommands",
      "writeArtifact report-1.md [seq=1 lessons=0 verdicts=0 comments=0 pending=1]",
      "attachReportFiles",
      "alertChief",
    ]);
    expect(w.attached).toEqual([["w1", 1, 2, null, "/storage/w1/report-1.md"]]);
    expect(w.delivered[0]!.message).toContain("Full report: /storage/w1/report-1.md");
  });

  test("a short report writes no file but the guarded attach still runs once, and the failed report file is named in the alert", async () => {
    const short = world();
    short.seed("w1", "worker");
    await short.intake.report("w1", { state: "ready", result: "Done." }, "proj");
    expect(short.writes).toEqual([]);
    expect(short.attached).toEqual([["w1", 1, 0, null, null]]);

    const failing = world({ writeArtifact: async () => { throw new Error("nope"); } });
    failing.seed("w1", "worker");
    await failing.intake.report("w1", { state: "ready", result: "x".repeat(900) }, "proj");
    expect(failing.attached).toEqual([["w1", 1, 0, null, null]]);
    expect(failing.delivered[0]!.message).toContain("Full report: could not write report-1.md (see the plugin log)");
    expect(failing.warned).toEqual(["Could not write w1's report file: Error: nope"]);
    expect(failing.rowOf("w1")).toMatchObject({ report_seq: 1, state: "ready" });
  });

  test("a reviewer verdict never writes report-<seq>.md, even when its result is long; the alert points at the verdict file", async () => {
    const w = world();
    w.seedReviewer();

    await w.intake.report("r1", { ...APPROVE, result: "y".repeat(1200) }, "proj");

    expect(w.writes.map((file) => file.name)).toEqual(["verdict-1.md"]);
    expect(w.delivered[0]!.message).toContain("Full report: /storage/r1/verdict-1.md");
    expect(w.attached).toEqual([["r1", 1, 0, "/storage/r1/verdict-1.md", null]]);
  });

  test("a planner's plan write failure refuses the report after the pending row insert and before the batch", async () => {
    const w = world({ writePlan: async () => { throw new Error("plan disk full"); } });
    w.pendingRows.set("p1", { threadId: "p1", role: "planner", projectId: "proj", chiefThreadId: "chief1", title: "p1", state: "active" });

    await expect(w.intake.report("p1", { state: "ready", plan: PLAN, result: "Planned." }, "proj")).rejects.toThrow("plan disk full");

    expect(w.rowOf("p1")).toMatchObject({ report_seq: 0 });
    expect(w.log).toEqual(["lookupRow"]);
    expect(w.count("alert_outbox")).toBe(0);
  });

  test("a planner's Chief mirror runs before the batch and its failure only warns; the stamp is read after the commit", async () => {
    let mirrors = 0;
    const w = world({
      writePlan: async (_id, _project, _plan, mirrorFor) => {
        if (mirrorFor) { mirrors += 1; throw new Error("no chief storage"); }
        return [{ path: "/plans/plan-1.md" }, { path: "/plans/plan-2.md" }];
      },
    });
    w.seed("p1", "planner");

    await w.intake.report("p1", { state: "ready", plan: PLAN, result: "Planned." }, "proj");

    expect(mirrors).toBe(1);
    expect(w.warned).toEqual(["Could not mirror p1's plan into Chief's storage: Error: no chief storage"]);
    expect(w.rowOf("p1")).toMatchObject({ report_seq: 1, state: "ready" });
    expect(JSON.parse(w.rowOf("p1").plan_waves as string)).toHaveLength(2);
    expect(w.log.indexOf("batch:start")).toBeLessThan(w.log.indexOf("reportStamp"));
    expect(w.log.slice(-4)).toEqual(["actionLine", "reportStamp", "attachReportFiles", "alertChief"]);
    expect(w.log.filter((entry) => entry === "recordedCommands")).toEqual([]);
  });
});

const PLAN = [
  { body: "# Plan\n\n## Contracts to verify\n- Totals stay non-negative\n\n## What we're NOT doing\n- x" },
  { body: "# Tests\n\n## Contracts to verify\n- Totals tested", test: true },
];

// Contract (plan 3, contract 11): an accepted planner report hands its plan files, and a reviewer verdict its verdict file, to the
// tracker after the commit and before the alert. A report with no files hands over nothing.
// Regression: files tracked before the commit (a refused report would leak), after the alert, with the wrong name or content, or for a file-less report.
describe("files handed to the tracker", () => {
  test("a planner's plan files go over with their names and bodies, after the commit and before the alert", async () => {
    const w = world();
    w.seed("p1", "planner");
    await w.intake.report("p1", { state: "ready", plan: PLAN, result: "Planned." }, "proj");
    expect(w.tracked.map(({ thread, files }) => [thread, files])).toEqual([["p1", [
      { name: "plan-1.md", content: `${PLAN[0]!.body}\n` },
      { name: "plan-2.md", content: `${PLAN[1]!.body}\n` },
    ]]]);
    expect(w.tracked[0]!.logBefore.at(-1)).toBe("attachReportFiles");
    expect(w.log.at(-1)).toBe("alertChief");
  });

  test("a reviewer's verdict file goes over with the very content that was written", async () => {
    const w = world();
    w.seedReviewer();
    await w.intake.report("r1", REQUEST_CHANGES, "proj");
    expect(w.tracked).toEqual([{ thread: "r1", files: [{ name: "verdict-1.md", content: w.writes[0]!.content }], logBefore: expect.any(Array) }]);
    expect(w.tracked[0]!.logBefore.at(-1)).toBe("attachReportFiles");
  });

  test("a verdict whose file could not be written, a worker report and a refused report hand over nothing", async () => {
    const failing = world({ writeArtifact: async () => { throw new Error("disk full"); } });
    failing.seedReviewer();
    await failing.intake.report("r1", APPROVE, "proj");
    const plain = world();
    plain.seed("w1", "worker");
    await plain.intake.report("w1", { state: "ready", result: "Done" }, "proj");
    const refused = world();
    refused.seedReviewer();
    await expect(refused.intake.report("r1", { ...APPROVE, findings: [finding] }, "proj")).rejects.toThrow();
    expect([failing.tracked, plain.tracked, refused.tracked]).toEqual([[], [], []]);
  });
});

describe("a refusal writes nothing", () => {
  test.each([
    { name: "approve with a blocking finding", role: "reviewer", params: { ...APPROVE, findings: [finding] }, message: 'verdict is approve but findings has 1 "blocking" entry' },
    { name: "a reviewer ready report without findings", role: "reviewer", params: { state: "ready", verdict: "approve", result: "ok" }, message: "findings is missing; send [] when there are none." },
    { name: "findings on a worker", role: "worker", params: { state: "ready", result: "ok", findings: [] }, message: "findings is only for a reviewer's ready report (role is worker); remove it." },
    { name: "a lesson on a worker", role: "worker", params: { state: "ready", result: "ok", lesson: "rule" }, message: "lesson is only for an advisor or reviewer's ready report (role is worker); remove it." },
    { name: "a lesson on a non-ready reviewer report", role: "reviewer", params: { state: "active", lesson: "rule" }, message: 'lesson is only allowed when state is ready (state is "active"); remove it.' },
    { name: "approve with a blocking finding and a lesson", role: "reviewer", params: { ...APPROVE, findings: [finding], lesson: "Never recorded." }, message: 'verdict is approve but findings has 1 "blocking" entry' },
    { name: "a lesson on a blocked reviewer report", role: "reviewer", params: { state: "blocked", result: "Stuck", blocker: "No access", recommendation: "Grant it", lesson: "Never recorded." }, message: 'lesson is only allowed when state is ready (state is "blocked"); remove it.' },
  ] as const)("validation: $name", async ({ role, params, message }) => {
    const w = world();
    w.seedReviewer();
    w.seed("w2", "worker");
    const before = w.stores();

    await expect(w.intake.report(role === "reviewer" ? "r1" : "w2", params as ReportParams, "proj")).rejects.toThrow(`chief_report was not saved; fix all of these and call it once more:\n- ${message}`);

    expect(w.stores()).toEqual(before);
    expect(w.log).toEqual(["lookupRow"]);
  });

  test.each([
    { name: "a complete row", state: "complete", message: "Managed thread r1 is complete and can no longer report." },
    { name: "an archived row", state: "archived", message: "Managed thread r1 is archived and can no longer report." },
    { name: "a deleted row", state: "deleted", message: "Managed thread r1 is deleted and can no longer report." },
  ] as const)("eligibility: $name", async ({ state, message }) => {
    const w = world();
    w.seedReviewer();
    w.db.prepare(`UPDATE managed_threads SET state=? WHERE thread_id='r1'`).run(state);
    w.store.reload?.();
    const before = w.stores();

    await expect(w.intake.report("r1", APPROVE, "proj")).rejects.toThrow(message);

    expect(w.stores()).toEqual(before);
    expect(w.log).toEqual(["lookupRow"]);
  });

  test("eligibility: a chief row, and a thread with no row and no spawn metadata", async () => {
    const w = world();
    w.seed("c1", "chief");
    const before = w.stores();
    const message = "chief_report is available only in managed worker, planner, reviewer, and advisor threads.";

    await expect(w.intake.report("c1", { state: "ready", result: "x" }, "proj")).rejects.toThrow(message);
    await expect(w.intake.report("ghost", { state: "ready", result: "x" }, "proj")).rejects.toThrow(message);

    expect(w.stores()).toEqual(before);
  });

  test("a pending row from spawn metadata is inserted only once the report validates", async () => {
    const w = world();
    w.pendingRows.set("w9", { threadId: "w9", role: "worker", projectId: "proj", chiefThreadId: "chief1", title: "w9", state: "active" });

    const before = w.stores();

    await expect(w.intake.report("w9", { state: "ready" }, "proj")).rejects.toThrow("result is empty; a ready report needs a non-empty result.");
    expect(w.stores()).toEqual(before);
    expect(w.rowOf("w9")).toBeUndefined();
    expect(w.log).toEqual(["lookupRow"]);

    await w.intake.report("w9", { state: "ready", result: "Done." }, "proj");
    expect(w.rowOf("w9")).toMatchObject({ report_seq: 1, state: "ready" });
  });

  // Contract (docs/specs/tracker.md, Unit of work + docs/specs/report-intake.md, Target): a recovery candidate has no pull request or
  // branch, so it only becomes a row when none exists once the report validates. A launch row that landed while the lookup awaited
  // (its PR and branch are the unit's join keys) is kept as it is. The no-row case is the control: recovery still inserts.
  // Regression: an unconditional insert of the stale candidate, which upserts the keys to null and drops the thread out of its unit.
  test.each([
    { launched: false, row: { title: "w9", pr_url: null, branch: null } },
    { launched: true, row: { title: "Launched", pr_url: "https://github.com/acme/shop/pull/1", branch: "feat/x" } },
  ])("a recovery candidate that returns after the launch row landed (launched: $launched) leaves $row", async ({ launched, row }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const w = world({ lookupRow: async (id) => { await gate; return { pending: w.pendingRows.get(id) }; } });
    w.pendingRows.set("w9", { threadId: "w9", role: "worker", projectId: "proj", chiefThreadId: "chief1", title: "w9", state: "active" });

    const report = w.intake.report("w9", { state: "ready", result: "Done." }, "proj");
    if (launched) w.store.insert({ threadId: "w9", role: "worker", projectId: "proj", chiefThreadId: "chief1", title: "Launched", state: "active", prUrl: row.pr_url, branch: row.branch });
    release();

    expect(await report).toBe(true);
    expect(w.rowOf("w9")).toMatchObject({ ...row, report_seq: 1, state: "ready" });
  });
});

describe("reviewer findings at the owner", () => {
  const padded = [
    { file: "  a.ts  ", line: 3, severity: "blocking", message: "  wrong  ", fix: "  do it  " },
    { file: "b.ts", severity: "nit", message: "naming" },
  ] as const;

  test("a JSON-string findings and the same array store the same findings JSON and write the same verdict file, trimmed", async () => {
    const run = async (findings: ReportParams["findings"]) => {
      const w = world();
      w.seedReviewer();
      await w.intake.report("r1", { ...REQUEST_CHANGES, findings }, "proj");
      return { stored: w.rowOf("r1").findings, file: w.writes[0]!.content };
    };

    const fromArray = await run([...padded]);
    const fromString = await run(JSON.stringify(padded));

    expect(fromString).toEqual(fromArray);
    expect(JSON.parse(fromArray.stored as string)).toEqual([
      { file: "a.ts", line: 3, severity: "blocking", message: "wrong", fix: "do it" },
      { file: "b.ts", severity: "nit", message: "naming" },
    ]);
    expect(fromArray.file).toContain("- a.ts:3 — wrong (fix: do it)");
  });

  test.each([
    { count: 40, accepted: true },
    { count: 41, accepted: false },
  ])("$count findings: accepted is $accepted", async ({ count, accepted }) => {
    const w = world();
    w.seedReviewer();
    const before = w.stores();
    const findings = Array.from({ length: count }, (_, index) => ({ file: `f${index}.ts`, severity: index ? "nit" as const : "blocking" as const, message: "m" }));

    const report = w.intake.report("r1", { ...REQUEST_CHANGES, findings }, "proj");

    if (accepted) {
      await report;
      expect(JSON.parse(w.rowOf("r1").findings as string)).toHaveLength(40);
    } else {
      await expect(report).rejects.toThrow("findings has 41 entries; max 40.");
      expect(w.stores()).toEqual(before);
    }
  });
});

describe("in-batch writes by role", () => {
  test("an advisor's lesson is tagged advisor, and its first advice resolves its plan's review", async () => {
    const w = world();
    w.seed("p1", "planner", {}, { plan_review: "required" });
    w.seed("a1", "advisor", { workerThreadId: "w1", planThreadId: "p1" });

    await w.intake.report("a1", { state: "ready", verdict: "approve", result: "Sound.", lesson: "Plan each wave's tests." }, "proj");

    expect(w.db.prepare(`SELECT role, source_thread_id FROM chief_lessons`).all()).toEqual([{ role: "advisor", source_thread_id: "a1" }]);
    expect(w.rowOf("p1").plan_review).toBe("approved");
    expect(w.rowOf("a1").advised_at).not.toBeNull();
  });

  test("an advisor's request_changes resolves the plan review to changes; its blocked report writes no lesson", async () => {
    const w = world();
    w.seed("p1", "planner", {}, { plan_review: "required" });
    w.seed("a1", "advisor", { planThreadId: "p1" });

    await w.intake.report("a1", { state: "blocked", blocker: "Cannot read.", recommendation: "Retry." }, "proj");

    expect(w.rowOf("p1").plan_review).toBe("changes");
    expect(w.count("chief_lessons")).toBe(0);
  });

  test("a plan worker's fails merge keeps the newest 12 and move a repeated entry to the newest end; the plan log is the last write of the batch", async () => {
    const w = world();
    w.seed("w1", "worker", { planThreadId: "pl1" });
    const stored = Array.from({ length: 11 }, (_, index) => ({ text: `old${index + 1}`, scope: "s", basis: "b", at: index + 1 }));
    w.db.prepare(`UPDATE managed_threads SET fails=? WHERE thread_id='w1'`).run(JSON.stringify(stored));
    w.store.reload?.();
    const fresh = ["old3", "n1", "n2", "n3", "n4"].map((text) => ({ text, scope: "s", basis: "b" }));

    await w.intake.report("w1", { state: "ready", result: "## Deviations from plan\n\nNone", fails: fresh }, "proj");

    const merged = JSON.parse(w.rowOf("w1").fails as string) as { text: string }[];
    expect(merged.map((entry) => entry.text)).toEqual(["old5", "old6", "old7", "old8", "old9", "old10", "old11", "old3", "n1", "n2", "n3", "n4"]);
    expect(w.planLog).toEqual(fresh.map((entry) => ({ ...entry, kind: "FAIL" })));
    const batch = w.log.slice(w.log.indexOf("batch:start"), w.log.indexOf("batch:end"));
    expect(batch.at(-1)).toBe("appendPlanLog");
    expect(batch.indexOf("writeAlert report:1:pending-1")).toBeLessThan(batch.indexOf("appendPlanLog"));
  });
});
