import { afterEach, describe, expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "../src/db/migrations";
import { createReviewLedger } from "../src/review/reviewLedger";

// Contract: reviewLedger answers its questions as data (which open reviews exist and which is in flight, what each reviewer
// verdict recorded, how many events a reviewer gave). It counts no rejections (plan-2). The caller oracle owns sentences
// and bytes; this file owns each rule once.
// Real SQLite with the plugin's real migrations; rows are seeded with minimal SQL. Nothing of the ledger is mocked.

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
});

type Row = { thread_id: string; replaces_thread_id: string | null; report_seq: number; created_at: number; state: string };

let hostCount = 0;
function world(busy: (status: string) => boolean = (status) => status === "working") {
  const { bb, harness } = createFakePluginHost({ pluginId: `ledger-${++hostCount}` });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const getRow = (id: string) => db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(id) as Row | undefined;
  const ledger = createReviewLedger<Row>(db, getRow, { busy });

  let clock = 0;
  const insert = (id: string, role: string, over: Record<string, unknown> = {}) => {
    const row = { thread_id: id, role, project_id: "proj", title: id, state: "ready", created_at: ++clock, updated_at: 0, report_seq: 0, ...over };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO managed_threads (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
    return id;
  };
  /** replaces: names the worker this one replaced. */
  const worker = (id: string, over: { replaces?: string; created_at?: number; pr_url?: string; report_seq?: number } = {}) =>
    insert(id, "worker", { replaces_thread_id: over.replaces ?? null, ...(over.created_at !== undefined && { created_at: over.created_at }), pr_url: over.pr_url ?? null, ...(over.report_seq !== undefined && { report_seq: over.report_seq }) });
  /** One reviewer covering every listed worker, as a plan review does. */
  const reviewer = (id: string, covers: string[], over: Record<string, unknown> = {}) => {
    insert(id, "reviewer", over);
    for (const w of covers) db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id) VALUES (?, ?)`).run(id, w);
    return id;
  };
  /** A verdict for each covered worker, in insertion order (the newest has the highest id). */
  const verdict = (reviewerId: string, workers: string[], verdictName: string, at: number, over: { head_sha?: string; worker_report_seq?: number; report_seq?: number } = {}) => {
    for (const w of workers) {
      db.prepare(`INSERT INTO reviewer_verdicts (reviewer_thread_id, worker_thread_id, verdict, report_seq, at, head_sha, worker_report_seq) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(reviewerId, w, verdictName, over.report_seq ?? 1, at, over.head_sha ?? null, over.worker_report_seq ?? null);
    }
  };
  return { ledger, db, worker, reviewer, verdict, insert };
}

describe("openReviews: the open reviews of workers' task chains", () => {
  test("one review covering several workers of a chain is listed once", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    worker("w2", { replaces: "w1" });
    reviewer("plan-review", ["w1", "w2"]);
    const { open, previous } = ledger.openReviews(["w2"]);
    expect(open.map((review) => review.thread_id)).toEqual(["plan-review"]);
    expect(previous?.thread_id).toBe("plan-review");
    expect(ledger.openReviews(["w1", "w2"]).open.map((review) => review.thread_id)).toEqual(["plan-review"]);
  });

  test("reviews come newest first, and previous is the newest", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    worker("w2", { replaces: "w1" });
    reviewer("old", ["w1"], { created_at: 100, state: "ready" });
    reviewer("new", ["w2"], { created_at: 200, state: "ready" });
    const { open, previous } = ledger.openReviews(["w2"]);
    expect(open.map((review) => review.thread_id)).toEqual(["new", "old"]);
    expect(previous?.thread_id).toBe("new");
  });

  test("inFlight is decided by the injected busy predicate, not by a built-in status list", () => {
    const { ledger, worker, reviewer } = world((status) => status === "working");
    worker("w1");
    worker("w2", { replaces: "w1" });
    reviewer("old", ["w1"], { created_at: 100, state: "working" });
    reviewer("new", ["w2"], { created_at: 200, state: "ready" });
    // "working" is busy under this predicate and the newest review is idle: inFlight is the older one.
    expect(ledger.openReviews(["w2"]).inFlight?.thread_id).toBe("old");
  });

  test("idle and ready reviews are not in flight", () => {
    const { ledger, worker, reviewer } = world((status) => status === "working");
    worker("w1");
    reviewer("r1", ["w1"], { state: "ready" });
    expect(ledger.openReviews(["w1"]).inFlight).toBeUndefined();
    const second = world((status) => status === "working");
    second.worker("w1");
    second.reviewer("r1", ["w1"], { state: "idle" });
    expect(second.ledger.openReviews(["w1"]).inFlight).toBeUndefined();
  });

  test("a state the predicate rejects is not in flight even when it is busy elsewhere", () => {
    const { ledger, worker, reviewer } = world((status) => status === "working");
    worker("w1");
    reviewer("r1", ["w1"], { state: "active" });
    expect(ledger.openReviews(["w1"])).toMatchObject({ previous: { thread_id: "r1" }, inFlight: undefined });
  });

  test("completed, archived and deleted reviewers are excluded", () => {
    const { ledger, worker, reviewer } = world(() => true);
    worker("w1");
    reviewer("done", ["w1"], { state: "complete" });
    reviewer("gone", ["w1"], { state: "archived" });
    reviewer("deleted", ["w1"], { state: "deleted" });
    expect(ledger.openReviews(["w1"])).toEqual({ open: [], previous: undefined, inFlight: undefined });
  });

  test("workers with no review give empty data", () => {
    const { ledger, worker } = world();
    worker("w1");
    expect(ledger.openReviews(["w1"])).toEqual({ open: [], previous: undefined, inFlight: undefined });
    expect(ledger.openReviews([])).toEqual({ open: [], previous: undefined, inFlight: undefined });
  });
});

describe("busyReview: the busy open review chief_complete names when it refuses skipReview", () => {
  const chain = (busy?: (status: string) => boolean) => {
    const w = world(busy);
    w.worker("w1");
    w.worker("w2", { replaces: "w1" });
    return w;
  };

  test("the worker's own review comes first even when a review of an older chain member is newer", () => {
    const { ledger, reviewer } = chain();
    reviewer("r2", ["w2"], { created_at: 100, state: "working" });
    reviewer("r1", ["w1"], { created_at: 200, state: "working" });
    expect(ledger.busyReview("w2")?.thread_id).toBe("r2");
    // openReviews orders by age (reviewStart's rule): the same data gives the other answer there.
    expect(ledger.openReviews(["w2"]).inFlight?.thread_id).toBe("r1");
  });

  test("an idle own review is skipped: the next busy review down the chain is named", () => {
    const { ledger, reviewer } = chain();
    reviewer("r2", ["w2"], { created_at: 100, state: "ready" });
    reviewer("r1", ["w1"], { created_at: 200, state: "working" });
    expect(ledger.busyReview("w2")?.thread_id).toBe("r1");
  });

  test("a review of a worker later in the chain is not in this worker's chain", () => {
    const { ledger, reviewer } = chain();
    reviewer("r2", ["w2"], { state: "working" });
    expect(ledger.busyReview("w1")).toBeUndefined();
  });

  test("busy is decided by the injected predicate, and completed reviews are ignored", () => {
    const { ledger, reviewer } = chain((status) => status === "working");
    reviewer("r2", ["w2"], { state: "complete" });
    reviewer("r1", ["w1"], { state: "active" });
    expect(ledger.busyReview("w2")).toBeUndefined();
  });
});

// Contract (PR #187): eventCounts is the one owner of "how many approve / request_changes events did each reviewer give".
// One event is one report (reviewer_thread_id, report_seq), however many target rows the report wrote; history wins over the
// current verdict; the carried reject_streak is never an event count. chiefStats' caller test lives in server.test.ts.
describe("eventCounts: review events per reviewer", () => {
  const noCounts = { approve: 0, request_changes: 0 };

  test("one report with several target rows is one event", () => {
    const { ledger, worker, reviewer, verdict } = world();
    for (const id of ["w1", "w2", "w3"]) worker(id);
    reviewer("r1", ["w1", "w2", "w3"]);
    verdict("r1", ["w1", "w2", "w3"], "request_changes", 1);
    expect(ledger.eventCounts([{ thread_id: "r1", verdict: "request_changes" }]).get("r1")).toEqual({ approve: 0, request_changes: 1 });
  });

  test("two reports of one reviewer are two events; the same report_seq of another reviewer is its own event", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    reviewer("r2", ["w1"]);
    verdict("r1", ["w1"], "request_changes", 1, { report_seq: 1 });
    verdict("r1", ["w1"], "request_changes", 2, { report_seq: 2 });
    verdict("r2", ["w1"], "request_changes", 3, { report_seq: 1 });
    const counts = ledger.eventCounts([{ thread_id: "r1", verdict: "request_changes" }, { thread_id: "r2", verdict: "request_changes" }]);
    expect(counts.get("r1")).toEqual({ approve: 0, request_changes: 2 });
    expect(counts.get("r2")).toEqual({ approve: 0, request_changes: 1 });
  });

  test("reject, approve, reject is two request_changes events", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    verdict("r1", ["w1"], "request_changes", 1, { report_seq: 1 });
    verdict("r1", ["w1"], "approve", 2, { report_seq: 2 });
    verdict("r1", ["w1"], "request_changes", 3, { report_seq: 3 });
    expect(ledger.eventCounts([{ thread_id: "r1", verdict: "request_changes" }]).get("r1")).toEqual({ approve: 1, request_changes: 2 });
  });

  test("history survives a cleared current verdict and a completed reviewer", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"], { state: "complete" });
    verdict("r1", ["w1"], "request_changes", 1);
    expect(ledger.eventCounts([{ thread_id: "r1", verdict: null }]).get("r1")).toEqual({ approve: 0, request_changes: 1 });
  });

  test("a reviewer with history does not count its current verdict again", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    reviewer("r2", ["w1"]);
    verdict("r1", ["w1"], "request_changes", 1);
    verdict("r2", ["w1"], "approve", 2);
    const counts = ledger.eventCounts([{ thread_id: "r1", verdict: "request_changes" }, { thread_id: "r2", verdict: "request_changes" }]);
    // r1: the current verdict is the same event as its history row. r2: a current verdict that differs from its history is still ignored.
    expect(counts.get("r1")).toEqual({ approve: 0, request_changes: 1 });
    expect(counts.get("r2")).toEqual({ approve: 1, request_changes: 0 });
  });

  test("a legacy reviewer with no history and a carried reject_streak of 3 is exactly one event, from its current verdict", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    reviewer("r1", ["w1"], { verdict: "request_changes", reject_streak: 3 });
    expect(ledger.eventCounts([{ thread_id: "r1", verdict: "request_changes" }]).get("r1")).toEqual({ approve: 0, request_changes: 1 });
  });

  test("no history and a null current verdict count nothing", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    expect(ledger.eventCounts([{ thread_id: "r1", verdict: null }]).get("r1")).toEqual(noCounts);
  });

  test("an empty input gives nothing; only the reviewers passed in get an entry, zero counts included", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    reviewer("r2", ["w1"]);
    reviewer("r3", ["w1"]);
    verdict("r1", ["w1"], "approve", 1);
    verdict("r2", ["w1"], "request_changes", 2);
    expect(ledger.eventCounts([]).size).toBe(0);
    const counts = ledger.eventCounts([{ thread_id: "r1", verdict: "approve" }, { thread_id: "r3", verdict: null }]);
    expect([...counts.keys()].sort()).toEqual(["r1", "r3"]);
    expect(counts.get("r1")).toEqual({ approve: 1, request_changes: 0 });
    expect(counts.get("r3")).toEqual(noCounts);
  });
});

// Contract: newestVerdictAt is the one owner of "what was the newest verdict over these rows and when": by recording order
// (insertion id), not by the `at` time, over only the ids given; empty input and no verdict give null. Regression: the newest is
// chosen by `at` (a clock step back makes an old rejection newest), or it reads another chain's verdicts.
describe("newestVerdictAt: the newest verdict over some rows", () => {
  test("the latest recorded verdict wins whatever its time, other rows are ignored, no input or no verdict is null", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    worker("w2");
    worker("other");
    const r = reviewer("r1", ["w1", "w2", "other"]);
    verdict(r, ["w1"], "request_changes", 500);
    verdict(r, ["w2"], "approve", 100);
    verdict(r, ["other"], "request_changes", 900);
    expect(ledger.newestVerdictAt(["w1"])).toEqual({ verdict: "request_changes", at: 500 });
    expect(ledger.newestVerdictAt(["w1", "w2"])).toEqual({ verdict: "approve", at: 100 });
    expect(ledger.newestVerdictAt(["other", "w2"])).toEqual({ verdict: "request_changes", at: 900 });
    expect(ledger.newestVerdictAt([])).toBeNull();
    expect(ledger.newestVerdictAt(["unknown"])).toBeNull();
  });
});

// Contract (plan-2 step 1): recordVerdict inserts exactly one reviewer_verdicts row per covered target per verdict, bound to the
// target's head_sha and report_seq, and never touches reject_streak (no code counts rejections any more).
// Regression: it bumps or seeds reject_streak, writes one row per verdict instead of per target, or drops the head/report binding.
describe("recordVerdict: one row per covered target per verdict", () => {
  test("two request_changes verdicts over two targets write four bound rows and leave every reject_streak alone", () => {
    const { ledger, db, worker, insert } = world();
    worker("w1");
    worker("w2");
    insert("r1", "reviewer", { reject_streak: 2 });
    db.prepare(`UPDATE managed_threads SET reject_streak=5 WHERE thread_id='w1'`).run();
    ledger.addTargets("r1", [
      { threadId: "w1", reportSeq: 3, headSha: "a".repeat(40), prUrl: null, branch: "b1" },
      { threadId: "w2", reportSeq: 7, headSha: "b".repeat(40), prUrl: null, branch: "b2" },
    ]);
    const reviewerRow = { thread_id: "r1", role: "reviewer" };
    ledger.recordVerdict(reviewerRow, "request_changes", 1, 1000);
    ledger.recordVerdict(reviewerRow, "request_changes", 2, 2000);
    const rows = db.prepare(`SELECT worker_thread_id, verdict, report_seq, head_sha, worker_report_seq FROM reviewer_verdicts WHERE reviewer_thread_id='r1' ORDER BY id`).all();
    expect(rows).toEqual([
      { worker_thread_id: "w1", verdict: "request_changes", report_seq: 1, head_sha: "a".repeat(40), worker_report_seq: 3 },
      { worker_thread_id: "w2", verdict: "request_changes", report_seq: 1, head_sha: "b".repeat(40), worker_report_seq: 7 },
      { worker_thread_id: "w1", verdict: "request_changes", report_seq: 2, head_sha: "a".repeat(40), worker_report_seq: 3 },
      { worker_thread_id: "w2", verdict: "request_changes", report_seq: 2, head_sha: "b".repeat(40), worker_report_seq: 7 },
    ]);
    expect(db.prepare(`SELECT thread_id, reject_streak FROM managed_threads ORDER BY thread_id`).all())
      .toEqual([{ thread_id: "r1", reject_streak: 2 }, { thread_id: "w1", reject_streak: 5 }, { thread_id: "w2", reject_streak: 0 }]);
  });
});
