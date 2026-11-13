import { type SegmentState } from "../plan/planProgress";
import { type ManagedRow } from "../types";
import { clip } from "../core/text";
import { spawnMetadataSchema, type TodoRow } from "../tools/shapes";
import type { Ctx } from "./context";
import { isWriter } from "../plan/waveSchedule";

export function createRoster(ctx: Ctx) {
  const { bb, db, isTestWave, ledger, onSpecChain, planWavesFor, progress, sideLane, store, todosForProject } = ctx;
  function rosterFor(projectId: string, includeComplete = false) {
    return store.all().filter((row) => row.project_id === projectId && (includeComplete || row.state !== "complete"));
  }

  /** A hand-off from a tester or a test-wave worker must name its kind (see explicitKind in startWorker). */
  function replacesCall(row: ManagedRow): string {
    if (isWriter(row.kind)) {
      if (sideLane(row)) return `chief_delegate (replaces: ${row.thread_id}, kind: spec-writer) for a docs fix`;
      return isTestWave(row)
        ? `chief_delegate (replaces: ${row.thread_id}, kind: tester) for a test rerun or chief_delegate (replaces: ${row.thread_id}, kind: spec-writer) for a docs fix`
        : `chief_delegate (replaces: ${row.thread_id}, kind: worker) once it reported ready, or chief_delegate (replaces: ${row.thread_id}, kind: spec-writer) for a docs fix`;
    }
    if ((row.kind === "tester" || isTestWave(row)) && onSpecChain(row)) return `chief_delegate (replaces: ${row.thread_id}, kind: worker) for a product-code fix, chief_delegate (replaces: ${row.thread_id}, kind: tester) for a test fix or chief_delegate (replaces: ${row.thread_id}, kind: spec-writer) for a docs fix`;
    return row.kind === "tester" || isTestWave(row)
      ? `chief_delegate (replaces: ${row.thread_id}, kind: worker) for a product-code fix or chief_delegate (replaces: ${row.thread_id}, kind: tester) for a test fix`
      : `chief_delegate (replaces: ${row.thread_id})`;
  }

  /** Said the same way in chief_stop's reply and both stall alerts. */
  function rerouteSteps(row: ManagedRow): string {
    if (row.role === "worker") {
      return `Once it is idle, call chief_consult (workerThreadId: ${row.thread_id}) if the cause is unclear, then hand the work to a fresh worker with ${replacesCall(row)} and the advice in its context. Use chief_plan instead if the brief itself is wrong or too big.`;
    }
    if (row.role === "reviewer") {
      return row.worker_thread_id
        ? `Once it is idle, start a fresh review with chief_review (workerThreadId: ${row.worker_thread_id}).`
        : `Once it is idle, chief_complete it, then start a fresh chief_review for branch ${row.branch}.`;
    }
    if (row.role === "planner" && row.replaces_thread_id) return `Once it is idle, start a fresh chief_plan (revises: ${row.replaces_thread_id}) with a narrower brief; the review round is already used.`;
    if (row.role === "planner") return "Once it is idle, start a fresh chief_plan with a narrower brief.";
    if (row.role === "advisor" && row.plan_thread_id) return `Once it is idle, start a fresh chief_consult (planThreadId: ${row.plan_thread_id}); the plan still needs its one review.`;
    if (row.role === "researcher") return "Once it is idle, decide without it or start a fresh chief_research with a narrower question.";
    return "Once it is idle, decide without it or start a fresh chief_consult with a narrower question.";
  }

  function belongsToChief(row: ManagedRow, chiefThreadId: string) {
    return row.thread_id === chiefThreadId || row.chief_thread_id === chiefThreadId;
  }

  // Mutation/reference check: only directly owned work, never the Chief itself. BB's parent_thread_id
  // is provenance, not ownership. These rules keep cooperating agents organised; they are not a
  // security boundary.
  function controlsThread(row: ManagedRow, callerChiefId: string) {
    return row.thread_id !== callerChiefId && row.chief_thread_id === callerChiefId;
  }

  /** The one target assertion behind every tool and managed-Chief CLI call that acts on another thread. */
  async function controlledTarget(threadId: string, caller: ManagedRow) {
    const target = await resolveTarget(threadId, caller.thread_id);
    if (!target || target.project_id !== caller.project_id || !controlsThread(target, caller.thread_id)) {
      throw new Error(`No managed thread ${threadId} for this Chief.`);
    }
    return target;
  }

  /** The last 3 reviewer rows with a verdict for this worker's task, so the
   * advisor sees the review history that led to the consult, across a `replaces`
   * handoff. */
  function taskReviews(worker: ManagedRow): ManagedRow[] {
    const workerIds = new Set(ledger.taskChain(worker.thread_id));
    return store.all()
      .filter((row) => row.role === "reviewer" && row.verdict && row.worker_thread_id && workerIds.has(row.worker_thread_id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 3);
  }

  const INACTIVE_CHIEF_STATES = ["complete", "archived", "deleted"];
  /** A superseded Chief (spawnChief already marked it complete/archived/deleted and
   * handed its workers to the replacement) must not still be able to act as Chief. */
  function isActiveChief(caller: ManagedRow | undefined): caller is ManagedRow {
    return !!caller && caller.role === "chief" && !INACTIVE_CHIEF_STATES.includes(caller.state);
  }

  /** A Coordinator is a Chief row with coordinator=1 (COORD-1). Nothing clears the flag. */
  function isCoordinator(row: ManagedRow | undefined): boolean {
    return !!row && row.role === "chief" && row.coordinator === 1;
  }

  /** A child Chief is a Chief row linked to its Coordinator. */
  function isLinkedChild(row: ManagedRow | undefined): boolean {
    return !!row && row.role === "chief" && !!row.coordinator_thread_id;
  }

  /** The one guard in front of every way to start a reviewer: only the active Chief may. */
  function requireChiefCaller(caller: ManagedRow | undefined, what: string): asserts caller is ManagedRow {
    if (isActiveChief(caller)) return;
    const role = (caller as ManagedRow | undefined)?.role;
    throw new Error(`${what} is for the active Chief only: ${role && role !== "chief" ? `a managed ${role} reports ready with chief_report, and Chief starts the review` : "ask the active Chief to start it"}.`);
  }

  async function resolveTarget(threadId: string, chiefThreadId: string): Promise<ManagedRow | undefined> {
    let target = store.get(threadId);
    if (!target) {
      try {
        const live = await bb.sdk.threads.get({ threadId });
        const chief = store.get(chiefThreadId);
        if (
          live.deletedAt === null && live.archivedAt === null &&
          live.parentThreadId === chiefThreadId && chief && live.projectId === chief.project_id
        ) {
          // Only adopt threads this plugin itself spawned (pluginMetadata seeded at
          // spawn time, trusted only once originPluginId proves it — see the report intake's
          // identical check) — otherwise a sub-thread the user created under Chief in
          // the BB UI gets silently relocated into the Chief section as a "worker".
          const seeded = live.originPluginId === bb.pluginId
            ? spawnMetadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null))
            : undefined;
          if (seeded?.success && seeded.data.role !== "chief" && seeded.data.chiefThreadId === chiefThreadId) {
            if (!store.get(threadId)) store.insert({
              threadId: live.id,
              role: seeded.data.role,
              projectId: live.projectId,
              chiefThreadId,
              parentThreadId: chiefThreadId,
              title: live.title || "Managed thread",
              state: live.status === "active" ? "active" : "idle",
              status: live.status,
            });
            target = store.get(threadId);
          }
        }
      } catch {
        // not found
      }
    }
    return target;
  }

  function rosterForChief(chiefThreadId: string, includeComplete = false) {
    return store.all().filter(
      (row) => belongsToChief(row, chiefThreadId) && (includeComplete || row.state !== "complete"),
    );
  }

  const SEGMENT_LABELS = { notDelegated: "not delegated", approved: "approved", changesRequested: "changes requested", inReview: "in review", testsSkipped: "tests skipped" } as const;

  /** A planner's wave schedule and how far it has been delegated, or a worker's own
   * wave — shared by chief_roster and bb chief status so the two never disagree either. */
  function waveLines(row: ManagedRow): string[] {
    if (row.role === "planner" && row.plan_waves) {
      const waves = planWavesFor(row.thread_id);
      const { done, total, segments } = progress.waveProgress(row);
      const segmentLabel = (state: SegmentState) => (state.kind === "worker" ? state.state : SEGMENT_LABELS[state.kind]);
      return [
        `waves: ${done}/${total} done, ${segments.map((segment) => `wave ${segment.wave} ${segmentLabel(segment.state)}`).join(", ")}`,
        ...waves.map((wave, index) => `  wave ${index + 1} of ${waves.length}: ${wave.path}${
          wave.dependsOn ? wave.dependsOn.length ? ` (after wave ${wave.dependsOn[0]})` : " (independent)" : ""}${wave.testsSkipped ? `: tests skipped: ${clip(wave.testsSkipped, 200)}` : ""}${wave.specsSkipped ? `: specs skipped: ${clip(wave.specsSkipped, 200)}` : ""}`),
      ];
    }
    if (row.role === "worker" && row.plan_thread_id && row.plan_wave != null) {
      return [`wave: ${row.plan_wave} of ${planWavesFor(row.plan_thread_id).length} (plan ${row.plan_thread_id})`];
    }
    return [];
  }

  /** One row's full detail block, reused by chief_roster and bb chief status. */
  /** The roster's plan-review lines: a planner's review status, a revision's original, a plan advisor's planner. */
  function planReviewLines(row: ManagedRow): string[] {
    if (row.role === "advisor" && row.plan_thread_id) return [`reviews plan: ${row.plan_thread_id}`];
    if (row.role !== "planner") return [];
    const lines = row.replaces_thread_id ? [`revises: ${row.replaces_thread_id}`] : [];
    if (!row.plan_review) return lines;
    const { inFlight, decider } = ctx.planAdvisors(row.thread_id);
    const revised = ctx.revisionsOf(row.thread_id).ready;
    const status = row.plan_review === "required"
      ? inFlight ? `in review (${inFlight.thread_id})` : "required"
      : row.plan_review === "approved" ? `approved (${decider?.thread_id ?? "?"})`
      : row.state === "complete" && revised ? `revised by ${revised.thread_id}` : `changes requested (${decider?.thread_id ?? "?"})`;
    return [...lines, `plan review: ${status}`];
  }

  function rosterRowLines(row: ManagedRow): string[] {
    return [
      `${row.role} | ${row.state} | live:${row.status ?? "unknown"} | ${row.title} | ${row.thread_id}`,
      ...(row.kind ? [`kind: ${row.kind}`] : []),
      ...(row.branch ? [`branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`pr: ${row.pr_url}`] : []),
      ...waveLines(row),
      ...planReviewLines(row),
      ...(row.unplanned_reason ? [`unplanned: ${clip(row.unplanned_reason, 200)}`] : []),
      ...(row.review_skipped ? [`review skipped: ${clip(row.review_skipped, 200)}`] : []),
      ...(row.tests_skipped ? [`tests skipped: ${clip(row.tests_skipped, 200)}`] : []),
      ...(row.retest_skipped ? [`retest skipped: ${clip(row.retest_skipped, 200)}`] : []),
      ...(row.summary || row.result ? [`result: ${row.summary ?? clip(row.result!, 300)}`] : []),
      ...(row.report_path ? [`report: ${row.report_path}`] : []),
      ...(row.blocker ? [`blocker: ${clip(row.blocker, 200)}`] : []),
      ...(row.recommendation ? [`recommendation: ${clip(row.recommendation, 200)}`] : []),
      ...(row.verdict ? [`verdict: ${row.verdict}`] : []),
    ];
  }

  /** bb chief stats: a read-only summary of the given rows, their alert rows and todos. */
  function chiefStats(scope: { projectId: string; chiefThreadId: string | null }, rows: ManagedRow[], todos: TodoRow[]) {
    const ids = new Set(rows.map((row) => row.thread_id));
    const alerts = new Map<string, { usageLimit: number; connection: number; stalls: number; hardStalls: number }>();
    const approximate = { usageLimit: 0, connection: 0, stalls: 0, hardStalls: 0 };
    const events = db.prepare(`SELECT source_thread_id, kind, detail, legacy FROM chief_failure_events`).all() as { source_thread_id: string; kind: string; detail: string | null; legacy: number }[];
    for (const event of events) {
      if (!ids.has(event.source_thread_id)) continue;
      const counts = alerts.get(event.source_thread_id) ?? { usageLimit: 0, connection: 0, stalls: 0, hardStalls: 0 };
      const field = event.kind === "provider" ? (event.detail === "usage_limit" ? "usageLimit" : "connection") : event.kind === "hard_stall" ? "hardStalls" : "stalls";
      counts[field] += 1;
      if (event.legacy === 1) approximate[field] += 1;
      alerts.set(event.source_thread_id, counts);
    }
    // ponytail: the branch fallback is a heuristic, so a branch reused by a later unplanned
    // task merges into one task; replaces_thread_id makes this precise from stats_since on.
    const keys = new Map<string, string | null>();
    const keyOf = (row: ManagedRow | undefined): string | null => {
      if (!row) return null;
      if (keys.has(row.thread_id)) return keys.get(row.thread_id)!;
      keys.set(row.thread_id, null);
      const branch = row.branch ? `branch:${row.project_id}:${row.branch}` : null;
      const viaLink = (id: string | null | undefined) => (id ? keyOf(store.get(id)) : null);
      const key = row.role === "planner" ? `plan:${row.thread_id}`
        : row.role === "worker" ? (row.plan_thread_id ? `plan:${row.plan_thread_id}` : viaLink(row.replaces_thread_id) ?? branch ?? `worker:${row.thread_id}`)
        : row.role === "reviewer" ? viaLink(row.worker_thread_id) ?? branch
        : row.role === "advisor" ? viaLink(row.worker_thread_id)
        : null;
      keys.set(row.thread_id, key);
      return key;
    };
    const groups = new Map<string, ManagedRow[]>();
    for (const row of rows) {
      const key = keyOf(row);
      if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    const failuresOf = (list: ManagedRow[]) => {
      const counts = list.map((row) => alerts.get(row.thread_id));
      return {
        usageLimit: sum(counts.map((c) => c?.usageLimit ?? 0)),
        connection: sum(counts.map((c) => c?.connection ?? 0)),
        threadErrors: sum(list.map((row) => row.thread_errors)),
        busyRejections: sum(list.map((row) => row.busy_rejections)),
        stalls: sum(counts.map((c) => c?.stalls ?? 0)),
        hardStalls: sum(counts.map((c) => c?.hardStalls ?? 0)),
      };
    };
    const reviewers = rows.filter((row) => row.role === "reviewer");
    const eventCounts = ledger.eventCounts(reviewers);
    const verdictsOf = (list: ManagedRow[]) => {
      const counts = list.flatMap((row) => eventCounts.get(row.thread_id) ?? []);
      return { approve: sum(counts.map((c) => c.approve)), request_changes: sum(counts.map((c) => c.request_changes)) };
    };
    const terminal = ["complete", "archived", "deleted"];
    const perTask = [...groups].filter(([, list]) => list.some((row) => row.role === "planner" || row.role === "worker")).map(([key, list]) => {
      const planner = list.find((row) => row.role === "planner");
      const workers = list.filter((row) => row.role === "worker").sort((a, b) => a.created_at - b.created_at);
      const latest = workers.at(-1);
      // A worker completed before its plan's final wave means the plan stopped mid-way: dropped.
      const status = !latest ? (planner && terminal.includes(planner.state) ? "dropped" : "open")
        : latest.state === "complete" && progress.onFinalWave(latest) ? "completed"
        : terminal.includes(latest.state) ? "dropped"
        : "open";
      const waves = key.startsWith("plan:") ? new Set(workers.map((row) => row.plan_wave)).size : 1;
      const verdicts = verdictsOf(list);
      // ponytail: a complete row's updated_at is its completion time; nothing rewrites a complete row except a delete.
      const start = Math.min(...[planner, ...workers].map((row) => row?.created_at ?? Infinity));
      return {
        key, title: planner?.title ?? workers[0]?.title ?? key, status, workers: workers.length, waves,
        replacements: Math.max(0, workers.length - waves),
        approvals: verdicts.approve,
        requestChanges: verdicts.request_changes,
        category: (key.startsWith("plan:") || workers.some((row) => row.plan_thread_id) ? "planned"
          : workers[0]?.simple === 1 ? "simple"
          : workers[0]?.planner_on == null ? "unknown"
          : workers[0].planner_on === 1 ? "unplanned_planner_on" : "unplanned_planner_off") as "planned" | "simple" | "unknown" | "unplanned_planner_on" | "unplanned_planner_off",
        consults: list.filter((row) => row.role === "advisor").length,
        ...failuresOf(list),
        wallTimeMs: status === "completed" ? latest!.updated_at - start : null,
      };
    });
    const times = perTask.map((task) => task.wallTimeMs).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const mid = times.length >> 1;
    const statsSince = (db.prepare(`SELECT value FROM plugin_meta WHERE key='stats_since'`).get() as { value: string } | undefined)?.value;
    const since = statsSince === undefined ? null : Number(statsSince);
    const eventsSince = (db.prepare(`SELECT value FROM plugin_meta WHERE key='failure_events_since'`).get() as { value: string } | undefined)?.value;
    const exactSince = eventsSince === undefined ? null : Number(eventsSince);
    const count = (status: string) => perTask.filter((task) => task.status === status).length;
    const todoCount = (state: TodoRow["state"]) => todos.filter((todo) => todo.state === state).length;
    const { approve, request_changes: requestChanges } = verdictsOf(rows);
    const categoryCount = (category: string) => perTask.filter((task) => task.category === category).length;
    const researchBy = new Map<string, { role: string; mode: string | null; calls: number; succeeded: number }>();
    for (const call of db.prepare(`SELECT caller_thread_id, role, mode, outcome FROM chief_research_calls ORDER BY id`).all() as { caller_thread_id: string; role: string; mode: string | null; outcome: string }[]) {
      // Chief's spawned call only started a researcher; that thread's own calls carry the real outcomes.
      if (!ids.has(call.caller_thread_id) || call.outcome === "spawned") continue;
      const entry = researchBy.get(`${call.role}\u0000${call.mode}`) ?? { role: call.role, mode: call.mode, calls: 0, succeeded: 0 };
      entry.calls += 1;
      if (call.outcome === "succeeded" || call.outcome === "partial") entry.succeeded += 1;
      researchBy.set(`${call.role}\u0000${call.mode}`, entry);
    }
    return {
      scope, statsSince: since, failureEventsSince: exactSince,
      tasks: {
        total: perTask.length, completed: count("completed"), open: count("open"), dropped: count("dropped"),
        planned: categoryCount("planned"), unplanned_planner_on: categoryCount("unplanned_planner_on"),
        unplanned_planner_off: categoryCount("unplanned_planner_off"), simple: categoryCount("simple"), unknown: categoryCount("unknown"),
      },
      verdicts: { approve, request_changes: requestChanges },
      research: [...researchBy.values()].sort((a, b) => a.role.localeCompare(b.role) || String(a.mode).localeCompare(String(b.mode))),
      todos: { open: todoCount("open"), done: todoCount("done"), dropped: todoCount("dropped") },
      repairs: {
        replacements: sum(perTask.map((task) => task.replacements)), requestChanges,
        regressions: reviewers.filter((row) => row.regression === 1).length,
        consults: rows.filter((row) => row.role === "advisor").length,
      },
      failures: { ...failuresOf(rows), rejectedReviews: requestChanges, approximate },
      wallTimeMs: {
        completed: times.length,
        median: !times.length ? null : times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2,
        total: times.length ? sum(times) : null,
      },
      perTask,
      notes: [
        `Thread errors, busy rejections and branchless replaces chains are recorded from ${since === null ? "an unknown date" : new Date(since).toISOString()}; threads before that show 0 and may split into separate tasks.`,
        `Provider failures and stalls are counted once per thread, turn and kind when detected, whether or not their alert reached Chief, exactly from ${exactSince === null ? "an unknown date" : new Date(exactSince).toISOString()}. ${sum(Object.values(approximate))} of them (usage limit ${approximate.usageLimit}, connection ${approximate.connection}, stalls ${approximate.stalls}, hard stalls ${approximate.hardStalls}) were copied from older alerts and are approximate: an undelivered alert replaced by a newer one was lost, and a task title naming a usage limit counted a connection failure as one. A failure the classifier does not recognise is counted as a thread error.`,
        "A deleted thread loses its completed state, so its task counts as dropped.",
        "Wall time runs from the first planner or worker spawn to the final worker's completion.",
      ],
    };
  }

  /** `42m`, or `1h 5m` from an hour up; `—` for null. */
  function duration(ms: number | null) {
    if (ms === null) return "—";
    const minutes = Math.round(ms / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function statsText(stats: ReturnType<typeof chiefStats>) {
    const { tasks, todos, repairs, failures, wallTimeMs, verdicts, research } = stats;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return [
      `Chief stats · ${stats.scope.chiefThreadId ? `Chief run ${stats.scope.chiefThreadId}` : `project ${stats.scope.projectId} (all Chief runs)`}`,
      `Tasks: ${tasks.total} — ${tasks.completed} completed, ${tasks.open} open, ${tasks.dropped} dropped · todos: ${todos.open} open, ${todos.done} done, ${todos.dropped} dropped`,
      `Task kinds: ${tasks.planned} planned, ${tasks.unplanned_planner_on} unplanned (planner on), ${tasks.unplanned_planner_off} unplanned (planner off), ${tasks.simple} simple, ${tasks.unknown} unknown`,
      `Reviews: ${verdicts.approve} approve, ${verdicts.request_changes} request_changes`,
      `Research: ${research.length ? research.map((entry) => `${entry.role} ${entry.mode ?? "resume"} ${entry.succeeded}/${entry.calls} succeeded`).join(", ") : "no calls"}`,
      `Repairs: ${plural(repairs.replacements, "replacement round")}, ${repairs.requestChanges} request_changes (${plural(repairs.regressions, "regression")}), ${plural(repairs.consults, "consult")}`,
      `Failures: provider ${failures.usageLimit + failures.connection} (usage limit ${failures.usageLimit}, connection ${failures.connection}) · timing ${failures.busyRejections + failures.stalls + failures.hardStalls} (busy rejections ${failures.busyRejections}, stalls ${failures.stalls}, hard stalls ${failures.hardStalls}) · rejected reviews ${failures.rejectedReviews} · thread errors ${failures.threadErrors}`,
      `Wall time (${wallTimeMs.completed} completed): median ${duration(wallTimeMs.median)}, total ${duration(wallTimeMs.total)}`,
      "Per task:",
      ...(stats.perTask.length ? stats.perTask.map((task) => {
        const failed = task.usageLimit + task.connection + task.threadErrors + task.busyRejections + task.stalls + task.hardStalls;
        return `- ${task.status} · ${task.title} · ${plural(task.workers, "worker")}, ${plural(task.replacements, "replacement")}, ${task.approvals} approve, ${task.requestChanges} request_changes, ${plural(task.consults, "consult")}, ${plural(failed, "failure")} · ${duration(task.wallTimeMs)}`;
      }) : ["- none"]),
      "Not measured:",
      ...stats.notes.map((note) => `- ${note}`),
    ].join("\n");
  }

  /** The Pending block, in the same wording as the lifecycle alert — "Pending: none."
   * when nothing is, so the block is never silently missing (an empty roster included). */
  function pendingLines(rows: ManagedRow[], todos: string[] = []): string[] {
    const pending = rows
      .map((row) => [row, ctx.nextAction(row)] as const)
      .filter((entry): entry is [ManagedRow, string] => entry[1] !== null)
      .map(([row, action]) => `- ${row.role} “${row.title}” (${row.thread_id}): ${action}`);
    return pending.length || todos.length ? ["Pending:", ...pending, ...todos] : ["Pending: none."];
  }

  /** Who owns a todo, seen by `viewer` (none = operator shell): "" for the viewer's own. */
  function todoOwnerLabel(todo: TodoRow, viewer?: string) {
    const owner = todo.chief_thread_id;
    if (!owner) return "unowned";
    if (owner === viewer) return "";
    return viewer && !isActiveChief(store.get(owner)) ? `ended Chief ${owner}` : `Chief ${owner}`;
  }

  function todoLine(todo: TodoRow, viewer?: string) {
    const state = todo.state === "open" ? "" : ` [${todo.state}]`;
    const label = todoOwnerLabel(todo, viewer);
    return `- todo #${todo.id}${label ? ` (${label})` : ""}${state}: ${todo.text}${todo.after ? ` (after: ${todo.after})` : ""}`;
  }

  /** A project's open todos as Pending lines — after thread lines, so clipping drops them first.
   * With `viewer`, the viewer's own todos come first and the rest follow under a header; without
   * one (operator shell) everything is one tagged list. With `collapseWaiting`, todos that wait
   * on an `after:` condition fold into one count line per group. With `viewer` and `collapseOthers`,
   * every other Chief's, ended Chief's and unowned todo (waiting ones too) folds into one count line. */
  function todoLines(projectId: string | undefined, collapseWaiting = false, viewer?: string, collapseOthers = false) {
    const todos = projectId ? (todosForProject.all(projectId) as TodoRow[]) : [];
    const group = (list: TodoRow[], noun: string) => {
      if (!collapseWaiting) return list.map((todo) => todoLine(todo, viewer));
      const waiting = list.filter((todo) => todo.after);
      const lines = list.filter((todo) => !todo.after).map((todo) => todoLine(todo, viewer));
      const n = waiting.length;
      if (n) lines.push(`- ${n} waiting ${noun}${n === 1 ? "" : "s"} (#${waiting.map((todo) => todo.id).join(", #")}) hidden: each waits on its after: condition. chief_roster includeWaiting: true lists them.`);
      return lines;
    };
    if (!viewer) return group(todos, "todo");
    const foreign = todos.filter((todo) => todo.chief_thread_id !== viewer);
    const own = group(todos.filter((todo) => todo.chief_thread_id === viewer), "todo");
    if (collapseOthers) {
      const n = foreign.length;
      return n ? [...own, `- ${n} other-Chief todo${n === 1 ? "" : "s"} (#${foreign.map((todo) => todo.id).join(", #")}) hidden: not your work. chief_roster includeOthers: true lists them.`] : own;
    }
    const others = group(foreign, "other-Chief todo");
    return [
      ...own,
      ...(others.length ? ["Other Chiefs' todos (not your work; act on one only when the user asks):", ...others] : []),
    ];
  }

  /** Clips a rendered Pending block to `limit` by whole lines — never mid-action —
   * naming how many were dropped. Clipped on its own, separately from the rest of
   * the roster, so an overflowing roster still cuts detail rows first. */
  function clipPendingBlock(lines: string[], limit: number): string {
    const joined = lines.join("\n");
    if (joined.length <= limit) return joined;
    const [header, ...items] = lines;
    const kept: string[] = [];
    let used = header!.length;
    for (const item of items) {
      const next = used + 1 + item.length;
      if (next > limit) break;
      used = next;
      kept.push(item);
    }
    let suffix = `…and ${items.length - kept.length} more pending`;
    while (kept.length > 0 && used + 1 + suffix.length > limit) {
      used -= 1 + kept.pop()!.length;
      suffix = `…and ${items.length - kept.length} more pending`;
    }
    return [header, ...kept, suffix].join("\n");
  }

  /** The Pending block exactly as chief_roster prints it. */
  function pendingBlock(chiefThreadId: string, includeWaiting = false, limit = 6_000, includeOthers = false) {
    return clipPendingBlock(pendingLines([...rosterForChief(chiefThreadId)].filter((row) => row.thread_id !== chiefThreadId).reverse(), todoLines(store.get(chiefThreadId)?.project_id, !includeWaiting, chiefThreadId, !includeOthers)), limit);
  }
  return { INACTIVE_CHIEF_STATES, belongsToChief, chiefStats, controlledTarget, controlsThread, isActiveChief, isCoordinator, isLinkedChild, pendingBlock, pendingLines, replacesCall, requireChiefCaller, rerouteSteps, resolveTarget, rosterFor, rosterForChief, rosterRowLines, statsText, taskReviews, todoLine, todoLines };
}

