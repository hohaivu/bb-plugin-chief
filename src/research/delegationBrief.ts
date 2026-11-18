import { MAX_WAVES, findingLines } from "../report/reportIntake";
import { ADVISE_ONLY, READ_ONLY, managedSkills, type WorkerKind } from "../core/roles";
import { isWriter } from "../plan/waveSchedule";
import type { FailEntry } from "../types";
import { bullets, clip, clipMiddle } from "../core/text";
import { quote } from "../forge/forge";

// The delegation split, like reviewBrief in reviewStart.ts: resolve what a replaces: successor inherits, and render
// the worker, planner and advisor prompts. Pure: startWorker, startPlan and startConsult gather the inputs
// (live checks, DB reads) first and keep every effect. Structural row types, so this file never imports ./server.

type Finding = { file: string; line?: number; severity: "blocking" | "nit"; message: string; fix?: string };

/** What a verdict preview reads from a reviewer's row. */
type VerdictRow = {
  thread_id: string;
  verdict: string | null;
  verdict_path: string | null;
  summary: string | null;
  result: string | null;
};

/** The delegate params the resolve step and the brief read. */
type DelegateInput = {
  title: string;
  mission: string;
  successCriteria?: string[];
  constraints?: string[];
  context?: string;
  branch?: string;
  issueUrl?: string;
  prUrl?: string;
  planThreadId?: string;
  wave?: number;
  kind?: WorkerKind;
  unplannedReason?: string;
  verifyCommand?: string;
};

/** The replaced worker's row, as far as inheritance and the brief read it. */
type PriorRow = VerdictRow & {
  branch: string | null;
  issue_url: string | null;
  pr_url: string | null;
  plan_thread_id: string | null;
  plan_wave: number | null;
  kind: "designer" | "tester" | "spec-writer" | null;
  /** The brief the worker was given: an unplanned tester's or Spec Writer's source of truth is its chain head's. */
  brief: string | null;
  verify_command: string | null;
  unplanned_reason: string | null;
  blocker: string | null;
  recommendation: string | null;
  report_path: string | null;
};

/** A reviewer's verdict for another thread's prompt: the clipped findings plus where to read them in full. */
export function verdictPreview(review: VerdictRow, suffix = "") {
  return [
    `Verdict: ${review.verdict ?? "none"}${suffix}`,
    ...(review.verdict_path ? [`Verdict file (read it in full): ${review.verdict_path}`] : []),
    review.summary ?? clip(review.result ?? "", 300),
    `Full report and last output: bb chief inspect ${review.thread_id}`,
  ];
}

/** What a delegation carries over from the worker it replaces, and from its own params.
 * Throws the two combination errors the schema cannot see when planThreadId is inherited. */
export function resolveDelegation(params: DelegateInput, prior: PriorRow | undefined) {
  const branch = prior ? prior.branch ?? undefined : params.branch;
  const issueUrl = params.issueUrl ?? (prior ? prior.issue_url ?? undefined : undefined);
  const prUrl = params.prUrl ?? (prior ? prior.pr_url ?? undefined : undefined);
  // With replaces: and no explicit wave, the new worker inherits the prior worker's
  // plan link — a fix worker after the final review still reads as "final wave".
  let planThreadId = params.planThreadId;
  let wave = params.wave;
  if (planThreadId === undefined && wave === undefined && prior?.plan_thread_id && prior.plan_wave != null) {
    planThreadId = prior.plan_thread_id;
    wave = prior.plan_wave;
  }
  // Same rule for the kind: a fix successor stays a designer, an explicit next wave uses its own.
  const kind: WorkerKind = params.kind ?? (prior && params.planThreadId === undefined && params.wave === undefined && prior.kind === "designer" ? "designer" : "worker");
  const verifyCommand = params.verifyCommand ?? prior?.verify_command ?? null;
  // The schema only sees params.planThreadId; a replaces: inherited one must be checked here too.
  if (planThreadId !== undefined && params.unplannedReason) {
    throw new Error("unplannedReason cannot be combined with planThreadId.");
  }
  const unplannedReason = params.unplannedReason ?? (planThreadId === undefined ? prior?.unplanned_reason ?? undefined : undefined);
  return { branch, issueUrl, prUrl, planThreadId, wave, kind, verifyCommand, unplannedReason };
}

export type WorkerBriefInput = {
  title: string;
  chiefThreadId: string;
  params: Pick<DelegateInput, "mission" | "successCriteria" | "constraints" | "context">;
  /** Plan-wave facts; wave and waveTotal are set together with a plan link. */
  wave: number | undefined;
  waveTotal: number | undefined;
  waveNext: number | null;
  waveIndependent: boolean;
  /** A fresh chain head's plan base: its branch and PR are based on it. */
  stackBase?: string;
  designWave: boolean;
  implementsDesign: number | null;
  contracts: string | undefined;
  /** "Plan file (wave N of M): path", or undefined without a plan link. */
  planContextLine: string | undefined;
  kind: WorkerKind;
  verifyCommand: string | null;
  branch: string | undefined;
  issueUrl: string | undefined;
  prUrl: string | undefined;
  prior: PriorRow | undefined;
  /** The replaced worker's open reviewer row and its parsed findings; undefined without a replaces:. */
  findings: (VerdictRow & { recommendation: string | null }) | undefined;
  structured: Finding[] | undefined;
  ruledOut: FailEntry[];
  /** A tester's or Spec Writer's source lines (plan files, contracts, approved design, or the head worker's brief); [] otherwise. */
  specSources: string[];
  /** On a spec-bearing chain: one line per Spec Writer whose docs a product worker, designer or tester follows; [] or absent otherwise. */
  specDocs?: string[];
  /** Spec Writer: its own wave has a `## Spec baseline` before that wave's worker ran. Tester: its wave or an ancestor has one. Optional: older callers omit it. */
  baseline?: boolean;
  /** A worker or designer on a spec wave: it builds from the plan alone while the wave's Spec Writer records the docs in parallel. Optional: older callers omit it. */
  specWave?: boolean;
  /** side: a Spec Writer in its own side worktree, folding docs/ onto the chain branch. Absent or implementation: every other row. */
  lane?: "side" | "implementation";
  /** Same-plan side-lane Spec Writer repair: every known docs item of its owned waves and the prior blocker, each with its source thread id. Optional: empty or absent renders nothing. */
  docsWork?: DocsWorkItem[];
  /** The replaced worker's open review covers more than one target, so its findings are not all this thread's. */
  sharedReview?: boolean;
  /** Tester only: a compact no-commit evidence brief. Optional: older callers omit it. */
  evidenceOnly?: boolean;
  /** Tester with a replaces: the chain's newest ready tester and its parsed receipt (null: missing or incomplete). Optional: older callers omit it. */
  receipt?: { tester: { thread_id: string; report_path: string | null }; receipt: { text: string } | null };
  /** The published slot wrapper's path; set, every kind but a Spec Writer gets `## Heavy commands`. Optional: older callers omit it. */
  heavyPath?: string | null;
};

/** The first Working contract item of a worker or planner brief: the plugin only offers a thread its skills, so the brief orders the load.
 * One wording for every provider: the Skill tool, or a full read of each offered SKILL.md. */
const loadLine = (skills: string[], holds = "") =>
  `- Before any task or repository file read or other task action, load these skills in full: ${skills.map((name) => `\`${name}\``).join(", ")}. Use your Skill tool; without one, read each offered SKILL.md file in full (these reads are the only exception to the sync-first rule). If one cannot be found or loaded, report blocked before any repository work. They hold this thread's working contract${holds}.`;

const deviationsLine = "- Your ready result must contain a `## Deviations from plan` heading listing each place you departed from the plan file and why, or `None`.";

const DOCS_WORK_MAX = 4_000;
/** The file name, under the repair's own thread storage, that holds the full work list when the section cannot name every omitted id. */
export const DOCS_WORK_FILE = "docs-work.md";

/** One docs item of the repair's work list, with where it came from: a worker, designer or tester `## Docs needed`, or the prior writer's blocker. */
export type DocsWorkItem = { id: string; kind: string; wave: number | null; blocker?: boolean; text: string };

/** The repair's docs work list. The section is at most DOCS_WORK_MAX characters. It shows the longest prefix of whole items (possibly none)
 * that leaves room for the exact omitted count and every omitted source id. Only when no prefix fits with the ids does the overflow line
 * point to `file`, the full list written to the repair's thread storage; `file` is then that text. */
function docsWorkSection(wave: number | undefined, items: DocsWorkItem[]): { lines: string[]; file?: string } {
  const heading = `## Docs work list (wave ${wave})`;
  const closing = "Fix every item that still holds, together with the Spec delta and the docs findings your mission assigns, then fold once (section 10). List an item already true in the docs at your HEAD under `## Already done`, and one that does not hold under `## Disputed findings`.";
  const lines = items.map((item) => `${item.id} ${item.blocker ? "(blocker)" : `(wave ${item.wave})`}: ${item.text}`);
  const n = items.length;
  const itemsLen = [0];
  for (const line of lines) itemsLen.push(itemsLen[itemsLen.length - 1] + line.length);
  const idsLen = Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) idsLen[i] = idsLen[i + 1] + items[i].id.length + (i < n - 1 ? 1 : 0);
  const inlineLine = (shown: number) => `${n - shown} more items not shown. Read each in full with bb chief inspect <id>: its \`## Docs needed\`, or its blocker for the prior writer's id: ${items.slice(shown).map((item) => item.id).join(" ")}.`;
  const fileLine = (shown: number) => `${n - shown} more items not shown, too many ids to list. All ${n} items, each in full with its source id, kind and wave, are in $BB_THREAD_STORAGE/${DOCS_WORK_FILE}: read that file.`;
  // The serialized size: heading, shown lines, the optional overflow line and the closing line, joined by newlines after the empty first line.
  const size = (shown: number, overflow: number) => heading.length + closing.length + itemsLen[shown] + overflow + (shown + (overflow ? 4 : 3) - 1);
  const render = (shown: number, overflow: string) => ["", heading, ...lines.slice(0, shown), ...(overflow ? [overflow] : []), closing];
  if (size(n, 0) <= DOCS_WORK_MAX) return { lines: render(n, "") };
  // The inline line's length is its fixed text plus the id list: measure it from the suffix lengths, and build only the winner.
  const fixed = inlineLine(0).length - idsLen[0];
  for (let shown = n - 1; shown >= 0; shown--) {
    if (size(shown, fixed + String(n - shown).length - String(n).length + idsLen[shown]) <= DOCS_WORK_MAX) return { lines: render(shown, inlineLine(shown)) };
  }
  let shown = n - 1;
  while (shown > 0 && size(shown, fileLine(shown).length) > DOCS_WORK_MAX) shown--;
  const file = [`# Docs work list (wave ${wave}): all ${n} items`, "",
    ...items.flatMap((item) => [`## ${item.id}: ${item.blocker ? "prior writer's blocker" : `${item.kind}, wave ${item.wave}`}`, "", item.text, ""])].join("\n");
  return { lines: render(shown, fileLine(shown)), file };
}

/** The worker's prompt, its brief, and the cut-down brief its reviewer judges against. */
export function workerBrief(input: WorkerBriefInput): { prompt: string; brief: string; reviewerBrief: string; /** The full docs work list, only when the brief's section points to it. */ docsWorkFile: string | undefined } {
  const { title, chiefThreadId, params, wave, waveTotal, waveNext, waveIndependent, stackBase, designWave, implementsDesign, contracts, planContextLine,
    kind, verifyCommand, branch, issueUrl, prUrl, prior, findings, structured, ruledOut, specSources, specDocs = [], baseline = false, specWave = false, lane = "implementation", evidenceOnly = false, receipt, docsWork, sharedReview = false, heavyPath = null } = input;
  const tester = kind === "tester";
  const evidence = evidenceOnly && tester;
  const specWriter = isWriter(kind);
  const docsSection = specWriter && docsWork?.length ? docsWorkSection(wave, docsWork) : undefined;
  const side = specWriter && lane === "side" && branch !== undefined;
  const context = [params.context, planContextLine].filter((value): value is string => Boolean(value)).join("\n\n") || undefined;
  // Evidence mode: with no Chief constraints, the blocking findings' fixes become the constraints (each fix once).
  const moved = evidence && !params.constraints?.length && findings?.result
    ? (structured ?? []).filter((entry) => entry.severity === "blocking" && entry.fix)
    : [];
  const constraints = moved.length ? moved.map((entry) => `${entry.file}${entry.line ? `:${entry.line}` : ""}: ${entry.fix}`) : params.constraints;
  // A tester brief drops an empty list's section; every other kind keeps "None stated.".
  const listed = (heading: string, values?: string[]) => tester && !values?.length ? [] : ["", heading, bullets(values)];
  const render = (mission: string, contextText?: string) => [
    "## Mission", mission,
    ...listed("## Success criteria", params.successCriteria),
    ...listed("## Constraints", constraints),
    ...(contextText ? ["", "## Context", contextText] : []),
  ].join("\n");
  const brief = render(params.mission, context);
  // The reviewer gets the same sections, with a long mission or context clipped —
  // it judges against the criteria and constraints, which stay in full.
  const reviewerBrief = render(clip(params.mission, 1_500), context && clipMiddle(context, 1_500));
  // A code span keeps the shell text literal; its backtick run is one longer than any run inside, padded with spaces.
  const span = (text: string) => ((ticks) => `${ticks} ${text} ${ticks}`)("`".repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1))));
  // A fence longer than any backtick run in the text, so a ``` line in it cannot close it.
  const fenced = (text: string) => ((fence) => [`${fence}sh`, text, fence])("`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1))));
  const prompt = [
    `You are the managed ${evidence ? "tester" : "worker"} for “${title}”. Report to Chief thread ${chiefThreadId}.`,
    "", brief,
    ...(findings?.result ? [
      "", `## Review findings to fix (${findings.thread_id})`,
      ...(structured ? [
        ...(findings.verdict_path ? [`Verdict file: ${findings.verdict_path}`] : []),
        // A fix that became a constraint is not repeated on its finding.
        ...findingLines(structured.map((entry) => moved.includes(entry) ? { ...entry, fix: undefined } : entry), "blocking"),
        ...(structured.some((entry) => entry.severity === "nit") ? ["Optional nits:", ...findingLines(structured, "nit")] : []),
      ] : verdictPreview(findings)),
      ...(specWriter && sharedReview ? ["This review covers several branches and waves. Fix only the docs findings your mission assigns to this wave; leave the others to their owners and do not list them as disputed."] : []),
      ...(findings.recommendation ? [`Recommendation: ${clip(findings.recommendation, 600)}`] : []),
      ...(evidence ? ["Verify each finding first; list one that does not hold under `## Disputed findings` with evidence. An `[AMBIGUOUS: …]` item is a question for Chief."] : [
        "First verify each finding against the code and the brief. Fix every blocking finding that holds.",
        "Do not apply a finding that is wrong, or that contradicts the brief or plan. List it in your ready result under `## Disputed findings`, with evidence: file:line, command output, or the brief or plan text it contradicts.",
        "Nits are optional: fix one only when it is trivial and inside this task's scope.",
        "An `[AMBIGUOUS: …]` item is a question for Chief, not a finding to fix.",
      ]),
    ] : []),
    ...(ruledOut.length ? [
      "", "## Already ruled out",
      ...ruledOut.map((entry) => `- [${entry.scope}] ${entry.text} (basis: ${entry.basis})`),
      "Do not retry these unless you have new evidence; say why if you do.",
    ] : []),
    ...(wave !== undefined && waveTotal !== undefined ? [
      "", "## Wave",
      specWriter
        ? `Wave ${wave} of ${waveTotal}: ${side ? `you run in parallel with its worker, in your own worktree on a side branch cut from ${branch}` : "its worker continues from your branch once you report ready"}. Your work is only its \`## Spec delta\` and the docs rules in the \`chief-role-spec-writer\` skill. Name "Wave ${wave} of ${waveTotal}" in your ready result.`
        : `Wave ${wave} of ${waveTotal}.${evidence ? "" : " Implement only this wave's plan file."} Name "Wave ${wave} of ${waveTotal}" in your ready result.`,
      waveNext !== null ? "No review runs after this wave." : "Chief starts the one review of the whole plan after every wave is ready. Never start or request a review yourself.",
      ...(stackBase ? [`This wave heads its own chain, stacked on ${stackBase}: its branch and PR are based on ${stackBase}; do not rebase onto the default branch.`] : waveIndependent ? ["This wave heads its own chain: it has its own branch, PR and worktree from the default base; do not build on another chain's branch."] : []),
      ...(implementsDesign !== null ? [`This wave implements the artboards that wave ${implementsDesign} drew and the owner approved. Read them through the design tool's MCP (read-only; never edit the design) and match them; the artboard names are in your mission or wave ${implementsDesign}'s report.`] : []),
      ...(designWave ? ["This is a design-only wave: the next wave implements it once the owner approves your artboards."] : []),
    ] : []),
    ...(specSources.length && specWriter ? [
      "", "## Read-only context",
      "Read each plan file in full; the implementation wave's `## Spec delta` is your work list. The contracts below are your wave's; they belong to the worker and the tester: never write code or tests for them.",
      ...specSources,
    ] : specSources.length && !evidence ? [
      "", "## Source of truth for test cases",
      "Read each in full, with the docs they name. Derive every test case from these, never from the implementation.",
      ...specSources,
    ] : []),
    ...(docsSection?.lines ?? []),
    ...((specDocs.length || specWave) && !specWriter && !evidence ? [
      "", "## Spec",
      tester
        ? "The committed docs are the source of truth. Read each Spec Writer report below (`bb chief inspect <id>`), docs/INDEX.md and the specs those reports changed. Derive tests from those docs and the plan contracts, not from the code."
        : specWave
          ? "The plan file is your source of truth. Pre-plan specs may be stale for the domains this wave touches: where they conflict with the plan, follow the plan and name the conflict in your report. A Spec Writer records this change in docs/ in parallel: do not wait for it and do not implement against its docs."
          : "Read each Spec Writer report below (`bb chief inspect <id>`), docs/INDEX.md and the specs those reports changed, and implement to match them.",
      ...specDocs,
      ...(tester ? [
        "- Before you derive tests, for each Spec Writer listed above run `git merge-base --is-ancestor <Fold head> HEAD`, using the Fold head from that writer's report. If it fails, report blocked: that writer's docs are not in your HEAD. A report with no Fold head (an implementation-lane writer) needs no check.",
        "- Code that contradicts the docs is product code that is wrong: follow the product-code rule in `## Test work`. Docs that are wrong: report blocked and recommend `chief_delegate (replaces: <your thread id>, kind: spec-writer)`.",
        ...(baseline ? ["- A new spec's baseline (the current behaviour a Spec Writer documented, listed in its report) is a source for regression tests, the same as the Spec delta's contracts. When the Spec delta changes a baseline statement, test only the delta's value. Behaviour under a Spec Writer's Open questions is not a contract."] : []),
      ] : [
        specWave
          ? "- If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan."
          : "- If the spec is wrong, report blocked and recommend `chief_delegate (replaces: <your thread id>, kind: spec-writer)`. If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan.",
        "- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start and as `Head commit: <sha>` when you report.",
      ]),
    ] : []),
    ...(contracts && !specWriter && !evidence ? [
      "", "## Contracts to verify",
      `Read the \`## Contracts to verify\` section of your plan file (${planContextLine}) in full: it is your checklist. Keep every item. Your ready result confirms each one with its evidence (test, command or file:line); the reviewer checks the same list.`,
    ] : []),
    ...(verifyCommand !== null && !specWriter && !evidence ? [
      "", "## Verify command",
      ...fenced(verifyCommand),
      ...(tester ? [
        "Run this exact command after your last commit and list it with its exit status under Automated Verification. Never change product code to make it pass. A failure at your Base commit is present before your test edits, not proof it predates the feature. List it without changing product code. It does not waive an explicit exit-0 receipt. Any other failure in product code follows the product-code rule in `## Test work`. If this command runs the whole test suite, run it only when your mission or your plan file's `## Contracts to verify` asks for a full-suite run; otherwise list it as \"not run: full suite not asked for\".",
      ] : [
        "Run this exact command in your worktree after your last commit and before reporting ready. Fix the work until it exits 0, then list it with its exit status under Automated Verification. No one reruns it; your recorded run is the evidence. If it cannot exit 0 for a reason outside this task (a missing tool, a failure already on the base), report blocked with its output instead of ready.",
        "If this command runs any test, do not run it or change code to make it pass: list it as \"not run: runs tests (a tester's)\" under Automated Verification and still run lint/analyze and build.",
      ]),
      ...(heavyPath ? [
        "Run it once through the slot wrapper; that run counts as running this exact command. Pool: sim if it boots or drives a simulator, emulator or device; test if it runs tests; else build:",
        ...fenced(`bash ${quote(heavyPath)} <pool> -- sh -c ${quote(verifyCommand)}`),
      ] : []),
    ] : []),
    ...(heavyPath && !specWriter ? [
      "", "## Heavy commands",
      `Slot wrapper: ${span(`bash ${quote(heavyPath)} <sim|test|build> -- <command>`)}. Run every build and test command through it in the foreground, choosing the pool as your role skill says.`,
    ] : []),
    ...(evidence ? (branch ? ["", "## Git workflow", `Before you read any file, on a clean tree run \`git fetch origin ${branch}\` then \`git merge --ff-only origin/${branch}\`; if either fails, report blocked.`] : []) : branch || issueUrl || prUrl ? [
      "", "## Git workflow",
      ...(side ? [`Side branch cut from ${branch}: commit only docs/ on it and push only through the \`## Fold\` steps.`]
        : branch ? [`Task branch: ${branch}. After loading your skills and before any other file read, sync and record \`${tester ? "Base commit" : "Local sync"}: <sha>\`; push every commit with \`git push origin HEAD:${branch}\`; follow the git workflow in your loaded skills.`] : []),
      ...(prior ? [`${side
        ? `Your worktree is fresh from ${branch}; it does not hold the previous Spec Writer's (${prior.thread_id}) commits. Write the Spec delta again on the current docs of ${branch}; never cherry-pick or merge the previous writer's commits.`
        : `This worktree already holds the previous worker's changes (${prior.thread_id}); continue from them.`}${prior.result ? "" : ` Its last report: bb chief inspect ${prior.thread_id}`}`] : []),
      ...(issueUrl ? [`Tracking issue: ${issueUrl}`] : []),
      ...(prUrl ? [`Draft pull request: ${prUrl}`] : []),
    ] : []),
    ...(side ? [
      "", "## Fold",
      `Fold your docs/ commits onto ${branch}: follow section 10 (Fold) of the \`chief-role-spec-writer\` skill with <branch> = ${branch}, and record Fold base and Fold head.`,
    ] : []),
    ...(prior?.result ? [
      "", "## Predecessor's last report",
      ...(tester && !evidence ? ((text) => {
        const sha = (label: string) => text.match(new RegExp(`${label}:\\s*\`?([0-9a-f]{7,40})`))?.[1];
        const head = sha("Head commit");
        const base = sha("Base commit");
        return [head
          ? `Head commit: ${head}.${base ? ` Changed files: \`git diff --name-only ${base}..${head}\`.` : ""}`
          : "Its report names no Head commit: read the full report."];
      })([prior.result, prior.blocker, prior.summary].filter(Boolean).join("\n")) : [
        evidence ? prior.report_path ?? `bb chief inspect ${prior.thread_id}` : prior.summary ?? clip(prior.result, 1_500),
        ...(prior.blocker ? [`Blocker: ${clip(prior.blocker, 600)}`] : []),
        ...(!evidence && prior.recommendation ? [`Recommendation: ${clip(prior.recommendation, 600)}`] : []),
      ]),
      ...(!evidence && prior.report_path ? [`Full report: ${prior.report_path}`] : []),
    ] : []),
    ...(tester && receipt ? [
      "", `## Prior receipt (${receipt.tester.thread_id})`,
      ...(receipt.receipt ? [
        receipt.receipt.text,
        evidence
          ? "Its commands are your commands and its Tested commit is Last tested, unless your mission names others."
          : "Reuse it: rerun the commands the change affects; do not rediscover commands or coverage it already names.",
      ] : [`${receipt.tester.thread_id}'s report has no complete receipt: ${receipt.tester.report_path ?? `bb chief inspect ${receipt.tester.thread_id}`}. Do not run partial commands from it.`]),
    ] : []),
    ...(evidence ? [
      "", "## Evidence work",
      "- This brief overrides the `chief-role-tester` skill: write no tests. Run only the commands your mission names, else the commands of a complete `## Prior receipt`, in this worktree. Commit nothing, push nothing, edit no tracked file; never use stash, autostash or another worktree. Chief owns the forge.",
      "- Record `git rev-parse HEAD` as `Head commit: <sha>` before any run.",
      "- Base runs: `git switch --detach <base>` on a clean tree; afterwards `git switch -` and check HEAD equals Head commit. After each switch, reinstall dependencies if the lockfile differs, and reset any database or state the suites write.",
      "- You need: `Expected head: <sha>` in your mission; `Last tested` (mission, else the receipt's Tested commit); and for each command its cwd, the exact command and the required exit status (mission, else a complete receipt). If any is missing, report blocked and recommend `chief_delegate (replaces: <your thread id>, kind: tester)` without evidenceOnly. Never report ready without them.",
      "- After the sync, HEAD must equal Expected head; otherwise report blocked naming both commits. Do not compare against the predecessor's commits.",
      "- If the fix needs a new or changed test (a finding asks for one, the receipt's Coverage lacks the fixed behaviour, or a test asserts the old behaviour), report blocked with the same normal-mode recommendation.",
      "- Run each command alone as `<cmd> > \"$BB_THREAD_STORAGE/<name>.log\" 2>&1; echo exit=$?`, then `tail -n 80` the log; read more only when the tail does not show the failure. Record per-file pass counts.",
      "- Ready: per command, base and head side by side (commit, exit status, pass counts); explain every difference, since an unexplained one is a regression. Before you report, HEAD equals Head commit and `git status --porcelain` prints nothing.",
      "- Blocked: name the command, its exit status and an output excerpt; recommend `chief_delegate (replaces: <your thread id>, kind: tester)` for a wrong test, `kind: worker` for product code.",
      "- Your ready result ends with `## Receipt` in the `chief-role-tester` skill format: Coverage and Gaps carried from the prior receipt, Tested commit = Expected head, commands and results updated.",
    ] : []),
    "", "## Working contract",
    ...(evidence ? [
      ...(findings?.result && findings.verdict_path ? ["- Read the verdict file in full."] : []),
      "- Report with chief_report: state ready and a `result` listing each command, its commit and exit status under Automated Verification, and under Manual what only a human can confirm; also a `summary` of at most 800 characters. Only Chief can mark it complete.",
      ...(planContextLine !== undefined ? [deviationsLine] : []),
      "- A blocked report must include the blocker and your recommended decision or next action.",
    ] : [
      loadLine(managedSkills("worker", kind), side ? ", git workflow and fold steps" : " and git workflow"),
      tester
        ? "- Change only test files, fixtures, helpers and test config; never product code or docs/."
        : specWriter
          ? "- Change only files under docs/; every commit carries the trailer Chief-Spec-Writer: $BB_THREAD_ID."
          : "- Never write, edit or run tests, and never change docs/: list a docs need under \"## Docs needed\".",
      ...(planContextLine !== undefined ? [deviationsLine] : []),
    ]),
    "- Do not ask the user directly from this thread. Chief decides whether a question needs escalation.",
    ...(kind === "designer" ? [
      "", "## Design work",
      "- Pick the mode the brief describes; if it describes none, use No spec. Design tool: create or edit in a design tool (Paper, Figma, or similar). Design in code: implement a design-tool artboard in the UI files the brief names. No spec: decide and implement the look within the project's existing design system, in the UI files the brief names or, when it names none, the files that render that UI.",
      "- Design tool and design in code use the tool's MCP. If that tool is not connected here, report blocked naming the missing tool. Before any other call to it, load its guide (Paper: `get_guide({ topic: \"paper-mcp-instructions\" })`) and follow it.",
      "- Design tool: after each meaningful change, verify it with the tool's screenshot (Paper: `get_screenshot`), and when done creating or editing call its finish call (Paper: `finish_working_on_nodes`). Design tool work changes no code or files unless the brief names them.",
      "- Design in code: read the artboard through the tool's MCP (read-only; do not edit the design), edit only the UI files the brief names, then compare a simulator or browser screenshot of the running app with the artboard's screenshot. Never write golden or screenshot tests; a tester does.",
      "- No spec: capture a simulator or browser screenshot of the running app.",
      "- In your ready result, put screenshot evidence under Automated: for each PNG, the command or tool call that produced it, its exit status when it has one, and the PNG path. For design in code, also list the differences that remain against the artboard. Taste and brand fit go under Manual.",
      "- Design in code or No spec: if you cannot run the app to capture a screenshot, report blocked naming what is missing; do not add screenshot tooling yourself.",
      "- In your report prose, name design nodes by layer name, never by raw node ID.",
      ...(designWave ? ["- Design-only wave: use Design tool mode. Draw or edit the artboards only; write no app code and change no repo files. In your ready result, list each artboard by layer name with its screenshot path so the owner can approve it."] : []),
    ] : []),
    ...(tester && !evidence ? [
      "", "## Test work",
      "- Follow the `chief-role-tester` skill: it is your testing policy and wins over the shared skill's verification lines.",
      "- Change only test files, fixtures, test helpers and test config; never product code.",
      ...(branch === undefined ? ["- When you start, record `git rev-parse HEAD` as `Base commit: <sha>` in your report."] : []),
      "- Ready: tests committed and pushed; Automated Verification lists each filtered test command with its exit status and maps each test to the contract it proves.",
      `- Blocked when a test fails because product code is wrong: commit and push the tests, name the failing tests, the filtered command, its exit status and an output excerpt, and recommend \`chief_delegate (replaces: <your thread id>, kind: worker)\` with the failures as its mission.`,
      "- When you report, record `git rev-parse HEAD` as `Head commit: <sha>`.",
    ] : []),
    ...(specWriter ? [
      "", "## Spec work",
      "- Follow the `chief-role-spec-writer` skill.",
      "- Planned: the wave's `## Spec delta` is your work list. Unplanned: Chief's mission is your Spec delta; it names the docs and domains to change.",
      "- Inputs: the plan file, docs/INDEX.md first, then only the specs the delta names and the decisions they link. Read code only to check a name or path the delta states; a gap goes under `## Open questions`.",
      ...(baseline ? ["- Baseline: this wave's plan has a `## Spec baseline` heading. It names each new docs/specs file and the code paths it covers. For each named file that does not exist at your Base commit, first document the current behaviour of that code as the `chief-role-spec-writer` skill's baseline section says, then apply the Spec delta. Behaviour that looks like a bug goes under `## Open questions` in your report, never into the docs as a contract."] : []),
      ...(prior && !isWriter(prior.kind) ? [`- Repair: Chief's mission is the docs fix. Read the report of the ${prior.kind ?? "worker"} you replace: bb chief inspect ${prior.thread_id}.`] : []),
      "- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start and as `Head commit: <sha>` when you report.",
      side
        ? "- Ready: docs committed and folded onto the branch. A delta item the docs already reflect needs no commit: say so, and record `Fold: none`. Automated Verification: the `git diff --name-only $U..HEAD` of Fold step 4 showing only `docs/` paths, with exit status; `wc -l`"
          + " of each new or changed decision file (20 lines or fewer); each kept STE exception (file, sentence, reason). List any Verify command as \"not run: docs-only change\"."
        : "- Ready: docs committed and pushed. A delta item the docs already reflect needs no commit: say so. Automated Verification: `git diff --name-only <base>..HEAD` showing only `docs/` paths, with exit status; `wc -l` of each new or changed decision file (20 lines or fewer); each kept STE exception (file, sentence, reason). List any Verify command as \"not run: docs-only change\".",
      "- Blocked when the Spec delta contradicts the plan or cannot be written: recommend a fresh chief_plan with this report in context. Never recommend kind: worker.",
    ] : []),
  ].join("\n");
  return { prompt, brief, reviewerBrief, docsWorkFile: docsSection?.file };
}

const branchLine = (branch: string) => `Your worktree is based on branch ${branch} (an open branch, not the project default). Read and plan against it.`;

export type PlannerBriefInput = {
  title: string; chiefThreadId: string; mission: string; context?: string;
  /** An open branch the planner's worktree is based on; chain heads of its plan stack on it. */
  branch?: string;
  /** Set for chief_plan revises: the plan its one advisor review sent back, and that advice. */
  revision?: {
    plannerThreadId: string;
    planPaths: string[];
    advisorThreadId: string;
    advisorReportPath: string | null;
    advisorSummary: string | null;
    blocker?: string | null;
    recommendation?: string | null;
  };
};

/** A planner's prompt: the problem and the plan contract. */
export function plannerBrief(input: PlannerBriefInput): string {
  const { title, chiefThreadId, mission, context, revision, branch } = input;
  return [
    `You are the managed planner for “${title}”. Report to Chief thread ${chiefThreadId}.`,
    ...(branch ? [branchLine(branch), `Chain heads of this plan stack on ${branch}: chief_forge_init bases their branches and pull requests on it.`] : []),
    "", "## Problem", mission,
    ...(context ? ["", "## Context", context] : []),
    ...(revision ? [
      "", "## Plan to revise",
      `Planner ${revision.plannerThreadId} wrote this plan and its one advisor review (${revision.advisorThreadId}) sent it back. Read every plan file and the advisor's report in full:`,
      ...revision.planPaths.map((path) => `- ${path}`),
      ...(revision.advisorReportPath ? [`- Advisor report: ${revision.advisorReportPath}`] : []),
      ...(revision.advisorSummary && !revision.advisorReportPath ? [`Advisor summary: ${revision.advisorSummary}`] : []),
      ...(revision.blocker ? [`The advisor reported blocked: ${revision.blocker}`, `Its recommendation: ${revision.recommendation ?? ""}`] : []),
      "- Keep the parts no finding touches. Fix every blocking finding.",
      "- List each finding you reject under a `## Disputed findings` heading, with your evidence.",
      "- If the advisor named a decision, resolve it from the context above, or report blocked with it.",
      "- Do not set `complex`: your plan goes straight to delegation with no second review.",
    ] : []),
    "", "## Working contract",
    loadLine(managedSkills("planner", undefined)),
    `- Remain read-only: ${READ_ONLY}.`,
    `- Split the work into at most ${MAX_WAVES} waves.`,
  ].join("\n");
}

export type AdvisorBriefInput = {
  title: string;
  chiefThreadId: string;
  mission: string;
  context?: string;
  /** The consulted worker and the reviewer verdicts on its task, or undefined for a consult with no worker. */
  worker?: VerdictRow & {
    brief: string | null;
    branch: string | null;
    pr_url: string | null;
    result: string | null;
    summary: string | null;
    report_path: string | null;
  };
  reviews: VerdictRow[];
  /** An open branch a no-worker or plan consult's worktree is based on. */
  branch?: string;
  /** Set for a plan review (chief_consult planThreadId): the planner, its plan files, result and report. */
  plan?: { plannerThreadId: string; paths: string[]; summary: string | null; reportPath: string | null };
};

/** An advisor's prompt: the question, and with a worker its brief, verdicts, branch and report. */
export function advisorBrief(input: AdvisorBriefInput): string {
  const { title, chiefThreadId, mission, context, worker, reviews, plan, branch } = input;
  return [
    `You are the managed advisor for “${title}”. Report to Chief thread ${chiefThreadId}.`,
    ...(branch ? [branchLine(branch)] : []),
    "You are a strategic advisor and debugger of last resort: find the root cause and the smallest credible way forward.",
    "", "## Question", mission,
    ...(context ? ["", "## Context", context] : []),
    ...(worker ? [
      ...(worker.brief ? [
        "", "## The brief this work was given", clipMiddle(worker.brief, 4_000),
      ] : []),
      ...(reviews.length ? [
        "", "## Reviewer verdicts",
        ...reviews.flatMap((review) => [
          ...verdictPreview(review, ` (${review.thread_id})`),
        ]),
      ] : []),
      "", "## Branch and diff",
      `Branch: ${worker.branch ?? "the project default base"}`,
      ...(worker.pr_url ? [`Pull request: ${worker.pr_url}`] : []),
      "This worktree holds the change: read it with git diff against its base.",
      ...(worker.result ? [
        worker.summary ?? clip(worker.result, 300),
        ...(worker.report_path ? [`Full report: ${worker.report_path}`] : []),
        `Full report and last output: bb chief inspect ${worker.thread_id}`,
      ] : []),
    ] : []),
    ...(plan ? [
      "", "## Plan to review",
      `Planner ${plan.plannerThreadId} wrote this plan. Read every plan file:`,
      ...plan.paths.map((path) => `- ${path}`),
      `Planner report: ${plan.reportPath ?? `bb chief inspect ${plan.plannerThreadId}`}`,
      "", "## Plan-review checklist",
      "- Wrong or missing files and callers.",
      "- An unsound wave split or `dependsOn`.",
      "- Contracts that are not falsifiable.",
      "- Contracts a reviewer cannot check at the pinned commit: `<…>` placeholders, worker-process facts, or commands that need another repository's checkout.",
      "- Missing Automated or Manual Verification.",
      "- A missing `## What we're NOT doing` heading.",
      "- Scope drift from the mission.",
      "- Migration or compatibility risk.",
      "- State transitions that are not total.",
      "- A test wave, test criteria, a full-suite run, or test work inside an implementation wave: the tester runs once in the review gate.",
      "- UI whose look no approved design or explicit visual spec fixes with no `design: true` wave before the wave that builds it, or app code inside a design wave.",
      "- A big feature (3+ modules or 10+ files of new behaviour) whose chain does not end with a reshape wave, a reshape wave on a bug fix, refactor or smaller change, or a reshape wave that writes or runs tests.",
      "- A chain that changes documented behaviour with no `spec: true` implementation wave, or a `## Spec delta` that names no docs file or restates test cases.",
    ] : []),
    "", "## Working contract",
    `- ${ADVISE_ONLY}`,
    "- Read every file this brief names in full before concluding anything: no partial reads, no limit or offset.",
    plan
      ? "- Verify each claim against the code; run read-only commands only and report each exit status."
      : "- Reproduce before concluding: run the failing test or command, and quote the command and its exit status.",
    ...(plan ? ["- Report ready with verdict: approve when the plan can be delegated as is (nits go in result); request_changes only for blocking problems, each with a concrete fix. Report blocked only for a product decision the owner must make; that also counts as the plan's one review. There is one review round: the planner revises once and nobody re-reviews."] : []),
    "- A ready report gives the root cause, the evidence, what earlier rounds missed, and the recommended next step for a fresh worker. Put the full advice in `result` and a short `summary` (at most 800 characters: root cause, recommended fix, evidence command).",
    "- A blocked report must include the blocker and your recommended decision or next action.",
    ...(worker ? ["- If the repeated rejections come from a project-level rule a future worker should know (not a task-specific bug), set `lesson`: one sentence, at most 400 characters. Otherwise omit it."] : []),
    "- Do not ask the user directly from this thread. Chief decides whether a question needs escalation.",
  ].join("\n");
}

/** The review gate's tester: one tester per gate, in parallel with its reviewer, over every pinned target. Pure. */
export function gateTesterBrief(input: {
  title: string; chiefThreadId: string | null; gateKey: string;
  targets: { threadId: string; branch: string; prUrl: string | null; headSha: string; base: string }[];
  planFiles: string[]; writers: { threadId: string; reportPath: string | null }[];
  verifyCommand: string | null; heavyPath: string | null;
}): string {
  const { targets, heavyPath } = input;
  return [
    `You are the review gate's tester for “${input.title}” (gate ${input.gateKey}). Report to Chief thread ${input.chiefThreadId ?? "Chief"}.`,
    "", "## Working contract",
    loadLine(managedSkills("worker", "tester")),
    "- You run in parallel with the gate's reviewer. Never wait for it, address it, or read its verdict.",
    "- Never change product code or docs/. Only tests, fixtures, test helpers and test config.",
    "", "## Gate targets",
    ...targets.map((target) => `- ${target.threadId}: branch ${target.branch}${target.prUrl ? `, ${target.prUrl}` : ""}, pinned ${target.headSha}, base ${target.base}`),
    "", "## Test scope",
    "- Read `git diff origin/<base>...<pinned sha>` for each target, the plan files, the docs the Spec Writers changed, and the repository's test rules. Decide which tests to write and at which level.",
    ...(input.planFiles.length ? [`- Plan files: ${input.planFiles.join(", ")}`] : []),
    ...input.writers.map((writer) => `- Spec Writer ${writer.threadId}${writer.reportPath ? `: report ${writer.reportPath}` : ""}`),
    "- Per branch: `git fetch origin && git checkout --detach origin/<branch>`, write the tests, run them filtered, commit, then `git push origin HEAD:<branch>`. Never force-push. When a push is rejected, run `git fetch origin && git rebase origin/<branch>` once and push again; if it is rejected again, report blocked.",
    "- When targets stack on each other, put the tests on the stack's tip branch only.",
    "- Run the full suite once on each branch head you pushed.",
    ...(input.verifyCommand ? [`- Verify command: ${span(input.verifyCommand)}.`] : []),
    ...(heavyPath ? [`- Slot wrapper: ${span(`bash ${quote(heavyPath)} <sim|test|build> -- <command>`)}. Run every build and test command through it in the foreground.`] : []),
    "", "## Report",
    "- Report ready with `testsPassed` (true only when every test you ran passed) and a `## Failing tests` section: per failure the test file:line, the command, its exit status, an output excerpt and the product file:line behind it.",
    ...(input.planFiles.length ? [deviationsLine] : []),
    "- Report blocked only for an environment problem, with your recommended next action.",
  ].join("\n");
}

/** A code span that keeps the shell text literal. */
const span = (text: string) => ((ticks) => `${ticks} ${text} ${ticks}`)("`".repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1))));
