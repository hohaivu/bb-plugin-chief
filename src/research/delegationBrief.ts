import { MAX_WAVES, findingLines } from "../report/reportIntake";
import { type WorkerKind } from "../core/roles";
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
  kind: "designer" | "spec-writer" | null;
  /** The brief the worker was given: an unplanned Spec Writer's source of truth is its chain head's. */
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
  /** A Spec Writer's source lines (plan files, contracts, approved design, or the head worker's brief); [] otherwise. */
  specSources: string[];
  /** On a spec-bearing chain: one line per Spec Writer whose docs a product worker or designer follows; [] or absent otherwise. */
  specDocs?: string[];
  /** Spec Writer: its own wave has a `## Spec baseline` before that wave's worker ran. Optional: older callers omit it. */
  baseline?: boolean;
  /** A worker or designer on a spec wave: it builds from the plan alone; the plan's Spec Writer records the docs after the last wave. Optional: older callers omit it. */
  specWave?: boolean;
  /** side: a Spec Writer in its own side worktree, folding docs/ onto the chain branch. Absent or implementation: every other row. */
  lane?: "side" | "implementation";
  /** Same-plan side-lane Spec Writer repair: every known docs item of its owned waves and the prior blocker, each with its source thread id. Optional: empty or absent renders nothing. */
  docsWork?: DocsWorkItem[];
  /** The replaced worker's open review covers more than one target, so its findings are not all this thread's. */
  sharedReview?: boolean;
  /** The published slot wrapper's path; set, every kind but a Spec Writer gets `## Heavy commands`. Optional: older callers omit it. */
  heavyPath?: string | null;
  /** A fix run: the gate's evidence for a gate fix; a chat fix replays none. Absent on every other delegation. */
  fixRun?: FixRunInput;
};

export type FixRunInput =
  | { run: "chat"; branch: string | null }
  | {
    run: "gate";
    targets: { threadId: string; branch: string; prUrl: string | null; headSha: string }[];
    reviewer: { threadId: string; verdict: string | null; verdictPath: string | null; findings: Finding[] } | null;
  };

/** The `## Fix run` section: the evidence, the rules and the report contract of a gate fix or a chat fix. */
function fixRunLines(fix: FixRunInput, heavy: string): string[] {
  const report = "Report ready only when every test command you ran, lint, build and the Verify command exited 0, each listed with its exit status under Automated Verification.";
  if (fix.run === "chat") {
    return [
      "", "## Fix run",
      "You continue completed work on its unmerged pull request; your mission is the change the user asked for in chat. No review follows: your ready run completes it.",
      `- Before editing, on a clean tree run \`git fetch origin && git merge --ff-only origin/${fix.branch ?? "<branch>"}\`; if it fails, report blocked.`,
      `- Commit, then \`git push origin HEAD:${fix.branch ?? "<branch>"}\`. Run the tests of the files you touched${heavy}, then lint, build and the Verify command.`,
      `- ${report}`,
    ];
  }
  const targets = fix.targets.map((target) => `- ${target.threadId}: branch ${target.branch}${target.prUrl ? `, ${target.prUrl}` : ""}, pinned ${target.headSha}`);
  const evidence = fix.reviewer ? [
    `Reviewer ${fix.reviewer.threadId}: ${fix.reviewer.verdict ?? "no verdict"}${fix.reviewer.verdictPath ? `; verdict file: ${fix.reviewer.verdictPath} (read it in full)` : ""}.`,
    ...findingLines(fix.reviewer.findings.filter((entry) => !entry.file.startsWith("docs/")), "blocking"),
  ] : [];
  return [
    "", "## Fix run",
    "You are the review gate's one fix run. There is no second fix. The gate passes on your ready report; any re-review is advisory.",
    "### Gate targets", ...targets, ...evidence,
    "- Verify each code finding against the code and the plan; fix every blocking one that holds. List a finding that does not hold under `## Disputed findings` with evidence.",
    `- Per branch: \`git fetch origin && git checkout --detach origin/<branch>\`, commit, \`git push origin HEAD:<branch>\` (stacked targets: the tip branch only).`,
    `- Run the tests of the files you touched${heavy} until each exits 0, then lint, build and the Verify command.`,
    `- ${report}`,
  ];
}

const deviationsLine = "- Your ready result must contain a `## Deviations from plan` heading listing each place you departed from the plan file and why, or `None`.";

const DOCS_WORK_MAX = 4_000;
/** The file name, under the repair's own thread storage, that holds the full work list when the section cannot name every omitted id. */
export const DOCS_WORK_FILE = "docs-work.md";

/** One docs item of the repair's work list, with where it came from: a worker or designer `## Docs needed`, or the prior writer's blocker. */
export type DocsWorkItem = { id: string; kind: string; wave: number | null; blocker?: boolean; text: string };

/** The repair's docs work list. The section is at most DOCS_WORK_MAX characters. It shows the longest prefix of whole items (possibly none)
 * that leaves room for the exact omitted count and every omitted source id. Only when no prefix fits with the ids does the overflow line
 * point to `file`, the full list written to the repair's thread storage; `file` is then that text. */
function docsWorkSection(wave: number | undefined, items: DocsWorkItem[]): { lines: string[]; file?: string } {
  const heading = `## Docs work list (wave ${wave})`;
  const closing = "Fix every item that still holds, together with the Spec delta and the docs findings your mission assigns, then fold once (the Fold steps in your rules). List an item already true in the docs at your HEAD under `## Already done`, and one that does not hold under `## Disputed findings`.";
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
    kind, verifyCommand, branch, issueUrl, prUrl, prior, findings, structured, ruledOut, specSources, specDocs = [], baseline = false, specWave = false, lane = "implementation", docsWork, sharedReview = false, heavyPath = null, fixRun } = input;
  const specWriter = isWriter(kind);
  const docsSection = specWriter && docsWork?.length ? docsWorkSection(wave, docsWork) : undefined;
  const side = specWriter && lane === "side" && branch !== undefined;
  const context = [params.context, planContextLine].filter((value): value is string => Boolean(value)).join("\n\n") || undefined;
  const render = (mission: string, contextText?: string) => [
    "## Mission", mission,
    "", "## Success criteria", bullets(params.successCriteria),
    "", "## Constraints", bullets(params.constraints),
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
    `You are the managed worker for “${title}”. Report to Chief thread ${chiefThreadId}.`,
    "", brief,
    ...(findings?.result ? [
      "", `## Review findings to fix (${findings.thread_id})`,
      ...(structured ? [
        ...(findings.verdict_path ? [`Verdict file: ${findings.verdict_path}`] : []),
        ...findingLines(structured, "blocking"),
        ...(structured.some((entry) => entry.severity === "nit") ? ["Optional nits:", ...findingLines(structured, "nit")] : []),
      ] : verdictPreview(findings)),
      ...(specWriter && sharedReview ? ["This review covers several branches and waves. Fix only the docs findings your mission assigns to this wave; leave the others to their owners and do not list them as disputed."] : []),
      ...(findings.recommendation ? [`Recommendation: ${clip(findings.recommendation, 600)}`] : []),
      "First verify each finding against the code and the brief. Fix every blocking finding that holds.",
      "Do not apply a finding that is wrong, or that contradicts the brief or plan. List it in your ready result under `## Disputed findings`, with evidence: file:line, command output, or the brief or plan text it contradicts.",
      "Nits are optional: fix one only when it is trivial and inside this task's scope.",
      "An `[AMBIGUOUS: …]` item is a question for Chief, not a finding to fix.",
    ] : []),
    ...(fixRun ? fixRunLines(fixRun, heavyPath ? " through the slot wrapper, pool `test`" : "") : []),
    ...(ruledOut.length ? [
      "", "## Already ruled out",
      ...ruledOut.map((entry) => `- [${entry.scope}] ${entry.text} (basis: ${entry.basis})`),
      "Do not retry these unless you have new evidence; say why if you do.",
    ] : []),
    ...(wave !== undefined && waveTotal !== undefined ? [
      "", "## Wave",
      specWriter
        ? `Wave ${wave} of ${waveTotal}: ${side ? `you are the plan's one Spec Writer. You run after every wave of the plan is ready, in your own worktree on a side branch cut from ${branch}. Your work is the \`## Spec delta\` of every spec: true wave in the plan files below, the docs work list when present, and your Spec Writer rules.` : "its worker continues from your branch once you report ready. Your work is only its `## Spec delta` and your Spec Writer rules."} Name "Wave ${wave} of ${waveTotal}" in your ready result.`
        : `Wave ${wave} of ${waveTotal}. Implement only this wave's plan file. Name "Wave ${wave} of ${waveTotal}" in your ready result.`,
      waveNext !== null ? "No review runs after this wave." : "Chief starts the one review of the whole plan after every wave is ready. Never start or request a review yourself.",
      ...(stackBase ? [`This wave heads its own chain, stacked on ${stackBase}: its branch and PR are based on ${stackBase}; do not rebase onto the default branch.`] : waveIndependent ? ["This wave heads its own chain: it has its own branch, PR and worktree from the default base; do not build on another chain's branch."] : []),
      ...(implementsDesign !== null ? [`This wave implements the artboards that wave ${implementsDesign} drew and the owner approved. Read them through the design tool's MCP (read-only; never edit the design) and match them; the artboard names are in your mission or wave ${implementsDesign}'s report.`] : []),
      ...(designWave ? ["This is a design-only wave: the next wave implements it once the owner approves your artboards."] : []),
    ] : []),
    ...(specSources.length && specWriter ? [
      "", "## Read-only context",
      side
        ? "Read each plan file in full; the `## Spec delta` of each spec: true wave is your work list. Each plan file's `## Contracts to verify` belongs to the worker: never write code or tests for them."
        : "Read each plan file in full; the implementation wave's `## Spec delta` is your work list. The contracts below are your wave's; they belong to the worker: never write code or tests for them.",
      ...specSources,
    ] : []),
    ...(docsSection?.lines ?? []),
    ...((specDocs.length || specWave) && !specWriter ? [
      "", "## Spec",
      specWave
        ? "The plan file is your source of truth. Pre-plan specs may be stale for the domains this wave touches: where they conflict with the plan, follow the plan and name the conflict in your report. A Spec Writer records this change in docs/ after the last wave of the plan is ready: do not wait for it and do not implement against its docs."
        : "Read each Spec Writer report below (`bb chief inspect <id>`), docs/INDEX.md and the specs those reports changed, and implement to match them.",
      ...specDocs,
        specWave
          ? "- If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan."
          : "- If the spec is wrong, report blocked and recommend `chief_delegate (replaces: <your thread id>, kind: spec-writer)`. If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan.",
        "- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start and as `Head commit: <sha>` when you report.",
    ] : []),
    ...(contracts && !specWriter ? [
      "", "## Contracts to verify",
      `Read the \`## Contracts to verify\` section of your plan file (${planContextLine}) in full: it is your checklist. Keep every item. Your ready result confirms each one with its evidence (test, command or file:line); the reviewer checks the same list.`,
    ] : []),
    ...(verifyCommand !== null && !specWriter ? [
      "", "## Verify command",
      ...fenced(verifyCommand),
      "Run this exact command in your worktree after your last commit and before reporting ready. Fix the work until it exits 0, then list it with its exit status under Automated Verification. No one reruns it; your recorded run is the evidence. If it cannot exit 0 for a reason outside this task (a missing tool, a failure already on the base), report blocked with its output instead of ready.",
      ...(heavyPath ? [
        "Run it once through the slot wrapper; that run counts as running this exact command. Pool: sim if it boots or drives a simulator, emulator or device; test if it runs tests; else build:",
        ...fenced(`bash ${quote(heavyPath)} <pool> -- sh -c ${quote(verifyCommand)}`),
      ] : []),
    ] : []),
    ...(heavyPath && !specWriter ? [
      "", "## Heavy commands",
      `Slot wrapper: ${span(`bash ${quote(heavyPath)} <sim|test|build> -- <command>`)}. Run every build and test command through it in the foreground, choosing the pool as your rules say.`,
    ] : []),
    ...(branch || issueUrl || prUrl ? [
      "", "## Git workflow",
      ...(side ? [`Side branch cut from ${branch}: commit only docs/ on it and push only through the \`## Fold\` steps.`]
        : branch ? [`Task branch: ${branch}. Before any file read, sync and record \`Local sync: <sha>\`; push every commit with \`git push origin HEAD:${branch}\`.`] : []),
      ...(prior ? [`${side
        ? `Your worktree is fresh from ${branch}; it does not hold the previous Spec Writer's (${prior.thread_id}) commits. Write the Spec delta again on the current docs of ${branch}; never cherry-pick or merge the previous writer's commits.`
        : `This worktree already holds the previous worker's changes (${prior.thread_id}); continue from them.`}${prior.result ? "" : ` Its last report: bb chief inspect ${prior.thread_id}`}`] : []),
      ...(issueUrl ? [`Tracking issue: ${issueUrl}`] : []),
      ...(prUrl ? [`Draft pull request: ${prUrl}`] : []),
    ] : []),
    ...(side ? [
      "", "## Fold",
      `Fold your docs/ commits onto ${branch}: follow the Fold steps in your rules with <branch> = ${branch}, and record Fold base and Fold head.`,
    ] : []),
    ...(prior?.result ? [
      "", "## Predecessor's last report",
      prior.summary ?? clip(prior.result, 1_500),
      ...(prior.blocker ? [`Blocker: ${clip(prior.blocker, 600)}`] : []),
      ...(prior.recommendation ? [`Recommendation: ${clip(prior.recommendation, 600)}`] : []),
      ...(prior.report_path ? [`Full report: ${prior.report_path}`] : []),
    ] : []),
    // Static rules are in the role's instructions; the Working contract holds only mode lines. An empty one goes.
    ...((contract) => contract.length ? ["", "## Working contract", ...contract] : [])([
      // A worker or designer gets the deviations rule in its instructions.
      ...(planContextLine !== undefined && specWriter ? [deviationsLine] : []),
    ]),
    ...(kind === "designer" ? [
      "", "## Design work",
      "- Pick the mode the brief describes; if it describes none, use No spec. Design tool: create or edit in a design tool (Paper, Figma, or similar). Design in code: implement a design-tool artboard in the UI files the brief names. No spec: decide and implement the look within the project's existing design system, in the UI files the brief names or, when it names none, the files that render that UI.",
      "- Design tool and design in code use the tool's MCP. If that tool is not connected here, report blocked naming the missing tool. Before any other call to it, load its guide (Paper: `get_guide({ topic: \"paper-mcp-instructions\" })`) and follow it.",
      "- Design tool: after each meaningful change, verify it with the tool's screenshot (Paper: `get_screenshot`), and when done creating or editing call its finish call (Paper: `finish_working_on_nodes`). Design tool work changes no code or files unless the brief names them.",
      "- Design in code: read the artboard through the tool's MCP (read-only; do not edit the design), edit only the UI files the brief names, then compare a simulator or browser screenshot of the running app with the artboard's screenshot. Never write golden or screenshot tests.",
      "- No spec: capture a simulator or browser screenshot of the running app.",
      "- In your ready result, put screenshot evidence under Automated: for each PNG, the command or tool call that produced it, its exit status when it has one, and the PNG path. For design in code, also list the differences that remain against the artboard. Taste and brand fit go under Manual.",
      "- Design in code or No spec: if you cannot run the app to capture a screenshot, report blocked naming what is missing; do not add screenshot tooling yourself.",
      "- In your report prose, name design nodes by layer name, never by raw node ID.",
      ...(designWave ? ["- Design-only wave: use Design tool mode. Draw or edit the artboards only; write no app code and change no repo files. In your ready result, list each artboard by layer name with its screenshot path so the owner can approve it."] : []),
    ] : []),
    ...(specWriter ? [
      "", "## Spec work",
      "- Planned: the `## Spec delta` of each spec: true wave is your work list. Unplanned: Chief's mission is your Spec delta; it names the docs and domains to change.",
      "- Inputs: the plan file, docs/INDEX.md first, then only the specs the delta names and the decisions they link. Read code only to check a name or path the delta states; a gap goes under `## Open questions`.",
      ...(baseline ? ["- Baseline: a spec wave's plan file has a `## Spec baseline` heading. It names each new docs/specs file and the code paths it covers. For each named file that does not exist at your Base commit, first document the current behaviour of that code as the Baseline steps in your rules say, then apply the Spec delta. Behaviour that looks like a bug goes under `## Open questions` in your report, never into the docs as a contract."] : []),
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
  /** The user-approved design snapshots (chief_plan researchThreadId, or inherited by a revision). */
  design?: { researcherThreadId: string; designPath: string; factsPath: string };
  /** Why this plan skipped the design discussion. */
  undesignedReason?: string;
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
  const { title, chiefThreadId, mission, context, revision, branch, design, undesignedReason } = input;
  const contextLines = [...(context ? [context] : []), ...(undesignedReason ? [`Design discussion skipped: ${undesignedReason}`] : [])];
  return [
    `You are the managed planner for “${title}”. Report to Chief thread ${chiefThreadId}.`,
    ...(branch ? [branchLine(branch), `Chain heads of this plan stack on ${branch}: chief_forge_init bases their branches and pull requests on it.`] : []),
    ...(design ? [
      "", "## Approved design",
      `The user approved this design in researcher ${design.researcherThreadId}. It is your brief; the title and mission only route the task. Read the design and the fact report in full. Its resolved decisions are settled: do not reopen them. Follow its patterns. Every wave that depends on a fact under the fact report's \`## Unconfirmed\` gets a \`## Depends on unconfirmed facts\` heading naming each fact.`,
      `- Design: ${design.designPath}`,
      `- Fact report: ${design.factsPath}`,
    ] : []),
    "", "## Problem", mission,
    ...(contextLines.length ? ["", "## Context", ...contextLines] : []),
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
    ] : []),
    "", "## Working contract",
    `- Split the work into at most ${MAX_WAVES} waves.`,
  ].join("\n");
}

export type AdvisorBriefInput = {
  title: string;
  chiefThreadId: string;
  mission: string;
  context?: string;
  /** An open branch the plan consult's worktree is based on. */
  branch?: string;
  /** The plan under review (chief_consult planThreadId): the planner, its plan files, result and report. */
  plan: { plannerThreadId: string; paths: string[]; summary: string | null; reportPath: string | null };
};

/** A plan advisor's prompt: the question, the plan files and the plan-review checklist. */
export function advisorBrief(input: AdvisorBriefInput): string {
  const { title, chiefThreadId, mission, context, plan, branch } = input;
  return [
    `You are the managed advisor for “${title}”. Report to Chief thread ${chiefThreadId}.`,
    ...(branch ? [branchLine(branch)] : []),
    "You are a strategic advisor and debugger of last resort: find the root cause and the smallest credible way forward.",
    "", "## Question", mission,
    ...(context ? ["", "## Context", context] : []),
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
    "- A test wave, or an implementation wave without its own tests or Verify command where its change needs them.",
    "- UI whose look no approved design or explicit visual spec fixes with no `design: true` wave before the wave that builds it, or app code inside a design wave.",
    "- A big feature (3+ modules or 10+ files of new behaviour) whose chain does not end with a reshape wave, a reshape wave on a bug fix, refactor or smaller change.",
    "- A chain that changes documented behaviour with no `spec: true` implementation wave, or a `## Spec delta` that names no docs file or restates test cases.",
  ].join("\n");
}

/** A code span that keeps the shell text literal. */
const span = (text: string) => ((ticks) => `${ticks} ${text} ${ticks}`)("`".repeat(Math.max(1, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1))));
