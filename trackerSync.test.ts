import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { ManagedRow } from "./server";
import type { Tracker, TrackerComment } from "./tracker";
import { TRACKER_TABLES, createTrackerSync } from "./trackerSync";

// Contracts come from docs/specs/tracker.md (Units, Mirroring, Reconcile pass, Decisions and answers, Off/unmapped/unavailable).
// The Tracker is a fake at the protocol boundary; the rows, the clock and the db are real. Nothing here knows a provider.
// Expected markers, keys and bodies are written out from the spec, never taken from the module.

const T0 = 1_000_000;
const at = (ms: number) => vi.setSystemTime(T0 + ms);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sha12 = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);
const PR_A = "https://github.com/acme/shop/pull/1";
const PR_B = "https://github.com/acme/shop/pull/2";

const disposals: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(0); });
afterEach(async () => {
  vi.useRealTimers();
  while (disposals.length) await disposals.pop()!();
});

type Cfg = { tracker: Tracker; projects: Map<string, string> } | null | "reject";
type Behaviour = Record<string, (...args: any[]) => Promise<any>>;
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};
/** Fails the first `times` calls, then answers like `ok`. */
const flaky = (times: number, ok: (...args: any[]) => Promise<any>) => { let n = 0; return async (...args: any[]) => { if (n++ < times) throw new Error("remote failure"); return ok(...args); }; };

let seq = 0;
function world() {
  const { bb, harness } = createFakePluginHost({ pluginId: "tracker-sync-test" });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  for (const table of TRACKER_TABLES) db.exec(table);

  const rows: ManagedRow[] = [];
  const calls: unknown[][] = [];
  const remote = { comments: [] as TrackerComment[], seq: 0 };
  const behave: Behaviour = {};
  let inflight = 0;
  let maxInflight = 0;
  const rec = (name: string, base: (...args: any[]) => Promise<any>) => async (...args: any[]) => {
    calls.push([name, ...args]);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    try { return await (behave[name] ?? base)(...args); } finally { inflight--; }
  };
  const tracker: Tracker = {
    available: rec("available", async () => true),
    findTask: rec("findTask", async () => null),
    createTask: rec("createTask", async () => "T1"),
    setStatus: rec("setStatus", async () => {}),
    attachThread: rec("attachThread", async () => {}),
    detachThread: rec("detachThread", async () => {}),
    linkPullRequest: rec("linkPullRequest", async () => {}),
    attachFile: rec("attachFile", async () => {}),
    comments: rec("comments", async () => [...remote.comments]),
    // Like the real adapter, Chief's own comment comes back as an owner (user) comment.
    postComment: rec("postComment", async (_task: string, body: string) => {
      const id = `c${++remote.seq}`;
      remote.comments.push({ id, byOwner: true, body, at: Date.now() });
      return id;
    }),
    setDecisionFlag: rec("setDecisionFlag", async () => {}),
  };

  const w = {
    db, rows, calls, remote, behave, tracker,
    cfg: { tracker, projects: new Map([["proj_1", "ABC"]]) } as Cfg,
    targets: {} as Record<string, string[]>,
    planDone: new Set<string>(),
    prMerged: vi.fn(async (_url: string, _project: string): Promise<boolean | null> => null),
    answerAlert: vi.fn((_thread: string, key: string, _message: string): string | null => `out:${key}`),
    deliver: vi.fn(async (_key: string) => {}),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get maxInflight() { return maxInflight; },
    add(row: Partial<ManagedRow> & { thread_id: string; role: ManagedRow["role"] }) {
      const full = {
        project_id: "proj_1", title: row.thread_id, state: "active", plan_waves: null, plan_thread_id: null, worker_thread_id: null,
        replaces_thread_id: null, pr_url: null, branch: null, created_at: ++seq, ...row,
      } as ManagedRow;
      rows.push(full);
      return full;
    },
    names: () => calls.map((c) => c[0]),
    called: (name: string) => calls.filter((c) => c[0] === name),
    drain: () => calls.splice(0),
    /** Every call that changes the remote. */
    writes: () => calls.filter(([name]) => !["available", "findTask", "comments"].includes(name as string)),
    units: () => db.prepare(`SELECT * FROM tracker_units`).all() as any[],
    receipts: (kind?: string) => (kind ? db.prepare(`SELECT * FROM tracker_receipts WHERE kind=? ORDER BY rowid`).all(kind) : db.prepare(`SELECT * FROM tracker_receipts ORDER BY rowid`).all()) as any[],
    rowCount: () => (db.prepare(`SELECT (SELECT COUNT(*) FROM tracker_units) + (SELECT COUNT(*) FROM tracker_receipts) AS n`).get() as { n: number }).n,
    sync: undefined as unknown as ReturnType<typeof createTrackerSync>,
  };
  const get = (id: string) => rows.find((r) => r.thread_id === id);
  w.sync = createTrackerSync({
    db, log: w.log,
    config: async () => { if (w.cfg === "reject") throw new Error("settings unreadable"); return w.cfg; },
    get, all: () => rows,
    taskChain: (id) => {
      const chain: string[] = [];
      for (let row = get(id); row && !chain.includes(row.thread_id); row = row.replaces_thread_id ? get(row.replaces_thread_id) : undefined) chain.push(row.thread_id);
      return chain.length ? chain : [id];
    },
    reviewTargets: (id) => w.targets[id] ?? [],
    planDone: (planner) => w.planDone.has(planner.thread_id),
    prMerged: (url, project) => w.prMerged(url, project),
    answerAlert: (thread, key, message) => w.answerAlert(thread, key, message),
    deliver: (key) => w.deliver(key),
  });
  return w;
}
type World = ReturnType<typeof world>;

const PLAN_WAVES = '[{"path":"plan-1.md"}]';
/** A planner whose unit exists and has a remote task T1 with the planner attached. */
async function plannedUnit(w: World) {
  const planner = w.add({ thread_id: "P1", role: "planner", title: "Plan · Alpha" });
  await w.sync.start(planner, "Mission text");
  await w.sync.sync();
  w.drain();
  return planner;
}

describe("bootstrap", () => {
  test("a new plan creates one task with a persisted id, then the planner is attached and the status is planning", async () => {
    const w = world();
    const planner = w.add({ thread_id: "P1", role: "planner", title: "Plan · Alpha" });
    await w.sync.start(planner, "Mission text");
    expect(w.names()).toEqual([]);
    await w.sync.sync();
    const marker = `chief-unit:${sha12("P1")}`;
    expect(w.calls).toEqual([
      ["available"],
      ["createTask", { project: "ABC", title: "Alpha", description: `Mission text\n\n${marker}` }],
      ["attachThread", "T1", "P1"],
      ["setStatus", "T1", "planning"],
    ]);
    expect(w.units()).toMatchObject([{ root_thread_id: "P1", task_id: "T1", create_state: "sent", marker, status: "planning" }]);
    // A second pass with nothing changed writes nothing.
    w.drain();
    await w.sync.sync();
    expect(w.writes()).toEqual([]);
  });

  test("the mission is clipped to 4,000 characters before the marker", async () => {
    const w = world();
    await w.sync.start(w.add({ thread_id: "P1", role: "planner" }), "m".repeat(9_000));
    const { description, marker } = w.units()[0];
    expect(description.startsWith("mmm")).toBe(true);
    expect(description.endsWith(`\n\n${marker}`)).toBe(true);
    expect(description.length).toBeLessThan(4_100);
  });

  test("a revision starts no second unit; its planner is attached to the root's task", async () => {
    const w = world();
    await plannedUnit(w);
    const revision = w.add({ thread_id: "P2", role: "planner", replaces_thread_id: "P1" });
    await w.sync.start(revision, "Revised mission");
    expect(w.units()).toHaveLength(1);
    await w.sync.sync();
    expect(w.called("createTask")).toEqual([]);
    expect(w.called("attachThread")).toEqual([["attachThread", "T1", "P2"]]);
  });

  test("a create that threw after the remote made the task is found by its marker on retry: no second task", async () => {
    const w = world();
    w.behave.createTask = flaky(1, async () => "T-second");
    await w.sync.start(w.add({ thread_id: "P1", role: "planner" }), "m");
    await w.sync.sync();
    expect(w.called("findTask")).toEqual([]);
    expect(w.units()[0]).toMatchObject({ task_id: null, create_state: null, create_attempts: 1 });
    w.behave.findTask = async () => "T-remote";
    await w.sync.sync();
    expect(w.called("findTask")).toEqual([["findTask", "ABC", `chief-unit:${sha12("P1")}`]]);
    expect(w.called("createTask")).toHaveLength(1);
    expect(w.units()[0]).toMatchObject({ task_id: "T-remote", create_state: "sent" });
    expect(w.called("attachThread")).toEqual([["attachThread", "T-remote", "P1"]]);
  });

  test("five failed creates fail the unit and its pending receipts (payload dropped), warn once and never alert", async () => {
    const w = world();
    w.behave.createTask = async () => { throw new Error("down"); };
    const planner = w.add({ thread_id: "P1", role: "planner" });
    await w.sync.start(planner, "m");
    await w.sync.attachFiles(planner, [{ name: "plan-1.md", content: "# plan" }]);
    expect(w.receipts("file")[0]).toMatchObject({ state: null, payload: "# plan" });
    for (let i = 0; i < 4; i++) await w.sync.sync();
    expect(w.units()[0]).toMatchObject({ create_state: null, create_attempts: 4 });
    expect(w.log.warn).not.toHaveBeenCalled();
    await w.sync.sync();
    expect(w.units()[0]).toMatchObject({ create_state: "failed", create_attempts: 5, task_id: null });
    expect(w.receipts()).toMatchObject([{ kind: "thread", ref: "P1", state: "failed", payload: null }, { kind: "file", state: "failed", payload: null }]);
    expect(w.log.warn).toHaveBeenCalledTimes(1);
    expect(w.answerAlert).not.toHaveBeenCalled();
    expect(w.deliver).not.toHaveBeenCalled();
    // A failed unit takes no more attempts and no new receipts.
    await w.sync.sync();
    await w.sync.attachFiles(planner, [{ name: "plan-2.md", content: "x" }]);
    expect(w.called("createTask")).toHaveLength(5);
    expect(w.receipts("file")).toHaveLength(1);
  });

  test("a worker that joins while the tracker is on is attached on the next pass", async () => {
    const w = world();
    await plannedUnit(w);
    await w.sync.join(w.add({ thread_id: "W1", role: "worker", plan_thread_id: "P1" }));
    await w.sync.sync();
    expect(w.called("attachThread")).toEqual([["attachThread", "T1", "W1"]]);
  });
});

describe("unit resolution", () => {
  // The expected root is written from the spec's table (Units). A file receipt is the observable: it lands on the unit of its row, or nowhere.
  async function family() {
    const w = world();
    w.add({ thread_id: "P1", role: "planner" });
    w.add({ thread_id: "P2", role: "planner", replaces_thread_id: "P1" });
    w.add({ thread_id: "W1", role: "worker", plan_thread_id: "P1" });
    w.add({ thread_id: "W2", role: "worker", plan_thread_id: "P1", replaces_thread_id: "W1" });
    w.add({ thread_id: "U1", role: "worker" });
    w.add({ thread_id: "U2", role: "worker", replaces_thread_id: "U1" });
    w.add({ thread_id: "A1", role: "advisor", plan_thread_id: "P1" });
    w.add({ thread_id: "A2", role: "advisor", worker_thread_id: "U1" });
    w.add({ thread_id: "A3", role: "advisor", worker_thread_id: "W1" });
    w.add({ thread_id: "R1", role: "reviewer", worker_thread_id: "W1" });
    w.add({ thread_id: "R2", role: "reviewer", worker_thread_id: "U1" });
    w.add({ thread_id: "R3", role: "reviewer", worker_thread_id: "U1" });
    w.add({ thread_id: "R4", role: "reviewer" });
    w.add({ thread_id: "A4", role: "advisor" });
    w.add({ thread_id: "X1", role: "researcher" });
    w.targets = { R1: ["W1"], R2: ["U2"], R3: [] };
    await w.sync.start(w.rows[0]!, "plan");
    await w.sync.start(w.rows.find((r) => r.thread_id === "U1")!, "task");
    return w;
  }
  test.each<[string, string, string | null]>([
    ["planner", "P1", "P1"],
    ["revision planner", "P2", "P1"],
    ["planned worker", "W1", "P1"],
    ["fix worker inheriting plan_thread_id", "W2", "P1"],
    ["unplanned worker", "U1", "U1"],
    ["the replaces: successor of an unplanned worker", "U2", "U1"],
    ["plan advisor", "A1", "P1"],
    ["worker advisor of an unplanned worker", "A2", "U1"],
    ["worker advisor of a planned worker", "A3", "P1"],
    ["reviewer through its review target (planned)", "R1", "P1"],
    ["reviewer through its review target (successor of an unplanned worker)", "R2", "U1"],
    ["reviewer with no target falls back to its worker", "R3", "U1"],
    ["branch-only reviewer", "R4", null],
    ["advisor-only consult", "A4", null],
    ["researcher", "X1", null],
  ])("%s → %s", async (_name, threadId, root) => {
    const w = await family();
    await w.sync.attachFiles(w.rows.find((r) => r.thread_id === threadId)!, [{ name: "f.md", content: "x" }]);
    expect(w.receipts("file").map((r) => [r.root_thread_id, r.ref])).toEqual(root ? [[root, `${threadId}:f.md`]] : []);
  });

  test("a project that is not mapped starts no unit", async () => {
    const w = world();
    await w.sync.start(w.add({ thread_id: "P1", role: "planner", project_id: "proj_other" }), "m");
    expect(w.rowCount()).toBe(0);
  });
});

describe("receipts", () => {
  test("a failed attach blocks the detach it gates; the detach fails and never runs", async () => {
    const w = world();
    w.add({ thread_id: "U1", role: "worker", state: "complete" });
    w.add({ thread_id: "U2", role: "worker", replaces_thread_id: "U1" });
    await w.sync.start(w.rows[0]!, "m");
    await w.sync.join(w.rows[1]!);
    w.behave.attachThread = async (_task: string, thread: string) => { if (thread === "U1") throw new Error("attach down"); };
    for (let i = 0; i < 5; i++) await w.sync.sync();
    expect(w.receipts("thread").map((r) => [r.ref, r.state])).toEqual([["U1", "failed"], ["U2", "sent"]]);
    expect(w.receipts("unthread")).toMatchObject([{ ref: "U1", state: "failed" }]);
    expect(w.called("detachThread")).toEqual([]);
  });

  test("the detach waits until the successor's attach is sent too", async () => {
    const w = world();
    w.add({ thread_id: "U1", role: "worker", state: "complete" });
    w.add({ thread_id: "U2", role: "worker", replaces_thread_id: "U1" });
    await w.sync.start(w.rows[0]!, "m");
    await w.sync.join(w.rows[1]!);
    w.behave.attachThread = flaky(2, async () => {});
    await w.sync.sync();
    expect(w.called("detachThread")).toEqual([]);
    w.drain();
    await w.sync.sync();
    expect(w.writes()).toEqual([["attachThread", "T1", "U1"], ["attachThread", "T1", "U2"], ["detachThread", "T1", "U1"]]);
  });

  test("a receipt stops at 5 attempts: one warning, no Chief alert, no further calls", async () => {
    const w = world();
    await plannedUnit(w);
    await w.sync.join(w.add({ thread_id: "W1", role: "worker", plan_thread_id: "P1" }));
    w.behave.attachThread = async () => { throw new Error("attach down"); };
    for (let i = 0; i < 4; i++) await w.sync.sync();
    expect(w.log.warn).not.toHaveBeenCalled();
    await w.sync.sync();
    expect(w.receipts("thread").find((r) => r.ref === "W1")).toMatchObject({ state: "failed", attempts: 5, last_error: "attach down" });
    expect(w.log.warn).toHaveBeenCalledTimes(1);
    expect(w.log.warn.mock.calls[0]![0]).toContain("5 attempts");
    w.drain();
    await w.sync.sync();
    expect(w.called("attachThread")).toEqual([]);
    expect(w.answerAlert).not.toHaveBeenCalled();
    expect(w.deliver).not.toHaveBeenCalled();
  });

  test("a file payload is dropped when the receipt is sent and when it fails", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    await w.sync.attachFiles(planner, [{ name: "plan-1.md", content: "# sent plan" }]);
    expect(w.receipts("file")[0]).toMatchObject({ state: null, payload: "# sent plan" });
    await w.sync.sync();
    expect(w.called("attachFile")).toEqual([["attachFile", "T1", { name: "plan-1.md", content: "# sent plan" }]]);
    expect(w.receipts("file")[0]).toMatchObject({ ref: "P1:plan-1.md", state: "sent", payload: null });

    w.behave.attachFile = async () => { throw new Error("upload down"); };
    await w.sync.attachFiles(planner, [{ name: "plan-2.md", content: "# lost plan" }]);
    for (let i = 0; i < 5; i++) await w.sync.sync();
    expect(w.receipts("file")[1]).toMatchObject({ ref: "P1:plan-2.md", state: "failed", payload: null, attempts: 5 });
  });

  test("a pull request is linked once; later passes link nothing", async () => {
    const w = world();
    w.add({ thread_id: "U1", role: "worker", pr_url: PR_A });
    await w.sync.start(w.rows[0]!, "m");
    await w.sync.sync();
    expect(w.called("linkPullRequest")).toEqual([["linkPullRequest", "T1", PR_A]]);
    w.drain();
    await w.sync.sync();
    expect(w.called("linkPullRequest")).toEqual([]);
  });
});

describe("single flight", () => {
  test("a call during a pass never interleaves with it and queues exactly one more pass", async () => {
    const w = world();
    const gate = deferred<string>();
    w.behave.createTask = () => gate.promise;
    await w.sync.start(w.add({ thread_id: "P1", role: "planner" }), "m");
    const first = w.sync.sync();
    await tick();
    expect(w.called("available")).toHaveLength(1);
    const second = w.sync.sync();
    const third = w.sync.sync();
    await tick();
    expect(w.called("available")).toHaveLength(1);
    gate.resolve("T1");
    await Promise.all([first, second, third]);
    expect(w.called("available")).toHaveLength(2);
    expect(w.called("createTask")).toHaveLength(1);
    expect(w.maxInflight).toBe(1);
  });

  test("a failure inside the pass is logged and sync() still resolves", async () => {
    const w = world();
    w.behave.available = async () => { throw new Error("probe exploded"); };
    await w.sync.start(w.add({ thread_id: "P1", role: "planner" }), "m");
    await expect(w.sync.sync()).resolves.toBeUndefined();
    expect(w.log.warn.mock.calls.map(([m]) => m).join("\n")).toContain("probe exploded");
    // The next call runs a fresh pass.
    w.behave.available = async () => true;
    await w.sync.sync();
    expect(w.called("createTask")).toHaveLength(1);
  });
});

describe("status", () => {
  test("a planned unit follows planning → working → done, and a revision walks the same road on its own plan", async () => {
    const w = world();
    const planner = w.add({ thread_id: "P1", role: "planner", title: "Plan · Alpha" });
    await w.sync.start(planner, "m");
    let creates = 0;
    const statuses = async () => { await w.sync.sync(); creates += w.called("createTask").length; const s = w.called("setStatus").map(([, , status]) => status); w.drain(); return s; };

    expect(await statuses()).toEqual(["planning"]);

    planner.state = "ready"; planner.plan_waves = PLAN_WAVES;
    const w1 = w.add({ thread_id: "W1", role: "worker", plan_thread_id: "P1" });
    expect(await statuses()).toEqual(["working"]);

    w1.state = "complete"; w.planDone.add("P1");
    expect(await statuses()).toEqual(["done"]);
    expect(await statuses()).toEqual([]);

    // The revision becomes the effective plan: the first plan being absorbed no longer finishes the unit.
    w.add({ thread_id: "P2", role: "planner", replaces_thread_id: "P1", state: "ready", plan_waves: PLAN_WAVES });
    expect(await statuses()).toEqual(["planning"]);

    const w2 = w.add({ thread_id: "W2", role: "worker", plan_thread_id: "P2" });
    expect(await statuses()).toEqual(["working"]);

    w2.state = "complete"; w.planDone.add("P2");
    expect(await statuses()).toEqual(["done"]);
    expect(w.units()).toHaveLength(1);
    expect(creates).toBe(1);
  });

  test("an unplanned unit stays working while the replaces: successor runs, and is done when the tip completes", async () => {
    const w = world();
    const first = w.add({ thread_id: "U1", role: "worker", state: "complete" });
    const second = w.add({ thread_id: "U2", role: "worker", replaces_thread_id: "U1" });
    await w.sync.start(first, "m");
    await w.sync.join(second);
    await w.sync.sync();
    expect(w.calls).toEqual([
      ["available"],
      ["createTask", expect.anything()],
      ["attachThread", "T1", "U1"],
      ["attachThread", "T1", "U2"],
      ["detachThread", "T1", "U1"],
      ["setStatus", "T1", "working"],
    ]);
    w.drain();
    await w.sync.sync();
    expect(w.writes()).toEqual([]);
    second.state = "complete";
    await w.sync.sync();
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", "done"]]);
  });

  test.each<[string, string | null, string]>([
    ["no pull request", null, "done"],
    ["a pull request", PR_A, "review"],
  ])("a finished unit with %s → %s", async (_name, pr, status) => {
    const w = world();
    await w.sync.start(w.add({ thread_id: "U1", role: "worker", state: "complete", pr_url: pr }), "m");
    await w.sync.sync();
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", status]]);
  });

  describe("merge polling", () => {
    async function inReview(w: World) {
      await w.sync.start(w.add({ thread_id: "U1", role: "worker", state: "complete", pr_url: PR_A }), "m");
      await w.sync.sync();
      expect(w.units()[0].status).toBe("review");
      w.drain();
    }

    test("asks the forge at most every 5 minutes; null keeps review; true makes it done; done is never polled again", async () => {
      const w = world();
      await inReview(w);
      await w.sync.sync();
      expect(w.prMerged).toHaveBeenCalledTimes(1);
      expect(w.prMerged).toHaveBeenLastCalledWith(PR_A, "proj_1");
      expect(w.called("setStatus")).toEqual([]);
      at(5 * 60_000 - 1);
      await w.sync.sync();
      expect(w.prMerged).toHaveBeenCalledTimes(1);
      w.prMerged.mockResolvedValue(true);
      at(5 * 60_000);
      await w.sync.sync();
      expect(w.prMerged).toHaveBeenCalledTimes(2);
      expect(w.called("setStatus")).toEqual([["setStatus", "T1", "done"]]);
      at(20 * 60_000);
      await w.sync.sync();
      expect(w.prMerged).toHaveBeenCalledTimes(2);
    });

    test.each<[string, (boolean | null)[], string]>([
      ["every pull request merged", [true, true], "done"],
      ["one pull request still open", [true, false], "review"],
      ["the forge cannot say for one", [true, null], "review"],
    ])("two pull requests, %s → %s", async (_name, merged, status) => {
      const w = world();
      w.add({ thread_id: "U1", role: "worker", state: "complete", pr_url: PR_A });
      w.add({ thread_id: "U2", role: "worker", state: "complete", pr_url: PR_B, replaces_thread_id: "U1" });
      await w.sync.start(w.rows[0]!, "m");
      await w.sync.sync();
      w.prMerged.mockImplementation(async (url) => merged[url === PR_A ? 0 : 1]!);
      await w.sync.sync();
      expect(w.prMerged).toHaveBeenCalledTimes(2);
      expect(w.units()[0].status).toBe(status);
    });

    test("is never asked while the unit is still working", async () => {
      const w = world();
      await w.sync.start(w.add({ thread_id: "U1", role: "worker", pr_url: PR_A }), "m");
      for (let i = 0; i < 3; i++) { await w.sync.sync(); at((i + 1) * 10 * 60_000); }
      expect(w.units()[0].status).toBe("working");
      expect(w.prMerged).not.toHaveBeenCalled();
    });
  });
});

describe("decisions", () => {
  const body = (n: number, request: string) =>
    `**Decision #${n}** (Chief)\n\n${request}\n\nAnswer with a comment; start it with #${n} when several decisions are open.\n\nchief-decision:${sha12(request)}`;

  test("a request posts one comment with the specified layout, then the flag opens", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    await w.sync.decide(planner, "Pick A or B.");
    await w.sync.sync();
    expect(w.called("postComment")).toEqual([["postComment", "T1", body(1, "Pick A or B.")]]);
    expect(w.called("setDecisionFlag")).toEqual([["setDecisionFlag", "ABC", "T1", true]]);
  });

  test("the same request twice posts once; two requests are numbered #1 and #2", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    await w.sync.decide(planner, "Pick A or B.");
    await w.sync.decide(planner, "Pick A or B.");
    await w.sync.decide(planner, "Ship now or wait?");
    await w.sync.sync();
    expect(w.called("postComment")).toEqual([["postComment", "T1", body(1, "Pick A or B.")], ["postComment", "T1", body(2, "Ship now or wait?")]]);
  });

  test("a row with no unit takes no decision", async () => {
    const w = world();
    await w.sync.decide(w.add({ thread_id: "X1", role: "researcher" }), "Pick?");
    await w.sync.decide(w.add({ thread_id: "P9", role: "planner" }), "Pick?");
    expect(w.rowCount()).toBe(0);
  });

  test("the comment succeeded and the flag failed: the next pass retries only the flag", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    w.behave.setDecisionFlag = flaky(1, async () => {});
    await w.sync.decide(planner, "Pick A or B.");
    await w.sync.sync();
    expect(w.units()[0].flagged).toBe(0);
    w.drain();
    await w.sync.sync();
    expect(w.called("postComment")).toEqual([]);
    expect(w.called("setDecisionFlag")).toEqual([["setDecisionFlag", "ABC", "T1", true]]);
    expect(w.units()[0].flagged).toBe(1);
    expect(w.receipts("decision")).toHaveLength(1);
  });

  test("a post that succeeded but looked failed is found by its marker on retry: no second comment", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    w.behave.postComment = async (_task: string, text: string) => { w.remote.comments.push({ id: "c-ghost", byOwner: true, body: text, at: Date.now() }); throw new Error("timeout"); };
    await w.sync.decide(planner, "Pick A or B.");
    await w.sync.sync();
    expect(w.receipts("decision")[0]).toMatchObject({ state: null, attempts: 1 });
    await w.sync.sync();
    expect(w.called("postComment")).toHaveLength(1);
    expect(w.receipts("decision")[0]).toMatchObject({ state: "sent", payload: null });
    expect(JSON.parse(w.receipts("decision")[0].result)).toEqual({ id: "c-ghost", number: 1, concernedThreadId: "P1" });
  });
});

describe("answers", () => {
  /** Posts the decisions and moves the clock on, so each owner comment is newer than them and the 60 s poll is due. */
  async function asked(...requests: string[]) {
    const w = world();
    const planner = await plannedUnit(w);
    for (const request of requests) { await w.sync.decide(planner, request); }
    await w.sync.sync();
    w.drain();
    at(61_000);
    return { w, planner };
  }
  const owner = (w: World, id: string, text: string) => w.remote.comments.push({ id, byOwner: true, body: text, at: Date.now() });

  test("one owner comment becomes one alert for the concerned thread, delivered once, and the flag clears", async () => {
    const { w } = await asked("Pick A or B.");
    owner(w, "o1", "Use option A.");
    await w.sync.sync();
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    expect(w.answerAlert).toHaveBeenCalledWith("P1", `decision-${sha12("Pick A or B.")}:answer`,
      "The owner answered decision #1 on tracker task “Alpha”:\nUse option A.\nTreat this as the owner's answer to that Need you request.");
    expect(w.deliver).toHaveBeenCalledTimes(1);
    expect(w.deliver).toHaveBeenCalledWith(`out:decision-${sha12("Pick A or B.")}:answer`);
    expect(w.receipts("answer")).toMatchObject([{ ref: "o1", state: "sent", result: sha12("Pick A or B.") }]);
    expect(w.receipts("decision")[0].answered_at).not.toBeNull();
    // The next pass closes the flag; seeing the same comment again does nothing.
    at(130_000);
    await w.sync.sync();
    await w.sync.sync();
    expect(w.called("setDecisionFlag")).toEqual([["setDecisionFlag", "ABC", "T1", false]]);
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    expect(w.deliver).toHaveBeenCalledTimes(1);
  });

  test("with two open decisions `#2 …` answers #2 only", async () => {
    const { w } = await asked("Pick A or B.", "Ship now or wait?");
    owner(w, "o1", "#2 Ship now.");
    await w.sync.sync();
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    expect(w.answerAlert.mock.calls[0]![1]).toBe(`decision-${sha12("Ship now or wait?")}:answer`);
    expect(w.answerAlert.mock.calls[0]![2]).toContain("decision #2");
    expect(w.receipts("decision").map((d) => d.answered_at !== null)).toEqual([false, true]);
  });

  test("a comment with no #N while two decisions are open is one unmatched alert and closes nothing", async () => {
    const { w } = await asked("Pick A or B.", "Ship now or wait?");
    owner(w, "o1", "Sounds fine to me.");
    await w.sync.sync();
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    const [thread, key, message] = w.answerAlert.mock.calls[0]!;
    expect([thread, key]).toEqual(["P1", `tracker-${sha12("o1")}:comment`]);
    expect(message).toContain("#1, #2");
    expect(message).toContain("Sounds fine to me.");
    expect(w.receipts("decision").map((d) => d.answered_at)).toEqual([null, null]);
    expect(w.receipts("answer")).toMatchObject([{ ref: "o1", result: null }]);
  });

  test("Chief's own decision comments are never answers, even though the tracker stores them as owner comments", async () => {
    const { w, planner } = await asked("Pick A or B.");
    at(1_000_000);
    await w.sync.decide(planner, "Ship now or wait?");
    await w.sync.sync();
    expect(w.remote.comments.map((c) => c.byOwner)).toEqual([true, true]);
    at(1_000_000 + 61_000);
    await w.sync.sync();
    expect(w.called("comments").length).toBeGreaterThan(0);
    expect(w.answerAlert).not.toHaveBeenCalled();
    expect(w.receipts("answer")).toEqual([]);
  });

  test("comments by anyone who is not the owner are not answers", async () => {
    const { w } = await asked("Pick A or B.");
    w.remote.comments.push({ id: "g1", byOwner: false, body: "an agent said so", at: Date.now() });
    await w.sync.sync();
    expect(w.answerAlert).not.toHaveBeenCalled();
  });

  test("a comment older than the decision is not an answer", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    w.remote.comments.push({ id: "o0", byOwner: true, body: "earlier chatter", at: Date.now() - 500 });
    await w.sync.decide(planner, "Pick A or B.");
    at(10);
    await w.sync.sync();
    at(61_010);
    await w.sync.sync();
    expect(w.answerAlert).not.toHaveBeenCalled();
  });

  test("no live Chief (answerAlert null) rolls the answer back; the next poll records it and alerts once", async () => {
    const { w } = await asked("Pick A or B.");
    w.answerAlert.mockReturnValueOnce(null);
    owner(w, "o1", "Use option A.");
    await w.sync.sync();
    expect(w.receipts("answer")).toEqual([]);
    expect(w.receipts("decision")[0].answered_at).toBeNull();
    expect(w.deliver).not.toHaveBeenCalled();
    expect(w.log.warn.mock.calls.map(([m]) => m).join("\n")).toContain("not recorded");
    at(61_000 + 60_000);
    await w.sync.sync();
    expect(w.answerAlert).toHaveBeenCalledTimes(2);
    expect(w.receipts("answer")).toHaveLength(1);
    expect(w.deliver).toHaveBeenCalledTimes(1);
  });

  test("polls a unit at most once in 60 seconds", async () => {
    const { w } = await asked("Pick A or B.");
    await w.sync.sync();
    expect(w.called("comments")).toHaveLength(1);
    at(61_000 + 59_999);
    await w.sync.sync();
    expect(w.called("comments")).toHaveLength(1);
    at(61_000 + 60_000);
    await w.sync.sync();
    expect(w.called("comments")).toHaveLength(2);
  });

  test("a unit with no open decision is never polled", async () => {
    const w = world();
    await plannedUnit(w);
    at(10 * 60_000);
    await w.sync.sync();
    expect(w.called("comments")).toEqual([]);
  });

  test("a failed flag-clear never blocks or repeats the answer; a later clear lands without a second alert", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    await w.sync.decide(planner, "Pick A or B.");
    await w.sync.sync();
    expect(w.units()[0].flagged).toBe(1);
    w.behave.setDecisionFlag = async (_project: string, _task: string, open: boolean) => { if (!open) throw new Error("flag down"); };
    w.drain();
    at(61_000);
    w.remote.comments.push({ id: "o1", byOwner: true, body: "Use option A.", at: Date.now() });
    await w.sync.sync();
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 3; i++) { at(61_000 + i * 61_000); await w.sync.sync(); }
    // The clear was attempted on every pass after the answer, and failed each time.
    expect(w.called("setDecisionFlag")).toEqual([["setDecisionFlag", "ABC", "T1", false], ["setDecisionFlag", "ABC", "T1", false], ["setDecisionFlag", "ABC", "T1", false]]);
    expect(w.units()[0].flagged).toBe(1);
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    expect(w.deliver).toHaveBeenCalledTimes(1);
    delete w.behave.setDecisionFlag;
    w.drain();
    at(61_000 + 5 * 61_000);
    await w.sync.sync();
    expect(w.called("setDecisionFlag")).toEqual([["setDecisionFlag", "ABC", "T1", false]]);
    expect(w.units()[0].flagged).toBe(0);
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    expect(w.deliver).toHaveBeenCalledTimes(1);
  });

  test("the alert text names the decision and carries no tracker command", async () => {
    const { w } = await asked("Pick A or B.", "Ship now or wait?");
    owner(w, "o1", "#1 A please");
    owner(w, "o2", "no number here");
    await w.sync.sync();
    const messages = w.answerAlert.mock.calls.map((c) => c[2]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("decision #1");
    for (const message of messages) expect(message).not.toMatch(/bb tasks|bb\s+task/i);
  });
});

describe("follow-up joins the unit", () => {
  // Contracts come from docs/specs/tracker.md (Unit of work, Mirroring, Hooks start, Receipt rules, Answer poll, Known Limits).
  const request = (id: string, mission: string) => `**Follow-up request** (Chief)\n\n${mission}\n\nchief-request:${id}`;
  /** Unplanned worker U1 whose unit has task T1, finished and settled. */
  async function earlierWork(w: World, extra: Partial<ManagedRow>) {
    const earlier = w.add({ thread_id: "U1", role: "worker", title: "Alpha", ...extra });
    await w.sync.start(earlier, "Mission A");
    await w.sync.sync();
    earlier.state = "complete";
    await w.sync.sync();
    w.drain();
    return earlier;
  }
  const followUp = async (w: World, extra: Partial<ManagedRow> = {}, mission = "Fix the review comment.") => {
    const row = w.add({ thread_id: "U2", role: "worker", title: "Beta", ...extra });
    await w.sync.start(row, mission);
    return row;
  };

  test("same pull request: no second task; one request comment before the attach; review → working → review → done", async () => {
    const w = world();
    await earlierWork(w, { pr_url: PR_A });
    expect(w.units()[0].status).toBe("review");
    const b = await followUp(w, { pr_url: PR_A });
    expect(w.units()).toHaveLength(1);
    await w.sync.sync();
    expect(w.called("createTask")).toEqual([]);
    expect(w.called("postComment")).toEqual([["postComment", "T1", request("U2", "Fix the review comment.")]]);
    expect(w.writes()).toEqual([
      ["postComment", "T1", request("U2", "Fix the review comment.")],
      ["attachThread", "T1", "U2"],
      ["setStatus", "T1", "working"],
    ]);
    // Two passes equal one pass.
    w.drain();
    await w.sync.sync();
    expect(w.writes()).toEqual([]);
    b.state = "complete";
    await w.sync.sync();
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", "review"]]);
    w.prMerged.mockResolvedValue(true);
    at(5 * 60_000);
    await w.sync.sync();
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", "review"], ["setStatus", "T1", "done"]]);
    expect(w.units()).toHaveLength(1);
  });

  test("same branch and no pull request: joins; a done unit goes back to working, then done with no pull request", async () => {
    const w = world();
    await earlierWork(w, { branch: "feat/x" });
    expect(w.units()[0].status).toBe("done");
    const b = await followUp(w, { branch: "feat/x" });
    await w.sync.sync();
    expect(w.units()).toHaveLength(1);
    expect(w.called("createTask")).toEqual([]);
    expect(w.called("postComment")).toHaveLength(1);
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", "working"]]);
    b.state = "complete";
    await w.sync.sync();
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", "working"], ["setStatus", "T1", "done"]]);
  });

  test("the request mission is clipped to 4,000 characters between the header and the marker", async () => {
    const w = world();
    await earlierWork(w, { pr_url: PR_A });
    await followUp(w, { pr_url: PR_A }, "m".repeat(9_000));
    await w.sync.sync();
    const [, , body] = w.called("postComment")[0]!;
    expect((body as string).startsWith("**Follow-up request** (Chief)\n\nmmm")).toBe(true);
    expect((body as string).endsWith("m…\n\nchief-request:U2")).toBe(true);
    expect((body as string).length).toBe("**Follow-up request** (Chief)\n\n".length + 4_000 + "\n\nchief-request:U2".length);
  });

  test.each<[string, Partial<ManagedRow>]>([
    ["a different pull request and branch", { pr_url: PR_B, branch: "feat/other" }],
    ["no pull request and no branch", {}],
  ])("unrelated work (%s) gets its own unit and task and posts no request comment", async (_name, extra) => {
    const w = world();
    await earlierWork(w, { pr_url: PR_A, branch: "feat/x" });
    w.behave.createTask = async () => "T2";
    await followUp(w, extra);
    await w.sync.sync();
    expect(w.units().map((u) => u.root_thread_id)).toEqual(["U1", "U2"]);
    expect(w.called("createTask")).toHaveLength(1);
    expect(w.called("postComment")).toEqual([]);
    expect(w.called("attachThread")).toEqual([["attachThread", "T2", "U2"]]);
  });

  test("planned earlier work: the follow-up joins the planner's unit; working while it runs, finished when its tip completes", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    planner.state = "ready"; planner.plan_waves = PLAN_WAVES;
    w.add({ thread_id: "W1", role: "worker", plan_thread_id: "P1", pr_url: PR_A, state: "complete" });
    await w.sync.join(w.rows.find((r) => r.thread_id === "W1")!);
    w.planDone.add("P1");
    await w.sync.sync();
    expect(w.units()[0].status).toBe("review");
    w.drain();
    const b = await followUp(w, { pr_url: PR_A });
    await w.sync.sync();
    expect(w.units()).toHaveLength(1);
    expect(w.called("createTask")).toEqual([]);
    expect(w.called("postComment")).toEqual([["postComment", "T1", request("U2", "Fix the review comment.")]]);
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", "working"]]);
    b.state = "complete";
    await w.sync.sync();
    expect(w.called("setStatus")).toEqual([["setStatus", "T1", "working"], ["setStatus", "T1", "review"]]);
  });

  describe("retry", () => {
    test("an attach that failed after the comment posted: the retry posts no second comment, attaches, and drops the payload", async () => {
      const w = world();
      await earlierWork(w, { pr_url: PR_A });
      w.behave.attachThread = flaky(1, async () => {});
      await followUp(w, { pr_url: PR_A });
      expect(w.receipts("thread").find((r) => r.ref === "U2")).toMatchObject({ state: null, payload: request("U2", "Fix the review comment.") });
      await w.sync.sync();
      expect(w.receipts("thread").find((r) => r.ref === "U2")).toMatchObject({ state: null, attempts: 1 });
      await w.sync.sync();
      expect(w.called("postComment")).toHaveLength(1);
      expect(w.called("attachThread")).toEqual([["attachThread", "T1", "U2"], ["attachThread", "T1", "U2"]]);
      expect(w.receipts("thread").find((r) => r.ref === "U2")).toMatchObject({ state: "sent", payload: null });
    });

    test("five failed attaches: one comment in all, the receipt fails and its payload is dropped", async () => {
      const w = world();
      await earlierWork(w, { pr_url: PR_A });
      w.behave.attachThread = async () => { throw new Error("attach down"); };
      await followUp(w, { pr_url: PR_A });
      for (let i = 0; i < 5; i++) await w.sync.sync();
      expect(w.called("postComment")).toHaveLength(1);
      expect(w.receipts("thread").find((r) => r.ref === "U2")).toMatchObject({ state: "failed", payload: null, attempts: 5 });
    });
  });

  test("the follow-up's reviewer, replacement and decisions land on the earlier unit; the replaced follow-up is detached after its successor attaches", async () => {
    const w = world();
    await earlierWork(w, { pr_url: PR_A });
    const b = await followUp(w, { pr_url: PR_A });
    await w.sync.sync();
    w.drain();
    const reviewer = w.add({ thread_id: "R1", role: "reviewer", worker_thread_id: "U2" });
    w.targets = { R1: ["U2"] };
    await w.sync.attachFiles(reviewer, [{ name: "verdict.md", content: "# verdict" }]);
    await w.sync.decide(b, "Pick A or B.");
    b.state = "complete";
    const successor = w.add({ thread_id: "U3", role: "worker", replaces_thread_id: "U2" });
    await w.sync.join(successor);
    expect(w.units()).toHaveLength(1);
    expect(new Set(w.receipts().map((r) => r.root_thread_id))).toEqual(new Set(["U1"]));
    await w.sync.sync();
    expect(w.called("attachFile")).toEqual([["attachFile", "T1", { name: "verdict.md", content: "# verdict" }]]);
    expect(w.called("postComment")).toHaveLength(1);
    expect(w.called("postComment")[0]![2]).toContain("Pick A or B.");
    expect(w.called("attachThread")).toEqual([["attachThread", "T1", "U3"]]);
    expect(w.called("detachThread")).toEqual([["detachThread", "T1", "U2"]]);
    expect(w.names().indexOf("detachThread")).toBeGreaterThan(w.names().indexOf("attachThread"));
    // The replaced follow-up finished, but its successor runs: the unit stays working until the tip completes.
    expect(w.units()[0].status).toBe("working");
    successor.state = "complete";
    await w.sync.sync();
    expect(w.units()[0].status).toBe("review");
  });

  test("a follow-up request comment is never taken as the owner's answer to an open decision", async () => {
    const w = world();
    await earlierWork(w, { pr_url: PR_A });
    await w.sync.decide(w.rows[0]!, "Pick A or B.");
    await w.sync.sync();
    expect(w.receipts("decision")[0]).toMatchObject({ state: "sent", answered_at: null });
    w.drain();
    at(61_000);
    await followUp(w, { pr_url: PR_A });
    await w.sync.sync();
    expect(w.called("postComment")).toEqual([["postComment", "T1", request("U2", "Fix the review comment.")]]);
    // The adapter returns Chief's own comment as an owner comment, newer than the open decision; the poll ran and ignored it.
    expect(w.remote.comments.map((c) => c.byOwner)).toEqual([true, true]);
    expect(w.called("comments").length).toBeGreaterThan(0);
    expect(w.answerAlert).not.toHaveBeenCalled();
    expect(w.receipts("answer")).toEqual([]);
    expect(w.receipts("decision")[0].answered_at).toBeNull();
  });

  test("earlier work from while the tracker was off: one unit under the earlier root with the follow-up's title and mission, and no request comment", async () => {
    const w = world();
    w.cfg = null;
    await w.sync.start(w.add({ thread_id: "U1", role: "worker", title: "Alpha", pr_url: PR_A, state: "complete" }), "Mission A");
    expect(w.rowCount()).toBe(0);
    w.cfg = { tracker: w.tracker, projects: new Map([["proj_1", "ABC"]]) };
    await followUp(w, { pr_url: PR_A });
    await w.sync.sync();
    const marker = `chief-unit:${sha12("U1")}`;
    expect(w.units()).toMatchObject([{ root_thread_id: "U1", title: "Beta", description: `Fix the review comment.\n\n${marker}`, task_id: "T1" }]);
    expect(w.called("createTask")).toEqual([["createTask", { project: "ABC", title: "Beta", description: `Fix the review comment.\n\n${marker}` }]]);
    expect(w.called("attachThread")).toEqual([["attachThread", "T1", "U2"]]);
    expect(w.called("postComment")).toEqual([]);
    expect(w.receipts("thread")).toMatchObject([{ ref: "U2", payload: null, state: "sent" }]);
  });

  describe("chains of any length", () => {
    // Each worker matches only its predecessor: A=(P1,b1) B=(P1,b2) C=(P2,b2) D=(P2,b3) E=(P3,b3) F=(P3,b4) G=(P4,b4).
    const PRS = [1, 1, 2, 2, 3, 3, 4].map((n) => `https://github.com/acme/shop/pull/${n + 10}`);
    const BRANCHES = ["b1", "b2", "b2", "b3", "b3", "b4", "b4"];
    const IDS = ["A", "B", "C", "D", "E", "F", "G"];
    /** A..F started and finished one after another; G is returned unstarted. */
    async function sixDone(w: World) {
      for (let i = 0; i < 6; i++) {
        const row = w.add({ thread_id: IDS[i]!, role: "worker", title: IDS[i], pr_url: PRS[i]!, branch: BRANCHES[i]! });
        await w.sync.start(row, `Mission ${IDS[i]}`);
        await w.sync.sync();
        row.state = "complete";
        await w.sync.sync();
      }
      w.drain();
    }

    test("the seventh worker joins the first one's task; its reviewer-of-the-sixth's files and its decisions land there; the task goes back to working", async () => {
      const w = world();
      await sixDone(w);
      expect(w.units().map((u) => u.root_thread_id)).toEqual(["A"]);
      expect(w.units()[0].status).toBe("review");
      const g = w.add({ thread_id: "G", role: "worker", title: "G", pr_url: PRS[6]!, branch: BRANCHES[6]! });
      await w.sync.start(g, "Mission G");
      const reviewer = w.add({ thread_id: "RF", role: "reviewer", worker_thread_id: "F" });
      w.targets = { RF: ["F"] };
      await w.sync.attachFiles(reviewer, [{ name: "verdict.md", content: "# verdict F" }]);
      await w.sync.decide(g, "Pick A or B.");
      await w.sync.decide(reviewer, "Pick C or D.");
      expect(w.units()).toHaveLength(1);
      expect(new Set(w.receipts().map((r) => r.root_thread_id))).toEqual(new Set(["A"]));
      await w.sync.sync();
      expect(w.called("createTask")).toEqual([]);
      expect(w.called("postComment").filter((c) => (c[2] as string).includes("chief-request:G"))).toEqual([["postComment", "T1", request("G", "Mission G")]]);
      expect(w.called("attachThread")).toEqual([["attachThread", "T1", "G"]]);
      expect(w.called("attachFile")).toEqual([["attachFile", "T1", { name: "verdict.md", content: "# verdict F" }]]);
      expect(w.called("postComment").filter((c) => (c[2] as string).includes("Pick "))).toHaveLength(2);
      // G is part of A's unit: its pull request is linked and the unit works while G runs.
      expect(w.called("linkPullRequest")).toEqual([["linkPullRequest", "T1", PRS[6]]]);
      expect(w.called("setStatus")).toEqual([["setStatus", "T1", "working"]]);
      // Two passes equal one pass.
      w.drain();
      await w.sync.sync();
      expect(w.writes()).toEqual([]);
      g.state = "complete";
      await w.sync.sync();
      expect(w.called("setStatus")).toEqual([["setStatus", "T1", "review"]]);
    });

    test("a cycle in the earlier-work links ends the walk: the thread belongs to no unit", async () => {
      const w = world();
      // A worker planned by an advisor that is, in turn, tied back to that worker.
      w.add({ thread_id: "X", role: "advisor", plan_thread_id: "W" });
      const worker = w.add({ thread_id: "W", role: "worker", plan_thread_id: "X" });
      await w.sync.start(worker, "Mission W");
      expect(w.log.warn).not.toHaveBeenCalled(); // a runaway walk would be caught by the hook and logged here
      await w.sync.sync();
      expect(w.rowCount()).toBe(0);
      expect(w.writes()).toEqual([]);
    });
  });

  test("off: the follow-up writes no row and makes no call", async () => {
    const w = world();
    await earlierWork(w, { pr_url: PR_A });
    const before = w.rowCount();
    w.cfg = null;
    await followUp(w, { pr_url: PR_A });
    await w.sync.sync();
    expect(w.rowCount()).toBe(before);
    expect(w.calls).toEqual([]);
  });
});

describe("off, unmapped and unavailable", () => {
  test("off: hooks and sync write no row and call no tracker method", async () => {
    const w = world();
    w.cfg = null;
    const planner = w.add({ thread_id: "P1", role: "planner" });
    await w.sync.start(planner, "m");
    await w.sync.attachFiles(planner, [{ name: "plan-1.md", content: "x" }]);
    await w.sync.decide(planner, "Pick?");
    await w.sync.sync();
    expect(w.rowCount()).toBe(0);
    expect(w.calls).toEqual([]);
  });

  test("switching off keeps rows and stops calls; switching back resumes pending work and never backfills what happened while off", async () => {
    const w = world();
    const planner = await plannedUnit(w);
    await w.sync.decide(planner, "Pick A or B.");
    await w.sync.sync();
    // Recorded while on, still unsent when the tracker is switched off.
    await w.sync.join(w.add({ thread_id: "W0", role: "worker", plan_thread_id: "P1" }));
    const before = w.rowCount();
    const cfg = w.cfg;
    w.cfg = null;
    w.drain();
    // While off: a new decision, a new unit, a joining worker and its files. Nothing is recorded; no call is made.
    await w.sync.decide(planner, "Ship now or wait?");
    await w.sync.start(w.add({ thread_id: "U1", role: "worker" }), "m");
    const offWorker = w.add({ thread_id: "W1", role: "worker", plan_thread_id: "P1", pr_url: PR_A });
    await w.sync.join(offWorker);
    await w.sync.attachFiles(offWorker, [{ name: "f.md", content: "x" }]);
    at(61_000);
    w.remote.comments.push({ id: "o1", byOwner: true, body: "Use option A.", at: Date.now() });
    await w.sync.sync();
    expect(w.rowCount()).toBe(before);
    expect(w.calls).toEqual([]);
    expect(w.answerAlert).not.toHaveBeenCalled();
    // Back on: the pending attach and the answer poll resume; the off-period worker is never attached or linked.
    w.cfg = cfg;
    await w.sync.sync();
    await w.sync.sync();
    expect(w.called("attachThread")).toEqual([["attachThread", "T1", "W0"]]);
    expect(w.called("linkPullRequest")).toEqual([]);
    expect(w.called("attachFile")).toEqual([]);
    expect(w.receipts("thread").map((r) => r.ref)).toEqual(["P1", "W0"]);
    expect(w.answerAlert).toHaveBeenCalledTimes(1);
    expect(w.receipts("decision")).toHaveLength(1);
    expect(w.units()).toHaveLength(1);
  });

  test("a rejected settings read counts as off: logged, nothing written, nothing thrown", async () => {
    const w = world();
    w.cfg = "reject";
    const planner = w.add({ thread_id: "P1", role: "planner" });
    await expect(w.sync.start(planner, "m")).resolves.toBeUndefined();
    await expect(w.sync.attachFiles(planner, [{ name: "f.md", content: "x" }])).resolves.toBeUndefined();
    await expect(w.sync.decide(planner, "Pick?")).resolves.toBeUndefined();
    await expect(w.sync.sync()).resolves.toBeUndefined();
    expect(w.log.warn).toHaveBeenCalled();
    expect(w.rowCount()).toBe(0);
    expect(w.calls).toEqual([]);
  });

  test("on with an unmapped project: no unit, no task", async () => {
    const w = world();
    w.cfg = { tracker: w.tracker, projects: new Map([["proj_other", "ABC"]]) };
    await w.sync.start(w.add({ thread_id: "P1", role: "planner" }), "m");
    await w.sync.sync();
    expect(w.rowCount()).toBe(0);
    expect(w.called("createTask")).toEqual([]);
  });

  test("on with an unavailable tracker: the unit row exists and the only call is available()", async () => {
    const w = world();
    w.behave.available = async () => false;
    await w.sync.start(w.add({ thread_id: "P1", role: "planner" }), "m");
    await w.sync.sync();
    await w.sync.sync();
    expect(w.units()).toMatchObject([{ task_id: null, create_state: null, create_attempts: 0 }]);
    expect(w.names()).toEqual(["available", "available"]);
  });
});
