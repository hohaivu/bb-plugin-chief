/** What the planner review reads of a managed_threads row; the server's ManagedRow satisfies it. */
interface ReviewRow {
  thread_id: string;
  role: string;
  state: string;
  created_at: number;
  plan_thread_id: string | null;
  plan_waves: string | null;
  plan_epic: number | null;
  plan_review: string | null;
  replaces_thread_id: string | null;
  last_report_state: string | null;
  advised_at: number | null;
}

/** One module owns how a planner's advisor review reads from the rows: the advisors, the revisions, and the typed status the callers switch on.
 * "Planner review" is the advisor's advice on a plan (chief_consult planThreadId), not the worker Review gate. Callers keep their writes,
 * launches and wording. `all` is the store's insertion order: newest-first revisions depend on it. */
export function createPlanReview<Row extends ReviewRow>(all: () => Row[], get: (id: string) => Row | undefined, busy: (state: string) => boolean) {
  /** The plan advisors of planner P, oldest first: the one in flight, the decider (first advice wins) and the newest abandoned attempt. */
  function advisors(plannerId: string) {
    const rows = all().filter((r) => r.role === "advisor" && r.plan_thread_id === plannerId)
      .sort((a, b) => a.created_at - b.created_at);
    const inFlight = rows.find((r) => r.advised_at == null && busy(r.state));
    const advised = rows.filter((r) => r.advised_at != null);
    const decider = advised.length ? advised.reduce((a, b) => (b.advised_at! < a.advised_at! ? b : a)) : undefined;
    const abandoned = rows.filter((r) => r.advised_at == null && r !== inFlight).at(-1);
    return { inFlight, decider, abandoned };
  }

  /** A planner has a reviewable result: a task plan's waves, or an epic's ready report (an epic has no waves). */
  const hasResult = (planner: Row) => !!planner.plan_waves || (!!planner.plan_epic && planner.last_report_state === "ready");

  /** The planners revising planner P, newest first: one still working, and the one whose plan is in. */
  function revisions(plannerId: string) {
    const rows = all().filter((r) => r.role === "planner" && r.replaces_thread_id === plannerId).reverse();
    return {
      all: rows,
      busy: rows.find((r) => busy(r.state)),
      // An epic revision delivered only with a ready report: a superseded blocked attempt is complete too.
      ready: rows.find((r) => (r.state === "ready" || r.state === "complete") && hasResult(r)),
    };
  }

  type Review =
    | { kind: "unreviewed" }
    | { kind: "inReview"; advisor: Row }
    | { kind: "unadvised" }
    | { kind: "approved"; decider?: Row }
    | { kind: "changes"; decider?: Row; by?: Row; busy?: Row; delivered: boolean };

  /** A planner's review state. `delivered` (changes only) is the one delivered-revision rule: an epic revision delivers with its ready report
   * and the original stays open until Chief completes both; a task revision's plan intake completes the original (completeSuperseded). */
  function status(planner: Row) {
    const epic = !!planner.plan_epic;
    const { inFlight, decider } = advisors(planner.thread_id);
    let review: Review;
    if (!planner.plan_review) review = { kind: "unreviewed" };
    else if (planner.plan_review === "required") review = inFlight ? { kind: "inReview", advisor: inFlight } : { kind: "unadvised" };
    else if (planner.plan_review === "approved") review = { kind: "approved", decider };
    else {
      const { ready: by, busy: working } = revisions(planner.thread_id);
      review = { kind: "changes", decider, by, busy: working, delivered: epic ? !!by : planner.state === "complete" };
    }
    return { epic, closed: epic && planner.state === "complete", revises: planner.replaces_thread_id, review };
  }

  /** Why chief_consult may not review planner P now, or null. */
  function consultRefusal(planner: Row) {
    if (!hasResult(planner) || planner.state === "complete") return { kind: "noOpenPlan" } as const;
    if (planner.replaces_thread_id) return { kind: "revision" } as const;
    if (planner.plan_review && planner.plan_review !== "required") return { kind: "decided", decider: advisors(planner.thread_id).decider } as const;
    const { inFlight } = advisors(planner.thread_id);
    if (inFlight) return { kind: "inReview", advisor: inFlight } as const;
    return null;
  }

  /** Why chief_plan revises may not start a revision of planner P, or `ok` with the advisor that asked for changes. */
  function revisionRefusal(planner: Row) {
    const s = status(planner);
    if (s.closed) return { kind: "closed" } as const;
    const r = s.review;
    if (r.kind !== "changes") return { kind: r.kind === "unreviewed" && s.revises ? "isRevision" : "notChanges" } as const;
    if (r.delivered) return { kind: "delivered", by: r.by } as const;
    if (r.busy) return { kind: "busy", by: r.busy } as const;
    return { kind: "ok", decider: r.decider! } as const;
  }

  /** A planner report the advisor review must guard: any epic report, or a ready report carrying a plan. */
  const reportGuard = (row: Row, readyWithPlan: boolean) => row.role === "planner" && (!!row.plan_epic || readyWithPlan);

  /** Why a guarded report from planner `threadId` is refused, read from the live rows, or null. */
  function reportRefusal(threadId: string) {
    const { inFlight } = advisors(threadId);
    if (inFlight) return { kind: "inReview", advisor: inFlight } as const;
    const planner = get(threadId);
    if (!planner?.plan_epic) return null;
    // A revision gets no review: its ready report is its delivery, so a later report must not replace it (a blocked attempt may still retry).
    if (planner.replaces_thread_id && planner.last_report_state === "ready") return { kind: "delivered" } as const;
    if (planner.plan_review === "approved" || planner.plan_review === "changes") return { kind: "decided", outcome: planner.plan_review } as const;
    return null;
  }

  /** An advisor whose planner no longer waits on its review (replaced or decided): it cannot be resumed. */
  const advisorStale = (advisor: Row) => !!advisor.plan_thread_id && advisor.advised_at == null && get(advisor.plan_thread_id)?.plan_review !== "required";

  return { advisors, revisions, hasResult, status, consultRefusal, revisionRefusal, reportGuard, reportRefusal, advisorStale };
}
