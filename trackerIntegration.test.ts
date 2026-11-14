import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APPROVE, NO_DEVIATIONS, PLAN_FIXTURE, TEST_WAVE, chiefReview, completeWorker, delegate, disposeAll, execFileMock, ghHead, setup, start, status, wave, withoutAlertMarker } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tracker integration", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const P = { projectId: "proj_1" };
  const BB = process.env.BB_CLI ?? "bb";
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const call = (state: State, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, ...P }) as Promise<any>;
  const sha12 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
  const until = async (done: () => unknown) => { for (let i = 0; i < 300 && !done(); i += 1) await sleep(5); expect(done()).toBeTruthy(); };
  afterEach(() => { vi.useRealTimers(); });

  /** `bb tasks`, faked behind execFileMock: an in-memory tracker. gh answers as the forge-comment tests' does. */
  function tasksCli(options: { hang?: boolean } = {}) {
    const tasks = new Map<string, { description: string; comments: { id: string; kind: string; body: string; createdAt: string }[] }>();
    const calls: string[][] = [];
    const attachments: { task: string; name: string; content: string }[] = [];
    let tick = 0;
    const stamp = () => new Date(1_800_000_000_000 + (tick += 1_000)).toISOString();
    const ok = (body: object = {}) => ({ stdout: JSON.stringify({ ok: true, ...body }), stderr: "" });
    const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
    const addComment = (task: string, body: string) => {
      const comment = { id: `c${++tick}`, kind: "user", body, createdAt: stamp() };
      tasks.get(task)!.comments.push(comment);
      return comment;
    };
    execFileMock.mockImplementation(async (file: string, args: string[]) => {
      if (file === "gh") return args[0] === "pr" ? { stdout: ghHead("feature/x"), stderr: "" } : { stdout: args.includes("POST") || args.includes("--paginate") ? "" : "boss\n", stderr: "" };
      if (file !== BB || args[0] !== "tasks") return { stdout: "", stderr: "" };
      const a = args.slice(1, -1);
      calls.push(a);
      if (options.hang) return new Promise<never>(() => {});
      const [verb, id] = a;
      switch (verb) {
        case "create": { const task = `task_${tasks.size + 1}`; tasks.set(task, { description: flag(a, "--description"), comments: [] }); return ok({ task: { id: task } }); }
        case "list": return ok({ tasks: [...tasks].map(([task, value]) => ({ id: task, description: value.description })) });
        case "show": return ok({ task: { id, description: tasks.get(id!)!.description }, comments: tasks.get(id!)!.comments });
        case "comment": return ok({ comment: { id: addComment(id!, flag(a, "--body")).id } });
        case "attachment": attachments.push({ task: a[2]!, name: flag(a, "--name"), content: await readFile(flag(a, "--file"), "utf8") }); return ok();
        case "label": return a[1] === "list" ? ok({ labels: [] }) : ok();
        case "update": if (a.includes("--description")) tasks.get(id!)!.description = flag(a, "--description"); return ok();
        default: return ok();
      }
    });
    return {
      calls, attachments, tasks,
      /** The owner's reply on a task. */
      owner: (task: string, body: string) => addComment(task, body),
      of: (verb: string) => calls.filter((a) => a[0] === verb),
      statuses: () => calls.filter((a) => a[0] === "update" && a.includes("--status")).map((a) => a[a.indexOf("--status") + 1]!),
    };
  }
  type Tasks = ReturnType<typeof tasksCli>;

  const on = (state: State) => state.harness.behavior.setSettings({ plannerEnabled: true, tracker: "bb-tasks", trackerProjects: "proj_1=ABC" });
  /** Supervisor passes until the tracker has made no new call for one more pass. */
  async function settled(state: State, tasks: Tasks) {
    let last = -1;
    for (let i = 0; i < 30; i += 1) {
      await state.supervisorCycle();
      await sleep(25);
      if (tasks.calls.length === last) return;
      last = tasks.calls.length;
    }
    throw new Error("the tracker never went quiet");
  }
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const chiefCtx = (chief: string) => ({ threadId: chief, ...P });
  const plan = (state: State, chief: string, args: string[] = []) =>
    state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", ...args], chiefCtx(chief));
  const planners = async (state: State) => (await status(state)).threads.filter((row) => row.role === "planner").map((row) => row.threadId);
  const WAVES = [{ body: PLAN_FIXTURE }, TEST_WAVE(2)];
  // Only a plan of more than one implementation wave gets its one advisor review.
  const MULTI = [{ body: PLAN_FIXTURE }, { body: wave(2) }, TEST_WAVE(3)];
  const ready = (state: State, planner: string, waves: object[] = WAVES) => call(state, "chief_report", { state: "ready", result: "Waves written.", plan: waves }, planner);
  async function delegateTo(state: State, chief: string, args: string[]) {
    const result = await state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"], chiefCtx(chief));
    expect(result.exitCode, result.stderr).toBe(0);
    return (JSON.parse(result.stdout!) as { threadId: string }).threadId;
  }
  /** Ready report, an approving review, then Chief completes the worker. */
  async function approveAndComplete(state: State, chief: string, worker: string) {
    await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker);
    const review = await chiefReview(state, chief, { workerThreadId: worker });
    await call(state, "chief_report", { state: "ready", result: "Checked", ...APPROVE }, review.threadId);
    await call(state, "chief_complete", { threadId: worker }, chief);
  }
  const decisionBody = (n: number, request: string) =>
    `**Decision #${n}** (Chief)\n\n${request}\n\nAnswer with a comment; start it with #${n} when several decisions are open.\n\nchief-decision:${sha12(request)}`;
  const answerAlerts = (state: State) => state.sent.filter((message) => String(message.input?.[0]?.text).includes("The owner answered decision"));

  // Contract (tracker spec, Bootstrap + Mirroring): from an empty store a new plan becomes one task: created with the unit marker as
  // the last description line, the planner attached, status planning (todo), in that order, and only on a supervisor pass.
  // Regression: a tool that calls the CLI itself; a second create; attach before create; a wrong first status.
  test("tracker integration: a plan creates one task, attaches its planner and sets planning, on supervisor passes only", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [planner] = await planners(state);
    await until(() => state.db.prepare("SELECT 1 FROM tracker_units").get());
    expect(tasks.calls).toEqual([]);
    await settled(state, tasks);
    expect(tasks.calls).toEqual([
      ["status"],
      ["create", "--project", "ABC", "--title", "Rework checkout", "--description", `Propose how to fix totals\n\nchief-unit:${sha12(planner!)}`],
      ["attach", "task_1", "--thread", planner],
      ["update", "task_1", "--status", "todo"],
    ]);
    expect(state.db.prepare("SELECT task_id, create_state, status FROM tracker_units").all()).toEqual([{ task_id: "task_1", create_state: "sent", status: "planning" }]);
  });

  // Contract (spec, Mirroring + Planned unit): a revision creates no task; its planner is attached and the first planner detached after
  // that attach; the status follows the effective (revised) plan: working once its wave is delegated, done only when that plan is absorbed.
  // Regression: a second task for the revision; detach before the successor's attach; done while a wave is still open.
  test("tracker integration: a revision creates no task and the status follows the revised plan to done", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [first] = await planners(state);
    await ready(state, first!, MULTI);
    await call(state, "chief_consult", { planThreadId: first, title: "Plan", mission: "Review this plan before delegation" }, chief);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!.threadId;
    await call(state, "chief_report", { state: "ready", result: "Merge the waves", verdict: "request_changes" }, advisor);
    await plan(state, chief, ["--revises", first!]);
    const revised = (await planners(state)).find((id) => id !== first)!;
    await ready(state, revised);
    await settled(state, tasks);
    expect(tasks.of("create")).toHaveLength(1);
    expect(tasks.of("attach").map((a) => a[3])).toEqual([first, revised]);
    expect(tasks.calls.findIndex((a) => a[0] === "attach" && a[3] === revised)).toBeLessThan(tasks.calls.findIndex((a) => a[0] === "detach" && a[3] === first));
    expect(tasks.statuses()).toEqual(["todo"]);

    const wave1 = await delegateTo(state, chief, ["--plan-thread", revised, "--wave", "1"]);
    const wave2 = await delegateTo(state, chief, ["--replaces", wave1, "--plan-thread", revised, "--wave", "2"]);
    await settled(state, tasks);
    expect(tasks.statuses()).toEqual(["todo", "in_progress"]);

    await approveAndComplete(state, chief, wave2);
    await settled(state, tasks);
    expect(tasks.statuses()).toEqual(["todo", "in_progress", "done"]);
    expect(tasks.of("create")).toHaveLength(1);
  });

  // Contract (spec, Mirroring): a plan advisor's escalation posts its decision on the task of the plan it reviews, not on a new task.
  test("tracker integration: a plan advisor's chief_escalate posts on the plan's task", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [planner] = await planners(state);
    await ready(state, planner!, MULTI);
    await call(state, "chief_consult", { planThreadId: planner, title: "Plan", mission: "Review this plan before delegation" }, chief);
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!.threadId;
    await call(state, "chief_escalate", { threadId: advisor, request: "Split the plan in two?" }, chief);
    await settled(state, tasks);
    expect(tasks.of("create")).toHaveLength(1);
    expect(tasks.of("comment")).toEqual([["comment", "task_1", "--body", decisionBody(1, "Split the plan in two?"), "--author", "Chief"]]);
  });

  // Contract (spec, Mirroring + Unplanned unit): an unplanned delegation creates a working task; a replaces: successor is attached and
  // the predecessor detached after that attach; the unit stays working until the tip completes.
  // Regression: a completed predecessor finishing the unit; detach before attach; a second task for the successor.
  test("tracker integration: an unplanned delegation makes a task; replaces attaches the successor then detaches the predecessor", async () => {
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const chief = (await start(state)).threadId;
    const first = await delegate(state, chief);
    await settled(state, tasks);
    expect(tasks.calls.map((a) => a[0])).toEqual(["status", "create", "attach", "update"]);
    expect(tasks.of("create")[0]![4]).toBe("Fix checkout totals");
    expect(tasks.statuses()).toEqual(["in_progress"]);

    const second = await delegate(state, chief, "Fix checkout totals", { replaces: first.threadId });
    await settled(state, tasks);
    const at = (verb: string, thread: string) => tasks.calls.findIndex((a) => a[0] === verb && a[3] === thread);
    expect(at("attach", second.threadId)).toBeGreaterThan(-1);
    expect(at("detach", first.threadId)).toBeGreaterThan(at("attach", second.threadId));
    expect(tasks.of("create")).toHaveLength(1);
    expect(tasks.statuses()).toEqual(["in_progress"]);

    await completeWorker(state, chief, second.threadId);
    await settled(state, tasks);
    expect(tasks.statuses()).toEqual(["in_progress", "done"]);
  });

  const ISSUE = "https://github.com/acme/shop/issues/7";
  const norm = (state: State, text: string) => text.replaceAll(state.storageRoot, "<root>");
  const taskOf = (tasks: Tasks, root: string) => [...tasks.tasks].find(([, task]) => task.description.endsWith(`chief-unit:${sha12(root)}`))![0];

  /** One scripted run through the real tool callers: a plan and its report, an unplanned worker reviewed and approved, two escalations. */
  async function reportsScenario(state: State) {
    const chief = (await start(state)).threadId;
    await plan(state, chief);
    const [planner] = await planners(state);
    const out: string[] = [];
    out.push(await ready(state, planner!));
    const worker = (await delegate(state, chief, "Fix totals", { issueUrl: ISSUE })).threadId;
    out.push(await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker));
    const review = await chiefReview(state, chief, { workerThreadId: worker });
    out.push(review.text, await call(state, "chief_report", { state: "ready", result: "Reviewed", ...APPROVE }, review.threadId));
    out.push(await call(state, "chief_escalate", { threadId: worker, request: "Which total rule?" }, chief));
    out.push(await call(state, "chief_escalate", { threadId: worker, request: "May I merge?", merge: true }, chief));
    await until(() => !state.db.prepare("SELECT 1 FROM forge_comments WHERE posted_at IS NULL AND gave_up_at IS NULL").get());
    return { chief, planner: planner!, worker, review: review.threadId, out };
  }
  const forgeCalls = () => execFileMock.mock.calls.filter(([file]) => file === "gh").map(([file, args]) => JSON.stringify([file, args]));
  /** The scenario on a fresh host, tracker off or on, then everything the owner sees. */
  async function parity(trackerOn: boolean) {
    execFileMock.mockReset();
    const state = await setup();
    const tasks = tasksCli();
    if (trackerOn) await on(state); else await state.harness.behavior.setSettings({ plannerEnabled: true });
    const run = await reportsScenario(state);
    await settled(state, tasks);
    const n = (text: string) => norm(state, text);
    return {
      state, tasks, run,
      seen: {
        out: run.out.map((text) => n(String(text))),
        alerts: state.sent.map((message) => [message.threadId, n(withoutAlertMarker(message.input[0].text))]),
        forge: (state.db.prepare("SELECT dedupe_key, target, body, mention FROM forge_comments ORDER BY dedupe_key").all() as object[]).map((row) => JSON.parse(n(JSON.stringify(row)))),
        gh: forgeCalls().map(n),
      },
    };
  }

  // Contract (spec, Off, unmapped, and unavailable + Mirroring): with the tracker off nothing is written or run; switched on, every
  // tool result, alert (text and order), forge comment and gh call equals the tracker-off run of the same scenario.
  // Regression: a tracker hook that changes a result string, delays or reorders an alert, or adds a forge comment; tracker rows or a CLI run while off.
  test("tracker integration: results, alerts and forge comments equal the tracker-off run, which writes no tracker row and runs no tracker CLI", async () => {
    const off = await parity(false);
    expect(off.tasks.calls).toEqual([]);
    expect([off.state.db.prepare("SELECT count(*) AS n FROM tracker_units").get(), off.state.db.prepare("SELECT count(*) AS n FROM tracker_receipts").get()]).toEqual([{ n: 0 }, { n: 0 }]);
    const onRun = await parity(true);
    expect(onRun.tasks.calls.length).toBeGreaterThan(0);
    expect(onRun.seen).toEqual(off.seen);
  });

  // Contract (spec, Mirroring): a planner's ready report attaches plan-N.md, a reviewer verdict attaches verdict-<seq>.md to the reviewed
  // worker's unit, with the files' content; the payload is NULL once the receipt is sent. chief_escalate posts one decision; merge: true none.
  // Regression: files attached to the wrong unit; a payload kept; a decision posted for a merge request.
  test("tracker integration: plan and verdict files reach their units; an escalation posts one decision and merge: true none", async () => {
    const { state, tasks, run } = await parity(true);
    const onDisk = (id: string, name: string) => readFile(join(state.storageRoot, "chief", "proj_1", id, name), "utf8");
    const files = (root: string) => tasks.attachments.filter((a) => a.task === taskOf(tasks, root));
    expect(files(run.planner)).toEqual([
      { task: taskOf(tasks, run.planner), name: "plan-1.md", content: await onDisk(run.planner, "plan-1.md") },
      { task: taskOf(tasks, run.planner), name: "plan-2.md", content: await onDisk(run.planner, "plan-2.md") },
    ]);
    expect(files(run.worker)).toEqual([{ task: taskOf(tasks, run.worker), name: "verdict-1.md", content: await onDisk(run.review, "verdict-1.md") }]);
    expect(state.db.prepare("SELECT state, payload FROM tracker_receipts WHERE kind='file'").all()).toEqual(Array(3).fill({ state: "sent", payload: null }));
    expect(tasks.of("comment")).toEqual([["comment", taskOf(tasks, run.worker), "--body", decisionBody(1, "Which total rule?"), "--author", "Chief"]]);
  });

  /** An unplanned worker with one open decision per request, posted to its task. */
  async function decided(state: State, tasks: Tasks, requests: string[]) {
    const chief = (await start(state)).threadId;
    const worker = (await delegate(state, chief, "Fix totals")).threadId;
    for (const request of requests) await call(state, "chief_escalate", { threadId: worker, request }, chief);
    await settled(state, tasks);
    return { chief, worker, task: taskOf(tasks, worker) };
  }
  const ANSWERED = (n: number, comment: string) => `The owner answered decision #${n} on tracker task “Fix totals”:\n${comment}\nTreat this as the owner's answer to that Need you request.`;

  // Contract (spec, Answers): an owner comment on the task reaches Chief as exactly one alert, however often the poll sees it; the
  // decision flag is raised by the decision and lowered by its answer.
  // Regression: a second alert on a later poll; an answer that never reaches Chief; a flag left raised.
  test("tracker integration: an owner comment on the task gives Chief exactly one alert", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const { chief, task } = await decided(state, tasks, ["Pick A or B?"]);
    expect(tasks.of("comment")).toEqual([["comment", task, "--body", decisionBody(1, "Pick A or B?"), "--author", "Chief"]]);
    expect(tasks.of("update").filter((a) => a.includes("--add-label"))).toHaveLength(1);
    expect(answerAlerts(state)).toHaveLength(0);
    tasks.owner(task, "Option A");
    for (let i = 0; i < 3; i += 1) { advance(61_000); await settled(state, tasks); }
    expect(answerAlerts(state).map((message) => [message.threadId, withoutAlertMarker(message.input[0].text)])).toEqual([[chief, `[Chief lifecycle alert]\n${ANSWERED(1, "Option A")}`]]);
    expect(tasks.of("update").filter((a) => a.includes("--remove-label"))).toHaveLength(1);
  });

  // Contract (spec, Answers reasons): the answer rides the existing outbox, so a hand-off sends an undelivered answer to the replacement Chief.
  // Regression: an answer stranded on the superseded Chief.
  test("tracker integration: after a Chief hand-over a pending answer goes to the replacement Chief", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const { chief, task } = await decided(state, tasks, ["Pick A or B?"]);
    tasks.owner(task, "Option A");
    state.failNextSend();
    advance(61_000);
    await state.supervisorCycle();
    const pending = () => state.db.prepare("SELECT target_thread_id, delivered_at FROM alert_outbox WHERE dedupe_key LIKE '%:answer'").get() as { target_thread_id: string; delivered_at: number | null } | undefined;
    await until(() => pending());
    expect(pending()).toEqual({ target_thread_id: chief, delivered_at: null });
    state.addLive("thr_adopted", "proj_1");
    expect((await state.harness.behavior.runCli(["adopt", "--thread", "thr_adopted"])).exitCode).toBe(0);
    advance(31_000);
    await state.supervisorCycle();
    await until(() => pending()?.delivered_at);
    expect(pending()!.target_thread_id).toBe("thr_adopted");
    expect(answerAlerts(state).map((message) => [message.threadId, withoutAlertMarker(message.input[0].text)])).toEqual([["thr_adopted", `[Chief lifecycle alert]\n${ANSWERED(1, "Option A")}`]]);
  });

  // Contract (spec, Answers reasons): each decision's answer has its own alert kind, so two answers to two decisions on one thread both
  // survive an unreachable Chief and both are delivered by the outbox retry.
  // Regression: the later answer evicting the earlier undelivered one (same-kind eviction of writeAlert).
  test("tracker integration: two answers to two decisions survive an unreachable Chief and both are delivered by retryAlerts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = await setup();
    const tasks = tasksCli();
    await on(state);
    const { chief, task } = await decided(state, tasks, ["Pick A or B?", "Ship now or later?"]);
    tasks.owner(task, "#1 Option A");
    tasks.owner(task, "#2 Later");
    state.failNextSend();
    state.failNextSend();
    advance(61_000);
    await state.supervisorCycle();
    const rows = () => state.db.prepare("SELECT target_thread_id, delivered_at, attempts FROM alert_outbox WHERE dedupe_key LIKE '%:answer' ORDER BY dedupe_key").all() as { target_thread_id: string; delivered_at: number | null; attempts: number }[];
    await until(() => rows().length === 2 && rows().every((row) => row.attempts === 1));
    expect(rows().map((row) => [row.target_thread_id, row.delivered_at])).toEqual([[chief, null], [chief, null]]);
    expect(answerAlerts(state)).toHaveLength(0);
    advance(31_000);
    await state.supervisorCycle();
    await until(() => rows().every((row) => row.delivered_at));
    expect(answerAlerts(state).map((message) => withoutAlertMarker(message.input[0].text)).sort()).toEqual([
      `[Chief lifecycle alert]\n${ANSWERED(1, "#1 Option A")}`, `[Chief lifecycle alert]\n${ANSWERED(2, "#2 Later")}`,
    ]);
  });

  // Contract (spec, Unit of work; recovery of a thread whose launch has not inserted its row): a spawn-seeded recovery has no pull request
  // or branch, so it inserts a row only when none exists once its lookup returns. A follow-up whose launch row (with its PR and branch)
  // landed while the lookup awaited stays on the earlier unit: its report files and decisions reach the original task, and no task is added.
  // The three callers of that recovery are the worker's own chief_report (reportIntake), chief_research (managedRow) and Chief's
  // chief_inspect (resolveTarget). launched: false is the control: with no launch, recovery still inserts the row.
  // Regression: an unconditional recovery insert at any one of them, which upserts the keys to null so the thread drops out of its unit.
  describe.each<[string, "worker" | "chief", string, object, string | undefined]>([
    ["chief_report (reportIntake)", "worker", "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, undefined],
    ["chief_research (managedRow)", "worker", "chief_research", { mode: "survey", question: "Who calls this?", items: ["a.ts"] }, "not available to a managed worker"],
    ["chief_inspect (resolveTarget)", "chief", "chief_inspect", {}, undefined],
  ])("stale spawn recovery through %s", (_name, caller, tool, params, rejection) => {
    test.each([true, false])("launch row landed during the lookup: %s", async (launched) => {
      const hold = { id: "", gate: Promise.resolve(), entered: () => {}, taken: false };
      const state = await setup({ onPluginMetadata: async (id) => { if (id === hold.id && !hold.taken) { hold.taken = true; hold.entered(); await hold.gate; } } });
      const tasks = tasksCli();
      await on(state);
      const chief = (await start(state)).threadId;
      const keys = { prUrl: "https://github.com/acme/shop/pull/1", branch: "feature/x" };
      const first = (await delegate(state, chief, "Fix checkout totals", keys)).threadId;
      await completeWorker(state, chief, first);
      await settled(state, tasks);
      expect(tasks.of("create")).toHaveLength(1);

      // The follow-up's thread exists and is ours, but its launch has not inserted a row yet.
      const id = `thr_${state.spawned.length + 1}`;
      state.addLive(id, "proj_1", "Follow-up", "chief");
      state.live.get(id)!.parentThreadId = chief;
      state.seedPluginMetadata(id, { role: "worker", chiefThreadId: chief });
      let release!: () => void;
      hold.id = id;
      hold.gate = new Promise<void>((resolve) => { release = resolve; });
      const entered = new Promise<void>((resolve) => { hold.entered = resolve; });
      const callerId = caller === "chief" ? chief : id;
      const stale = call(state, tool, caller === "chief" ? { threadId: id } : params, callerId).then(() => undefined, (error: Error) => error);
      await entered;
      if (launched) expect((await delegate(state, chief, "Fix checkout totals", keys)).threadId).toBe(id);
      release();
      const error = await stale;
      if (rejection) expect(error?.message).toContain(rejection); else expect(error).toBeUndefined();

      const row = () => state.db.prepare("SELECT role, pr_url, branch FROM managed_threads WHERE thread_id=?").get(id);
      if (!launched) {
        expect(row()).toEqual({ role: "worker", pr_url: null, branch: null });
        return;
      }
      expect(row()).toEqual({ role: "worker", pr_url: keys.prUrl, branch: keys.branch });
      // Later work of the follow-up lands on the original task: its reviewer's verdict file and its decision.
      if (tool !== "chief_report") await call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, id);
      const review = await chiefReview(state, chief, { workerThreadId: id });
      await call(state, "chief_report", { state: "ready", result: "Checked", ...APPROVE }, review.threadId);
      await call(state, "chief_escalate", { threadId: id, request: "Which total rule?" }, chief);
      await settled(state, tasks);
      expect(tasks.of("create")).toHaveLength(1);
      expect([...tasks.tasks.keys()]).toEqual(["task_1"]);
      expect(tasks.of("attach").filter((a) => a[3] === id)).toEqual([["attach", "task_1", "--thread", id]]);
      expect(tasks.attachments.map((a) => [a.task, a.name])).toEqual([["task_1", "verdict-1.md"]]);
      expect(tasks.of("comment").map((a) => a[1])).toEqual(["task_1", "task_1"]);
      expect(tasks.of("comment").map((a) => a[3])).toEqual([expect.stringContaining(`chief-request:${id}`), decisionBody(1, "Which total rule?")]);
    });
  });

  // Contract (spec, Failure handling): a bb tasks CLI that never resolves blocks none of chief_plan, chief_delegate, chief_report, chief_escalate.
  // Regression: a tool or report that awaits the adapter hangs here (the race names the tool that did).
  test("tracker integration: a bb tasks CLI that never resolves blocks no tool", async () => {
    const state = await setup();
    const tasks = tasksCli({ hang: true });
    await on(state);
    const chief = (await start(state)).threadId;
    const within = async (name: string, run: () => Promise<unknown>) => {
      const result = await Promise.race([run(), sleep(1_500).then(() => `BLOCKED: ${name}`)]);
      expect(result, `${name} waited for the tracker`).not.toBe(`BLOCKED: ${name}`);
      return result;
    };
    await within("chief_plan", () => plan(state, chief));
    const [planner] = await planners(state);
    await until(() => state.db.prepare("SELECT 1 FROM tracker_units").get());
    await state.supervisorCycle();
    await until(() => tasks.calls.length > 0);
    const worker = await within("chief_delegate", () => delegate(state, chief, "Fix totals", { issueUrl: ISSUE })) as { threadId: string };
    await within("chief_report", () => ready(state, planner!));
    await within("chief_report (worker)", () => call(state, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` }, worker.threadId));
    await within("chief_escalate", () => call(state, "chief_escalate", { threadId: worker.threadId, request: "Which total rule?" }, chief));
    expect(tasks.calls).toEqual([["status"]]);
  });
});
