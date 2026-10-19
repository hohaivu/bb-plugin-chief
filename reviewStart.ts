import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ManagedSpawn } from "./managedSpawn";
import type { createReviewLedger } from "./reviewLedger";
import { REVIEW_ONLY } from "./roles";
import type { ThreadStore } from "./threadStore";
import { chainOf, type PlanWave } from "./waveSchedule";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type LiveThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

/** Shared reviewer prompt: REVIEW_ONLY and the chief_report/verdict contract are
 * identical for a worker's reviewer and a branch/PR reviewer. Invariant rules come
 * first so the prefix caches; every per-run line sits under `## This review`. */
export function reviewerPrompt(opts: {
  subject: string;
  chiefThreadId: string | null;
  focus?: string;
  provenance: string[];
  /** True when the review is pinned to a pull request's head commit instead of a worktree. */
  pinned?: boolean;
}) {
  return [
    REVIEW_ONLY,
    "Confirm the automated criteria actually ran with their exit status; list the manual criteria that still need a human to confirm.",
    "Classify the change, then check it by type: a bug fix fixes the root cause, not the symptom, and has a regression test or a reproducing check; a refactor or migration leaves behaviour unchanged, with the base commit as the oracle: where practical, run the old and new code on the same inputs (the same command, test or fixture against a checkout of the base), and treat any behaviour difference the worker did not explain as a regression; a feature aligns with the contract and spec in the brief; a mixed change is checked part by part by each part's type.",
    "Evidence rules: a blocking finding needs a traced input → code path → failure; never reject on speculation. Never approve only because tests pass; read the change. Report only problems this diff introduced; a pre-existing problem is at most a nit, unless the diff makes it reachable. When a signature or exported contract changed, inspect its callers.",
    "Test audit: when the diff adds or changes tests, check that each would fail on a plausible wrong implementation (an off-by-one, a missed boundary, a swapped branch, a dropped case). A test that asserts a tautology, a trivial constant, or only what the mock returns proves nothing. Vacuous tests count as missing verification evidence for the behaviour they claim to cover.",
    "A contract stated as a property (round-trip, idempotency, invariant or bound, equivalence, must-never-happen) holds for inputs beyond the worker's own examples: check at least one boundary or adversarial input the worker did not choose.",
    "Classify every finding as blocking or nit. Blocking means the change cannot ship as it stands. These are always blocking: a bug or incorrect behaviour, an unmet listed contract, a regression, missing or false verification evidence, a designer mismatch the brief does not accept, scope drift the worker did not state, and functional code replaced by a comment, TODO or placeholder. A nit is style, naming, a minor simplification, or an optional improvement.",
    "State the assumptions your verdict rests on. Write a finding that needs a product or architecture answer as `[AMBIGUOUS: <question>]`; it is neither a blocker nor a nit, and alone it never sets request_changes. Drop doubts that would not change the verdict.",
    "The verdict is request_changes only when at least one blocking finding exists; nits alone mean approve.",
    "Send each finding in chief_report `findings` ({file, line, severity, message, fix}); put the at-most-5 nits cap, assumptions and `[AMBIGUOUS: …]` items in result.",
    "Send a `summary` with the report: verdict, blocking count, nit count, the most important blocking finding with file:line.",
    "If the change introduced a new problem or regression that was not there before, say so with request_changes and regression: true.",
    "Set chief_report `lesson` (at most 400 characters) only for a durable, project-level review rule or known false positive a future reviewer should know; never for something specific to this task.",
    "Do not broaden scope or make product decisions. Recommend escalation when a real decision is required.",
    "## This review",
    opts.subject,
    `Report your findings to ${opts.chiefThreadId ? `Chief thread ${opts.chiefThreadId}` : "Chief"} with chief_report, state ready, and a verdict.`,
    ...(opts.focus ? [`Review focus: ${opts.focus}`] : []),
    opts.pinned
      ? "Inspect the pinned pull request commit and the pull request description; do not rely only on the worker's claims. When review-context.md lists plan files, read each in full before judging the change against it, including the worker's stated deviations and any unstated scope drift."
      : "Inspect the actual worktree and evidence; do not rely only on the worker's claims. When review-context.md lists plan files, read each in full before judging the change against it, including the worker's stated deviations and any unstated scope drift.",
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
  /** Per target: file:line pointers outside its diff, or why they could not be computed. Optional: older callers omit it. */
  impactSlices?: { threadId: string; branch: string | null; lines?: string[]; skipped?: string }[];
}

/** The prompt a worker's reviewer starts from, plus the long provenance it reads from review-context.md in its storage.
 * Pure: it renders what startReview gathered and reads nothing else. */
export function reviewBrief(input: ReviewBriefInput): { prompt: string; context: string } {
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
  const briefSection = worker.brief && !head && !many ? ["## The brief this work was given", worker.brief] : [];
  const recordedSection = head || many ? [] : ["## Recorded commands (from the worker's event log)", ...input.recordedLines];
  const reportSection = many
    ? targets.flatMap((target) => target.hasResult ? [
      `## The report of worker ${target.threadId}`,
      ...(target.reportPath ? [`Full report: ${target.reportPath}`] : []),
      `Full report and last output: bb chief inspect ${target.threadId}`, "",
    ] : [])
    : worker.hasResult ? [
      head ? "## The worker's report file" : "## What the worker reported",
      ...(head ? [] : [worker.reported]),
      ...(worker.reportPath ? [`Full report: ${worker.reportPath}`] : []),
      `Full report and last output: bb chief inspect ${worker.threadId}`,
    ] : [];
  const previousSection = previous ? [
    `## The previous review (${previous.threadId})`,
    ...previous.preview,
    ...(previous.recommendation ? [`Recommendation: ${previous.recommendation}`] : []),
  ] : [];
  const planSection = wavePaths.length ? [
    many
      ? `## Plan: ${wavePaths.length} wave${wavePaths.length > 1 ? "s" : ""}, one branch per chain`
      : `## Plan: this branch carries wave${chain.length > 1 ? "s" : ""} ${chain.join(", ")} of ${wavePaths.length}`,
    ...chain.map((n) => `Wave ${n} of ${wavePaths.length}: ${wavePaths[n - 1]}`),
  ] : [];
  const slices = input.impactSlices ?? [];
  const sliceSection = slices.length ? [
    "## Impact slice",
    ...slices.flatMap((slice) => [
      ...(many ? [`### ${slice.branch ?? "no branch"} (worker ${slice.threadId})`] : []),
      ...(slice.lines ?? [`Skipped: ${slice.skipped}.`]),
    ]),
  ] : [];
  const sections = [briefSection, recordedSection, reportSection, previousSection, planSection, sliceSection].filter((lines) => lines.length);
  const context = sections.map((lines) => lines.join("\n")).join("\n\n");
  const summary = sections.length ? [
    "", "## Context",
    ...(briefSection.length ? ["- The brief this work was given."] : []),
    ...(recordedSection.length ? [`- ${input.recordedLines[0] ?? "Recorded commands"} (the worker's event log).`] : []),
    ...(reportSection.length ? [`- Where to read the worker report${plural}.`] : []),
    ...(previousSection.length ? [`- The previous review (${previous!.threadId}) with its findings.`] : []),
    ...(planSection.length ? [`- The plan wave file${chain.length > 1 ? "s" : ""} this review covers.`] : []),
    ...(sliceSection.length ? ["- The impact slice: pointers to code outside the diff that the change calls or that calls it."] : []),
    "Read `$BB_THREAD_STORAGE/review-context.md` in full before reviewing. If it is missing, wait 10 seconds and read again; if still missing, report blocked naming it.",
  ] : [];
  const prompt = reviewerPrompt({
    pinned: pinnedAll,
    subject: many
      ? `Independently review the whole plan: ${targets.length} branches, each with its own pull request, started after every wave was ready. Review each target below, then give one verdict for all of them; request_changes if any target has a blocking finding, and name the branch each finding belongs to. Read each pull request description (gh pr view <url> --json title,body, or glab mr view <url>) as its brief, and treat nothing outside a target's pinned commit as part of its change. The worker's recorded commands ran against the worker's own tree: rerun the project's build/check at each pinned commit.\n${targets.map(targetLine).join("\n")}`
      : head
        ? `Independently review pull request ${worker.prUrl} (worker thread ${worker.threadId}: “${worker.title}”), pinned to its head commit ${head.sha} (branch ${head.branch}, targeting ${head.base}). First run \`git fetch origin ${head.branch} && git checkout --detach ${head.sha}\`. The pull request description is the brief: read it (gh pr view ${worker.prUrl} --json title,body, or glab mr view ${worker.prUrl}), then review the diff of ${head.sha} against origin/${head.base}. Treat nothing outside that commit as part of the change. The worker's recorded commands ran against the worker's own tree, not this commit: rerun the project's build/check at ${head.sha}.`
        : `Independently review the work owned by worker thread ${worker.threadId}: “${worker.title}”.`,
    chiefThreadId: input.chiefThreadId,
    focus: input.focus,
    provenance: [
      ...summary,
      ...(briefSection.length ? [
        "", "Judge the change against that brief. A trade-off the brief mandates is not a defect — say so rather than filing it as one.",
      ] : []),
      ...(contractLines.length ? [
        "", "## Contracts to verify", ...contractLines,
        `Check every item against ${pinnedAll ? "the pinned commit" : "the worktree"}${plural}. An unmet item means request_changes naming it; say which items you confirmed.`,
      ] : []),
      ...(slices.some((slice) => slice.lines) ? [
        "Use the impact slice in review-context.md only as reference for contract mismatches (a callee's real signature or contract, a caller's expectations); report findings only on lines this diff introduced, never on slice lines.",
      ] : []),
      ...(recordedSection.length ? [
        "Recorded commands are recorded by BB, not reported by the worker; a claimed check with no matching command is unverified.",
      ] : []),
      ...(worker.kind === "designer" ? [
        "", "This is design work (a Designer). Check it read-only against the brief's mode. Design tool: check the result with the tool's screenshots and confirm the worker called its finish call (e.g. `finish_working_on_nodes`). Design in code: read the artboard through the tool's MCP and compare the worker's golden or simulator PNGs against it; any visible mismatch the brief does not accept means request_changes. Never edit the design or the code.",
      ] : []),
      ...(reportSection.length && (head || many) ? [
        `Read each worker report for its Deviations from plan only; each pull request at its pinned commit is the change.`,
      ] : []),
      ...(previous ? [
        "", `Check each finding of the previous review against ${pinnedAll ? "the pinned commit" : "the current worktree"}${plural}: say which were fixed and which remain. Do not re-open points it approved. A nit from the previous review that is still open never makes this round request_changes; list it as a nit again. Weigh every item under the worker's \`## Disputed findings\`. Drop a finding the evidence refutes. Keep it blocking only with a traced failure.`,
      ] : []),
      ...(wavePaths.length ? [
        "", `Review ${many ? "each branch" : "the whole branch"} against its base against the plan wave files in review-context.md.`,
        "Read each worker's full report (its Full report path in review-context.md, not the summary) for its Deviations from plan section. Judge each stated deviation on its merits. A change outside the plan, or a planned step skipped, that the worker did not state is scope drift: a blocking finding.",
      ] : []),
    ],
  });
  return { prompt, context };
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
  verify_command?: string | null;
  created_at: number;
}

export type ReviewStarted = { gated?: false; threadId: string; title: string; workerThreadId: string | null; created: boolean; pinnedSha?: string | null; covers?: string[]; gateSkipped?: string[]; sliceSkipped?: string[] };
/** A pre-review gate failed: no reviewer was spawned, no ledger row written, no open review superseded. */
export type ReviewGated = { gated: true; workerThreadId: string; command: string; sha: string; exitCode: number; outputPath: string | null; tail: string; issues?: string[] };
export type GateResult = { passed: true } | { skipped: string } | { failed: Omit<ReviewGated, "gated"> };

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
  /** Writes the reviewer's review-context.md; owns its retries and alerting Chief on final failure. */
  writeReviewContext: (threadId: string, content: string, workerThreadId: string) => Promise<void>;
  /** Runs row.verify_command on the pinned sha (or the branch tip when null) in a temporary checkout. */
  runGate: (row: Row, command: string, pinnedSha: string | null, projectDir: string | null) => Promise<GateResult>;
  /** Git-only file:line pointers outside the commit's diff; never blocks a review, a failure is `{ skipped }`. */
  impactSlice: (row: Row, head: PinnedHead | null, projectDir: string | null, maxEntries: number) => Promise<{ lines: string[] } | { skipped: string }>;
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
  const reviewStarts = new Map<string, Promise<ReviewStarted | ReviewGated>>();

  /** Runs one start under its key: a second call with the same key joins the first, and the entry goes once it settles. */
  async function dedupe<T extends ReviewStarted | ReviewGated>(key: string, run: () => Promise<T>): Promise<T> {
    const inFlight = reviewStarts.get(key);
    if (inFlight) return inFlight as Promise<T>;
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
    return dedupe<ReviewStarted | ReviewGated>(reviewKey, async () => {
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
      // Deterministic gate before any reviewer exists: a failure spawns nothing and writes no ledger row.
      const gateSkipped: string[] = [];
      for (const target of targets) {
        if (!target.verify_command) continue;
        let gate: GateResult;
        try {
          gate = await deps.runGate(target, target.verify_command, heads.get(target.thread_id)?.sha ?? null, projectDir);
        } catch (error) {
          gate = { skipped: `the gate failed unexpectedly (${clip(String(error), 200)})` };
        }
        if ("failed" in gate) return { gated: true as const, ...gate.failed };
        if ("skipped" in gate) gateSkipped.push(`${target.thread_id}: ${gate.skipped}`);
      }
      // After the gate, so a failed gate computes nothing; sequential, each bounded by its own deadline.
      const impactSlices: NonNullable<ReviewBriefInput["impactSlices"]> = [];
      const sliceSkipped: string[] = [];
      for (const target of targets) {
        const slice = await deps.impactSlice(target, heads.get(target.thread_id) ?? null, projectDir, Math.max(5, Math.floor(30 / targets.length)))
          .catch((error): { skipped: string } => ({ skipped: clip(String(error), 200) }));
        impactSlices.push({ threadId: target.thread_id, branch: heads.get(target.thread_id)?.branch ?? target.branch, ...slice });
        if ("skipped" in slice) sliceSkipped.push(`${target.thread_id}: ${slice.skipped}`);
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
      const { prompt, context } = reviewBrief({
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
        impactSlices,
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
      if (context) await deps.writeReviewContext(thread.id, context, workerThreadId);
      // Seed from the task's history, not just the open reviewer: a completed one must not reset the count.
      const streak = ledger.carriedStreak(targets.map((target) => target.thread_id));
      if (openReviews.length || streak) {
        const now = Date.now();
        store.batch(() => {
          ledger.seedStreak(thread.id, streak, previous, now);
          for (const old of openReviews) store.completeSuperseded(old.thread_id, now);
        });
      }
      return { threadId: thread.id, title, workerThreadId, created: true, pinnedSha: head?.sha ?? null, covers: targets.map((target) => target.thread_id), gateSkipped, sliceSkipped };
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
