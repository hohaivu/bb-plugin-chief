import type { BbPluginApi } from "@get-bb/plugin-sdk";

// If either threshold ever changes, also edit skills/chief/SKILL.md rule 6 (ordinal prose: a skill cannot import
// a constant) and the chief_delegate tool description in server.ts, which spell the ladder out.
/** Consecutive request_changes verdicts on one task before Chief must consult the advisor. */
export const CONSULT_AFTER_REJECTIONS = 2;
/** Consecutive request_changes verdicts on one task before Chief stops and escalates to the user. */
export const STOP_AFTER_REJECTIONS = 3;

export type Rung = "fix" | "consult" | "stop";

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

/** The managed_threads writes the ledger makes; the thread store owns them and they run in the caller's store.batch. */
interface LedgerWrites {
  repointReviewer(priorThreadId: string, successorThreadId: string, now: number): void;
  setRejectStreak(reviewerThreadId: string, streak: number, now: number): void;
  bumpRejectStreak(threadId: string, verdict: string | null): void;
}

/** One module owns verdict recording, review targets and the 2/3 reject ladder. It returns data and decisions,
 * never sentences, and its write functions run inside the caller's transaction: they never open their own.
 * getRow reads the server's live row cache, which is reloaded after writes. */
export function createReviewLedger<Row extends LedgerRow>(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  getRow: (threadId: string) => Row | undefined,
  writes: LedgerWrites,
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

  /** Consecutive request_changes on a task, across its whole replaces: chain and every reviewer of it (open,
   * completed or re-pointed), from reviewer_verdicts; an approve ends it. Rows from before that table fall
   * back to the newest reviewer's carried reject_streak. lastAt is the newest verdict's time. */
  function taskRejections(workerThreadId: string) {
    const chain = taskChain(workerThreadId);
    const marks = chain.map(() => "?").join(",");
    const verdicts = db.prepare(`SELECT verdict, at FROM reviewer_verdicts WHERE worker_thread_id IN (${marks}) ORDER BY id DESC`).all(...chain) as { verdict: string; at: number }[];
    const end = verdicts.findIndex((entry) => entry.verdict !== "request_changes");
    const carried = db.prepare(`SELECT r.reject_streak FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id IN (${marks}) ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`).get(...chain) as { reject_streak: number } | undefined;
    return { chain, streak: Math.max(end === -1 ? verdicts.length : end, carried?.reject_streak ?? 0), lastAt: verdicts[0]?.at ?? 0 };
  }

  /** The only place that compares a streak with the thresholds. */
  function rung(streak: number): Rung {
    if (streak >= STOP_AFTER_REJECTIONS) return "stop";
    return streak >= CONSULT_AFTER_REJECTIONS ? "consult" : "fix";
  }

  /** startWorker's consult check for a replaces: of `prior`. A consult counts once: it must have sent its advice (a
   * ready or blocked report, recorded in advised_at; a status-only, stopped or completed-unreported consult has none),
   * and started after the latest rejection and after the worker being replaced, so a worker already sent on the one
   * more round cannot be replaced on the same consult. One plan review has one ladder: a consult on any branch of
   * the review that wrote the newest verdict counts for every branch. */
  function consultGate(prior: { thread_id: string; created_at: number }) {
    const { chain, lastAt } = taskRejections(prior.thread_id);
    const group = new Set(chain);
    const newestReviewer = db.prepare(`SELECT reviewer_thread_id FROM reviewer_verdicts WHERE worker_thread_id IN (${chain.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`).get(...chain) as { reviewer_thread_id: string } | undefined;
    for (const target of newestReviewer ? targets(newestReviewer.reviewer_thread_id) : []) {
      for (const id of taskChain(target.worker_thread_id)) group.add(id);
    }
    return !!db.prepare(`SELECT 1 FROM managed_threads WHERE role='advisor' AND worker_thread_id IN (${[...group].map(() => "?").join(",")})
          AND advised_at IS NOT NULL AND created_at >= ? LIMIT 1`).get(...group, Math.max(lastAt, prior.created_at));
  }

  /** Advice: the task's streak and its rung. nextAction's advisor line reads this; it never asks permission. */
  const ladder = (workerThreadId: string) => {
    const { streak } = taskRejections(workerThreadId);
    return { streak, rung: rung(streak) };
  };

  /** Permission: what replaces: of `prior` still needs, or null when it may go ahead. The consult check runs only on the consult rung.
   * retest: the replacement is the retest tester hand-off, which skips the consult and user rungs. */
  function replacement(prior: { thread_id: string; created_at: number }, userApprovedRound: boolean, retest = false): null | { needs: "user" | "consult"; streak: number } {
    if (retest) return null;
    const { streak, rung: at } = ladder(prior.thread_id);
    if (at === "stop" && !userApprovedRound) return { needs: "user", streak };
    if (at === "consult" && !consultGate(prior)) return { needs: "consult", streak };
    return null;
  }

  /** The newest reviewer of any state that was pinned to a head (reviewed_head_sha set) and covers any worker in these workers' task chains; null when none.
   * An unpinned review ran in a worker's own environment and is never returned. */
  function lastPinnedReviewer(workerThreadIds: string[]): string | null {
    const chain = [...new Set(workerThreadIds.flatMap(taskChain))];
    const row = db.prepare(`SELECT r.thread_id FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND r.reviewed_head_sha IS NOT NULL AND t.worker_thread_id IN (${chain.map(() => "?").join(",")}) ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`).get(...chain) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
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

  /** replaces: re-points an open review at the fresh worker: the reviewer row and every target of an open review. */
  function repoint(priorThreadId: string, successorThreadId: string, now: number) {
    writes.repointReviewer(priorThreadId, successorThreadId, now);
    // The same re-point for every worker an open review covers, so a plan review's other branches follow their fresh workers too.
    db.prepare(`UPDATE review_targets SET worker_thread_id=?, report_seq=NULL WHERE worker_thread_id=? AND reviewer_thread_id IN (SELECT thread_id FROM managed_threads WHERE role='reviewer' AND state NOT IN ('complete','archived','deleted'))`).run(successorThreadId, priorThreadId);
  }

  /** One review_targets row per covered worker, bound to the head and report the review was started for. */
  function addTargets(reviewerThreadId: string, covered: { threadId: string; reportSeq: number | null; headSha: string | null; prUrl: string | null; branch: string | null }[]) {
    for (const target of covered) {
      db.prepare(`INSERT OR REPLACE INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha, pr_url, branch) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(reviewerThreadId, target.threadId, target.reportSeq, target.headSha, target.prUrl, target.branch);
    }
  }

  /** The streak a new reviewer of these workers starts from: the task's history, not just the open reviewer, so a completed one cannot reset the count. */
  const carriedStreak = (workerThreadIds: string[]) => Math.max(0, ...workerThreadIds.map((id) => taskRejections(id).streak));

  function seedStreak(reviewerThreadId: string, streak: number, previous: { reject_streak: number } | undefined, now: number) {
    writes.setRejectStreak(reviewerThreadId, Math.max(previous?.reject_streak ?? 0, streak), now);
  }

  /** A report's verdict: reject_streak counts only consecutive request_changes verdicts and resets on an approve; a
   * reviewer's verdict also writes one reviewer_verdicts row per covered worker, each with the head and report it was
   * bound to (-1 marks a target re-pointed to a fresh worker, which no report matches). */
  function recordVerdict(row: { thread_id: string; role: string }, verdict: string | null, reportSeq: number, now: number) {
    writes.bumpRejectStreak(row.thread_id, verdict);
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

  /** The newest reviewer_verdicts row over these worker ids and the time it was recorded; null when none. */
  function newestVerdictAt(threadIds: string[]): { verdict: string; at: number } | null {
    if (!threadIds.length) return null;
    return (db.prepare(`SELECT verdict, at FROM reviewer_verdicts WHERE worker_thread_id IN (${threadIds.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`).get(...threadIds) as { verdict: string; at: number } | undefined) ?? null;
  }

  /** The newest verdict on the worker's task chain, with the report it covered; undefined when none was recorded. */
  function newestVerdict(worker: { thread_id: string }) {
    const chain = taskChain(worker.thread_id);
    return db.prepare(`SELECT v.verdict, v.head_sha, v.worker_thread_id, COALESCE(v.worker_report_seq, r.reviewed_report_seq) AS reviewed_report_seq
      FROM reviewer_verdicts v LEFT JOIN managed_threads r ON r.thread_id = v.reviewer_thread_id
      WHERE v.worker_thread_id IN (${chain.map(() => "?").join(",")}) ORDER BY v.id DESC LIMIT 1`).get(...chain) as
      { verdict: string; head_sha: string | null; worker_thread_id: string | null; reviewed_report_seq: number | null } | undefined;
  }

  /** Whether the newest verdict is an approve for what the worker would ship. With a pull request that is the head
   * currentHead reports now (read only when an approve exists and pr_url is set); without one, the worker's current report. */
  async function headApproval(worker: { thread_id: string; report_seq: number; pr_url: string | null }, currentHead: () => Promise<{ sha: string } | null>) {
    const newest = newestVerdict(worker);
    if (!newest) return { approved: false, reason: "no-verdict" } as const;
    if (newest.verdict !== "approve") return { approved: false, reason: "not-approve", verdict: newest.verdict } as const;
    if (worker.pr_url) {
      const head = await currentHead();
      if (!head) return { approved: false, reason: "head-unreadable" } as const;
      if (newest.head_sha?.toLowerCase() !== head.sha) return { approved: false, reason: "head-moved", approvedSha: newest.head_sha, headSha: head.sha } as const;
      return { approved: true } as const;
    }
    if (newest.worker_thread_id !== worker.thread_id || newest.reviewed_report_seq !== worker.report_seq) return { approved: false, reason: "report-moved" } as const;
    return { approved: true } as const;
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

  return { targets, openReview, openReviews, lastPinnedReviewer, busyReview, covering, isCurrent, taskChain, ladder, rung, replacement, headApproval, repoint, addTargets, carriedStreak, seedStreak, recordVerdict, newestVerdict, newestVerdictAt, eventCounts };
}
