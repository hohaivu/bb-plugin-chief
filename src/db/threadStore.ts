import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** What insert writes of a new managed row; Role and State are the server's row types. */
export interface ThreadInsert<Role extends string = string, State extends string = string> {
  threadId: string;
  role: Role;
  projectId: string;
  chiefThreadId?: string | null;
  workerThreadId?: string | null;
  parentThreadId?: string | null;
  title: string;
  state?: State;
  status?: string | null;
  brief?: string | null;
  branch?: string | null;
  issueUrl?: string | null;
  prUrl?: string | null;
  planThreadId?: string | null;
  planWave?: number | null;
  reviewedReportSeq?: number | null;
  reviewedHeadSha?: string | null;
  unplannedReason?: string | null;
  replacesThreadId?: string | null;
  kind?: string | null;
  plannerOn?: boolean | null;
  verifyCommand?: string | null;
  /** The Coordinator a new child Chief reports to; written only on a new row, a later insert keeps the stored link. */
  coordinatorThreadId?: string | null;
}

/** The columns a report writes to its row; reserveReport maps them onto the UPDATE's parameters. */
export interface ReportReservation {
  threadId: string;
  state: string;
  result: string | null;
  summary: string | null;
  /** Already null unless the report is blocked. */
  blocker: string | null;
  recommendation: string | null;
  verdict: string | null;
  /** The JSON schedule a planner-ready report persisted, or null to keep the stored one. */
  planWaves: string | null;
  regression: 0 | 1;
  /** The merged fails JSON, or null to keep the stored one. */
  fails: string | null;
  /** A reviewer's findings JSON; every report replaces it (null clears). */
  findings: string | null;
  /** A gate tester's ready testsPassed (1/0); null on every other report keeps the stored value. */
  testsPassed: 0 | 1 | null;
  now: number;
}

export interface LiveSync {
  threadId: string;
  state: string;
  status: string;
  /** The row's new active_since: null unless the thread is active. */
  activeSince: number | null;
  enteringActive: boolean;
  now: number;
}

/** One pinned target of a review gate. */
export interface GateTarget { threadId: string; reportSeq: number; branch: string; prUrl: string | null; headSha: string; base: string }
/** A review_gates row with its targets decoded. */
export interface ReviewGate {
  gate_key: string; project_id: string; chief_thread_id: string; plan_thread_id: string | null; targets: GateTarget[];
  reviewer_thread_id: string | null; tester_thread_id: string | null; fixer_thread_id: string | null; corrector_thread_id: string | null; created_at: number;
}
export type GateActor = "reviewer_thread_id" | "tester_thread_id" | "fixer_thread_id" | "corrector_thread_id";
const GATE_ACTORS: GateActor[] = ["reviewer_thread_id", "tester_thread_id", "fixer_thread_id", "corrector_thread_id"];

export interface ThreadStoreHooks {
  /** Runs after every reload (not after refresh); the server gates its sweep and Pending publish on it. */
  onReload: () => void;
}

/** SQL guard: the Chief row has no Coordinator link, or its link points at a Coordinator that is complete, archived or deleted. */
const UNLINKED_OR_DEAD = `(coordinator_thread_id IS NULL OR coordinator_thread_id IN (SELECT thread_id FROM managed_threads WHERE state IN ('complete','archived','deleted')))`;

/** One module owns the managed_threads rows and the cache of them: the cache is replaced only here, and every
 * write reloads it, once per write or once per batch. Other tables stay with their callers. */
export function createThreadStore<Row extends { thread_id: string; role: string; state: string }>(db: Database, hooks: ThreadStoreHooks) {
  const allRows = db.prepare(`SELECT * FROM managed_threads ORDER BY created_at ASC, rowid ASC`);
  const load = () => new Map((allRows.all() as Row[]).map((row) => [row.thread_id, row]));
  const allGates = db.prepare(`SELECT * FROM review_gates ORDER BY created_at ASC, rowid ASC`);
  const loadGates = () => (allGates.all() as (Omit<ReviewGate, "targets"> & { targets: string })[]).map((gate) => ({ ...gate, targets: JSON.parse(gate.targets) as GateTarget[] }));
  let rows = load();
  let gates = loadGates();
  let batching = 0;

  /** Load without onReload: completeAbsorbed runs inside the sweep, so a reload there would recurse. */
  function refresh() {
    rows = load();
    gates = loadGates();
  }
  function reload() {
    refresh();
    hooks.onReload();
  }
  /** After a write: a batch defers to its single reload, anything else reloads at once. */
  function wrote() {
    if (!batching) reload();
  }

  /** Runs fn in one transaction, then reloads once, whatever fn wrote (the ledger's own writes touch rows too).
   * A throw rolls back and leaves the cache as it was. */
  function batch<T>(fn: () => T): T {
    batching += 1;
    let result: T;
    try {
      result = db.transaction(fn)();
    } finally {
      batching -= 1;
    }
    if (!batching) reload();
    return result;
  }

  /** The review ledger's writes run inside the caller's store.batch, which reloads once: they never reload on their own. */
  function inBatch() {
    if (!batching) throw new Error("A review ledger write must run inside store.batch.");
  }

  function insert(input: ThreadInsert<Row["role"], Row["state"]>) {
    const now = Date.now();
    db.prepare(`INSERT INTO managed_threads (
      thread_id, role, project_id, chief_thread_id, worker_thread_id, parent_thread_id, title,
      state, status, brief, branch, issue_url, pr_url, plan_thread_id, plan_wave, reviewed_report_seq, reviewed_head_sha, unplanned_reason, replaces_thread_id, kind, planner_on, verify_command, active_since, active_cycle, created_at, updated_at, coordinator_thread_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET role=excluded.role, project_id=excluded.project_id,
      worker_thread_id=excluded.worker_thread_id,
      parent_thread_id=COALESCE(excluded.parent_thread_id, managed_threads.parent_thread_id),
      title=excluded.title, state=excluded.state, status=excluded.status,
      brief=excluded.brief, branch=excluded.branch, issue_url=excluded.issue_url, pr_url=excluded.pr_url,
      plan_thread_id=excluded.plan_thread_id, plan_wave=excluded.plan_wave,
      reviewed_report_seq=excluded.reviewed_report_seq, reviewed_head_sha=excluded.reviewed_head_sha, unplanned_reason=excluded.unplanned_reason,
      replaces_thread_id=COALESCE(excluded.replaces_thread_id, managed_threads.replaces_thread_id),
      kind=excluded.kind, verify_command=excluded.verify_command,
      planner_on=COALESCE(excluded.planner_on, managed_threads.planner_on),
      coordinator_thread_id=COALESCE(managed_threads.coordinator_thread_id, excluded.coordinator_thread_id),
      updated_at=excluded.updated_at`).run(
      input.threadId, input.role, input.projectId, input.chiefThreadId ?? null,
      input.workerThreadId ?? null, input.parentThreadId ?? null, input.title, input.state ?? "starting",
      input.status ?? "starting", input.brief ?? null, input.branch ?? null,
      input.issueUrl ?? null, input.prUrl ?? null, input.planThreadId ?? null, input.planWave ?? null,
      input.reviewedReportSeq ?? null, input.reviewedHeadSha ?? null, input.unplannedReason ?? null, input.replacesThreadId ?? null,
      input.kind ?? null, input.plannerOn == null ? null : input.plannerOn ? 1 : 0, input.verifyCommand ?? null,
      input.state === "active" ? now : null,
      input.state === "active" ? 1 : 0, now, now, input.coordinatorThreadId ?? null,
    );
    wrote();
  }

  return {
    get: (threadId: string) => rows.get(threadId),
    /** The review gate under this key, or undefined. */
    gate: (gateKey: string) => gates.find((gate) => gate.gate_key === gateKey),
    /** The newest gate whose targets or actor columns hold this thread, or undefined. */
    gateFor: (threadId: string) => [...gates].reverse().find((gate) => gate.targets.some((target) => target.threadId === threadId) || GATE_ACTORS.some((column) => gate[column] === threadId)),
    /** The thread is a gate's reviewer, tester, fixer or corrector. */
    isGateActor: (threadId: string) => gates.some((gate) => GATE_ACTORS.some((column) => gate[column] === threadId)),
    /** Opens a gate with its pinned targets. Batch only: the caller writes the actor ids in the same transaction. */
    openGate(gate: { gateKey: string; projectId: string; chiefThreadId: string; planThreadId: string | null; targets: GateTarget[]; now: number }) {
      inBatch();
      db.prepare(`INSERT INTO review_gates (gate_key, project_id, chief_thread_id, plan_thread_id, targets, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(gate.gateKey, gate.projectId, gate.chiefThreadId, gate.planThreadId, JSON.stringify(gate.targets), gate.now);
    },
    /** Names a gate's actor. Batch only. */
    setGateActor(gateKey: string, column: GateActor, threadId: string) {
      inBatch();
      db.prepare(`UPDATE review_gates SET ${column}=? WHERE gate_key=?`).run(threadId, gateKey);
    },
    /** Records a fix run's origin. Batch only. */
    setFixRun(threadId: string, run: "gate" | "chat") {
      inBatch();
      db.prepare(`UPDATE managed_threads SET fix_run=? WHERE thread_id=?`).run(run, threadId);
    },
    /** The live cache: replaced on reload, so read it again each time rather than holding it. */
    rows: () => rows,
    all: () => [...rows.values()],
    reload,
    refresh,
    batch,
    insert,

    /** A sweep found a supporting row whose work was absorbed. Refreshes without onReload: it runs inside the sweep. */
    completeAbsorbed(threadId: string, status: string) {
      db.prepare(`UPDATE managed_threads SET state='complete', status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(status, Date.now(), threadId);
      refresh();
    },

    /** handOver: the superseded Chief is complete. */
    completeChief(threadId: string, now: number) {
      db.prepare(`UPDATE managed_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(now, threadId);
      wrote();
    },
    /** handOver: its open work moves to the successor. */
    moveOpenWork(nextChiefId: string, now: number, projectId: string, previousChiefId: string) {
      db.prepare(`UPDATE managed_threads SET chief_thread_id=?, updated_at=?
        WHERE project_id=? AND chief_thread_id=? AND state NOT IN ('complete','archived','deleted')`).run(
        nextChiefId, now, projectId, previousChiefId,
      );
      wrote();
    },
    /** chief_coordinate: upgrades a Chief with no managed work to a Coordinator, once. Returns whether the row changed. */
    setCoordinator(threadId: string, now: number, title: string) {
      const { changes } = db.prepare(`UPDATE managed_threads SET coordinator=1, title=?, updated_at=?
        WHERE thread_id=? AND role='chief' AND COALESCE(coordinator,0)=0 AND coordinator_thread_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM managed_threads w WHERE w.chief_thread_id=? AND w.state NOT IN ('complete','archived','deleted'))`).run(title, now, threadId, threadId);
      if (changes) wrote();
      return changes > 0;
    },
    /** chief_attach: links a live plain Chief to a Coordinator, once. Returns whether the row changed. */
    linkToCoordinator(childId: string, coordinatorId: string, now: number) {
      const { changes } = db.prepare(`UPDATE managed_threads SET coordinator_thread_id=?, updated_at=?
        WHERE thread_id=? AND role='chief' AND COALESCE(coordinator,0)=0
        AND ${UNLINKED_OR_DEAD}
        AND state NOT IN ('complete','archived','deleted')`).run(coordinatorId, now, childId);
      if (changes) wrote();
      return changes > 0;
    },
    /** handOver: the successor takes the previous child's link while that Coordinator is live. Never sets a link on a Coordinator and never overwrites a live link. */
    inheritCoordinator(previousId: string, nextId: string, now: number) {
      const link = db.prepare(`SELECT p.coordinator_thread_id AS id FROM managed_threads p JOIN managed_threads c ON c.thread_id=p.coordinator_thread_id
        WHERE p.thread_id=? AND c.role='chief' AND c.coordinator=1 AND c.state NOT IN ('complete','archived','deleted')`).get(previousId) as { id: string } | undefined;
      if (!link) return false;
      const { changes } = db.prepare(`UPDATE managed_threads SET coordinator_thread_id=?, updated_at=?
        WHERE thread_id=? AND role='chief' AND COALESCE(coordinator,0)=0
        AND ${UNLINKED_OR_DEAD}`).run(link.id, now, nextId);
      if (changes) wrote();
      return changes > 0;
    },
    /** The plan's shared tracking issue; the first one recorded stays. */
    setPlanIssueUrl(threadId: string, url: string) {
      db.prepare(`UPDATE managed_threads SET plan_issue_url=? WHERE thread_id=? AND plan_issue_url IS NULL`).run(url, threadId);
      wrote();
    },
    /** A replaced worker or an old review, retired once its successor exists. */
    completeSuperseded(threadId: string, now: number) {
      db.prepare(`UPDATE managed_threads SET state='complete', active_since=NULL, updated_at=? WHERE thread_id=?`).run(now, threadId);
      wrote();
    },

    /** A replacement whose launch was rolled back: unlinked from its plan so no schedule, review or ownership decision sees it (the row stays for diagnostics),
     * and complete only once the thread is confirmed stopped; a thread that may still run stays live, so it keeps holding its branch. */
    rollBackLaunch(threadId: string, now: number, stopped: boolean) {
      db.prepare(`UPDATE managed_threads SET plan_thread_id=NULL, plan_wave=NULL, updated_at=? ${stopped ? ", state='complete', active_since=NULL" : ""} WHERE thread_id=?`).run(now, threadId);
      wrote();
    },

    /** chief_continue: re-arms the stall clock unless the nudge cap is reached. Returns whether it was capped.
     * Decides from the stored counter inside one synchronous transaction, not a pre-send snapshot. */
    markContinued(threadId: string, now: number, maxStallResets: number) {
      const capped = db.transaction(() => {
        const stored = db.prepare(`SELECT stall_resets FROM managed_threads WHERE thread_id=?`).get(threadId) as { stall_resets: number } | undefined;
        const atCap = (stored?.stall_resets ?? 0) >= maxStallResets;
        // Past the cap the nudge still lands, but active_since, active_cycle and the alerted cycles keep their schedule.
        db.prepare(`UPDATE managed_threads SET state='active', blocker=NULL, recommendation=NULL, verdict=NULL, owner_approval=NULL, owner_approved_at=NULL,
        active_since=CASE WHEN ? THEN active_since ELSE ? END, active_cycle=active_cycle+?,
        stall_alerted_cycle=CASE WHEN ? THEN stall_alerted_cycle ELSE NULL END, stall_resets=stall_resets+?, updated_at=? WHERE thread_id=?`).run(
          atCap ? 1 : 0, now, atCap ? 0 : 1, atCap ? 1 : 0, atCap ? 0 : 1, now, threadId,
        );
        return atCap;
      })();
      wrote();
      return capped;
    },

    /** chief_log: only the read cursor moves. */
    markLogRead(threadId: string, logId: number) {
      db.prepare(`UPDATE managed_threads SET log_read_id=? WHERE thread_id=?`).run(logId, threadId);
      wrote();
    },

    /** A busy-worker refusal, counted for bb chief stats. */
    countBusyRejection(threadId: string) {
      db.prepare(`UPDATE managed_threads SET busy_rejections=busy_rejections+1 WHERE thread_id=?`).run(threadId);
      wrote();
    },

    /** chief_complete. A replaced result drops the summary and report file that described the old one. cleanupApprovedAt is written in the same UPDATE, so completion and cleanup eligibility never split. */
    markComplete(args: { status: string; result: string | null; note: string | null; now: number; threadId: string; cleanupApprovedAt: number | null; reviewSkipped: string | null }) {
      db.prepare(`UPDATE managed_threads SET state='complete', status=@status,
      result=CASE WHEN @note IS NULL THEN COALESCE(@result, result) ELSE COALESCE(@result, result, '') || @note END,
      summary=CASE WHEN @result IS NULL THEN summary END, report_path=CASE WHEN @result IS NULL THEN report_path END,
      result_rev=result_rev + (@result IS NOT NULL),
      blocker=NULL, recommendation=NULL, active_since=NULL, cleanup_approved_at=@cleanupApprovedAt, review_skipped=@reviewSkipped, updated_at=@now WHERE thread_id=@threadId`).run(args);
      wrote();
    },

    /** chief_owner_approval: writes nothing else. */
    recordOwnerApproval(threadId: string, approval: string) {
      db.prepare(`UPDATE managed_threads SET owner_approval=?, owner_approved_at=? WHERE thread_id=?`).run(approval, Date.now(), threadId);
      wrote();
    },

    /** chief_stop: blocked with a reroute recommendation, not complete. */
    markStopped(threadId: string, blocker: string, recommendation: string) {
      db.prepare(`UPDATE managed_threads SET state='blocked', blocker=?, recommendation=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
        blocker, recommendation, Date.now(), threadId,
      );
      wrote();
    },

    /** chief_report: reserves the next report_seq and stores the report's columns; returns the reserved seq and result_rev. */
    reserveReport(report: ReportReservation) {
      const reserved = db.prepare(`UPDATE managed_threads SET state=?, result=?, summary=?, blocker=?, recommendation=?, verdict=?,
        plan_waves = COALESCE(?, plan_waves), regression=?, report_path=NULL, fails = COALESCE(?, fails), findings=?, tests_passed = COALESCE(?, tests_passed), report_seq = report_seq + 1, stall_resets = CASE WHEN ?='active' THEN stall_resets ELSE 0 END,
        last_report_state=?, owner_approval=NULL, owner_approved_at=NULL,
        active_since = CASE WHEN ?='active' THEN active_since ELSE NULL END, updated_at=? WHERE thread_id=? RETURNING report_seq, result_rev`).get(
        report.state, report.result, report.summary, report.blocker,
        report.recommendation, report.verdict,
        report.planWaves, report.regression, report.fails, report.findings, report.testsPassed,
        report.state, report.state, report.state, report.now, report.threadId,
      ) as { report_seq: number; result_rev: number };
      wrote();
      return reserved;
    },
    /** An advisor's first ready or blocked report. */
    markAdvised(threadId: string, now: number) {
      db.prepare(`UPDATE managed_threads SET advised_at=COALESCE(advised_at, ?) WHERE thread_id=?`).run(now, threadId);
      wrote();
    },
    /** A planner's ready report: 'required' or null; never overwrites a resolved review. */
    setPlanReview(threadId: string, value: string | null) {
      db.prepare(`UPDATE managed_threads SET plan_review=? WHERE thread_id=? AND (plan_review IS NULL OR plan_review='required')`).run(value, threadId);
      wrote();
    },
    /** chief_skip_specs: sets the given waiver reason on one wave in plan_waves, in one write,
     * and touches no other field. */
    skipWave(plannerThreadId: string, wave: number, fields: { specsSkipped: string }) {
      db.transaction(() => {
        const row = db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(plannerThreadId) as { plan_waves: string | null } | undefined;
        const waves = JSON.parse(row?.plan_waves ?? "[]") as Record<string, unknown>[];
        if (!waves[wave - 1]) throw new Error(`Planner ${plannerThreadId} has no wave ${wave}.`);
        Object.assign(waves[wave - 1]!, fields);
        db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(waves), plannerThreadId);
      })();
      wrote();
    },
    /** A plan advisor's first advice: the first write wins. */
    resolvePlanReview(threadId: string, outcome: "approved" | "changes") {
      db.prepare(`UPDATE managed_threads SET plan_review=? WHERE thread_id=? AND plan_review='required'`).run(outcome, threadId);
      wrote();
    },
    /** Guarded by report_seq, and report_path also by result_rev: a slow write never attaches its path to a
     * newer report, nor to a result chief_complete replaced meanwhile (even with identical text). */
    attachReportFiles(threadId: string, seq: number, resultRev: number, verdictPath: string | null, reportPath: string | null) {
      db.prepare(`UPDATE managed_threads SET verdict_path=?, report_path=CASE WHEN result_rev=? THEN ? END WHERE thread_id=? AND report_seq=?`).run(
        verdictPath, resultRev, reportPath, threadId, seq,
      );
      wrote();
    },

    /** reconcile: the thread is gone. */
    markDeleted(threadId: string, now: number) {
      db.prepare(`UPDATE managed_threads SET state='deleted', status=NULL, active_since=NULL, updated_at=? WHERE thread_id=?`).run(now, threadId);
      wrote();
    },
    /** reconcile: the thread was archived. */
    markArchived(threadId: string, status: string, now: number) {
      db.prepare(`UPDATE managed_threads SET state='archived', status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(status, now, threadId);
      wrote();
    },
    /** reconcile: the live thread's parent changed. */
    setParent(threadId: string, parentThreadId: string, now: number) {
      db.prepare(`UPDATE managed_threads SET parent_thread_id=?, updated_at=? WHERE thread_id=?`).run(parentThreadId, now, threadId);
      wrote();
    },
    /** reconcile: the row follows the live thread's state and status. */
    syncLive(sync: LiveSync) {
      db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=?,
      active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
      updated_at=? WHERE thread_id=?`).run(
        sync.state, sync.status,
        sync.activeSince,
        sync.enteringActive ? 1 : 0, sync.enteringActive ? 1 : 0, sync.now, sync.threadId,
      );
      wrote();
    },

    /** lifecycle: a Chief, or any thread that went idle, failed, archived or deleted, takes the state its event names. */
    recordState(threadId: string, state: string, status: string, now: number) {
      db.prepare(`UPDATE managed_threads SET state=?, status=?, active_since=NULL, updated_at=? WHERE thread_id=?`).run(
        state, status, now, threadId,
      );
      wrote();
    },
    /** lifecycle: a non-Chief thread went active. */
    markActive(threadId: string, status: string, activeSince: number, enteringActive: boolean, now: number) {
      db.prepare(`UPDATE managed_threads SET state='active', status=?, active_since=?,
        active_cycle=active_cycle+?, stall_alerted_cycle=CASE WHEN ? THEN NULL ELSE stall_alerted_cycle END,
        updated_at=? WHERE thread_id=?`).run(
        status, activeSince,
        enteringActive ? 1 : 0, enteringActive ? 1 : 0, now, threadId,
      );
      wrote();
    },
    /** lifecycle: a non-transient failure, counted for bb chief stats. */
    countError(threadId: string) {
      db.prepare(`UPDATE managed_threads SET thread_errors=thread_errors+1 WHERE thread_id=?`).run(threadId);
      wrote();
    },

    /** The supervisor sent a stall alert for this cycle. */
    markStallAlerted(threadId: string, stallCycle: number, stopCycle: number | null) {
      db.prepare(`UPDATE managed_threads SET stall_alerted_cycle=?, stop_alerted_cycle=?, updated_at=? WHERE thread_id=?`)
        .run(stallCycle, stopCycle, Date.now(), threadId);
      wrote();
    },

    /** A Chief that failed a turn is active again once it calls a tool. */
    reactivate(threadId: string) {
      db.prepare(`UPDATE managed_threads SET state='active', updated_at=? WHERE thread_id=?`).run(Date.now(), threadId);
      wrote();
    },
  };
}

export type ThreadStore<Row extends { thread_id: string; role: string; state: string }> = ReturnType<typeof createThreadStore<Row>>;
