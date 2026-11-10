import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import { APPROVE, NO_DEVIATIONS, chiefReview, completeWorker, delegate, disposals, disposeAll, execFileMock, ghHead, rowOf, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// Forge comments (wave 2): the callers in server.ts reach the outbox through the real gh adapter, so every test routes the
// forge CLI at the execFile boundary. The same assertions hold on the pre-move base (c8a0d76) and on the module.
describe("forge comments", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const PR = "https://github.com/acme/shop/pull/8";
  const markerOf = (key: string) => `<!-- chief:${createHash("sha1").update(key).digest("hex").slice(0, 16)} -->`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (done: () => unknown) => { for (let i = 0; i < 300 && !done(); i += 1) await sleep(5); expect(done()).toBeTruthy(); };
  const call = (state: State, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, projectId: "proj_1" }) as Promise<any>;
  const rows = (state: State) => state.db.prepare(`SELECT * FROM forge_comments ORDER BY created_at, dedupe_key`).all() as any[];
  const rowOf = (state: State, id: string) => state.db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(id) as any;
  const forgeCalls = () => execFileMock.mock.calls.filter(([file, args]) => file === "gh" && args[0] === "api");
  const postCalls = () => forgeCalls().filter(([, args]) => args.includes("POST"));
  const bodyOf = (args: string[]) => args.find((arg) => arg.startsWith("body="))!.slice(5);
  const never = () => new Promise<never>(() => {});
  const bad = () => Object.assign(new Error("gh failed"), { stderr: "HTTP 502 bad gateway" });
  /** gh answers pull-request lookups as the other tests do; `forge` decides what the comment API does. */
  const route = (forge: (args: string[]) => unknown) => execFileMock.mockImplementation(async (file: string, args: string[]) =>
    file === "gh" && args[0] === "api" ? forge(args) : file === "gh" && args[0] === "pr" ? { stdout: ghHead("feature/x") } : { stdout: "" });
  const ISSUE = "https://github.com/acme/shop/issues/7";
  // The pre-move code caches a forge login per host for the whole process, so any case that reaches a login lookup runs on a host
  // of its own: the same assertions then hold on base and on the module, whatever ran before.
  let hostCount = 0;
  const freshHost = () => `forge${hostCount += 1}.example.com`;
  const prOn = (host: string) => `https://${host}/acme/shop/pull/8`;
  type Op = "post" | "scan" | "login";
  const opOf = (args: string[]): Op => args.includes("POST") ? "post" : args.includes("--paginate") ? "scan" : "login";
  const callsOf = (op: Op) => forgeCalls().filter(([, args]) => opOf(args) === op);
  const ANSWERS: Record<Op, unknown> = { post: { stdout: "" }, scan: { stdout: "" }, login: { stdout: "boss\n" } };
  /** Every comment call answers normally, except the operations `override` takes over. */
  const routeOps = (override: Partial<Record<Op, (args: string[]) => unknown>> = {}) =>
    route((args) => (override[opOf(args)] ?? (() => ANSWERS[opOf(args)]))(args));
  /** A comment call that stays unresolved until `release()`, then answers as a healthy forge would. */
  const gate = (op: Op) => { let release!: () => void; const held = new Promise((resolve) => { release = () => resolve(ANSWERS[op]); }); return { held, release }; };
  const alerts = (state: State, text: string) => state.sent.filter((message) => String(message.input?.[0]?.text).includes(text));
  const sentText = (state: State, from: number) => state.sent.slice(from).map((message) => ({ threadId: message.threadId, text: message.input[0].text }));

  async function blockedWorker(state: State, forge: { issueUrl?: string; prUrl?: string } = { prUrl: PR }) {
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix totals", forge);
    return { chief, worker, act: () => call(state, "chief_report", { state: "blocked", result: "Tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" }, worker.threadId) };
  }
  const readyWorker = async (state: State, forge?: { issueUrl?: string; prUrl?: string }) => {
    const { chief, worker } = await blockedWorker(state, forge);
    await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker.threadId);
    state.live.set(worker.threadId, { ...state.live.get(worker.threadId)!, status: "idle" });
    return { chief, worker };
  };

  /** What a caller owes its own user whatever the forge does: its returned text, its committed state and the full Report to its Chief. */
  type Scenario = {
    chief: string; prefix: string; act: () => Promise<unknown>; result: string;
    /** The managed row the report or completion changes, and the fields it must hold afterwards. */
    row: { id: string; fields: object };
    /** The one Report alert Chief receives, in full; null when the caller sends none. */
    report: { from: string; text: string } | null;
  };
  const CALLERS: [string, (state: State, pr: string) => Promise<Scenario>][] = [
    ["blocked report", async (state, pr) => {
      const { chief, worker, act } = await blockedWorker(state, { prUrl: pr });
      return {
        chief: chief.threadId, prefix: "blocked:", act, result: "Report delivered to Chief.",
        row: { id: worker.threadId, fields: { state: "blocked", last_report_state: "blocked", report_seq: 1, blocker: "Totals test fails", recommendation: "Fix the product code", result: "Tests fail" } },
        report: { from: worker.threadId, text: `[Chief lifecycle alert]\nWorker report from Fix totals (${worker.threadId})\nState: blocked\nBlocked: Totals test fails — decide or escalate to the user.\nBlocker: Totals test fails\nRecommendation: Fix the product code\nResult: Tests fail` },
      };
    }],
    ["reviewer verdict", async (state, pr) => {
      const { chief, worker } = await readyWorker(state, { prUrl: pr });
      const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
      return {
        chief: chief.threadId, prefix: "verdict:", act: () => call(state, "chief_report", { state: "ready", result: "Reviewed", ...APPROVE }, review.threadId), result: "Report delivered to Chief.",
        row: { id: review.threadId, fields: { state: "ready", verdict: "approve", last_report_state: "ready", report_seq: 1, result: "Reviewed" } },
        report: { from: review.threadId, text: `[Chief lifecycle alert]\nReviewer report from Review · Fix totals (${review.threadId})\nState: ready\nVerdict: approve\nVerdict file: ${join(state.storageRoot, "chief", "proj_1", review.threadId, "verdict-1.md")}\nThe reviewer approves. chief_complete (threadId: ${worker.threadId}); it marks the pull request ready. Nits listed with an approve are optional: start no worker round for them alone.\nFull report and last output: bb chief inspect ${review.threadId}\nResult: Reviewed` },
      };
    }],
    ["completion", async (state, pr) => {
      const { chief, worker } = await readyWorker(state, { prUrl: pr });
      return {
        chief: chief.threadId, prefix: "complete:", act: () => completeWorker(state, chief.threadId, worker.threadId),
        result: "Marked “Fix totals” complete without a review (reason recorded).\nIts pull request is marked ready for review.\nNo cleanup: no approving review.",
        row: { id: worker.threadId, fields: { state: "complete", last_report_state: "ready", report_seq: 1, result: `Done${NO_DEVIATIONS}` } },
        report: null,
      };
    }],
  ];
  const reporterOutbox = (state: State, reporter: string) =>
    state.db.prepare(`SELECT dedupe_key, delivered_at FROM alert_outbox WHERE dedupe_key LIKE ?`).all(`${reporter}:report:%`) as { dedupe_key: string; delivered_at: number | null }[];
  /** The caller's own work, as base produces it: asserted while a forge call is unresolved, and again after it settles. */
  function expectRequiredWork(state: State, scenario: Scenario, sentBefore: number, outboxBefore: number) {
    expect(rowOf(state, scenario.row.id)).toMatchObject(scenario.row.fields);
    expect(sentText(state, sentBefore)).toEqual(scenario.report ? [{ threadId: scenario.chief, text: scenario.report.text }] : []);
    if (!scenario.report) return;
    // The full Report replaced its pending fallback in the outbox and was marked delivered.
    const outbox = reporterOutbox(state, scenario.report.from);
    expect(outbox).toHaveLength(outboxBefore + 1);
    expect(outbox.filter((entry) => entry.dedupe_key.includes("pending-"))).toEqual([]);
    expect(outbox.every((entry) => entry.delivered_at)).toBe(true);
  }
  const SEED_ROW = (state: State, chief: string, target: string, attempts: number, mention: number) => {
    const key = `escalate:${chief}:seeded`;
    state.db.prepare(`INSERT INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, attempts, created_at) VALUES (?, 'proj_1', ?, ?, ?, ?, ?, ?)`)
      .run(key, chief, target, `seeded body\n\n${markerOf(key)}`, mention, attempts, Date.now() - 60_000);
    return key;
  };
  // Which comment operation each case holds up: post is the caller's own new row; a leftover row with earlier attempts reaches
  // the marker scan first; a leftover row that wants a mention reaches the login lookup first. Both leftovers sit ahead of the new row.
  const OPS: { op: Op; seed: [attempts: number, mention: number] | null; held: { seeded: number; caller: number; calls: [post: number, scan: number, login: number] }; rejected: { seeded: number; calls: [number, number, number] } }[] = [
    { op: "post", seed: null, held: { seeded: 0, caller: 1, calls: [1, 0, 0] }, rejected: { seeded: 0, calls: [1, 0, 0] } },
    { op: "scan", seed: [1, 0], held: { seeded: 2, caller: 0, calls: [0, 1, 0] }, rejected: { seeded: 2, calls: [1, 1, 0] } },
    { op: "login", seed: [0, 1], held: { seeded: 1, caller: 0, calls: [0, 0, 1] }, rejected: { seeded: 1, calls: [2, 0, 1] } },
  ];
  const SCAN_ARGS = (host: string) => ["api", "--hostname", host, "--paginate", "repos/acme/shop/issues/8/comments", "--jq", ".[].body"];
  const LOGIN_ARGS = (host: string) => ["api", "--hostname", host, "user", "--jq", ".login"];

  // Contract "Required result never waits on optional work (R3)": while a post, a marker scan or a login lookup is unresolved,
  // each caller returns the text it returns on base, holds its committed state, and has delivered its full Report to its Chief.
  // Releasing the call lets delivery resume. Regression: a caller awaits a comment call, the call runs inside the transaction,
  // or the Report is left at its pending fallback.
  describe.each(OPS)("while a comment $op call is unresolved", ({ op, seed, held }) => {
    test.each(CALLERS)("%s returns, commits and reports in full, and delivery resumes on release", async (_name, build) => {
      const state = await setup();
      const hold = gate(op);
      routeOps({ [op]: () => hold.held });
      const host = freshHost();
      const scenario = await build(state, prOn(host));
      const seeded = seed ? SEED_ROW(state, scenario.chief, prOn(host), ...seed) : null;
      const sentBefore = state.sent.length;
      const outboxBefore = scenario.report ? reporterOutbox(state, scenario.report.from).length : 0;
      const rowOfKey = (key: string | undefined) => rows(state).find((row) => row.dedupe_key === key);
      const callerKey = () => rows(state).find((row) => row.dedupe_key.startsWith(scenario.prefix))?.dedupe_key;
      try {
        expect(await scenario.act()).toBe(scenario.result);
        expectRequiredWork(state, scenario, sentBefore, outboxBefore);
        // The stuck call was really reached, and nothing past it ran.
        await until(() => callsOf(op).length === 1);
        await until(() => (rowOfKey(seeded ?? callerKey())?.attempts ?? 0) === (seeded ? held.seeded : held.caller));
        expect([callsOf("post").length, callsOf("scan").length, callsOf("login").length]).toEqual(held.calls);
        expect(rowOfKey(callerKey())).toMatchObject({ attempts: held.caller, posted_at: null, gave_up_at: null });
        // A supervisor tick neither waits for the stuck pass nor starts a second call.
        await state.supervisorCycle();
        expect([callsOf("post").length, callsOf("scan").length, callsOf("login").length]).toEqual(held.calls);
        expectRequiredWork(state, scenario, sentBefore, outboxBefore);
      } finally {
        hold.release();
      }
      await until(() => rows(state).length > 0 && rows(state).every((row) => row.posted_at));
      expectRequiredWork(state, scenario, sentBefore, outboxBefore);
      const callerBody = rowOfKey(callerKey())!.body;
      const seededBody = seed ? `seeded body\n\n${seed[1] ? "@boss\n\n" : ""}${markerOf(seeded!)}` : null;
      expect(postCalls().map(([, args]) => bodyOf(args))).toEqual(seededBody ? [seededBody, callerBody] : [callerBody]);
      if (op === "scan") expect(callsOf("scan").map(([, args]) => args)).toEqual([SCAN_ARGS(host)]);
      if (op === "login") expect(callsOf("login").map(([, args]) => args)).toEqual([LOGIN_ARGS(host)]);
    });
  });

  // Same contract, with every comment call failing: the callers are unchanged, and each row records the failed attempt.
  describe.each(OPS)("while every comment call fails, with a $op operation reached", ({ seed, rejected }) => {
    test.each(CALLERS)("%s returns, commits and reports in full", async (_name, build) => {
      const state = await setup();
      const fail = () => { throw bad(); };
      routeOps({ post: fail, scan: fail, login: fail });
      const host = freshHost();
      const scenario = await build(state, prOn(host));
      const seeded = seed ? SEED_ROW(state, scenario.chief, prOn(host), ...seed) : null;
      const sentBefore = state.sent.length;
      const outboxBefore = scenario.report ? reporterOutbox(state, scenario.report.from).length : 0;
      expect(await scenario.act()).toBe(scenario.result);
      expectRequiredWork(state, scenario, sentBefore, outboxBefore);
      await until(() => rows(state).length > (seed ? 1 : 0) && rows(state).every((row) => row.last_error));
      const caller = rows(state).find((row) => row.dedupe_key.startsWith(scenario.prefix));
      expect(caller).toMatchObject({ attempts: 1, posted_at: null, gave_up_at: null, last_error: expect.stringContaining("502") });
      if (seeded) expect(rows(state).find((row) => row.dedupe_key === seeded)).toMatchObject({ attempts: rejected.seeded, posted_at: null, gave_up_at: null, last_error: expect.stringContaining("502") });
      expect([callsOf("post").length, callsOf("scan").length, callsOf("login").length]).toEqual(rejected.calls);
      expectRequiredWork(state, scenario, sentBefore, outboxBefore);
    });
  });

  // Contract "Equivalence of stored rows": for fixed inputs through the real callers, the stored row and the POSTed comment are
  // these literals (written by hand from the base behaviour, never produced by the code under test): key form, project, thread,
  // target choice, body, mention flag, mention placement and the marker as the last line. The same table runs on base c8a0d76.
  // Regression: any changed title, round, line, detail text, key, target choice or mention position.
  type Golden = { key: string; thread: string; target: string; body: string; mention: 0 | 1; post?: string; path?: string; host?: string };
  const GOLDENS: [string, (state: State) => Promise<{ act: () => Promise<unknown>; golden: Golden }>][] = [
    ["blocked report (target: the pull request over the issue)", async (state) => {
      const { worker, act } = await blockedWorker(state, { issueUrl: ISSUE, prUrl: PR });
      const key = `blocked:${worker.threadId}:1`;
      return { act, golden: { key, thread: worker.threadId, target: PR, mention: 0, body: `**Chief · Blocked** · round 1\n**Blocker:** Totals test fails\n**Recommendation:** Fix the product code\n\n${markerOf(key)}` } };
    }],
    ["reviewer verdict of a worker (request_changes with findings, round and reviewed head)", async (state) => {
      const { chief, worker } = await readyWorker(state, { issueUrl: ISSUE, prUrl: PR });
      const review = await chiefReview(state, chief.threadId, { workerThreadId: worker.threadId });
      const key = `verdict:${review.threadId}:1:${worker.threadId}`;
      return {
        act: () => call(state, "chief_report", {
          state: "ready", result: "Totals go negative when the discount exceeds the subtotal.", recommendation: "Clamp at zero.", verdict: "request_changes",
          findings: [{ file: "totals.ts", line: 1, severity: "blocking", message: "Totals go negative." }, { file: "totals.ts", line: 9, severity: "nit", message: "Rename tmp." }],
        }, review.threadId),
        golden: {
          key, thread: review.threadId, target: PR, mention: 0,
          body: `**Chief · Review verdict** · round 1\n**Changes requested**\nReviewed head: \`aaaaaaaaaaaa\`\n1 blocking finding, 1 nit\n\n<details><summary>Findings and recommendation</summary>\n\n### Blocking findings\n\n- totals.ts:1 — Totals go negative.\n\n### Nits\n\n- totals.ts:9 — Rename tmp.\n\n### Findings\n\nTotals go negative when the discount exceeds the subtotal.\n\n### Recommendation\n\nClamp at zero.\n\n</details>\n\n${markerOf(key)}`,
        },
      };
    }],
    ["reviewer verdict of a pull request (approve, no worker in the key, no round)", async (state) => {
      const { chief } = await blockedWorker(state);
      const review = await chiefReview(state, chief.threadId, { pullRequest: PR });
      const key = `verdict:${review.threadId}:1`;
      return {
        act: () => call(state, "chief_report", { state: "ready", result: "Reviewed", ...APPROVE }, review.threadId),
        golden: { key, thread: review.threadId, target: PR, mention: 0, body: `**Chief · Review verdict**\n**Approved**\n0 blocking findings, 0 nits\n\n<details><summary>Findings and recommendation</summary>\n\n### Findings\n\nReviewed\n\n</details>\n\n${markerOf(key)}` },
      };
    }],
    ["completion (target: the issue over the pull request)", async (state) => {
      const { chief, worker } = await readyWorker(state, { issueUrl: ISSUE, prUrl: PR });
      const key = `complete:${worker.threadId}`;
      return {
        act: () => completeWorker(state, chief.threadId, worker.threadId),
        golden: {
          key, thread: worker.threadId, target: ISSUE, mention: 0, path: "repos/acme/shop/issues/7/comments",
          body: `**Chief · Completed** · round 1\n**Fix totals**\nPull request: ${PR}\n**Planning skipped:** Bounded test fixture\n**Review skipped:** review is not under test here\n**Tests skipped:** tests are not under test here\n\n<details><summary>Result</summary>\n\nDone\n\n## Deviations from plan\nNone\n\n</details>\n\n${markerOf(key)}`,
        },
      };
    }],
    ["escalation (configured handle: the mention line sits before the marker, the stored body has none)", async (state) => {
      await state.harness.behavior.setSettings({ forgeOwnerHandle: "@boss" });
      const { chief, worker } = await blockedWorker(state);
      const request = "Pick a currency rounding rule.";
      const key = `escalate:${worker.threadId}:${createHash("sha1").update(request).digest("hex").slice(0, 12)}`;
      return {
        // The same request twice: one row, one post.
        act: async () => {
          const first = await call(state, "chief_escalate", { threadId: worker.threadId, request }, chief.threadId);
          const second = await call(state, "chief_escalate", { threadId: worker.threadId, request }, chief.threadId);
          expect([first, second]).toEqual(Array(2).fill(`Queued for ${PR}. Now write the same request in chat under **Need you**.`));
        },
        golden: { key, thread: worker.threadId, target: PR, mention: 1, body: `**Chief · Need you**\n${request}\n\n${markerOf(key)}`, post: `**Chief · Need you**\n${request}\n\n@boss\n\n${markerOf(key)}` },
      };
    }],
    ["escalation (no configured handle: the forge login is the mention)", async (state) => {
      const host = freshHost();
      const { chief, worker } = await blockedWorker(state, { prUrl: prOn(host) });
      const request = "Choose between the two migrations.";
      const key = `escalate:${worker.threadId}:${createHash("sha1").update(request).digest("hex").slice(0, 12)}`;
      return {
        act: () => call(state, "chief_escalate", { threadId: worker.threadId, request }, chief.threadId),
        golden: { key, thread: worker.threadId, target: prOn(host), host, mention: 1, body: `**Chief · Need you**\n${request}\n\n${markerOf(key)}`, post: `**Chief · Need you**\n${request}\n\n@boss\n\n${markerOf(key)}` },
      };
    }],
  ];
  test.each(GOLDENS)("%s stores and posts the golden comment once", async (_name, build) => {
    const state = await setup();
    routeOps();
    const { act, golden } = await build(state);
    await act();
    await until(() => rows(state).length && rows(state).every((row) => row.posted_at));
    expect(rows(state).map(({ dedupe_key, project_id, thread_id, target, body, mention }) => ({ dedupe_key, project_id, thread_id, target, body, mention })))
      .toEqual([{ dedupe_key: golden.key, project_id: "proj_1", thread_id: golden.thread, target: golden.target, body: golden.body, mention: golden.mention }]);
    expect(golden.body.endsWith(`\n\n${markerOf(golden.key)}`)).toBe(true);
    expect(postCalls().map(([file, args]) => [file, args])).toEqual([["gh", ["api", "--hostname", golden.host ?? "github.com", "--method", "POST", golden.path ?? "repos/acme/shop/issues/8/comments", "-f", `body=${golden.post ?? golden.body}`]]]);
    // A later pass finds nothing pending.
    await state.supervisorCycle();
    await sleep(20);
    expect(postCalls()).toHaveLength(1);
  });

  // Contract "Rolled-back transaction writes nothing": the verdict/blocked row is enqueued inside report()'s transaction.
  // Regression: the post is started before the commit, or the row survives the rollback.
  test("a report whose transaction rolls back queues no row and posts nothing", async () => {
    const state = await setup();
    route(() => ({ stdout: "" }));
    const { worker, act } = await blockedWorker(state);
    state.db.exec(`DROP TABLE alert_outbox`);
    await expect(act()).rejects.toThrow();
    await sleep(30);
    expect(rows(state)).toEqual([]);
    expect(forgeCalls()).toHaveLength(0);
    expect(rowOf(state, worker.threadId).state).not.toBe("blocked");
  });

  // Contract "enqueue defers the alert": a queue-write failure never fails the report; Chief hears of it after the commit.
  test("a failed queue write leaves the report intact and alerts Chief", async () => {
    const state = await setup();
    route(() => ({ stdout: "" }));
    const { worker, act } = await blockedWorker(state);
    state.db.exec(`DROP TABLE forge_comments`);
    await act();
    expect(rowOf(state, worker.threadId).state).toBe("blocked");
    await until(() => alerts(state, "Could not queue the forge comment blocked").length);
    expect(alerts(state, "The local record is intact.")).not.toHaveLength(0);
    expect(forgeCalls()).toHaveLength(0);
  });

  // Contract "Exactly one escalation" + inherited limits: a row left at attempts=5 by an earlier process runs again at once
  // as attempt 6 on a fresh instance, scans first, and escalates once with the "after 5 attempts" text. These are limits kept, not fixed.
  test("a row left at 5 attempts retries at once after a restart, escalates once, and is then terminal", async () => {
    const state = await setup();
    const { worker } = await blockedWorker(state);
    const key = `blocked:${worker.threadId}:9`;
    state.db.prepare(`INSERT INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, attempts, created_at) VALUES (?, 'proj_1', ?, ?, ?, 0, 5, ?)`)
      .run(key, worker.threadId, PR, `body\n\n${markerOf(key)}`, Date.now());
    const order: string[] = [];
    route((args) => {
      if (args.includes("POST")) { order.push("post"); throw bad(); }
      order.push("scan");
      return { stdout: "" };
    });
    await state.supervisorCycle();
    await until(() => rows(state)[0]?.gave_up_at);
    expect(order).toEqual(["scan", "post"]);
    expect(rows(state)[0]).toMatchObject({ attempts: 6, posted_at: null });
    await until(() => alerts(state, "after 5 attempts").length === 1);
    await state.supervisorCycle();
    await sleep(30);
    expect(forgeCalls()).toHaveLength(2);
    expect(alerts(state, "after 5 attempts")).toHaveLength(1);
  });

  test("a row that exhausts its attempts for a thread with no Chief is logged as an error, not alerted", async () => {
    const state = await setup();
    const { worker } = await blockedWorker(state);
    state.db.prepare(`UPDATE managed_threads SET chief_thread_id=NULL WHERE thread_id=?`).run(worker.threadId);
    const key = `blocked:${worker.threadId}:9`;
    state.db.prepare(`INSERT INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, attempts, created_at) VALUES (?, 'proj_1', ?, ?, ?, 0, 4, ?)`)
      .run(key, worker.threadId, PR, `body\n\n${markerOf(key)}`, Date.now());
    route((args) => { if (args.includes("POST")) throw bad(); return { stdout: "" }; });
    await state.supervisorCycle();
    await until(() => state.harness.logEntries.some((entry) => entry.level === "error" && entry.message.includes("after 5 attempts")));
    expect(alerts(state, "after 5 attempts")).toHaveLength(0);
  });

  // Contract "Table persistence and migration index": the host hashes each migration statement by index and refuses a mismatch,
  // so the statement list keeps its base prefix byte for byte and forge_comments stays at index 114.
  // The digests were computed on base c8a0d76. Regression: a statement before index 114 moves or changes, or the table text drifts.
  test("the migration prefix and the forge_comments statement match the base bytes", () => {
    const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(131);
    expect(sha256(JSON.stringify(MIGRATIONS.slice(0, 131)))).toBe("06d2542eb36bce964295e9664ed9ce6670c59f03bf1bd605a5bae6092acfa6ba");
    expect(MIGRATIONS[114]).toMatch(/^CREATE TABLE forge_comments/);
    expect(sha256(MIGRATIONS[114]!)).toBe("a3417ec24942a9bbcebd37d78f81c24adfc436e63223e91291d30553a718982c");
  });

  const upgradeHost = () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade" });
    disposals.push(() => harness.lifecycle.dispose());
    return { bb, db: bb.storage.database() };
  };
  // Contract "Persisted format unchanged": a database migrated before forge_comments upgrades without losing its rows, and the
  // unchanged full statement list replays on the migrated database without error and without changing schema or data.
  // Regression: the upgrade drops or rewrites an existing row, or replaying the same list re-runs or re-records a statement.
  test("a database migrated before forge_comments upgrades with its rows intact, and replaying the full list changes nothing", () => {
    const { bb, db } = upgradeHost();
    bb.storage.migrate(db, MIGRATIONS.slice(0, 114));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='forge_comments'`).get()).toBeUndefined();
    db.prepare(`INSERT INTO managed_threads (thread_id, role, project_id, title, state, created_at, updated_at) VALUES ('thr_keep', 'worker', 'proj_1', 'Keep me', 'ready', 1, 2)`).run();

    bb.storage.migrate(db, MIGRATIONS);
    expect(db.prepare(`SELECT name FROM pragma_table_info('forge_comments') ORDER BY cid`).all().map((column: any) => column.name))
      .toEqual(["dedupe_key", "project_id", "thread_id", "target", "body", "mention", "attempts", "last_error", "posted_at", "gave_up_at", "created_at"]);
    // Statements after the table (ALTER managed_threads) ran over the existing row, which kept its values.
    expect(db.prepare(`SELECT thread_id, role, project_id, title, state, created_at, updated_at, plan_issue_url, plan_review FROM managed_threads`).all())
      .toEqual([{ thread_id: "thr_keep", role: "worker", project_id: "proj_1", title: "Keep me", state: "ready", created_at: 1, updated_at: 2, plan_issue_url: null, plan_review: null }]);

    const snapshot = () => {
      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((table) => table.name);
      return {
        schema: db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all(),
        data: Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()])),
      };
    };
    const migrated = snapshot();
    expect(migrated.data._bb_migrations).toHaveLength(MIGRATIONS.length);
    expect(() => bb.storage.migrate(db, MIGRATIONS)).not.toThrow();
    expect(snapshot()).toEqual(migrated);
  });

  // The host refuses to start on a statement whose bytes changed at an applied index; that is a separate promise from the replay above.
  test("the host refuses a changed forge_comments statement on a migrated database", () => {
    const { bb, db } = upgradeHost();
    bb.storage.migrate(db, MIGRATIONS);
    const changed = MIGRATIONS.map((statement, index) => index === 114 ? `${statement} ` : statement);
    expect(() => bb.storage.migrate(db, changed)).toThrow(/migration 114 does not match/);
  });
});
