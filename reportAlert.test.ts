import { describe, expect, test } from "vitest";
import { reportAlert, reportFileBody, type ReportAlertInput } from "./src/report/reportIntake";
import { ALERT_MARKER_ROOM, MAX_ALERT_LENGTH, type RecordedCommand } from "./src/core/text";
import type { ReportParams } from "./src/types";

// Contracts (shrink-prompts wave 1, plan-1.md "Contracts to verify"): the worker ready alert lists only the failed recorded commands under a header that
// counts all of them, and `clipped` is true when any command is left out, so report-<seq>.md (every command) is written; an action up to 1,200
// characters is shown whole and a longer one is clipped at 1,200 and sets `clipped`; the required lines keep their place inside the alert budget
// while lower-priority lines shrink first; a planner alert shows each plan file once. reportAlert is a pure function of its input, so each test
// names the one input it varies. Expected values are written from the plan, never from a render of the code.

const ROOM = MAX_ALERT_LENGTH - "[Chief lifecycle alert]\n".length - ALERT_MARKER_ROOM;
const POINTER = { line: "Full report: /s/chief/proj_1/thr_9/report-1.md", name: "report-1.md" };
const cmd = (command: string, exitCode: number | null): RecordedCommand => ({ command, exitCode, status: exitCode === null ? "running" : "done" });
const input = (over: Partial<ReportAlertInput> = {}): ReportAlertInput => ({
  role: "worker", title: "Wave 1", threadId: "thr_9", params: { state: "ready", result: "Done." } as ReportParams, action: "Next: review it.",
  recorded: undefined, failList: undefined, verdict: null, verdictPath: null, waveLines: [], inlinePlans: [], preview: false, lessonId: null, stamp: null, ...over,
});
const lines = (text: string) => text.split("\n");
const action = (length: number) => `Next: ${"a".repeat(length - 6)}`;

describe("worker ready alert: recorded commands", () => {
  const fail1 = cmd("npm run lint", 1);
  const fail2 = cmd("npx tsc --noEmit", 2);
  const table: [string, RecordedCommand[] | null, string[], string[], boolean][] = [
    // [name, recorded, lines that must show, lines that must not show, clipped]
    ["a mix keeps the header over all commands and lists only the failed ones", [cmd("git status", 0), fail1, cmd("npm run build", 0), cmd("sleep 9", null), fail2],
      ["Recorded (last 5 commands): 2 non-zero exit", "  npm run lint → exit 1", "  npx tsc --noEmit → exit 2"], ["git status", "npm run build", "sleep 9"], true],
    ["all successful: header only, no command line", [cmd("git status", 0), cmd("npm run build", 0)], ["Recorded (last 2 commands): 0 non-zero exit"], ["git status", "npm run build"], true],
    ["only a command with no exit yet: header only", [cmd("sleep 9", null)], ["Recorded (last 1 commands): 0 non-zero exit"], ["sleep 9"], true],
    ["all failed and fitting: every line, nothing left out", [fail1, fail2], ["Recorded (last 2 commands): 2 non-zero exit", "  npm run lint → exit 1", "  npx tsc --noEmit → exit 2"], [], false],
    ["no command recorded", [], ["Recorded: none recorded"], [], false],
    ["the event log could not be read", null, ["Recorded: could not read the event log (see the plugin log)"], [], false],
  ];
  test.each(table)("%s", (_name, recorded, shows, hides, clipped) => {
    const result = reportAlert(input({ recorded }))(null);
    for (const line of shows) expect(lines(result.text)).toContain(line);
    for (const line of hides) expect(result.text).not.toContain(line);
    expect(result.clipped).toBe(clipped);
  });

  test("a failed command longer than the 120-character excerpt is cut and sets clipped", () => {
    const result = reportAlert(input({ recorded: [cmd(`npx vitest run ${"x".repeat(200)}`, 1)] }))(null);
    expect(result.text).not.toContain("x".repeat(120));
    expect(result.clipped).toBe(true);
  });

  test("the report file keeps every command, successful and still running ones included", () => {
    const recorded = [cmd("git status", 0), fail1, cmd("sleep 9", null)];
    const file = reportFileBody({ role: "worker", title: "Wave 1", threadId: "thr_9", params: { state: "ready", result: "Done." } as ReportParams, verdict: null, action: "Next: x", waveLines: [], inlinePlans: [], recorded });
    for (const line of ["  git status → exit 0", "  npm run lint → exit 1", "  sleep 9 → exit running"]) expect(lines(file)).toContain(line);
    expect(file).toContain("Recorded (last 3 commands): 1 non-zero exit");
  });

  test("more failed commands than the room holds end with the …and N more line, and the alert stays inside the budget", () => {
    const recorded = Array.from({ length: 30 }, (_, index) => cmd(`npx vitest run suite-${index}.test.ts ${"y".repeat(100)}`, 1));
    const result = reportAlert(input({ recorded, params: { state: "ready", result: "r".repeat(2000) } as ReportParams }))(POINTER);
    expect(result.text.length).toBeLessThanOrEqual(ROOM);
    expect(result.text).toMatch(/\n {2}…and \d+ more\n/);
    expect(result.clipped).toBe(true);
  });
});

describe("alert action line", () => {
  test.each([[400], [401], [1_199], [1_200]])("an action of %i characters shows whole and does not set clipped", (length) => {
    const result = reportAlert(input({ action: action(length) }))(null);
    expect(lines(result.text)).toContain(action(length));
    expect(result.clipped).toBe(false);
  });

  test("an action of 1,201 characters is clipped at 1,200 with an ellipsis and sets clipped", () => {
    const result = reportAlert(input({ action: action(1_201) }))(null);
    const shown = lines(result.text).find((line) => line.startsWith("Next: "))!;
    expect(shown).toBe(`${action(1_201).slice(0, 1_199)}…`);
    expect(shown).toHaveLength(1_200);
    expect(result.clipped).toBe(true);
  });

  // (a) a ready worker alert with a 1,200-character action, an 800-character summary and 12 failed commands.
  test("a ready worker alert with the longest action, an 800-character summary and 12 failed commands fits and keeps the action intact", () => {
    const recorded = Array.from({ length: 12 }, (_, index) => cmd(`npx vitest run suite-${index}.test.ts ${"z".repeat(90)}`, 1));
    const params = { state: "ready", result: "r".repeat(4_000), summary: "s".repeat(800) } as ReportParams;
    for (const pointer of [null, POINTER]) {
      const result = reportAlert(input({ action: action(1_200), params, recorded }))(pointer);
      expect(result.text.length).toBeLessThanOrEqual(ROOM);
      expect(lines(result.text)).toContain(action(1_200));
      expect(result.text).toContain("Recorded (last 12 commands): 12 non-zero exit");
    }
  });

  // (b) a blocked alert with a 1,200-character action and a 4,000-character blocker and recommendation.
  test("a blocked alert with the longest action and 4,000-character blocker and recommendation fits, keeps the action intact and marks both fields clipped", () => {
    const params = { state: "blocked", blocker: "b".repeat(4_000), recommendation: "c".repeat(4_000) } as ReportParams;
    const plain = reportAlert(input({ action: action(1_200), params }))(null);
    expect(plain.text.length).toBeLessThanOrEqual(ROOM);
    expect(lines(plain.text)).toContain(action(1_200));
    expect(plain.text).toMatch(/\nBlocker: b+… \(clipped\)\n/);
    expect(plain.text).toMatch(/\nRecommendation: c+… \(clipped\)$/);
    expect(plain.clipped).toBe(true);
    const filed = reportAlert(input({ action: action(1_200), params }))(POINTER);
    expect(filed.text.length).toBeLessThanOrEqual(ROOM);
    expect(lines(filed.text)).toContain(action(1_200));
    expect(filed.text).toMatch(/\nBlocker: b+… \(clipped; full text in report-1\.md\)\n/);
    expect(filed.text).toMatch(/\nRecommendation: c+… \(clipped; full text in report-1\.md\)$/);
  });

  test("a blocked alert with a short action lists the required lines in order, with the action untouched", () => {
    const params = { state: "blocked", blocker: "Totals test fails", recommendation: "Fix the product code", result: "Two tests fail" } as ReportParams;
    const result = reportAlert(input({ action: "Next: delegate a worker.", params }))(null);
    expect(result.text).toBe([
      "Worker report from Wave 1 (thr_9)", "State: blocked", "Next: delegate a worker.", "Blocker: Totals test fails", "Recommendation: Fix the product code", "Result: Two tests fail",
    ].join("\n"));
    expect(result.clipped).toBe(false);
  });
});

describe("planner ready alert: plan files appear once", () => {
  const paths = [1, 2, 3].map((n) => `/s/chief/proj_1/thr_4/plan-${n}.md`);
  const waveLines = paths.map((path, index) => `Wave ${index + 1} of 3: ${path}`);
  const params = { state: "ready", result: "A three-wave plan." } as ReportParams;
  const INTRO = "Plan files, wave 1 first. To show the plan to the user, put each line below alone on its own line in your reply (not in a code block):";

  test("with the mirror written, the inline lines carry each path once and no `Wave n of N:` line shows", () => {
    const result = reportAlert(input({ role: "planner", params, waveLines, inlinePlans: paths }))(null);
    expect(lines(result.text)).toContain("Plan: 3 wave(s)");
    expect(lines(result.text).slice(lines(result.text).indexOf(INTRO))).toEqual(expect.arrayContaining([INTRO, ...paths]));
    expect(result.text).not.toMatch(/^Wave \d of 3:/m);
    for (const path of paths) expect(result.text.split(path)).toHaveLength(2);
  });

  test("with no inline lines (the mirror failed), the `Wave n of N:` lines show once each and there is no intro", () => {
    const result = reportAlert(input({ role: "planner", params, waveLines, inlinePlans: [] }))(null);
    for (const line of waveLines) expect(lines(result.text)).toContain(line);
    expect(result.text).not.toContain("Plan files, wave 1 first.");
    for (const path of paths) expect(result.text.split(path)).toHaveLength(2);
  });

  test("the report file still lists the wave lines and the inline lines", () => {
    const file = reportFileBody({ role: "planner", title: "Plan", threadId: "thr_4", params, verdict: null, action: "Next: x", waveLines, inlinePlans: paths, recorded: undefined });
    for (const line of [...waveLines, ...paths]) expect(lines(file)).toContain(line);
  });
});
