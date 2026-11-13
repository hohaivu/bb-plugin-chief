import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { delegate, disposeAll, setup } from "./test/harness";
import { dailyWorld, localDay, restoreEnv } from "./test/dailyFixture";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(async () => { vi.unstubAllGlobals(); restoreEnv(); await disposeAll(); });

// Contracts (docs/specs/observability.md, "Daily report"): one file and one self-alert per local date, no Chief means no report,
// the ledger keeps 90 days, one adapter's failure never touches another section, Sentry issues split into new and recurring,
// the report stays within 60,000 characters on whole items, and the calibration and lesson sections follow their evidence rules.
const DAY = 86_400_000;
type State = Awaited<ReturnType<typeof setup>>;
const issue = (n: number, firstSeen: string, title = `Error ${n}`) => ({ shortId: `CHIEF-${n}`, title, count: "7", level: "error", firstSeen, lastSeen: new Date().toISOString(), permalink: `https://sentry.example/${n}` });
const sentrySettings = { sentryAuthToken: "tok-secret-1", sentryOrg: "acme", sentryProject: "chief" };
const respond = (issues: unknown[]) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => issues });
const event = (state: State, id: string, at: number) => state.db.prepare(`INSERT INTO chief_events (event_id, at, kind) VALUES (?, ?, 'stall')`).run(id, at);
const ledger = (state: State) => (state.db.prepare(`SELECT event_id FROM chief_events WHERE event_id LIKE 'old-%' OR event_id LIKE 'new-%' ORDER BY event_id`).all() as { event_id: string }[]).map((row) => row.event_id);

describe("daily report job", () => {
  test("writes one dated file, alerts Chief once as itself, and a second run the same day changes nothing", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    const first = await world.run();
    expect(first.path).toMatch(new RegExp(`reports/daily-${localDay()}\\.md$`));
    expect(first.alerts).toHaveLength(1);
    expect(first.alerts[0]!.dedupe_key).toBe(`${world.chief}:daily:${localDay()}`);
    expect(await readFile(first.path!, "utf8")).toMatch(new RegExp(`^# Daily Chief report ${localDay()}\n`));
    const alert = state.sent.filter((send) => String(send.text ?? send.message ?? JSON.stringify(send)).includes("Daily Chief report"));
    expect(alert).toHaveLength(1);
    expect(alert[0]).not.toHaveProperty("senderThreadId");

    const second = await world.run();
    expect(second.alerts).toEqual(first.alerts);
    expect(second.path).toBe(first.path);
    expect(state.sent.filter((send) => JSON.stringify(send).includes("Daily Chief report"))).toHaveLength(1);
  });

  test.each([["with a Chief", true], ["with no Chief", false]])("the ledger keeps 90 days, %s", async (_name, withChief) => {
    const state = await setup();
    const world = withChief ? await dailyWorld(state) : null;
    event(state, "old-1", Date.now() - 91 * DAY);
    event(state, "new-1", Date.now() - 89 * DAY);
    const outcome = world ? await world.run() : (await state.harness.behavior.runSchedule("daily-report"), { alerts: state.db.prepare(`SELECT 1 FROM alert_outbox WHERE dedupe_key LIKE '%:daily:%'`).all() });
    expect(ledger(state)).toEqual(["new-1"]);
    expect(outcome.alerts).toHaveLength(withChief ? 1 : 0);
  });

  test("one adapter failing makes only its sections error; the report is still written", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    state.harness.sdk.stub("hosts.get", async () => { throw new Error("host gone"); });
    world.identify(world.chief, "provider-1"); // pi then needs the data dir to look for the file
    const { path } = await world.run();
    const report = await readFile(path!, "utf8");
    expect(report).toMatch(/\| bbLogs \| error \| 0 \| .*host gone/);
    expect(report).toMatch(/\| pi \| error \| 0 \|/);
    expect(report).toMatch(/\| chiefEvents \| ok \|/);
    expect(report).toMatch(/\| sentry \| skipped \|/);
  });
});

describe("daily report: Sentry", () => {
  test("issues first seen in the window are new, older ones recurring; the read token is sent as a bearer and never printed", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings(sentrySettings);
    const world = await dailyWorld(state);
    respond([issue(1, new Date().toISOString()), issue(2, new Date(Date.now() - 5 * DAY).toISOString())]);
    const report = await readFile((await world.run()).path!, "utf8");
    expect(report).toMatch(/New \(first seen in the window\): 1\n- error?.*CHIEF-1/s.test(report) ? /./ : /New \(first seen in the window\): 1\n.*CHIEF-1/);
    expect(report).toMatch(/Recurring \(seen before the window\): 1\n.*CHIEF-2/);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/0/projects/acme/chief/issues/");
    expect(init.headers.Authorization).toBe("Bearer tok-secret-1");
    expect(report).not.toContain("tok-secret-1");
  });

  test("with the token, organization or project unset nothing is fetched and the section says skipped", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings({ sentryAuthToken: "tok-secret-1" });
    const world = await dailyWorld(state);
    const report = await readFile((await world.run()).path!, "utf8");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report).toContain("Not available: skipped");
  });

  test("a report over 60,000 characters drops whole items from its longest section and says how many", async () => {
    const state = await setup();
    await state.harness.behavior.setSettings(sentrySettings);
    const world = await dailyWorld(state);
    respond(Array.from({ length: 200 }, (_, n) => issue(n + 1, new Date(Date.now() - 5 * DAY).toISOString(), `Failure ${n + 1} ${"x".repeat(280)}`)));
    const report = await readFile((await world.run()).path!, "utf8");
    expect(report.length).toBeLessThanOrEqual(60_000);
    expect(report).toMatch(/…\d+ more cut to fit 60000 characters/);
    const items = report.split("\n").filter((line) => /^- .*CHIEF-/.test(line));
    const cut = Number(/…(\d+) more cut/.exec(report)![1]);
    expect(items.length).toBeGreaterThan(100);
    expect(items.length + cut).toBe(200);
    // Every kept item is a whole line (each is clipped to an excerpt on its own, never cut by the size limit).
    for (const item of items) expect(item).toMatch(/^- 7× recurring: CHIEF-\d+ \[error\] Failure \d+ x+…?$/);
  });
});

describe("daily report: retro sections", () => {
  const RUBRIC = "2026-11-13.1";
  const judgedWorker = (state: State, id: string, pass: boolean) => state.db.prepare(`INSERT INTO chief_scores (thread_id, plan_thread_id, role, scorer, rubric_version, label, score, reason, at) VALUES (?, 'thr_plan', 'worker', 'efficiency', ?, 'x', ?, 'because', ?)`).run(id, RUBRIC, pass ? 0.9 : 0.1, Date.now() - 1_000);
  const verdict = (state: State, id: string, kind: string, bound: boolean) => state.db.prepare(`INSERT INTO reviewer_verdicts (reviewer_thread_id, worker_thread_id, verdict, report_seq, at, head_sha, worker_report_seq) VALUES ('thr_rev', ?, ?, 1, ?, ?, ?)`).run(id, kind, Date.now(), bound ? "abc" : null, bound ? 1 : null);
  const section = (report: string, title: string) => new RegExp(`## ${title.replace(/[()]/g, "\\$&")}[^\n]*\n([\\s\\S]*?)\n## `).exec(report)![1]!;

  test("calibration: unbound verdicts are counted out and the 2×2 matrix and disagreement rate are exact", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    // pass: 4 approve + 2 request_changes; fail: 3 approve + 3 request_changes; two more judged workers have only unbound verdicts.
    const plan: [boolean, string, number][] = [[true, "approve", 4], [true, "request_changes", 2], [false, "approve", 3], [false, "request_changes", 3]];
    let n = 0;
    for (const [pass, kind, count] of plan) for (let i = 0; i < count; i++) { const id = `thr_w${n++}`; judgedWorker(state, id, pass); verdict(state, id, kind, true); }
    for (const id of ["thr_u1", "thr_u2"]) { judgedWorker(state, id, true); verdict(state, id, "approve", false); }
    const calibration = section(await readFile((await world.run()).path!, "utf8"), "Calibration (judge vs first reviewer verdict, workers, non-communication)");
    expect(calibration).toContain("14 workers judged");
    expect(calibration).toContain("12 with a bound verdict (coverage 86%); 2 unbound");
    expect(calibration).toContain("| pass | 4 | 2 |");
    expect(calibration).toContain("| fail | 3 | 3 |");
    expect(calibration).toContain("Disagreement rate 42% (5/12)");
  });

  test("calibration with fewer than 10 bound verdicts says insufficient evidence and prints no matrix", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    for (let i = 0; i < 3; i++) { judgedWorker(state, `thr_w${i}`, true); verdict(state, `thr_w${i}`, "approve", true); }
    const calibration = section(await readFile((await world.run()).path!, "utf8"), "Calibration (judge vs first reviewer verdict, workers, non-communication)");
    expect(calibration).toContain("insufficient evidence (n=3)");
    expect(calibration).not.toContain("| pass |");
  });

  test("an accepted lesson with fewer than 5 judged threads on a side shows too few, never a rate", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    state.db.prepare(`INSERT INTO chief_lessons (project_id, text, source_thread_id, at, status, decided_at) VALUES ('proj_1', 'Keep briefs short.', 'thr_x', ?, 'accepted', ?)`).run(Date.now() - 2 * DAY, Date.now() - DAY);
    const lessons = section(await readFile((await world.run()).path!, "utf8"), "Lessons");
    expect(lessons).toMatch(/accepted #\d+: pass rate before→after too few \(n<5; before n=0, after n=0\)/);
    expect(lessons).not.toMatch(/\d+% \(n=/);
  });
});
