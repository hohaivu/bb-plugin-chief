import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ManagedSpawn } from "./managedSpawn";
import type { createReviewLedger } from "./reviewLedger";
import { REVIEW_ONLY } from "./roles";
import type { ThreadStore } from "./threadStore";
import { chainOf, type PlanWave } from "./waveSchedule";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type LiveThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

/** Shared reviewer prompt: REVIEW_ONLY and the chief_report/verdict contract are
 * identical for a worker's reviewer and a branch/PR reviewer. Only the subject
 * line and provenance section (worker brief/result, or nothing for a branch/PR
 * with no worker) differ. */
export function reviewerPrompt(opts: {
  subject: string;
  chiefThreadId: string | null;
  focus?: string;
  provenance: string[];
  /** True when the review is pinned to a pull request's head commit instead of a worktree. */
  pinned?: boolean;
}) {
  return [
    opts.subject,
    opts.focus ? `Review focus: ${opts.focus}` : "Review for correctness, regressions, validation quality, and unnecessary complexity.",
    REVIEW_ONLY,
    opts.pinned
      ? "Inspect the pinned pull request commit and the pull request description; do not rely only on the worker's claims. When plan files are listed below, read each in full before judging the change against it, including the worker's stated deviations and any unstated scope drift."
      : "Inspect the actual worktree and evidence; do not rely only on the worker's claims. When plan files are listed below, read each in full before judging the change against it, including the worker's stated deviations and any unstated scope drift.",
    "Confirm the automated criteria actually ran with their exit status; list the manual criteria that still need a human to confirm.",
    `Report your findings to ${opts.chiefThreadId ? `Chief thread ${opts.chiefThreadId}` : "Chief"} with chief_report, state ready, and a verdict.`,
    "Classify every finding as blocking or nit. Blocking means the change cannot ship as it stands. These are always blocking: a bug or incorrect behaviour, an unmet listed contract, a regression, missing or false verification evidence, a designer mismatch the brief does not accept, and scope drift the worker did not state. A nit is style, naming, a minor simplification, or an optional improvement.",
    "The verdict is request_changes only when at least one blocking finding exists; nits alone mean approve.",
    "List blocking findings first, then at most 5 nits, then write \"and N more nits\" for the rest. Give every finding a file:line and the concrete fix; mark any finding that needs a design or product decision as such.",
    "Send a `summary` with the report: verdict, blocking count, nit count, the most important blocking finding with file:line.",
    "If the change introduced a new problem or regression that was not there before, say so with request_changes and regression: true.",
    "Do not broaden scope or make product decisions. Recommend escalation when a real decision is required.",
    ...opts.provenance,
  ].join("\n");
}

/** The forge's head for a pull request, read when the review starts. */
export interface PinnedHead { branch: string; sha: string; base: string }

/** One worker a review covers, with the head the forge reported for it (null: not readable, not pinned). */
export interface BriefTarget {
  threadId: string;
  title: string;
  prUrl: string | null;
  branch: string | null;
  reportSeq: number;
  /** Whether the worker has reported a result. */
  hasResult: boolean;
  reportPath: string | null;
  head: PinnedHead | null;
}

export interface ReviewBriefInput {
  /** The worker chief_review named; its head is `head`, and it is one of `targets` unless a plan review reaches it through another. */
  worker: BriefTarget & {
    kind: "designer" | null;
    /** Its brief, already cut to fit; null when it has none. */
    brief: string | null;
    /** What it reported, already cut to fit: its summary, else the start of its result. */
    reported: string;
  };
  targets: BriefTarget[];
  /** The plan's wave files, and the 1-based waves this review's branch carries. */
  wavePaths: string[];
  chain: number[];
  /** The waves' contract text, already cut to fit. */
  contractLines: string[];
  /** The recorded-commands lines (BB's own event log), already rendered. */
  recordedLines: string[];
  /** The newest open reviewer with a result, its verdict already rendered; null when none. */
  previous: { threadId: string; preview: string[]; recommendation: string | null } | null;
  focus?: string;
  chiefThreadId: string | null;
}

/** The prompt a worker's reviewer starts from. Pure: it renders what startReview gathered and reads nothing else. */
export function reviewBrief(input: ReviewBriefInput): string {
  const { worker, targets, wavePaths, chain, contractLines, previous } = input;
  const head = worker.head;
  const many = targets.length > 1;
  const plural = many ? "s" : "";
  const pinnedAll = targets.every((target) => target.head);
  const targetLine = (target: BriefTarget) => {
    const pinned = target.head;
    return pinned
      ? `- worker ${target.threadId} “${target.title}”: ${target.prUrl} (branch ${pinned.branch}, targeting ${pinned.base}), pinned to ${pinned.sha}: \`git fetch origin ${pinned.branch}\`, then review \`git diff origin/${pinned.base}...${pinned.sha}\``
      : `- worker ${target.threadId} “${target.title}”: branch ${target.branch}${target.prUrl ? ` (${target.prUrl})` : ""}, head not readable, not pinned: \`git fetch origin ${target.branch}\`, then review \`git diff <the project's default branch>...origin/${target.branch}\`; the verdict binds to its report ${target.reportSeq}`;
  };
  return reviewerPrompt({
    pinned: pinnedAll,
    subject: many
      ? `Independently review the whole plan: ${targets.length} branches, each with its own pull request, started after every wave was ready. Review each target below, then give one verdict for all of them; request_changes if any target has a blocking finding, and name the branch each finding belongs to. Read each pull request description (gh pr view <url> --json title,body, or glab mr view <url>) as its brief, and treat nothing outside a target's pinned commit as part of its change. The worker's recorded commands ran against the worker's own tree: rerun the project's build/check at each pinned commit.\n${targets.map(targetLine).join("\n")}`
      : head
        ? `Independently review pull request ${worker.prUrl} (worker thread ${worker.threadId}: “${worker.title}”), pinned to its head commit ${head.sha} (branch ${head.branch}, targeting ${head.base}). First run \`git fetch origin ${head.branch} && git checkout --detach ${head.sha}\`. The pull request description is the brief: read it (gh pr view ${worker.prUrl} --json title,body, or glab mr view ${worker.prUrl}), then review the diff of ${head.sha} against origin/${head.base}. Treat nothing outside that commit as part of the change. The worker's recorded commands ran against the worker's own tree, not this commit: rerun the project's build/check at ${head.sha}.`
        : `Independently review the work owned by worker thread ${worker.threadId}: “${worker.title}”.`,
    chiefThreadId: input.chiefThreadId,
    focus: input.focus,
    provenance: [
      ...(worker.brief && !head && !many ? [
        "", "## The brief this work was given", worker.brief,
        "", "Judge the change against that brief. A trade-off the brief mandates is not a defect — say so rather than filing it as one.",
      ] : []),
      ...(contractLines.length ? [
        "", "## Contracts to verify", ...contractLines,
        `Check every item against ${pinnedAll ? "the pinned commit" : "the worktree"}${plural}. An unmet item means request_changes naming it; say which items you confirmed.`,
      ] : []),
      ...(head || many ? [] : [
        "", "## Recorded commands (from the worker's event log)",
        ...input.recordedLines,
        "Recorded by BB, not reported by the worker; a claimed check with no matching command is unverified.",
      ]),
      ...(worker.kind === "designer" ? [
        "", "This is design work (a Designer). Check it read-only against the brief's mode. Design tool: check the result with the tool's screenshots and confirm the worker called its finish call (e.g. `finish_working_on_nodes`). Design in code: read the artboard through the tool's MCP and compare the worker's golden or simulator PNGs against it; any visible mismatch the brief does not accept means request_changes. Never edit the design or the code.",
      ] : []),
      ...(many
        ? targets.flatMap((target) => target.hasResult ? [
          "", `## The report of worker ${target.threadId}`,
          ...(target.reportPath ? [`Full report: ${target.reportPath}`] : []),
          `Full report and last output: bb chief inspect ${target.threadId}`,
          "Read it for its Deviations from plan only; each pull request at its pinned commit is the change.",
        ] : [])
        : [
          ...(worker.hasResult && head ? [
            "", "## The worker's report file",
            ...(worker.reportPath ? [`Full report: ${worker.reportPath}`] : []),
            `Full report and last output: bb chief inspect ${worker.threadId}`,
            "Read it for its Deviations from plan only; the pull request at its pinned commit is the change.",
          ] : []),
          ...(worker.hasResult && !head ? [
            "", "## What the worker reported", worker.reported,
            ...(worker.reportPath ? [`Full report: ${worker.reportPath}`] : []),
            `Full report and last output: bb chief inspect ${worker.threadId}`,
          ] : []),
        ]),
      ...(previous ? [
        "", `## The previous review (${previous.threadId})`,
        ...previous.preview,
        ...(previous.recommendation ? [`Recommendation: ${previous.recommendation}`] : []),
        "", `Check each finding above against ${pinnedAll ? "the pinned commit" : "the current worktree"}${plural}: say which were fixed and which remain. Do not re-open points it approved. A nit from the previous review that is still open never makes this round request_changes; list it as a nit again.`,
      ] : []),
      ...(wavePaths.length ? [
        "", many
          ? `This plan has ${wavePaths.length} wave${wavePaths.length > 1 ? "s" : ""}, one branch per chain. Review each branch against its base against its waves' plans:`
          : `This branch carries wave${chain.length > 1 ? "s" : ""} ${chain.join(", ")} of ${wavePaths.length}. Review the whole branch against its base against ${chain.length > 1 ? "these waves' plans" : "this wave's plan"}:`,
        ...chain.map((n) => `Wave ${n} of ${wavePaths.length}: ${wavePaths[n - 1]}`),
        "Read each worker's full report (Full report path above, not the summary) for its Deviations from plan section. Judge each stated deviation on its merits. A change outside the plan, or a planned step skipped, that the worker did not state is scope drift: a blocking finding.",
      ] : []),
    ],
  });
}

/** The prompt of a branch or pull-request reviewer no managed worker owns. Pure. */
export function branchReviewBrief(input: { branch: string; pullRequestRef: string | null; focus?: string; chiefThreadId: string }): string {
  const { branch, pullRequestRef } = input;
  return reviewerPrompt({
    // This worktree is cut from the branch itself, so "its base" would be an empty diff.
    subject: pullRequestRef
      ? `Independently review pull request ${pullRequestRef} (branch ${branch}). No managed worker owns this change. This worktree is checked out on that branch: diff it against the pull request's target branch (gh pr view ${pullRequestRef} --json baseRefName, or glab mr view ${pullRequestRef}).`
      : `Independently review branch ${branch}. No managed worker owns this change. This worktree is checked out on that branch: diff it against the project's default branch (origin/HEAD).`,
    chiefThreadId: input.chiefThreadId,
    focus: input.focus,
    provenance: [],
  });
}

/** What startReview and startBranchReview read of a managed_threads row; the server's ManagedRow satisfies it. */
interface ReviewRow {
  thread_id: string;
  role: string;
  project_id: string;
  chief_thread_id: string | null;
  title: string;
  state: string;
  kind: "designer" | null;
  brief: string | null;
  result: string | null;
  summary: string | null;
  report_path: string | null;
  recommendation: string | null;
  branch: string | null;
  pr_url: string | null;
  plan_thread_id: string | null;
  plan_wave: number | null;
  report_seq: number;
  replaces_thread_id: string | null;
  reject_streak: number;
  reviewed_head_sha: string | null;
  created_at: number;
}

export type ReviewStarted = { threadId: string; title: string; workerThreadId: string | null; created: boolean; pinnedSha?: string | null; covers?: string[] };

/** The row fields launch writes for a reviewer. */
interface ReviewInsert {
  threadId: string; role: "reviewer"; projectId: string; chiefThreadId?: string | null; workerThreadId?: string | null;
  parentThreadId?: string | null; title: string; state?: string; status?: string | null;
  branch?: string | null; prUrl?: string | null; reviewedReportSeq?: number | null; reviewedHeadSha?: string | null;
}

export interface ReviewStartDeps<Row extends ReviewRow> {
  db: Database;
  store: ThreadStore<Row>;
  ledger: ReturnType<typeof createReviewLedger<Row>>;
  managedSpawn: ManagedSpawn<ReviewInsert>;
  requireChiefCaller: (caller: Row | undefined, what: string) => asserts caller is Row;
  reviewRefusal: (worker: Row) => string | null;
  reviewTargetsFor: (worker: Row) => Row[];
  planWavesFor: (planThreadId: string | null) => PlanWave[];
  controlsThread: (row: Row, callerChiefId: string) => boolean;
  terminal: (state: string) => boolean;
  busyStatuses: ReadonlySet<string>;
  waitIdleAfterReport: (worker: Row) => Promise<LiveThread>;
  busyRejection: (worker: Row, status: string, before: string) => never;
  prHead: (pullRequest: string, cwd: string | null) => Promise<PinnedHead | null>;
  projectPath: (projectId: string) => Promise<string | null>;
  projectHostId: (projectId: string) => Promise<string | null>;
  defaultHostId: () => Promise<string>;
  environmentHostId: (environmentId: string) => Promise<string | null>;
  recordedCommands: (threadId: string) => Promise<{ command: string; exitCode: number | null; status: string }[] | null>;
  recordedLines: (recorded: { command: string; exitCode: number | null; status: string }[] | null) => string[];
  verdictPreview: (review: Row) => string[];
  clip: (value: string, limit?: number) => string;
  clipMiddle: (value: string, limit: number) => string;
}

/** One module owns starting a reviewer: the owner and duplicate checks, the in-flight dedupe, the pinned heads,
 * the brief, the launch, and retiring the reviews it supersedes. It returns data; alerts and tool-result wording stay in the server. */
export function createReviewStart<Row extends ReviewRow>(deps: ReviewStartDeps<Row>) {
  const {
    db, store, ledger, managedSpawn, reviewRefusal, reviewTargetsFor, planWavesFor, controlsThread, terminal,
    busyStatuses, waitIdleAfterReport, busyRejection, prHead, projectPath, projectHostId, defaultHostId, environmentHostId,
    recordedCommands, recordedLines, verdictPreview, clip, clipMiddle,
  } = deps;
  const existingBranchReview = db.prepare<[string, string, string]>(
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id IS NULL AND chief_thread_id=? AND project_id=? AND branch=? AND state NOT IN ('complete','archived','deleted') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const reviewStarts = new Map<string, Promise<ReviewStarted>>();

  /** Runs one start under its key: a second call with the same key joins the first, and the entry goes once it settles. */
  async function dedupe(key: string, run: () => Promise<ReviewStarted>) {
    const inFlight = reviewStarts.get(key);
    if (inFlight) return inFlight;
    const start = run();
    reviewStarts.set(key, start);
    try {
      return await start;
    } finally {
      reviewStarts.delete(key);
    }
  }

  /** A reviewer that already finished (idle, ready, blocked, or failed) is superseded
   * by a fresh one rather than resumed; its reject_streak carries over onto the new
   * row, so deadlock detection still sees consecutive rejections across the fresh
   * reviewers. The verdict history lives in reviewer_verdicts, not on the row. Only a reviewer still busy (BUSY_STATUSES) is returned as-is. */
  async function startReview(caller: Row | undefined, workerThreadId: string, focus?: string) {
    deps.requireChiefCaller(caller, "Starting a review");
    const worker = store.get(workerThreadId);
    if (!worker || worker.role !== "worker") throw new Error(`No managed worker ${workerThreadId}.`);
    const refusal = reviewRefusal(worker);
    if (refusal) throw new Error(refusal);
    // One review of a plan covers the latest worker of every branch; any other worker covers itself.
    const targets = reviewTargetsFor(worker);
    for (const target of targets) {
      if (!controlsThread(target, caller.thread_id) || target.project_id !== caller.project_id) throw new Error(`No managed worker ${target.thread_id} for this Chief.`);
    }
    const planReview = targets.length > 1 || (!!worker.plan_thread_id && worker.plan_wave != null && planWavesFor(worker.plan_thread_id).length > 0);
    const reviewKey = planReview ? `plan:${worker.plan_thread_id}` : workerThreadId;
    return dedupe(reviewKey, async () => {
      const openReviews = [...new Set(targets.flatMap((target) => ledger.taskChain(target.thread_id)))]
        .flatMap((id) => { const open = ledger.openReview(id); return open ? [open] : []; })
        .filter((review, index, all) => all.findIndex((other) => other.thread_id === review.thread_id) === index)
        .sort((a, b) => b.created_at - a.created_at);
      const previous = openReviews[0];
      const busy = openReviews.find((review) => busyStatuses.has(review.state));
      if (busy) {
        return { threadId: busy.thread_id, title: busy.title, workerThreadId, created: false, pinnedSha: busy.reviewed_head_sha, covers: targets.map((target) => target.thread_id) };
      }
      const lives = new Map<string, LiveThread>();
      for (const target of targets) {
        const live = await waitIdleAfterReport(target);
        if (busyStatuses.has(live.status)) busyRejection(target, live.status, "starting a review");
        if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Worker ${target.thread_id} is not reviewable.`);
        lives.set(target.thread_id, live);
      }
      const live = lives.get(workerThreadId)!;
      // The forge's head, read now, is the commit each verdict will cover. No PR, or a head the forge will not
      // tell us, keeps a single-worker review on the worker's own environment exactly as before (reviewed_head_sha stays NULL).
      const projectDir = await projectPath(worker.project_id);
      const heads = new Map<string, PinnedHead | null>();
      for (const target of targets) heads.set(target.thread_id, target.pr_url ? await prHead(target.pr_url, projectDir) : null);
      const head = heads.get(workerThreadId) ?? null;
      if (!head && !live.environmentId) throw new Error(`Worker ${workerThreadId} has no reusable environment.`);
      for (const target of targets) {
        if (target !== worker && !heads.get(target.thread_id) && !target.branch) {
          throw new Error(`Worker ${target.thread_id} has no readable pull request head and no branch, so the plan's one review cannot reach it. Retry once the forge answers.`);
        }
      }
      const hostId = head ? (await projectHostId(worker.project_id)) ?? await defaultHostId() : await environmentHostId(live.environmentId!);
      const prepared = await managedSpawn.prepare(worker.project_id, { role: "reviewer", hostId });
      const title = `Review · ${worker.title}`;
      const waves = planWavesFor(worker.plan_thread_id);
      // A plan review sees every wave; a single worker's reviewer sees only its chain's waves.
      const chain = worker.plan_wave != null && waves.length && !planReview ? chainOf(waves, worker.plan_wave) : waves.map((_, index) => index + 1);
      const contractLines = waves.length === 1
        ? waves[0]!.contracts ? [clip(waves[0]!.contracts, 3_000)] : []
        : chain.flatMap((n) => waves[n - 1]!.contracts ? [`Wave ${n} of ${waves.length}:`, clip(waves[n - 1]!.contracts!, 3_000)] : []);
      const recorded = head ? null : await recordedCommands(workerThreadId);
      const briefTarget = (row: Row): BriefTarget => ({
        threadId: row.thread_id, title: row.title, prUrl: row.pr_url, branch: row.branch, reportSeq: row.report_seq,
        hasResult: !!row.result, reportPath: row.report_path, head: heads.get(row.thread_id) ?? null,
      });
      const prompt = reviewBrief({
        worker: {
          ...briefTarget(worker), kind: worker.kind,
          brief: worker.brief ? clipMiddle(worker.brief, 4_000) : null,
          reported: worker.summary ?? clip(worker.result ?? "", 300),
        },
        targets: targets.map(briefTarget),
        wavePaths: waves.map((wave) => wave.path),
        chain,
        contractLines,
        recordedLines: recordedLines(recorded),
        previous: previous?.result ? {
          threadId: previous.thread_id,
          preview: verdictPreview(previous),
          recommendation: previous.recommendation ? clip(previous.recommendation, 600) : null,
        } : null,
        focus,
        chiefThreadId: worker.chief_thread_id,
      });
      const thread = await managedSpawn.launch(prepared, {
        projectId: worker.project_id,
        environment: head
          ? { type: "host", hostId: hostId as string, workspace: { type: "managed-worktree", baseBranch: { kind: "named" as const, name: head.branch } } }
          : { type: "reuse", environmentId: live.environmentId! },
        title, prompt,
      }, { role: "reviewer", chiefThreadId: worker.chief_thread_id, workerThreadId, reviewedReportSeq: worker.report_seq, reviewedHeadSha: head?.sha },
      (threadId) => ledger.addTargets(threadId, targets.map((target) => ({
        threadId: target.thread_id, reportSeq: target.report_seq, headSha: heads.get(target.thread_id)?.sha ?? null, prUrl: target.pr_url, branch: target.branch,
      }))));
      // Seed from the task's history, not just the open reviewer: a completed one must not reset the count.
      const streak = ledger.carriedStreak(targets.map((target) => target.thread_id));
      if (openReviews.length || streak) {
        const now = Date.now();
        store.batch(() => {
          ledger.seedStreak(thread.id, streak, previous, now);
          for (const old of openReviews) store.completeSuperseded(old.thread_id, now);
        });
      }
      return { threadId: thread.id, title, workerThreadId, created: true, pinnedSha: head?.sha ?? null, covers: targets.map((target) => target.thread_id) };
    });
  }

  /** The chief_review counterpart to startReview for a pull request or branch no
   * managed worker owns: same reviewer contract, but spawned on a fresh managed
   * worktree (delegate()'s exact shape) instead of the worker's reused environment. */
  async function startBranchReview(caller: Row | undefined, branch: string, pullRequestRef: string | null, focus?: string) {
    deps.requireChiefCaller(caller, "Starting a review");
    const { thread_id: chiefThreadId, project_id: projectId } = caller;
    // A branch a managed worker still carries is reviewed through that worker, so the review follows its plan and head.
    const owner = store.all().find((row) => row.role === "worker" && !terminal(row.state)
      && row.chief_thread_id === chiefThreadId && row.project_id === projectId && row.branch === branch);
    if (owner) throw new Error(`Branch ${branch} is owned by worker ${owner.thread_id}: use chief_review (workerThreadId: ${owner.thread_id}).`);
    return dedupe(JSON.stringify(["branch", chiefThreadId, projectId, branch]), async () => {
      const duplicate = existingBranchReview.get(chiefThreadId, projectId, branch) as Row | undefined;
      if (duplicate) return { threadId: duplicate.thread_id, title: duplicate.title, workerThreadId: null, created: false };
      const hostId = (await projectHostId(projectId)) ?? await defaultHostId();
      const prepared = await managedSpawn.prepare(projectId, { role: "reviewer", hostId });
      const title = `Review · ${branch}`;
      const prompt = branchReviewBrief({ branch, pullRequestRef, focus, chiefThreadId });
      const thread = await managedSpawn.launch(prepared, {
        projectId,
        environment: {
          type: "host",
          hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "named" as const, name: branch } },
        },
        title, prompt,
      }, { role: "reviewer", chiefThreadId, branch, prUrl: pullRequestRef });
      return { threadId: thread.id, title, workerThreadId: null, created: true };
    });
  }

  return { startReview, startBranchReview };
}
