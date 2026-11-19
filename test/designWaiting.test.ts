import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { delegate, disposeAll, setup, start, status } from "./harness";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// The design researcher's waiting marker (docs/specs/research.md, Supervision and Researcher rows; plan thr_zbmxhv55e9 wave 1).
describe("design researcher waiting on the user", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const alertsTo = (state: State, chief: string) => state.sent.filter((message) => message.threadId === chief).map((message) => message.input[0].text as string);
  const row = (state: State, id: string) => state.db.prepare("SELECT state, waiting_on_user, report_seq, last_report_state FROM managed_threads WHERE thread_id=?").get(id) as { state: string; waiting_on_user: number; report_seq: number; last_report_state: string | null };
  const failureKinds = (state: State, id: string) => (state.db.prepare("SELECT kind FROM chief_failure_events WHERE source_thread_id=? ORDER BY kind").all(id) as { kind: string }[]).map((entry) => entry.kind);

  async function chiefWith(state: State, design: boolean) {
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.callAgentTool("chief_research", { question: "Who calls this?", design }, opts);
    const researcher = (await status(state)).threads.find((thread: { role: string; threadId: string }) => thread.role === "researcher")!.threadId;
    return { chief: chief.threadId, opts, researcher, as: { threadId: researcher, projectId: "proj_1" } };
  }
  const report = (state: State, who: { threadId: string; projectId: string }, params: Record<string, unknown>) => state.harness.behavior.callAgentTool("chief_report", params, who);
  const WAITING = { state: "active", waitingOnUser: true, result: "Design discussion: waiting on the user. Design: /tmp/design.md" };
  const blocked = (blocker: string, extra: Record<string, unknown> = {}) => ({ state: "blocked", blocker, recommendation: "Ask the user in the researcher thread.", ...extra });

  // Contract (research.md Researcher rows): waitingOnUser is refused for other roles, light researchers and states other than active and blocked.
  // Regression: the marker accepted from a worker or a light researcher mutes their stall supervision.
  test.each([
    ["a worker", "worker", { ...WAITING }],
    ["a light researcher", "light", { ...WAITING }],
    ["a design researcher reporting ready", "design", { state: "ready", waitingOnUser: true, result: "Helpers: 0" }],
    ["a design researcher reporting idle", "design", { state: "idle", waitingOnUser: true }],
  ])("%s cannot set waitingOnUser", async (_name, who, params) => {
    const state = await setup();
    const ctx = await chiefWith(state, who !== "light");
    const target = who === "worker" ? { threadId: (await delegate(state, ctx.chief)).threadId, projectId: "proj_1" } : ctx.as;
    const before = row(state, target.threadId);
    await expect(report(state, target, params)).rejects.toThrow(/waitingOnUser/);
    expect(row(state, target.threadId)).toEqual(before);
    expect(before.waiting_on_user).toBe(0);
  });

  // Contract: a design researcher's active and blocked reports with the flag store the marker.
  test.each([["active", WAITING], ["blocked", blocked("Round open. Design: /tmp/design.md", { waitingOnUser: true })]])("a design researcher's %s report with the flag stores the marker", async (name, params) => {
    const state = await setup();
    const ctx = await chiefWith(state, true);
    await report(state, ctx.as, params);
    expect(row(state, ctx.researcher)).toMatchObject({ state: name, waiting_on_user: 1 });
  });

  describe("blocked-route precedence", () => {
    // Contract (research.md Supervision table): `blocked`, waiting → the Next line routes the round through chief_escalate and design.md, in the report alert and in chief_roster Pending.
    // Regression: the generic "Blocked: <clipped blocker> — decide or escalate" line for a waiting design researcher, which hides the round behind the alert's clip.
    test("a waiting blocked design researcher gets the escalate route in the alert and in the roster Pending, and a 4,000-character round is not carried by the clipped blocker", async () => {
      const state = await setup();
      const ctx = await chiefWith(state, true);
      const round = `Round 1 of the design. Design: /tmp/design.md\n${"Which database should hold the sessions? ".repeat(100).slice(0, 3_900)}ROUND-TAIL-MARKER`;
      expect(round.length).toBeGreaterThan(3_900);
      await report(state, ctx.as, blocked(round, { waitingOnUser: true }));
      await settle();
      const alert = alertsTo(state, ctx.chief).at(-1)!;
      expect(alert).toContain(`chief_escalate (threadId ${ctx.researcher}`);
      expect(alert).toContain("design.md");
      expect(alert).not.toContain("ROUND-TAIL-MARKER");
      const roster = String(await state.harness.behavior.callAgentTool("chief_roster", {}, ctx.opts));
      const pending = roster.slice(roster.indexOf("Pending:"));
      expect(pending).toContain(`chief_escalate (threadId ${ctx.researcher}`);
    });

    // Contract (research.md "a blocked researcher without waiting_on_user keeps the generic Next lines"). Regression: the escalate route applied to every blocked design researcher.
    test("a design researcher blocked without the flag keeps the generic Blocked line", async () => {
      const state = await setup();
      const ctx = await chiefWith(state, true);
      await report(state, ctx.as, blocked("The repository has no tests to read."));
      await settle();
      const alert = alertsTo(state, ctx.chief).at(-1)!;
      expect(alert).toContain("The repository has no tests to read.");
      expect(alert).not.toContain("chief_escalate (threadId");
    });
  });

  describe("stall supervision", () => {
    const THRESHOLD_MS = 60_000;
    const sessionFor = async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ stallMinutes: "1" });
      const ctx = await chiefWith(state, true);
      const t0 = 1_000_000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
      const goActive = async () => {
        state.live.set(ctx.researcher, { ...state.live.get(ctx.researcher)!, status: "active" });
        await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(ctx.researcher)! });
      };
      const named = () => alertsTo(state, ctx.chief).filter((text) => text.includes(ctx.researcher));
      return { state, ctx, t0, nowSpy, goActive, named };
    };

    // Contract (research.md Supervision and Researcher rows): a waiting active design researcher gets no stall alert, no hard stall alert and no recorded failure; a later
    // active report without the flag (a rejection restart) returns it to stall supervision. Regression: the marker never cleared by a later report, or the loop never skipping it.
    test("a waiting researcher is muted for the stall loop until an active report without the flag", async () => {
      const { state, ctx, t0, nowSpy, goActive, named } = await sessionFor();
      try {
        await goActive();
        await report(state, ctx.as, WAITING);
        const quiet = named().length;
        nowSpy.mockReturnValue(t0 + 3 * THRESHOLD_MS);
        await state.supervisorCycle();
        expect(named()).toHaveLength(quiet);
        expect(failureKinds(state, ctx.researcher)).toEqual([]);

        await report(state, ctx.as, { state: "active", result: "Research restarted: the user rejected the design direction." });
        expect(row(state, ctx.researcher)).toMatchObject({ state: "active", waiting_on_user: 0 });
        await goActive();
        const beforeStall = named().length;
        nowSpy.mockReturnValue(t0 + 3 * THRESHOLD_MS + THRESHOLD_MS + 1_000);
        await state.supervisorCycle();
        // The thread has been active since t0, so the first alert after the unmute is already the hard one.
        expect(named()).toHaveLength(beforeStall + 1);
        expect(failureKinds(state, ctx.researcher)).toEqual(["hard_stall"]);
      } finally {
        nowSpy.mockRestore();
      }
    });

    // Contract (research.md Researcher rows): a `failed` live state stores 0. Regression: a failed waiting researcher keeping the marker, so a restart is never supervised.
    test("a failed live sync clears the waiting marker", async () => {
      const { state, ctx, goActive } = await sessionFor();
      try {
        await goActive();
        await report(state, ctx.as, WAITING);
        expect(row(state, ctx.researcher).waiting_on_user).toBe(1);
        // The supervisor's reconcile syncs a live thread whose status is "error" to the failed state.
        state.live.set(ctx.researcher, { ...state.live.get(ctx.researcher)!, status: "error" });
        await state.supervisorCycle();
        expect(row(state, ctx.researcher).state).toBe("failed");
        expect(row(state, ctx.researcher).waiting_on_user).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
