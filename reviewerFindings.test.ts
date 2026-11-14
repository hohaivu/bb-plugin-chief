import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { APPROVE, chiefReview, configurationContext, delegate, disposeAll, execFileMock, ghHead, rowOf, setup, start, status, wave, withoutAlertMarker } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// ---- Reviewer result (plan thr_hh3bvcnaqs, wave 2, tester A): frozen on base 2351b05 ----
// Contract: docs/specs/report-intake.md baseline (validation, findings trim, ledger, lesson write) and the configure lesson read.
// These two groups run unchanged on base 2351b05 and on every later head; they go through chief_report and configure only.
describe("chief_report reviewer findings acceptance", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const PR = "https://github.com/acme/shop/pull/8";
  const nit = (n = 0) => ({ file: `f${n}.ts`, line: n + 1, severity: "nit", message: `Nit ${n}` });
  const blocking = (extra: object = {}) => ({ file: "totals.ts", line: 1, severity: "blocking", message: "Totals go negative.", ...extra });
  const HEADER = "chief_report was not saved; fix all of these and call it once more:";
  const refusal = (...lines: string[]) => [HEADER, ...lines.map((line) => `- ${line}`)].join("\n");
  const count = (state: State, table: string) => (state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const rowOf = (state: State, id: string) => state.db.prepare("SELECT * FROM managed_threads WHERE thread_id=?").get(id) as any;
  // The six stores a report touches, plus every alert sent to a thread.
  const stores = (state: State, id: string) => {
    const { report_seq, reject_streak, findings, verdict } = rowOf(state, id);
    return {
      report_seq, reject_streak, findings, verdict,
      verdicts: count(state, "reviewer_verdicts"), lessons: count(state, "chief_lessons"),
      alerts: count(state, "alert_outbox"), comments: count(state, "forge_comments"), sent: state.sent.length,
    };
  };
  // gh answers the pull-request lookup, so a verdict on a worker with a PR enqueues a forge comment row.
  const reviewed = async () => {
    execFileMock.mockImplementation(async (file: string, args: string[]) => ({ stdout: file === "gh" && args[0] === "pr" ? ghHead("feature/x") : "" }));
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix checkout totals", { prUrl: PR });
    const as = (threadId: string) => ({ threadId, projectId: "proj_1" });
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(worker.threadId));
    const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    const report = (params: object, threadId = review.threadId) => state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...params }, as(threadId)) as Promise<unknown>;
    return { state, chief, worker, review, report };
  };

  // path "array": the array reaches checkReport as sent. path "string": the same shape as a JSON string; used where the tool schema
  // refuses the array form first (see the schema test below: a fractional line and a bad severity), so checkReport is the one under test.
  const long = (n: number) => "x".repeat(n);
  const refused: { name: string; path: "array" | "string"; params: object; lines: string[] }[] = [
    { name: "request_changes with empty findings", path: "array", params: { verdict: "request_changes", findings: [] }, lines: ['verdict is request_changes but findings has no "blocking" entry; add the blocking finding or send approve.'] },
    { name: "request_changes with only nits", path: "array", params: { verdict: "request_changes", findings: [nit(0), nit(1)] }, lines: ['verdict is request_changes but findings has no "blocking" entry; add the blocking finding or send approve.'] },
    { name: "approve with one blocking finding", path: "array", params: { verdict: "approve", findings: [blocking()] }, lines: ['verdict is approve but findings has 1 "blocking" entry; send request_changes or mark them "nit".'] },
    { name: "approve with two blocking findings (plural)", path: "array", params: { verdict: "approve", findings: [blocking(), blocking({ line: 2 })] }, lines: ['verdict is approve but findings has 2 "blocking" entries; send request_changes or mark them "nit".'] },
    { name: "findings missing", path: "array", params: { verdict: "approve" }, lines: ["findings is missing; send [] when there are none."] },
    { name: "line 0", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), line: 0 }] }, lines: ["findings[0].line is 0; send a 1-based integer or omit it."] },
    { name: "line -1", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), line: -1 }] }, lines: ["findings[0].line is -1; send a 1-based integer or omit it."] },
    { name: "line 1.5", path: "string", params: { verdict: "approve", findings: JSON.stringify([{ ...nit(0), line: 1.5 }]) }, lines: ["findings[0].line is 1.5; send a 1-based integer or omit it."] },
    { name: "severity major", path: "string", params: { verdict: "approve", findings: JSON.stringify([{ ...nit(0), severity: "major" }]) }, lines: ['findings[0].severity is "major"; allowed "blocking" or "nit".'] },
    { name: "empty file", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), file: "" }] }, lines: ["findings[0].file is missing or empty; send text."] },
    { name: "whitespace-only file", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), file: "  \t " }] }, lines: ["findings[0].file is missing or empty; send text."] },
    { name: "empty message", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), message: "" }] }, lines: ["findings[0].message is missing or empty; send text."] },
    { name: "whitespace-only message", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), message: " \n " }] }, lines: ["findings[0].message is missing or empty; send text."] },
    { name: "file over 300 after trim", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), file: ` ${long(301)} ` }] }, lines: ["findings[0].file is 301 characters; max 300. Shorten it."] },
    { name: "message over 1000 after trim", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), message: ` ${long(1_001)} ` }] }, lines: ["findings[0].message is 1,001 characters; max 1,000. Shorten it."] },
    { name: "fix over 1000 after trim", path: "array", params: { verdict: "approve", findings: [{ ...nit(0), fix: ` ${long(1_001)} ` }] }, lines: ["findings[0].fix is 1,001 characters; max 1,000. Shorten it."] },
    { name: "41 findings", path: "array", params: { verdict: "approve", findings: Array.from({ length: 41 }, (_, n) => nit(n)) }, lines: ["findings has 41 entries; max 40. Keep the blocking ones and the most useful nits."] },
    { name: "malformed JSON string", path: "string", params: { verdict: "approve", findings: "[{not json" }, lines: ["findings: send an array of {file, line?, severity, message, fix?}."] },
  ];

  test.each(refused)("refuses $name ($path path) and writes nothing", async ({ params, lines }) => {
    const { state, review, report } = await reviewed();
    const before = stores(state, review.threadId);
    await expect(report(params)).rejects.toThrow(refusal(...lines));
    expect(stores(state, review.threadId)).toEqual(before);
    expect(before.report_seq).toBe(0);
  });

  test.each([
    ["a fractional line", { ...nit(0), line: 1.5 }],
    ["a severity outside blocking and nit", { ...nit(0), severity: "major" }],
  ])("the tool schema refuses an array with %s before checkReport runs, and writes nothing", async (_, finding) => {
    const { state, review, report } = await reviewed();
    const before = stores(state, review.threadId);
    await expect(report({ verdict: "approve", findings: [finding] })).rejects.toThrow('tool "chief_report" arguments are invalid: findings: Invalid input');
    expect(stores(state, review.threadId)).toEqual(before);
  });

  test("refuses findings on a non-reviewer report and writes nothing (array path)", async () => {
    const { state, worker } = await reviewed();
    const before = stores(state, worker.threadId);
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done", findings: [nit(0)] }, { threadId: worker.threadId, projectId: "proj_1" }))
      .rejects.toThrow(refusal("findings is only for a reviewer's ready report (role is worker); remove it."));
    expect(stores(state, worker.threadId)).toEqual(before);
  });

  test("a refused request_changes leaves the streak at 0, and the corrected report then counts as the first rejection", async () => {
    const { state, review, report } = await reviewed();
    await expect(report({ verdict: "request_changes", findings: [nit(0)] })).rejects.toThrow("chief_report was not saved");
    expect(rowOf(state, review.threadId).reject_streak).toBe(0);
    await report({ verdict: "request_changes", findings: [blocking(), nit(0)] });
    expect(rowOf(state, review.threadId)).toMatchObject({ report_seq: 1, reject_streak: 1, verdict: "request_changes" });
  });

  test("accepts 40 findings and stores all of them", async () => {
    const { state, review, report } = await reviewed();
    const list = Array.from({ length: 40 }, (_, n) => nit(n));
    await report({ verdict: "approve", findings: list });
    expect(JSON.parse(rowOf(state, review.threadId).findings)).toEqual(list);
  });

  test("a JSON-string findings gives the same stored findings, verdict file and alert as the same array", async () => {
    const list = [blocking({ line: 3 }), nit(0)];
    const run = async (findings: unknown) => {
      const { state, review, report } = await reviewed();
      await report({ verdict: "request_changes", findings });
      const row = rowOf(state, review.threadId);
      // Thread ids differ per fixture: compare the texts with the ids masked.
      const mask = (text: string) => text.replaceAll(review.threadId, "<reviewer>");
      return { stored: row.findings, file: mask(await readFile(row.verdict_path, "utf8")), alert: mask(withoutAlertMarker(state.sent.at(-1).input[0].text)).replace(/\S*verdict-1\.md/g, "<file>").replace(/thr_\w+/g, "<id>") };
    };
    const asArray = await run(list);
    const asString = await run(JSON.stringify(list));
    expect(asString.stored).toBe(asArray.stored);
    expect(asString.file.replace(/thr_\w+/g, "<id>")).toBe(asArray.file.replace(/thr_\w+/g, "<id>"));
    expect(asString.alert).toBe(asArray.alert);
    expect(JSON.parse(asArray.stored)).toEqual(list);
  });

  // The array path may be trimmed by the tool schema already; only the JSON-string path reaches the report with the spaces intact.
  test.each(["array", "string"] as const)("stores file, message and fix trimmed, and the verdict file lists them trimmed (%s path)", async (path) => {
    const { state, review, report } = await reviewed();
    const findings = [
      { file: `  ${long(300)}  `, line: 2, severity: "blocking", message: "  Blocking text  ", fix: "  Do this  " },
      { file: "  nit.ts ", severity: "nit", message: "\tNit text\n", fix: "   " },
    ];
    await report({ verdict: "request_changes", findings: path === "string" ? JSON.stringify(findings) : findings });
    const row = rowOf(state, review.threadId);
    expect(JSON.parse(row.findings)).toEqual([
      { file: long(300), line: 2, severity: "blocking", message: "Blocking text", fix: "Do this" },
      { file: "nit.ts", severity: "nit", message: "Nit text", fix: "" },
    ]);
    const file = await readFile(row.verdict_path, "utf8");
    const [blockingPart, nitPart] = file.split("## Nits");
    expect(blockingPart).toContain("## Blocking findings");
    expect(blockingPart).toContain("Blocking text");
    expect(blockingPart).toContain("Do this");
    expect(blockingPart).not.toMatch(/  Blocking text|Blocking text {2}|Do this {2}/);
    expect(nitPart).toContain("nit.ts");
    expect(nitPart).toContain("Nit text");
    expect(nitPart).not.toMatch(/\t|  Nit text|Nit text\n\n\n/);
  });

  test("request_changes writes one reviewer_verdicts row per covered target, adds 1 to reject_streak, and a later approve resets it", async () => {
    const { state, worker, review, report } = await reviewed();
    const verdictRows = () => state.db.prepare("SELECT worker_thread_id, verdict, report_seq FROM reviewer_verdicts WHERE reviewer_thread_id=? ORDER BY id").all(review.threadId);
    const commentsBefore = count(state, "forge_comments");
    await report({ verdict: "request_changes", findings: [blocking(), nit(0)] });
    expect(verdictRows()).toEqual([{ worker_thread_id: worker.threadId, verdict: "request_changes", report_seq: 1 }]);
    expect(rowOf(state, review.threadId).reject_streak).toBe(1);
    expect(count(state, "forge_comments")).toBe(commentsBefore + 1);
    await report({ verdict: "request_changes", findings: [blocking()] });
    expect(rowOf(state, review.threadId).reject_streak).toBe(2);
    expect(verdictRows()).toHaveLength(2);
    await report({ ...APPROVE });
    expect(rowOf(state, review.threadId)).toMatchObject({ reject_streak: 0, verdict: "approve", report_seq: 3 });
    expect(verdictRows().at(-1)).toEqual({ worker_thread_id: worker.threadId, verdict: "approve", report_seq: 3 });
  });
});

describe("reviewer lesson from chief_report to the next reviewer", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const EARLIER = "## Lessons from earlier review rounds";
  const REVIEW = "## Review lessons (known false positives and checks)";
  const as = (threadId: string, projectId = "proj_1") => ({ threadId, projectId });
  const instructionsOf = async (state: State, threadId: string, projectId = "proj_1", pluginMetadata?: object) =>
    (await state.harness.behavior.resolveAgentConfiguration({ ...configurationContext(threadId, projectId), ...(pluginMetadata ? { pluginMetadata } : {}) })).instructions as string;
  const section = (instructions: string, header: string) => instructions.split("\n\n").find((part) => part.startsWith(header));
  const lessonRows = (state: State) => state.db.prepare("SELECT project_id, text, source_thread_id, worker_thread_id, role FROM chief_lessons ORDER BY id").all();
  // Lesson gate (docs/decisions/2026-11-13-lesson-lifecycle-gate.md): a report lesson starts proposed; only an accepted one is injected.
  // These tests accept it through the real CLI first, then keep their original injection expectations.
  const acceptAll = async (state: State, chiefThreadId: string) => {
    for (const { id } of state.db.prepare("SELECT id FROM chief_lessons WHERE status='proposed' ORDER BY id").all() as { id: number }[])
      await state.harness.behavior.runCli(["lesson", "accept", String(id), "--reason", "test accepts"], as(chiefThreadId));
  };

  async function firstReview() {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId);
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(worker.threadId));
    const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
    const report = (params: object, threadId = review.threadId) => state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", ...APPROVE, ...params }, as(threadId)) as Promise<unknown>;
    // The next reviewer reviews another worker of the same project.
    const nextReviewer = async () => {
      const other = await delegate(state, chief.threadId, `Other work ${Math.random()}`);
      await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(other.threadId));
      return (await chiefReview(state, chief.threadId, { workerThreadId: other.threadId })).threadId;
    };
    return { state, chief, worker, review, report, nextReviewer };
  }

  test("a reviewer's lesson writes one reviewer-role row and the alert names it", async () => {
    const { state, worker, review, report } = await firstReview();
    await report({ lesson: "Check the discount path before flagging rounding." });
    expect(lessonRows(state)).toEqual([{
      project_id: "proj_1", text: "Check the discount path before flagging rounding.",
      source_thread_id: review.threadId, worker_thread_id: worker.threadId, role: "reviewer",
    }]);
    expect(state.db.prepare("SELECT status FROM chief_lessons").all()).toEqual([{ status: "proposed" }]);
    expect(state.sent.at(-1).input[0].text).toContain("Lesson proposed for future managed threads: Check the discount path before flagging rounding.");
  });

  test("the next reviewer of the project sees it under Review lessons; other roles and other projects do not", async () => {
    const { state, chief, report, nextReviewer } = await firstReview();
    await report({ lesson: "Rounding is by design." });
    await acceptAll(state, chief.threadId);
    const next = await nextReviewer();
    const seen = await instructionsOf(state, next);
    expect(section(seen, REVIEW)).toBe(`${REVIEW}\n- Rounding is by design.`);
    expect(seen).not.toContain(EARLIER);
    const seeded = (role: string) => ({ role, chiefThreadId: chief.threadId });
    for (const role of ["worker", "planner", "advisor"]) {
      const text = await instructionsOf(state, `thr_seed_${role}`, "proj_1", seeded(role));
      expect(text, role).not.toContain("Rounding is by design.");
      expect(text, role).not.toContain(REVIEW);
      expect(text, role).not.toContain(EARLIER);
    }
    const otherProject = await instructionsOf(state, "thr_seed_reviewer", "proj_2", seeded("reviewer"));
    expect(otherProject).not.toContain("Rounding is by design.");
    expect(otherProject).not.toContain(REVIEW);
    // Control: the same seeded reviewer in the lesson's own project does see it.
    expect(await instructionsOf(state, "thr_seed_reviewer", "proj_1", seeded("reviewer"))).toContain("- Rounding is by design.");
  });

  test("an advisor's lesson shows under earlier-review lessons for every managed role, and not under Review lessons", async () => {
    const { state, chief, nextReviewer } = await firstReview();
    await state.harness.behavior.runCli(["consult", "--title", "Rework checkout", "--mission", "Explore a fix for the discount bug"], as(chief.threadId));
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done", lesson: "Plans name their test wave." }, as(advisor.threadId));
    expect(lessonRows(state)).toEqual([expect.objectContaining({ text: "Plans name their test wave.", source_thread_id: advisor.threadId, role: "advisor" })]);
    await acceptAll(state, chief.threadId);
    const seeded = (role: string) => ({ role, chiefThreadId: chief.threadId });
    const next = await nextReviewer();
    const texts: [string, string][] = [["reviewer", await instructionsOf(state, next)]];
    for (const role of ["worker", "planner", "advisor"]) texts.push([role, await instructionsOf(state, `thr_seed_${role}`, "proj_1", seeded(role))]);
    for (const [role, text] of texts) {
      expect(section(text, EARLIER), role).toBe(`${EARLIER}\n- Plans name their test wave.`);
      expect(text, role).not.toContain(REVIEW);
    }
  });

  test("with 12 reviewer lessons the next reviewer sees the newest 10, oldest first", async () => {
    const { state, chief, report, nextReviewer } = await firstReview();
    for (let n = 1; n <= 12; n += 1) await report({ lesson: `Lesson ${String(n).padStart(2, "0")}.` });
    expect(lessonRows(state)).toHaveLength(12);
    await acceptAll(state, chief.threadId);
    const shown = section(await instructionsOf(state, await nextReviewer()), REVIEW)!;
    expect(shown.split("\n")).toEqual([REVIEW, ...Array.from({ length: 10 }, (_, n) => `- Lesson ${String(n + 3).padStart(2, "0")}.`)]);
  });

  test("a lessons section over 3,000 characters is clipped at 3,000", async () => {
    const { state, chief, report, nextReviewer } = await firstReview();
    for (let n = 0; n < 10; n += 1) await report({ lesson: `${n}`.repeat(400) });
    await acceptAll(state, chief.threadId);
    const shown = section(await instructionsOf(state, await nextReviewer()), REVIEW)!;
    expect(shown).toHaveLength(3_000);
    expect(shown.endsWith("…")).toBe(true);
    // Oldest first: the clipped tail is the newest lessons' end, and the oldest lesson is whole.
    expect(shown).toContain(`- ${"0".repeat(400)}\n- ${"1".repeat(400)}`);
    expect(shown).not.toContain("9".repeat(400));
  });

  test("a refused reviewer report with a lesson writes no chief_lessons row", async () => {
    const { state, review, report } = await firstReview();
    await expect(report({ verdict: "approve", findings: [{ file: "totals.ts", severity: "blocking", message: "Bad." }], lesson: "Never recorded." })).rejects.toThrow("chief_report was not saved");
    expect(lessonRows(state)).toEqual([]);
    expect(rowOf(state, review.threadId).report_seq).toBe(0);
  });

  test("a lesson on a non-ready report is refused and writes no row", async () => {
    const { state, review } = await firstReview();
    await expect(state.harness.behavior.callAgentTool("chief_report", { state: "blocked", result: "Stuck", blocker: "No access", recommendation: "Grant it", lesson: "Never recorded." }, as(review.threadId)))
      .rejects.toThrow('lesson is only allowed when state is ready (state is "blocked"); remove it.');
    expect(lessonRows(state)).toEqual([]);
  });
});
