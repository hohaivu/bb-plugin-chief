import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { delegate, disposeAll, setup } from "./harness";
import { dailyWorld, localDay, restoreEnv } from "./dailyFixture";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(async () => { vi.unstubAllGlobals(); restoreEnv(); await disposeAll(); });

// Contracts (docs/specs/observability.md, "Daily report"): one file and one self-alert per local date, no Chief means no report,
// the ledger keeps 90 days, one adapter's failure never touches another section, Sentry issues split into new and recurring,
// and the report stays within 60,000 characters on whole items.
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

  test("the scorecard counts request_changes per thread from old rows (round=N) and new rows (no detail) alike", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    const row = (id: string, thread: string | null, kind: string, at: number, detail: string | null) =>
      state.db.prepare(`INSERT INTO chief_events (event_id, at, thread_id, kind, detail) VALUES (?, ?, ?, ?, ?)`).run(id, at, thread, kind, detail);
    const hour = Date.now() - 3_600_000;
    row("rc-1", "thr_a", "request_changes", hour, "round=1"); // written before the gate
    row("rc-2", "thr_a", "request_changes", hour + 1, null); // written by the gate
    row("rc-3", "thr_a", "request_changes", hour + 2, null);
    row("rc-4", "thr_b", "request_changes", hour + 3, "round=2");
    row("rc-5", "thr_c", "request_changes", hour + 4, null);
    row("rc-6", "thr_c", "request_changes", Date.now() - 30 * 3_600_000, null); // previous window
    row("rc-7", null, "request_changes", hour + 5, null); // no thread: counted in no thread
    const report = await readFile((await world.run()).path!, "utf8");
    expect(report).toMatch(/\| request_changes \| 6 \| 1 \|/);
    expect(report).toMatch(/\| threads with ≥ 2 request_changes \| 1 \| 0 \|/);
    expect(report).toMatch(/\| most request_changes on one thread \| 3 \| 1 \|/);
  });

  test("a tests_skipped row from before the gate stays readable in the scorecard", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    state.db.prepare(`INSERT INTO chief_events (event_id, at, thread_id, kind, detail) VALUES ('ts-1', ?, 'thr_a', 'tests_skipped', 'no tests needed')`).run(Date.now() - 3_600_000);
    expect(await readFile((await world.run()).path!, "utf8")).toMatch(/\| tests_skipped \| 1 \| 0 \|/);
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

describe("daily report: lessons", () => {
  test("lists a proposed lesson, with no pass-rate line and none of the retired score sections", async () => {
    const state = await setup();
    const world = await dailyWorld(state);
    const lesson = (text: string, status: string, decidedAt: number | null) => state.db.prepare(`INSERT INTO chief_lessons (project_id, text, source_thread_id, at, status, decided_at) VALUES ('proj_1', ?, 'thr_x', ?, ?, ?)`).run(text, Date.now() - 2 * DAY, status, decidedAt).lastInsertRowid;
    const proposed = lesson("Keep briefs short.", "proposed", null);
    lesson("Name the verify command.", "accepted", Date.now() - DAY);
    const report = await readFile((await world.run()).path!, "utf8");
    const lessons = report.split(/^## /m).find((section) => section.startsWith("Lessons\n")); // up to the next level-two heading
    expect(lessons).toContain(`- #${proposed}: Keep briefs short.`);
    expect(report).not.toContain("pass rate");
    for (const title of ["Score trend", "Calibration", "Communication", "Failed threads"]) expect(report).not.toMatch(new RegExp(`^## ${title}`, "m"));
  });
});
