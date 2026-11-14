import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { disposeAll, execFileMock, setup } from "./test/harness";
import { blockedReport, completedPlan, dueNow, ev, retroRow, userSays, workflowStubs } from "./test/retroFixture";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (docs/specs/observability.md, "Retro grader", "Rubrics and scoring", "Communication rubric", "Lesson lifecycle"):
// the state machine claims once, retries, fails after 3 attempts, collects idempotently and validates the judge's answer against the bundle.
const PASS: [string, string][] = [["efficiency", "highly_efficient"], ["procedure-compliance", "fully_compliant"], ["verbosity", "proportionate"]];
const FAIL: [string, string][] = [["efficiency", "mostly_efficient"], ["procedure-compliance", "fully_compliant"], ["verbosity", "verbose"]];
const thread = (threadId: string, labels = PASS, lesson: unknown = null) => ({ threadId, scores: labels.map(([scorer, label]) => ({ scorer, label, reason: `why ${label}`, evidence: [] })), lesson });
const NO_SIGNALS = { briefGapBlock: null, askedTwice: null, unclearBriefRounds: null, userWordsLost: null };
const handoff = (threadId: string, label = "clear", over: Record<string, unknown> = {}) => ({ threadId, label, reason: `handoff ${label}`, signals: NO_SIGNALS, evidence: [], ...over });
const answer = (ids: { planner: string; worker: string }, over: { worker?: unknown; handoffs?: unknown[] } = {}) => ({
  threads: [thread(ids.planner), over.worker ?? thread(ids.worker)],
  communication: { handoffs: over.handoffs ?? [handoff(ids.planner), handoff(ids.worker)], lessons: [] },
  lost: 0,
});
const lessonOf = (evidence: string[]) => ({ surface: "worker-brief", rule: "State the verify command in every brief.", missingOrWrong: "The brief had no verify command.", prevents: "A skipped verify run.", recurrence: "recurs", existingInstruction: null, evidence });
const scoresOf = (state: Awaited<ReturnType<typeof setup>>) => state.db.prepare(`SELECT thread_id, scorer, label, score, reason FROM chief_scores ORDER BY thread_id, scorer`).all() as any[];
const lessons = (state: Awaited<ReturnType<typeof setup>>) => state.db.prepare(`SELECT status, surface, plan_thread_id, text FROM chief_lessons WHERE plan_thread_id IS NOT NULL`).all() as any[];
const retroAlerts = (state: Awaited<ReturnType<typeof setup>>) => state.db.prepare(`SELECT message FROM alert_outbox WHERE dedupe_key LIKE '%:retro:%'`).all() as any[];
const failedAlerts = (state: Awaited<ReturnType<typeof setup>>) => state.db.prepare(`SELECT message FROM alert_outbox WHERE dedupe_key LIKE '%retro-failed:%'`).all() as any[];

/** A finished plan whose judge run succeeds with `result`: launches on the first tick, collects on the second. */
async function judged(result: (ids: { planner: string; worker: string }) => unknown, options: Parameters<typeof completedPlan>[1] = {}, setupOptions: Parameters<typeof setup>[0] = {}) {
  const state = await setup(setupOptions);
  const stubs = workflowStubs();
  const fixture = await completedPlan(state, options);
  stubs.status.mockImplementation(async () => ({ status: "succeeded", result: result(fixture) }));
  return { state, stubs, ...fixture };
}

describe("retro eligibility", () => {
  test("a completed plan with a completed worker is claimed once and launches one judge run for each thread plus the handoffs", async () => {
    const { state, stubs, planner, tick } = await judged(() => null);
    await tick();
    expect(retroRow(state, planner)).toMatchObject({ state: "running", run_id: "wfr_1", attempts: 1 });
    expect(stubs.run).toHaveBeenCalledTimes(1);
    const argv = stubs.run.mock.calls[0]![0];
    const args = JSON.parse(argv[argv.indexOf("--args") + 1]!);
    expect(args.jobs.map((job: { kind: string }) => job.kind)).toEqual(["thread", "thread", "communication"]);
    expect(args.cap).toBe(9);
  });

  test.each([
    ["retroJudge is off", async (state: Awaited<ReturnType<typeof setup>>) => { await state.harness.behavior.setSettings({ retroJudge: false }); }, undefined],
    ["the plan finished before retros_since", async (state: Awaited<ReturnType<typeof setup>>) => { state.db.prepare(`UPDATE plugin_meta SET value=? WHERE key='retros_since'`).run(String(Date.now() + 3_600_000)); }, undefined],
    ["no worker of the plan completed", undefined, (state: Awaited<ReturnType<typeof setup>>, ids: { worker: string }) => { state.db.prepare(`UPDATE managed_threads SET state='blocked' WHERE thread_id=?`).run(ids.worker); }],
    ["a revised planner superseded it", undefined, async (state: Awaited<ReturnType<typeof setup>>, ids: { chief: string; planner: string }) => {
      const { plan } = await import("./test/testerHelpers");
      const revision = await plan(state, ids.chief);
      state.db.prepare(`UPDATE managed_threads SET replaces_thread_id=? WHERE thread_id=?`).run(ids.planner, revision.threadId);
    }],
  ])("%s: no retro row and no judge run", async (_name, afterwards, before) => {
    const state = await setup();
    const stubs = workflowStubs();
    const { tick } = await completedPlan(state, { before: before ? (ids) => before(state, ids) : undefined });
    await afterwards?.(state);
    await tick();
    expect(state.db.prepare(`SELECT COUNT(*) n FROM chief_retros`).get()).toEqual({ n: 0 });
    expect(stubs.run).not.toHaveBeenCalled();
  });
});

describe("retro state machine", () => {
  test("a failed launch leaves it pending with the reason, and the next due tick starts it", async () => {
    const { state, stubs, planner, tick } = await judged(() => null);
    stubs.run.mockRejectedValueOnce(new Error("workflow service down"));
    await tick();
    expect(retroRow(state, planner)).toMatchObject({ state: "pending", attempts: 1, run_id: null });
    expect(retroRow(state, planner).last_error).toContain("could not start: workflow service down");
    await tick(); // not due yet: the lease holds
    expect(stubs.run).toHaveBeenCalledTimes(1);
    dueNow(state, planner);
    await tick();
    expect(retroRow(state, planner)).toMatchObject({ state: "running", attempts: 2, run_id: "wfr_1", last_error: null });
  });

  test("a failed run returns it to pending and the next attempt gets a new run id", async () => {
    const { state, stubs, planner, tick } = await judged(() => null);
    await tick();
    stubs.status.mockResolvedValueOnce({ status: "failed", error: { message: "judge crashed" } });
    stubs.run.mockResolvedValueOnce({ runId: "wfr_2" });
    await tick(); // poll sees the failed run
    expect(retroRow(state, planner)).toMatchObject({ state: "pending", run_id: null });
    expect(retroRow(state, planner).last_error).toContain("run failed");
    dueNow(state, planner);
    await tick();
    expect(retroRow(state, planner)).toMatchObject({ state: "running", run_id: "wfr_2", attempts: 2 });
  });

  test("the third failed start ends in failed with exactly one alert to Chief and no more attempts", async () => {
    const { state, stubs, planner, tick } = await judged(() => null);
    stubs.run.mockRejectedValue(new Error("no workflow service"));
    for (let attempt = 1; attempt <= 3; attempt++) { await tick(); dueNow(state, planner); }
    expect(retroRow(state, planner)).toMatchObject({ state: "failed", attempts: 3 });
    expect(failedAlerts(state)).toHaveLength(1);
    expect(failedAlerts(state)[0].message).toContain("failed after 3 attempts");
    await tick();
    expect(stubs.run).toHaveBeenCalledTimes(3);
    expect(failedAlerts(state)).toHaveLength(1);
  });

  test("a run still going after 2 hours is stopped and the retro goes back to pending", async () => {
    const { state, stubs, planner, tick } = await judged(() => null);
    stubs.status.mockResolvedValue({ status: "running" });
    await tick();
    state.db.prepare(`UPDATE chief_retros SET started_at=? WHERE plan_thread_id=?`).run(Date.now() - 2 * 60 * 60_000 - 1_000, planner);
    await tick();
    expect(stubs.stop).toHaveBeenCalledWith(["wfr_1"]);
    expect(retroRow(state, planner)).toMatchObject({ state: "pending", run_id: null });
    expect(retroRow(state, planner).last_error).toContain("timed out after 2 h");
  });

  test("a succeeded run whose retro.md write keeps failing retries inside 2 hours, then exhausts the attempts into one failure alert", async () => {
    const { state, stubs, planner, tick } = await judged((ids) => answer(ids));
    state.failWritesMatching(/retro\.md\.tmp-/); // the bundle and the manifest still write; only the result file is refused
    const overdue = () => state.db.prepare(`UPDATE chief_retros SET started_at=? WHERE plan_thread_id=?`).run(Date.now() - 2 * 60 * 60_000 - 1_000, planner);

    await tick(); // attempt 1 launches
    await tick(); // collect fails, still inside the bound: the row stays running for the next tick
    expect(retroRow(state, planner)).toMatchObject({ state: "running", attempts: 1 });
    expect(retroRow(state, planner).last_error).toContain("collect failed");
    expect(state.db.prepare(`SELECT COUNT(*) n FROM chief_scores`).get()).toEqual({ n: 0 });

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) { dueNow(state, planner); await tick(); } // the next attempt launches
      overdue();
      await tick(); // collect fails past 2 hours: the run settles through the retry budget
      dueNow(state, planner);
    }
    expect(retroRow(state, planner)).toMatchObject({ state: "failed", attempts: 3, run_id: null });
    expect(retroRow(state, planner).last_error).toContain("timed out after 2 h");
    expect(failedAlerts(state)).toHaveLength(1);
    expect(failedAlerts(state)[0].message).toContain("failed after 3 attempts");
    expect(stubs.stop).not.toHaveBeenCalled(); // the run had already succeeded
    await tick();
    expect(stubs.run).toHaveBeenCalledTimes(3);
    expect(failedAlerts(state)).toHaveLength(1);
    expect(retroAlerts(state)).toHaveLength(0);
  });

  test("two overlapping ticks make one claim and one launch", async () => {
    const { state, stubs, planner, tick } = await judged(() => null);
    await Promise.all([tick(), tick()]);
    expect(stubs.run).toHaveBeenCalledTimes(1);
    expect(retroRow(state, planner)).toMatchObject({ state: "running", attempts: 1 });
  });
});

describe("retro collection", () => {
  test("a finished run stores scores per thread and handoff, writes retro.md, alerts once, and a second collect changes nothing", async () => {
    const { state, planner, worker, tick } = await judged((ids) => answer(ids, { worker: thread(ids.worker, FAIL, lessonOf([`${ids.worker}#1`])), handoffs: [handoff(ids.planner), handoff(ids.worker, "minor_gaps")] }));
    state.seedEvents(worker, [userSays(1, "Fix the totals")]);
    await tick();
    await tick();
    expect(retroRow(state, planner)).toMatchObject({ state: "done", last_error: null });
    const first = scoresOf(state);
    expect(first.filter((row) => row.thread_id === worker).map((row) => [row.scorer, row.label])).toEqual([
      ["communication", "minor_gaps"], ["efficiency", "mostly_efficient"], ["procedure-compliance", "fully_compliant"], ["verbosity", "verbose"],
    ]);
    expect(first).toHaveLength(8);
    expect(retroAlerts(state)).toHaveLength(1);
    expect(lessons(state)).toHaveLength(1);
    expect(retroAlerts(state)[0].message).toMatch(/Retro for plan “.*”: .*retro\.md\. 1\/2 threads failed, 0 insufficient\. 1 proposed lessons/);
    const markdown = await readFile(retroRow(state, planner).path, "utf8");
    expect(markdown).toContain(`| ${worker} | worker |`);
    expect(markdown).toContain("fail");

    // Collect the same run a second time: the row was left running by a crash after the write.
    state.db.prepare(`UPDATE chief_retros SET state='running' WHERE plan_thread_id=?`).run(planner);
    await tick();
    expect(retroRow(state, planner).state).toBe("done");
    expect(scoresOf(state)).toEqual(first);
    expect(retroAlerts(state)).toHaveLength(1);
    expect(lessons(state)).toHaveLength(1);
  });

  test("a result for a thread that was not requested is dropped, and a missing applicable score leaves the thread insufficient", async () => {
    const { state, planner, worker, tick } = await judged((ids) => ({
      ...answer(ids),
      threads: [thread(ids.planner), { ...thread(ids.worker), scores: thread(ids.worker).scores.slice(0, 2) }, thread("thr_stranger")],
    }));
    await tick();
    await tick();
    expect(scoresOf(state).some((row) => row.thread_id === "thr_stranger")).toBe(false);
    expect(scoresOf(state).find((row) => row.thread_id === worker && row.scorer === "verbosity")).toMatchObject({ label: "insufficient_evidence", score: null });
    expect(await readFile(retroRow(state, planner).path, "utf8")).toMatch(new RegExp(`\\| ${worker} \\| worker \\|.*\\| insufficient \\|`));
  });

  // The filing bar: a lesson needs a failing source thread and evidence refs that exist in the bundle. One filed lesson proves the harness can store one.
  test.each([
    ["a failing thread with a cited lesson files exactly one proposed lesson", FAIL, (ids: { worker: string }) => [`${ids.worker}#1`], 1],
    ["a passing thread's lesson is not stored", PASS, (ids: { worker: string }) => [`${ids.worker}#1`], 0],
    ["an evidence ref that is not in the bundle stores nothing", FAIL, (ids: { worker: string }) => [`${ids.worker}#99`], 0],
  ])("filing bar: %s", async (_name, labels, evidence, stored) => {
    const { state, planner, worker, tick } = await judged((ids) => answer(ids, { worker: thread(ids.worker, labels, lessonOf(evidence(ids))) }));
    state.seedEvents(worker, [userSays(1, "Fix the totals"), ev(2, { type: "agentMessage", text: "Done." })]);
    await tick();
    await tick();
    const rows = lessons(state);
    expect(rows).toHaveLength(stored);
    if (stored) expect(rows[0]).toMatchObject({ status: "proposed", surface: "worker-brief", plan_thread_id: planner });
    expect(retroRow(state, planner).state).toBe("done");
  });
});

describe("retro bundle bound", () => {
  const SHA = "a".repeat(40);
  const FILE_LIMIT = 120_000;
  const bigDiff = `diff --git a/totals.ts b/totals.ts\n${"+const line = 1;\n".repeat(2_000)}`;

  test("a thread file with a long brief, diff, ledger and event history stays within 120,000 characters, and its refs match the events kept", async () => {
    const state = await setup({ projectPath: "/repo/proj1" });
    state.harness.sdk.stub("system.config", async () => ({ primaryHostId: "host_1" }));
    const stubs = workflowStubs();
    const wrapped = execFileMock.getMockImplementation()!;
    execFileMock.mockImplementation(async (file: string, args: string[], options: object) => file === "git"
      ? { stdout: args[0] === "symbolic-ref" ? "origin/main\n" : args[0] === "rev-parse" ? `${SHA}\n` : args[0] === "diff" ? bigDiff : "", stderr: "" }
      : wrapped(file, args, options));
    const { chief, planner, worker, tick } = await completedPlan(state, { branch: "feature/x", mission: `BRIEF_HEAD ${"b".repeat(11_900)}` });
    stubs.status.mockResolvedValue({ status: "succeeded", result: null });
    for (let n = 0; n < 50; n++) state.db.prepare(`INSERT INTO chief_events (event_id, at, thread_id, role, kind, detail) VALUES (?, ?, ?, 'worker', 'stall', ?)`).run(`ledger-${n}`, Date.now() + n, worker, `L${n} ${"d".repeat(296)}`);
    state.seedEvents(worker, Array.from({ length: 150 }, (_, n) => userSays(n + 1, `${n + 1} ${"u".repeat(1_700)}`)));
    await tick();

    const dir = join(state.storageRoot, "chief", "proj_1", chief, "retro", planner);
    const names = await readdir(dir);
    expect(names).toEqual(expect.arrayContaining([`thread-${worker}.md`, `thread-${planner}.md`, "handoffs.md", "manifest.json"]));
    const lengths = Object.fromEntries(await Promise.all(names.map(async (name) => [name, (await readFile(join(dir, name), "utf8")).length])));
    expect(Math.max(...Object.values(lengths))).toBeLessThanOrEqual(FILE_LIMIT);

    const text = await readFile(join(dir, `thread-${worker}.md`), "utf8");
    // Non-vacuous: every ingredient is present and the events were cut to make room, so the bound was what limited the file.
    expect(text.includes("BRIEF_HEAD")).toBe(true);
    expect(text.includes("```diff")).toBe(true);
    const ledgerLines = [...text.matchAll(/^- \S+ stall: L\d+ /gm)].length; // at most 40 observed events, whatever the ledger holds
    expect(ledgerLines).toBeGreaterThan(30);
    expect(ledgerLines).toBeLessThanOrEqual(40);
    expect(/lines cut to fit/.test(text)).toBe(true);
    expect(text.length).toBeGreaterThan(100_000);
    const kept = [...text.matchAll(/^#(\d+) /gm)].map((match) => Number(match[1]));
    expect(kept.length).toBeGreaterThan(20);
    expect(kept.length).toBeLessThan(150);
    // Refs are exactly the cited lines visible in the retained files: the thread file's events plus this thread's lines kept in handoffs.md.
    const handoffs = await readFile(join(dir, "handoffs.md"), "utf8");
    const cited = [...handoffs.matchAll(new RegExp(`^${worker}#(\\d+) `, "gm"))].map((match) => Number(match[1]));
    const refs: number[] = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")).refs[worker];
    expect([...new Set(refs)].sort((a, b) => a - b)).toEqual([...new Set([...kept, ...cited])].sort((a, b) => a - b));
    expect(kept.every((seq) => refs.includes(seq))).toBe(true);
  });
});

describe("retro communication", () => {
  const CONSTRAINT = "Never touch the migrations folder.";
  const section = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));
  async function handoffsOf(state: Awaited<ReturnType<typeof setup>>, chief: string, planner: string) {
    return readFile(join(state.storageRoot, "chief", "proj_1", chief, "retro", planner, "handoffs.md"), "utf8");
  }
  const updatedAt = (state: Awaited<ReturnType<typeof setup>>, id: string) => (state.db.prepare(`SELECT updated_at FROM managed_threads WHERE thread_id=?`).get(id) as { updated_at: number }).updated_at;

  test("a constraint the brief dropped and a child that blocks twice: the bundle shows both sides, and the judge's costly_gaps is stored with its evidence", async () => {
    const { state, chief, planner, worker, tick } = await judged((ids) => answer(ids, { handoffs: [handoff(ids.planner), handoff(ids.worker, "costly_gaps", {
      reason: "The brief left out the migrations constraint and the child blocked twice on it.", evidence: [`${ids.worker}#2`, `${ids.worker}#3`],
      signals: { ...NO_SIGNALS, briefGapBlock: true, askedTwice: true, userWordsLost: true },
    })] }));
    state.seedEvents(chief, [userSays(9, `Fix the totals. ${CONSTRAINT}`, updatedAt(state, planner))]);
    state.seedEvents(worker, [userSays(1, "Correct and verify totals"), blockedReport(2, "Which folder may I not touch?"), blockedReport(3, "Which folder may I not touch? Asking again.")]);
    await tick();
    await tick();
    const text = await handoffsOf(state, chief, planner);
    expect(section(text, `## Handoff ${worker}`, "### Child's first events")).not.toContain(CONSTRAINT);
    expect(text.slice(text.indexOf("## Chief's side"))).toContain(CONSTRAINT);
    expect(section(text, `## Handoff ${worker}`, "### Brief sent")).toContain("blocks 2");
    const row = state.db.prepare(`SELECT label, score, reason, detail FROM chief_scores WHERE thread_id=? AND scorer='communication'`).get(worker) as any;
    expect(row).toMatchObject({ label: "costly_gaps" });
    expect(row.score).toBeLessThan(0.7);
    expect(row.reason).toContain(`${worker}#2`);
    expect(row.reason).toContain(`${worker}#3`);
    expect(JSON.parse(row.detail)).toMatchObject({ observed: { blocks: 2 }, signals: { briefGapBlock: true, askedTwice: true } });
  });

  test("the same constraint kept in the brief: nothing blocked, and the stored label follows the judge's clear", async () => {
    const { state, chief, planner, worker, tick } = await judged((ids) => answer(ids), { mission: `Correct and verify totals. ${CONSTRAINT}` });
    state.seedEvents(chief, [userSays(9, `Fix the totals. ${CONSTRAINT}`, updatedAt(state, planner))]);
    state.seedEvents(worker, [userSays(1, "Correct and verify totals"), ev(2, { type: "agentMessage", text: "Done." })]);
    await tick();
    await tick();
    const text = await handoffsOf(state, chief, planner);
    const mine = section(text, `## Handoff ${worker}`, "### Child's first events");
    expect(mine).toContain(CONSTRAINT);
    expect(mine).toContain("blocks 0");
    expect(state.db.prepare(`SELECT label FROM chief_scores WHERE thread_id=? AND scorer='communication'`).get(worker)).toEqual({ label: "clear" });
  });

  test("Chief lifecycle, Coordinator alert and Coordinator notice messages are automated: the Chief's side keeps only the user's words", async () => {
    const { state, chief, planner, tick } = await judged((ids) => answer(ids));
    const at = updatedAt(state, planner);
    state.seedEvents(chief, [
      userSays(7, `[Chief lifecycle alert]\nLIFECYCLE-ALERT ${planner}`, at),
      userSays(8, `[Coordinator alert]\nCOORDINATOR-ALERT ${planner}`, at),
      userSays(9, `[Coordinator notice]\nCOORDINATOR-NOTICE ${planner}`, at),
      userSays(10, `Fix the totals. ${CONSTRAINT}`, at),
    ]);
    await tick();
    await tick();
    const side = (await handoffsOf(state, chief, planner)).slice((await handoffsOf(state, chief, planner)).indexOf("## Chief's side"));
    expect(side).toContain(CONSTRAINT);
    for (const automated of ["LIFECYCLE-ALERT", "COORDINATOR-ALERT", "COORDINATOR-NOTICE"]) expect(side).not.toContain(automated);
  });

  test("a child whose events cannot be read is insufficient_evidence even when the judge says clear", async () => {
    const { state, worker, tick } = await judged((ids) => answer(ids));
    state.harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId: string }) => { if (threadId === worker) throw new Error("events API down"); return []; });
    await tick();
    await tick();
    expect(state.db.prepare(`SELECT label, score FROM chief_scores WHERE thread_id=? AND scorer='communication'`).get(worker)).toEqual({ label: "insufficient_evidence", score: null });
  });
});

describe("retro never edits Chief", () => {
  const files = async (dir: string): Promise<string[]> => (await readdir(dir, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));

  test("a retro run and a daily report add files only under the Chief's retro/ and reports/ artifact folders", async () => {
    const { state, chief, planner, tick } = await judged((ids) => answer(ids));
    const before = new Set(await files(state.storageRoot));
    await tick();
    await tick();
    await state.harness.behavior.runSchedule("daily-report");
    const added = (await files(state.storageRoot)).filter((path) => !before.has(path));
    expect(added.length).toBeGreaterThan(0);
    const allowed = new RegExp(`^chief/proj_1/${chief}/(retro/${planner}/|reports/)`);
    expect(added.filter((path) => !allowed.test(path))).toEqual([]);
  });
});

describe("retro retry over its own staged files", () => {
  const stagedIn = async (dir: string) => (await readdir(dir, { recursive: true })).sort();

  test("a retry re-stages its bundle over the first attempt, leaves another plan's files byte-for-byte, and starts a new run", async () => {
    const { state, stubs, chief, planner, worker, tick } = await judged(() => null);
    const retroDir = join(state.storageRoot, "chief/proj_1", chief, "retro");
    await tick(); // attempt 1 stages retro/<planner>/
    const firstManifest = await readFile(join(retroDir, planner, "manifest.json"), "utf8");
    const other = join(retroDir, "thr_other_plan");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "manifest.json"), '{"planId":"thr_other_plan"}');
    await writeFile(join(other, "thread-thr_x.md"), "Plan Q evidence\n\u00e9");
    const untouched = async () => Promise.all((await stagedIn(other)).map(async (name) => [name, await readFile(join(other, name), "utf8")]));
    const before = await untouched();

    state.seedEvents(worker, [userSays(1, "Fix the totals")]); // the retry reads new evidence, so its manifest differs
    stubs.status.mockResolvedValueOnce({ status: "failed", error: { message: "judge crashed" } });
    stubs.run.mockResolvedValueOnce({ runId: "wfr_2" });
    await tick(); // poll sees the failed run
    dueNow(state, planner);
    await tick(); // attempt 2 stages the same files again

    expect(retroRow(state, planner)).toMatchObject({ state: "running", run_id: "wfr_2", attempts: 2, last_error: null });
    expect(await untouched()).toEqual(before);
    const secondManifest = await readFile(join(retroDir, planner, "manifest.json"), "utf8");
    expect(secondManifest).not.toBe(firstManifest);
    expect(JSON.parse(secondManifest).planId).toBe(planner);
    expect((await stagedIn(join(retroDir, planner))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("a retry whose first launch failed still starts: the files from the failed attempt do not block it", async () => {
    const { state, stubs, planner, tick } = await judged(() => null);
    stubs.run.mockRejectedValueOnce(new Error("workflow service down")); // the bundle is staged before the launch fails
    await tick();
    expect(retroRow(state, planner).last_error).toContain("could not start: workflow service down");
    dueNow(state, planner);
    await tick();
    expect(retroRow(state, planner)).toMatchObject({ state: "running", attempts: 2, last_error: null });
  });

  test("collecting a succeeded run again rewrites retro.md over the first copy", async () => {
    const { state, planner, tick } = await judged((ids) => answer(ids));
    await tick();
    await tick();
    const { path } = retroRow(state, planner);
    await writeFile(path, "STALE");
    state.db.prepare(`UPDATE chief_retros SET state='running' WHERE plan_thread_id=?`).run(planner);
    await tick();
    expect(retroRow(state, planner)).toMatchObject({ state: "done", last_error: null });
    const text = await readFile(path, "utf8");
    expect(text).not.toBe("STALE");
    expect(text).toContain("| thread |");
  });
});
