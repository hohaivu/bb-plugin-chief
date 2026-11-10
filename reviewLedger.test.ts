import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import { createReviewLedger } from "./reviewLedger";

// Contract: reviewLedger answers three questions as data (the 2/3 ladder and what a replaces: needs, which open reviews
// exist and which is in flight, whether the newest verdict approves what the worker would ship). The caller oracle
// (server.test.ts "review decisions oracle") owns sentences and bytes; this file owns each rule once.
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
  // The write side belongs to the thread store; no function under test here writes.
  const writes = { repointReviewer() {}, setRejectStreak() {}, bumpRejectStreak() {} };
  const ledger = createReviewLedger<Row>(db, getRow, writes, { busy });

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
  const advisor = (id: string, forWorker: string, over: { created_at: number; advised_at: number | null }) => insert(id, "advisor", { worker_thread_id: forWorker, ...over });
  /** A verdict for each covered worker, in insertion order (the newest has the highest id). */
  const verdict = (reviewerId: string, workers: string[], verdictName: string, at: number, over: { head_sha?: string; worker_report_seq?: number; report_seq?: number } = {}) => {
    for (const w of workers) {
      db.prepare(`INSERT INTO reviewer_verdicts (reviewer_thread_id, worker_thread_id, verdict, report_seq, at, head_sha, worker_report_seq) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(reviewerId, w, verdictName, over.report_seq ?? 1, at, over.head_sha ?? null, over.worker_report_seq ?? null);
    }
  };
  const rejections = (reviewerId: string, workerId: string, count: number) => {
    for (let n = 0; n < count; n++) verdict(reviewerId, [workerId], "request_changes", 100 + n);
  };
  return { ledger, db, worker, reviewer, advisor, verdict, rejections };
}

describe("ladder: the task's streak and rung", () => {
  test.each([
    [0, "fix"],
    [1, "fix"],
    [2, "consult"],
    [3, "stop"],
  ] as const)("%i consecutive request_changes is the %s rung", (count, rung) => {
    const { ledger, worker, reviewer, rejections } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    rejections("r1", "w1", count);
    expect(ledger.ladder("w1")).toEqual({ streak: count, rung });
  });

  test("an approve ends the streak: only the request_changes after it count", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    verdict("r1", ["w1"], "request_changes", 1);
    verdict("r1", ["w1"], "request_changes", 2);
    verdict("r1", ["w1"], "approve", 3);
    verdict("r1", ["w1"], "request_changes", 4);
    expect(ledger.ladder("w1")).toEqual({ streak: 1, rung: "fix" });
    verdict("r1", ["w1"], "request_changes", 5);
    expect(ledger.ladder("w1")).toEqual({ streak: 2, rung: "consult" });
    verdict("r1", ["w1"], "approve", 6);
    expect(ledger.ladder("w1")).toEqual({ streak: 0, rung: "fix" });
  });

  test("the streak is counted across a replaces: chain and every reviewer of it", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    worker("w2", { replaces: "w1" });
    reviewer("r1", ["w1"], { state: "complete" });
    reviewer("r2", ["w2"]);
    verdict("r1", ["w1"], "request_changes", 1);
    verdict("r1", ["w1"], "request_changes", 2);
    verdict("r2", ["w2"], "request_changes", 3);
    expect(ledger.ladder("w2")).toEqual({ streak: 3, rung: "stop" });
    // The replaced worker's own history stops at its own chain: w1 has no successor in its chain.
    expect(ledger.ladder("w1")).toEqual({ streak: 2, rung: "consult" });
  });

  test("rows with no verdict history fall back to the newest reviewer's carried reject_streak", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    reviewer("r1", ["w1"], { reject_streak: 2 });
    expect(ledger.ladder("w1")).toEqual({ streak: 2, rung: "consult" });
  });

  test("a carried reject_streak above the recorded verdicts wins", () => {
    const { ledger, worker, reviewer, rejections } = world();
    worker("w1");
    reviewer("r1", ["w1"], { reject_streak: 3 });
    rejections("r1", "w1", 1);
    expect(ledger.ladder("w1")).toEqual({ streak: 3, rung: "stop" });
  });
});

describe("replacement: what a replaces: of the prior worker still needs", () => {
  /** A prior worker (created at 10) with `count` request_changes, the last recorded at 100 + count - 1. */
  function rejected(count: number, busy?: (status: string) => boolean) {
    const w = world(busy);
    w.worker("prior", { created_at: 10 });
    w.reviewer("r1", ["prior"], { created_at: 20 });
    w.rejections("r1", "prior", count);
    const prior = { thread_id: "prior", created_at: 10 };
    return { ...w, prior };
  }

  test.each([0, 1])("%i rejections need nothing, with or without a user-approved round", (count) => {
    const { ledger, prior } = rejected(count);
    expect(ledger.replacement(prior, false)).toBeNull();
    expect(ledger.replacement(prior, true)).toBeNull();
  });

  test("two rejections with no advisor need a consult", () => {
    const { ledger, prior } = rejected(2);
    expect(ledger.replacement(prior, false)).toEqual({ needs: "consult", streak: 2 });
  });

  test("a user-approved round does not waive the consult at two rejections", () => {
    const { ledger, prior } = rejected(2);
    expect(ledger.replacement(prior, true)).toEqual({ needs: "consult", streak: 2 });
  });

  test("an advisor that advised after the latest rejection and after the prior worker satisfies the consult", () => {
    const { ledger, prior, advisor } = rejected(2);
    advisor("a1", "prior", { created_at: 150, advised_at: 160 });
    expect(ledger.replacement(prior, false)).toBeNull();
  });

  test.each([
    ["has not advised (advised_at null)", { created_at: 150, advised_at: null }],
    ["was created before the latest rejection", { created_at: 50, advised_at: 60 }],
  ])("an advisor that %s does not count", (_name, over) => {
    const { ledger, prior, advisor } = rejected(2);
    advisor("a1", "prior", over);
    expect(ledger.replacement(prior, false)).toEqual({ needs: "consult", streak: 2 });
  });

  test("an advisor created after the latest rejection but before the prior worker does not count", () => {
    const w = world();
    w.worker("prior", { created_at: 120 });
    w.reviewer("r1", ["prior"], { created_at: 20 });
    w.rejections("r1", "prior", 2); // the latest rejection is at 101
    w.advisor("a1", "prior", { created_at: 110, advised_at: 115 });
    expect(w.ledger.replacement({ thread_id: "prior", created_at: 120 }, false)).toEqual({ needs: "consult", streak: 2 });
  });

  test("a consult on another branch of the same plan review counts", () => {
    const w = world();
    w.worker("prior", { created_at: 10 });
    w.worker("sibling", { created_at: 11 });
    w.worker("unrelated", { created_at: 12 });
    // One plan review covers both branches and wrote the newest verdicts for each.
    w.reviewer("plan-review", ["prior", "sibling"], { created_at: 20 });
    w.verdict("plan-review", ["prior", "sibling"], "request_changes", 100);
    w.verdict("plan-review", ["prior", "sibling"], "request_changes", 101);
    w.advisor("a-other", "unrelated", { created_at: 150, advised_at: 160 });
    expect(w.ledger.replacement({ thread_id: "prior", created_at: 10 }, false)).toEqual({ needs: "consult", streak: 2 });
    w.advisor("a-sibling", "sibling", { created_at: 150, advised_at: 160 });
    expect(w.ledger.replacement({ thread_id: "prior", created_at: 10 }, false)).toBeNull();
  });

  test("three rejections need the user, even with a consult", () => {
    const { ledger, prior, advisor } = rejected(3);
    expect(ledger.replacement(prior, false)).toEqual({ needs: "user", streak: 3 });
    advisor("a1", "prior", { created_at: 150, advised_at: 160 });
    expect(ledger.replacement(prior, false)).toEqual({ needs: "user", streak: 3 });
  });

  test("three rejections with a user-approved round pass with no consult", () => {
    const { ledger, prior } = rejected(3);
    expect(ledger.replacement(prior, true)).toBeNull();
  });
});

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

describe("headApproval: is the newest verdict an approve for what the worker would ship", () => {
  const HEAD = "a".repeat(40);
  const OTHER = "b".repeat(40);
  const head = (sha: string | null) => vi.fn(async () => (sha ? { sha } : null));

  test("no verdict on the chain", async () => {
    const { ledger, worker } = world();
    worker("w1", { pr_url: "https://forge/pr/1" });
    const currentHead = head(HEAD);
    expect(await ledger.headApproval({ thread_id: "w1", report_seq: 1, pr_url: "https://forge/pr/1" }, currentHead)).toEqual({ approved: false, reason: "no-verdict" });
    expect(currentHead).not.toHaveBeenCalled();
  });

  test("a newest request_changes is not an approve, and the head is not read", async () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    verdict("r1", ["w1"], "approve", 1, { head_sha: HEAD });
    verdict("r1", ["w1"], "request_changes", 2, { head_sha: HEAD });
    const currentHead = head(HEAD);
    expect(await ledger.headApproval({ thread_id: "w1", report_seq: 1, pr_url: "https://forge/pr/1" }, currentHead)).toEqual({ approved: false, reason: "not-approve", verdict: "request_changes" });
    expect(currentHead).not.toHaveBeenCalled();
  });

  describe("with a pull request", () => {
    const pr = "https://forge/pr/1";
    const seeded = (recorded: string | null) => {
      const w = world();
      w.worker("w1", { pr_url: pr });
      w.reviewer("r1", ["w1"]);
      w.verdict("r1", ["w1"], "approve", 1, { head_sha: recorded ?? undefined });
      return w;
    };

    test("the approved head still is the pull request's head: approved, and it is read exactly once", async () => {
      const { ledger } = seeded(HEAD);
      const currentHead = head(HEAD);
      expect(await ledger.headApproval({ thread_id: "w1", report_seq: 1, pr_url: pr }, currentHead)).toEqual({ approved: true });
      expect(currentHead).toHaveBeenCalledTimes(1);
    });

    test("an uppercase recorded head_sha that matches is approved", async () => {
      const { ledger } = seeded(HEAD.toUpperCase());
      expect(await ledger.headApproval({ thread_id: "w1", report_seq: 1, pr_url: pr }, head(HEAD))).toEqual({ approved: true });
    });

    test("a head that cannot be read is head-unreadable, after one read", async () => {
      const { ledger } = seeded(HEAD);
      const currentHead = head(null);
      expect(await ledger.headApproval({ thread_id: "w1", report_seq: 1, pr_url: pr }, currentHead)).toEqual({ approved: false, reason: "head-unreadable" });
      expect(currentHead).toHaveBeenCalledTimes(1);
    });

    test("a moved head names both commits", async () => {
      const { ledger } = seeded(HEAD);
      expect(await ledger.headApproval({ thread_id: "w1", report_seq: 1, pr_url: pr }, head(OTHER))).toEqual({ approved: false, reason: "head-moved", approvedSha: HEAD, headSha: OTHER });
    });

    test("an approve that recorded no head is head-moved with a null approvedSha", async () => {
      const { ledger } = seeded(null);
      expect(await ledger.headApproval({ thread_id: "w1", report_seq: 1, pr_url: pr }, head(HEAD))).toEqual({ approved: false, reason: "head-moved", approvedSha: null, headSha: HEAD });
    });

    test("the report is not compared when there is a pull request", async () => {
      const { ledger } = seeded(HEAD);
      expect(await ledger.headApproval({ thread_id: "w1", report_seq: 9, pr_url: pr }, head(HEAD))).toEqual({ approved: true });
    });
  });

  describe("without a pull request", () => {
    const seeded = (over: { on?: string; seq?: number } = {}) => {
      const w = world();
      w.worker("w1");
      w.worker("w2", { replaces: "w1" });
      w.reviewer("r1", ["w1", "w2"]);
      w.verdict("r1", [over.on ?? "w2"], "approve", 1, { worker_report_seq: over.seq ?? 3 });
      return w;
    };

    test("the approve covers the worker's current report: approved, and no head is read", async () => {
      const { ledger } = seeded();
      const currentHead = head(HEAD);
      expect(await ledger.headApproval({ thread_id: "w2", report_seq: 3, pr_url: null }, currentHead)).toEqual({ approved: true });
      expect(currentHead).not.toHaveBeenCalled();
    });

    test("the worker reported again after the approve: report-moved", async () => {
      const { ledger } = seeded();
      const currentHead = head(HEAD);
      expect(await ledger.headApproval({ thread_id: "w2", report_seq: 4, pr_url: null }, currentHead)).toEqual({ approved: false, reason: "report-moved" });
      expect(currentHead).not.toHaveBeenCalled();
    });

    test("the newest approve was recorded on an older chain member: report-moved", async () => {
      const { ledger } = seeded({ on: "w1", seq: 3 });
      expect(await ledger.headApproval({ thread_id: "w2", report_seq: 3, pr_url: null }, head(HEAD))).toEqual({ approved: false, reason: "report-moved" });
    });
  });
});

// Contract (docs/specs/plan-chains.md "Review Worktree"): the reviewer a later pinned review may reuse is the newest reviewer of any
// state that was pinned to a head and covers a worker of the task's chain; an unpinned reviewer ran in a worker's own environment.
describe("lastPinnedReviewer: the earlier reviewer whose worktree a pinned review may reuse", () => {
  const SHA = "a".repeat(40);

  test("none when nothing reviewed the task", () => {
    const { ledger, worker } = world();
    worker("w1");
    expect(ledger.lastPinnedReviewer(["w1"])).toBeNull();
  });

  test("the newest pinned reviewer wins over an older pinned one, whatever its state", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    reviewer("r1", ["w1"], { reviewed_head_sha: SHA, state: "ready" });
    reviewer("r2", ["w1"], { reviewed_head_sha: SHA, state: "complete" });
    expect(ledger.lastPinnedReviewer(["w1"])).toBe("r2");
  });

  test("an unpinned reviewer is skipped even when newer: the answer is the newest pinned one", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    reviewer("r1", ["w1"], { reviewed_head_sha: SHA });
    reviewer("r2", ["w1"]);
    expect(ledger.lastPinnedReviewer(["w1"])).toBe("r1");
    const only = world();
    only.worker("w1");
    only.reviewer("r1", ["w1"]);
    expect(only.ledger.lastPinnedReviewer(["w1"])).toBeNull();
  });

  test("a reviewer of an earlier worker in the replaces: chain counts: the task, not the row, is the unit", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    worker("w2", { replaces: "w1" });
    reviewer("r1", ["w1"], { reviewed_head_sha: SHA });
    expect(ledger.lastPinnedReviewer(["w2"])).toBe("r1");
  });

  test("a reviewer of an unrelated task is never returned", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    worker("other");
    reviewer("r1", ["other"], { reviewed_head_sha: SHA });
    expect(ledger.lastPinnedReviewer(["w1"])).toBeNull();
  });

  test("a plan review covering several workers is found from any of them, and the lists are merged", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    worker("w2");
    reviewer("r1", ["w1", "w2"], { reviewed_head_sha: SHA });
    expect(ledger.lastPinnedReviewer(["w2"])).toBe("r1");
    expect(ledger.lastPinnedReviewer(["w1", "w2"])).toBe("r1");
  });

  test("the same creation time is broken by insertion order: the later row wins", () => {
    const { ledger, worker, reviewer } = world();
    worker("w1");
    reviewer("r1", ["w1"], { reviewed_head_sha: SHA, created_at: 500 });
    reviewer("r2", ["w1"], { reviewed_head_sha: SHA, created_at: 500 });
    expect(ledger.lastPinnedReviewer(["w1"])).toBe("r2");
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

  test("reject, approve, reject is two request_changes events, while the consecutive streak is one", () => {
    const { ledger, worker, reviewer, verdict } = world();
    worker("w1");
    reviewer("r1", ["w1"]);
    verdict("r1", ["w1"], "request_changes", 1, { report_seq: 1 });
    verdict("r1", ["w1"], "approve", 2, { report_seq: 2 });
    verdict("r1", ["w1"], "request_changes", 3, { report_seq: 3 });
    expect(ledger.eventCounts([{ thread_id: "r1", verdict: "request_changes" }]).get("r1")).toEqual({ approve: 1, request_changes: 2 });
    expect(ledger.ladder("w1").streak).toBe(1);
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
    expect(ledger.ladder("w1").streak).toBe(3);
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
