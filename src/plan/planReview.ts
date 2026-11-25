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

/** One module owns how a plan chain reads from the rows: the advisors, the revisions, the typed status the callers switch on, and the one owner of
 * the chain's next action. A chain is an original planner P, its plan advisors (`plan_thread_id = P`) and its revisions (planners with `replaces_thread_id = P`).
 * "Planner review" is the advisor's advice on a plan (chief_consult planThreadId), not the worker Review gate. Callers keep their writes,
 * launches and wording. `all` is the store's insertion order: newest-first revisions depend on it. */
export function createPlanReview<Row extends ReviewRow>(all: () => Row[], get: (id: string) => Row | undefined, busy: (state: string) => boolean) {
  /** An archived or deleted row can no longer report or be completed: it is never an attempt. */
  const usable = (r: Row) => r.state !== "archived" && r.state !== "deleted";

  /** The plan advisors of planner P: the attempt and the decider (first advice wins; an archived decider still decides, its advice is recorded on P).
   * The attempt is the oldest usable busy unadvised advisor, else the newest usable unadvised idle one. A failed or chief_stop-ped advisor can never report: not an attempt. */
  function advisors(plannerId: string) {
    const rows = all().filter((r) => r.role === "advisor" && r.plan_thread_id === plannerId)
      .sort((a, b) => a.created_at - b.created_at);
    const open = rows.filter((r) => usable(r) && r.advised_at == null);
    const attempt = open.find((r) => busy(r.state)) ?? open.filter((r) => r.state === "idle").at(-1);
    const advised = rows.filter((r) => r.advised_at != null);
    const decider = advised.length ? advised.reduce((a, b) => (b.advised_at! < a.advised_at! ? b : a)) : undefined;
    return { attempt, decider };
  }

  /** A planner has a reviewable result: a task plan's waves, or an epic's ready report (an epic has no waves). */
  const hasResult = (planner: Row) => !!planner.plan_waves || (!!planner.plan_epic && planner.last_report_state === "ready");

  /** A planner worth a next-action line: it carries a task plan's waves or is an epic, whatever its last report says. Wider than hasResult on purpose. */
  const hasPlan = (planner: Row) => !!planner.plan_waves || !!planner.plan_epic;

  /** A revision delivers with its stored result: an epic's ready report, a task's plan. Live state never enters this rule: a thread that goes busy again keeps its report. */
  const delivers = (r: Row) => r.plan_epic ? r.last_report_state === "ready" : !!r.plan_waves;

  /** The planners revising planner P, newest first: the delivered one, and the attempt (usable, busy, idle or blocked, not delivered; a superseded complete or a failed one is not). */
  function revisions(plannerId: string) {
    const rows = all().filter((r) => r.role === "planner" && r.replaces_thread_id === plannerId).reverse();
    const live = rows.filter(usable);
    const attempt = live.find((r) => !delivers(r) && (busy(r.state) || r.state === "idle" || r.state === "blocked"));
    return { all: rows, delivered: live.find(delivers), attempt, busy: attempt && busy(attempt.state) ? attempt : undefined };
  }

  type Review =
    | { kind: "unreviewed" }
    | { kind: "inReview"; advisor: Row }
    | { kind: "unadvised" }
    | { kind: "approved"; decider?: Row }
    | { kind: "changes"; decider?: Row; by?: Row; busy?: Row; delivered: boolean }
    // A stored value no tool writes: no refusal or next action, only the roster's changes-requested wording.
    | { kind: "unrecognized"; decider?: Row; by?: Row };

  /** A planner's review state. `delivered` (changes only) is the one delivered-revision rule: a usable delivered revision, or a completed task original
   * (a task revision's plan intake completes it: completeSuperseded). An epic original stays open until Chief completes both. */
  function status(planner: Row) {
    const epic = !!planner.plan_epic;
    const { attempt, decider } = advisors(planner.thread_id);
    let review: Review;
    if (!planner.plan_review) review = { kind: "unreviewed" };
    else if (planner.plan_review === "required") review = attempt ? { kind: "inReview", advisor: attempt } : { kind: "unadvised" };
    else if (planner.plan_review === "approved") review = { kind: "approved", decider };
    else if (planner.plan_review !== "changes") review = { kind: "unrecognized", decider, by: revisions(planner.thread_id).delivered };
    else {
      const { delivered: by, busy: working } = revisions(planner.thread_id);
      review = { kind: "changes", decider, by, busy: working, delivered: !!by || (!epic && planner.state === "complete") };
    }
    return { epic, closed: epic && planner.state === "complete", revises: planner.replaces_thread_id, review };
  }

  /** Why chief_consult may not review planner P now, or null. */
  function consultRefusal(planner: Row) {
    if (!hasResult(planner) || planner.state === "complete") return { kind: "noOpenPlan" } as const;
    if (planner.replaces_thread_id) return { kind: "revision" } as const;
    if (planner.plan_review && planner.plan_review !== "required") return { kind: "decided", decider: advisors(planner.thread_id).decider } as const;
    const { attempt } = advisors(planner.thread_id);
    if (attempt) return { kind: "inReview", advisor: attempt } as const;
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

  /** A ready task plan clears an unset or stale `required` review; a decided one stays. */
  const clearsReview = (planner: Row) => planner.plan_review == null || planner.plan_review === "required";

  /** A task revision's ready plan completes its original only when the original's review asked for changes. */
  const completesOriginal = (original: Row | undefined) => original?.role === "planner" && original.plan_review === "changes";

  /** A planner report the advisor review must guard: any epic report, or a ready report carrying a plan. */
  const reportGuard = (row: Row, readyWithPlan: boolean) => row.role === "planner" && (!!row.plan_epic || readyWithPlan);

  /** Why a guarded report from planner `threadId` is refused, read from the live rows, or null. */
  function reportRefusal(threadId: string) {
    const { attempt } = advisors(threadId);
    if (attempt) return { kind: "inReview", advisor: attempt } as const;
    const planner = get(threadId);
    if (!planner?.plan_epic) return null;
    // A revision gets no review: its ready report is its delivery, so a later report must not replace it (a blocked attempt may still retry).
    if (planner.replaces_thread_id && delivers(planner)) return { kind: "delivered" } as const;
    if (planner.plan_review === "approved" || planner.plan_review === "changes") return { kind: "decided", outcome: planner.plan_review } as const;
    return null;
  }

  /** An advisor whose planner no longer waits on its review (replaced or decided): it cannot be resumed. */
  const advisorStale = (advisor: Row) => !!advisor.plan_thread_id && advisor.advised_at == null && get(advisor.plan_thread_id)?.plan_review !== "required";

  type Chain =
    | { kind: "closed"; owner: null }
    | { kind: "planning" | "advising" | "consult" | "approved" | "plan" | "revising" | "revised"; owner: string }
    | { kind: "revise"; owner: string; decider?: Row };

  /** The one owner of a plan chain's next action, the same for every row of the chain (first match wins). Only the owner renders a Pending line;
   * a delivered revision is checked before an attempt so it keeps the chain when it goes busy or idle again. */
  function owner(row: Row): Chain {
    const P = row.role === "advisor" ? (row.plan_thread_id ? get(row.plan_thread_id) : undefined) : row.replaces_thread_id ? get(row.replaces_thread_id) : row;
    if (!P || !usable(P)) return { kind: "closed", owner: null };
    const { delivered, attempt } = revisions(P.thread_id);
    if (P.state === "complete") return !P.plan_epic && delivered ? { kind: "revised", owner: delivered.thread_id } : { kind: "closed", owner: null };
    if (!hasResult(P)) return { kind: "planning", owner: P.thread_id };
    const { attempt: advisor, decider } = advisors(P.thread_id);
    switch (P.plan_review) {
      case "required": return advisor ? { kind: "advising", owner: advisor.thread_id } : { kind: "consult", owner: P.thread_id };
      case "approved": return { kind: "approved", owner: P.thread_id };
      case "changes":
        // A completed epic revision hands the chain back to P: its only open call is chief_complete (P).
        if (delivered) return { kind: "revised", owner: P.plan_epic && delivered.state === "complete" ? P.thread_id : delivered.thread_id };
        if (attempt) return { kind: "revising", owner: attempt.thread_id };
        return { kind: "revise", owner: P.thread_id, decider };
      default: return { kind: "plan", owner: P.thread_id };
    }
  }

  return { advisors, revisions, owner, hasResult, hasPlan, clearsReview, completesOriginal, status, consultRefusal, revisionRefusal, reportGuard, reportRefusal, advisorStale };
}
