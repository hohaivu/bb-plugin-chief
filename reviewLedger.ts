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

/** What the ledger reads of a managed_threads row; the server's ManagedRow satisfies it. */
interface LedgerRow {
  thread_id: string;
  replaces_thread_id: string | null;
  report_seq: number;
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

  /** The newest verdict on the worker's task chain, with the report it covered; undefined when none was recorded. */
  function newestVerdict(worker: { thread_id: string }) {
    const chain = taskChain(worker.thread_id);
    return db.prepare(`SELECT v.verdict, v.head_sha, v.worker_thread_id, COALESCE(v.worker_report_seq, r.reviewed_report_seq) AS reviewed_report_seq
      FROM reviewer_verdicts v LEFT JOIN managed_threads r ON r.thread_id = v.reviewer_thread_id
      WHERE v.worker_thread_id IN (${chain.map(() => "?").join(",")}) ORDER BY v.id DESC LIMIT 1`).get(...chain) as
      { verdict: string; head_sha: string | null; worker_thread_id: string | null; reviewed_report_seq: number | null } | undefined;
  }

  return { targets, openReview, covering, isCurrent, taskChain, taskRejections, rung, consultGate, repoint, addTargets, carriedStreak, seedStreak, recordVerdict, newestVerdict };
}
