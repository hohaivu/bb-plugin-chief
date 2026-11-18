import type { BbPluginApi } from "@get-bb/plugin-sdk";

export interface ReviewTarget {
  reviewer_thread_id: string;
  worker_thread_id: string;
  report_seq: number | null;
  head_sha: string | null;
  pr_url: string | null;
  branch: string | null;
}

export type ReviewEventCounts = Readonly<{ approve: number; request_changes: number }>;

/** What the ledger reads of a managed_threads row; the server's ManagedRow satisfies it. */
interface LedgerRow {
  thread_id: string;
  replaces_thread_id: string | null;
  report_seq: number;
  created_at: number;
  state: string;
}

/** One module owns verdict recording, and review targets. It returns data and decisions,
 * never sentences, and its write functions run inside the caller's transaction: they never open their own.
 * getRow reads the server's live row cache, which is reloaded after writes. */
export function createReviewLedger<Row extends LedgerRow>(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  getRow: (threadId: string) => Row | undefined,
  states: { busy: (status: string) => boolean },
) {
  // A worker's reviewers are found through review_targets: one plan review covers the latest worker of every branch.
  const openReviewOf = db.prepare<[string]>(
    `SELECT r.* FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? AND r.state NOT IN ('complete','archived','deleted') ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
  );
  // Unlike openReviewOf, this is not filtered by state: nextAction's dedup must
  // still find a reviewer that has since completed, so a completed reviewer that
  // already covered the worker's latest report does not bring back a spurious
  // chief_review recommendation. target_seq is the report of this worker it covered.
  const coveringReviewer = db.prepare<[string]>(
    `SELECT r.*, t.report_seq AS target_seq FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
  );
  const targetsOf = db.prepare<[string]>(`SELECT * FROM review_targets WHERE reviewer_thread_id=? ORDER BY rowid`);

  const targets = (reviewerThreadId: string) => targetsOf.all(reviewerThreadId) as ReviewTarget[];
  const openReview = (workerThreadId: string) => openReviewOf.get(workerThreadId) as Row | undefined;
  const covering = (workerThreadId: string) => coveringReviewer.get(workerThreadId) as (Row & { target_seq: number | null }) | undefined;
  /** True when a reviewer (of any state) already covers the worker's latest report. */
  const isCurrent = (worker: { thread_id: string; report_seq: number }) => covering(worker.thread_id)?.target_seq === worker.report_seq;

  /** The worker and every worker it replaced through replaces:, newest first. */
  function taskChain(workerThreadId: string) {
    const chain: string[] = [];
    for (let worker = getRow(workerThreadId); worker && !chain.includes(worker.thread_id);
      worker = worker.replaces_thread_id ? getRow(worker.replaces_thread_id) : undefined) {
      chain.push(worker.thread_id);
    }
    if (!chain.length) chain.push(workerThreadId);
    return chain;
  }

  /** Every open review of these workers' task chains, newest first; inFlight is the first one still busy. */
  function openReviews(workerThreadIds: string[]) {
    const open = [...new Set(workerThreadIds.flatMap(taskChain))]
      .flatMap((id) => { const review = openReview(id); return review ? [review] : []; })
      .filter((review, index, all) => all.findIndex((other) => other.thread_id === review.thread_id) === index)
      .sort((a, b) => b.created_at - a.created_at);
    return { open, previous: open[0] as Row | undefined, inFlight: open.find((review) => states.busy(review.state)) };
  }

  /** The first still-busy open review down the worker's own task chain, own review first, not newest first: chief_complete
   * names this one when it refuses skipReview. reviewStart's openReviews.inFlight orders by age instead. */
  const busyReview = (workerThreadId: string) => taskChain(workerThreadId).map(openReview).find((review) => review && states.busy(review.state));

  /** One review_targets row per covered worker, bound to the head and report the review was started for. */
  function addTargets(reviewerThreadId: string, covered: { threadId: string; reportSeq: number | null; headSha: string | null; prUrl: string | null; branch: string | null }[]) {
    for (const target of covered) {
      db.prepare(`INSERT OR REPLACE INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha, pr_url, branch) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(reviewerThreadId, target.threadId, target.reportSeq, target.headSha, target.prUrl, target.branch);
    }
  }

  /** A reviewer's verdict writes one reviewer_verdicts row per covered worker, each with the head and report it was
   * bound to (-1 marks a legacy target whose report was cleared). */
  function recordVerdict(row: { thread_id: string; role: string }, verdict: string | null, reportSeq: number, now: number) {
    if (row.role !== "reviewer" || !verdict) return;
    const covered = targets(row.thread_id);
    if (covered.length) {
      for (const target of covered) {
        db.prepare(`INSERT INTO reviewer_verdicts (reviewer_thread_id, worker_thread_id, verdict, report_seq, at, head_sha, worker_report_seq) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(row.thread_id, target.worker_thread_id, verdict, reportSeq, now, target.head_sha, target.report_seq ?? -1);
      }
    } else {
      db.prepare(`INSERT INTO reviewer_verdicts (reviewer_thread_id, worker_thread_id, verdict, report_seq, at, head_sha) SELECT thread_id, worker_thread_id, ?, report_seq, ?, reviewed_head_sha FROM managed_threads WHERE thread_id=?`).run(verdict, now, row.thread_id);
    }
  }

  /** How many distinct reviewers recorded a verdict on these worker ids since a time (the gate's re-review bound). */
  function reviewersWithVerdict(threadIds: string[], since: number): number {
    if (!threadIds.length) return 0;
    return (db.prepare(`SELECT COUNT(DISTINCT reviewer_thread_id) AS n FROM reviewer_verdicts WHERE worker_thread_id IN (${threadIds.map(() => "?").join(",")}) AND at >= ?`).get(...threadIds, since) as { n: number }).n;
  }

  /** The newest reviewer_verdicts row over these worker ids and the time it was recorded; null when none. */
  function newestVerdictAt(threadIds: string[]): { verdict: string; at: number; reviewer_thread_id: string } | null {
    if (!threadIds.length) return null;
    return (db.prepare(`SELECT verdict, at, reviewer_thread_id FROM reviewer_verdicts WHERE worker_thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`).get(...threadIds) as { verdict: string; at: number; reviewer_thread_id: string } | undefined) ?? null;
  }

  /** The newest verdict on the worker's task chain, with the report it covered; undefined when none was recorded. */
  function newestVerdict(worker: { thread_id: string }) {
    const chain = taskChain(worker.thread_id);
    return db.prepare(`SELECT v.verdict, v.head_sha, v.worker_thread_id, COALESCE(v.worker_report_seq, r.reviewed_report_seq) AS reviewed_report_seq
      FROM reviewer_verdicts v LEFT JOIN managed_threads r ON r.thread_id = v.reviewer_thread_id
      WHERE v.worker_thread_id IN (${chain.map(() => "?").join(",")}) ORDER BY v.id DESC LIMIT 1`).get(...chain) as
      { verdict: string; head_sha: string | null; worker_thread_id: string | null; reviewed_report_seq: number | null } | undefined;
  }

  /** Read-only. How many approve and request_changes events each given reviewer gave. One event is one report
   * (reviewer_thread_id, report_seq), however many target rows it wrote. A reviewer with history uses only its
   * history; one from before reviewer_verdicts existed has none, so its current verdict counts once (null adds
   * nothing). Not reject_streak, and no replacement chains. Returns an entry for each given reviewer, none other. */
  function eventCounts(reviewers: readonly { thread_id: string; verdict: string | null }[]): ReadonlyMap<string, ReviewEventCounts> {
    const counts = new Map<string, { approve: number; request_changes: number }>();
    for (const reviewer of reviewers) counts.set(reviewer.thread_id, { approve: 0, request_changes: 0 });
    const withHistory = new Set<string>();
    const bump = (reviewerThreadId: string, verdict: string | null) => {
      const entry = counts.get(reviewerThreadId)!;
      if (verdict === "approve" || verdict === "request_changes") entry[verdict] += 1;
    };
    for (const event of db.prepare(`SELECT reviewer_thread_id, verdict FROM reviewer_verdicts GROUP BY reviewer_thread_id, report_seq`).all() as { reviewer_thread_id: string; verdict: string }[]) {
      if (!counts.has(event.reviewer_thread_id)) continue;
      withHistory.add(event.reviewer_thread_id);
      bump(event.reviewer_thread_id, event.verdict);
    }
    for (const reviewer of reviewers) if (!withHistory.has(reviewer.thread_id)) bump(reviewer.thread_id, reviewer.verdict);
    return counts;
  }

  return { targets, openReview, openReviews, busyReview, covering, isCurrent, taskChain, addTargets, recordVerdict, newestVerdict, newestVerdictAt, reviewersWithVerdict, eventCounts };
}
