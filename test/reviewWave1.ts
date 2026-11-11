import { expect } from "vitest";
import { REVIEWER_NATIVE_LINE, replaceText, spliceAfter, REVIEWER_ANCHOR } from "./harness";

// Wave 1 of the reviewer-prompt plan edits the review prompt that 19babad rendered. Every oracle that compares a prompt against a base
// fixture applies exactly these named edits to the base text, each with an exact count; the new texts are copied from wave 1's plan
// (steps 2b, 3c, 5c, 6a-6c), the old texts from 19babad's source. No expected byte comes from the current implementation.

// Step 5c: the native line, split by `reshape`. `feature && reshape` is the base line, byte for byte.
export const NATIVE_RESHAPE_PAREN = " (a reshape wave's contracts do)";
export const NATIVE_RESHAPE_TAIL = " A reshape commit belongs to its feature: judge the feature and its reshape together as one feature against the plan's contracts, not the reshape commit as a refactor with the base commit as the oracle.";
/** `feature && !reshape`: the base line with exactly the two named removals. */
export const NATIVE_NO_RESHAPE_LINE = replaceText(replaceText(REVIEWER_NATIVE_LINE, NATIVE_RESHAPE_PAREN, "", 1), NATIVE_RESHAPE_TAIL, "", 1);

// Step 2a/2b: the `## Context` list and the wait rule go; one read line names the file.
export const CONTEXT_READ_OLD = "Read `$BB_THREAD_STORAGE/review-context.md` in full before reviewing. If it is missing, wait 10 seconds and read again; if still missing, report blocked naming it.";
export const contextReadNew = (path: string) => "Read `<contextPath>` in full before reviewing: it holds the reports, plan files and pointers this brief names.".replace("<contextPath>", path);
// Step 6b: the plan-file sentence leaves both inspect lines.
export const INSPECT_PLAN_SUFFIX = " When review-context.md lists plan files, read each in full before judging the change against it, including the worker's stated deviations and any unstated scope drift.";
// Step 5c: the test-audit rule renders only when `testAudit`; the do-not-report parenthesis follows it.
export const TEST_AUDIT_LINE = "Test audit: when the diff adds or changes tests, check that each would fail on a plausible wrong implementation (an off-by-one, a missed boundary, a swapped branch, a dropped case). A test that asserts a tautology, a trivial constant, or only what the mock returns proves nothing. Vacuous tests count as missing verification evidence for the behaviour they claim to cover.";
export const TEST_AUDIT_PAREN_WITH = "(the bug-fix regression check and the test audit still apply)";
export const TEST_AUDIT_PAREN_WITHOUT = "(the bug-fix regression check still applies)";
// Step 3c: the worker-reported rule follows the contract list's check line.
export const CONTRACT_CHECK_ANCHOR = "Check every item against ";
export const WORKER_REPORTED_RULE = "An item you cannot check at the pinned commit is worker-reported: an unresolved `<…>` placeholder you cannot resolve from the reports, a fact about the worker's process (its starting HEAD, its pushes, branches it did not create), or a command that needs another repository's checkout. Confirm it from the worker's report and mark it worker-reported. It is unmet only when the report or the code contradicts it, never only because you cannot check it.";
// Step 6a.
export const IMPACT_OLD = "Use the impact slice in review-context.md only as reference for contract mismatches (a callee's real signature or contract, a caller's expectations); report findings only on lines this diff introduced, never on slice lines.";
export const IMPACT_NEW = "Use the impact slice in review-context.md only as reference for contract mismatches (a callee's real signature or contract, a caller's expectations); never report a finding on a slice line.";
export const REREVIEW_OLD = "An earlier round already reviewed this change up to the previous reviewed head named above. Report findings only on lines the commits in that range add or change; earlier code is out of scope unless those commits make a problem in it reachable. Check the contract items those commits touch and every item the previous review found unmet.";
// The plan's new section text names "each pull request that names a range" and the no-range sentence; base's own `many` conditional keeps both off a single review.
const REREVIEW_PLAN_TEXT = "An earlier round already reviewed this change up to the previous reviewed head named above for each pull request that names a range. There, \"this diff\" in the evidence rules means the commits in that range: earlier code is out of scope unless those commits make a problem in it reachable. Check the contract items those commits touch and every item the previous review found unmet. A pull request with no range is reviewed whole against its base.";
export const REREVIEW_RANGE_PHRASE = " for each pull request that names a range";
export const REREVIEW_NO_RANGE_SENTENCE = " A pull request with no range is reviewed whole against its base.";
export const REREVIEW_NEW_SINGLE = replaceText(replaceText(REREVIEW_PLAN_TEXT, REREVIEW_RANGE_PHRASE, "", 1), REREVIEW_NO_RANGE_SENTENCE, "", 1);
export const REREVIEW_NEW_MANY = REREVIEW_PLAN_TEXT;
// Step 6b/6c: the plan lines and the worker-report lines merge into one plan line and one worker-reports line.
export const PLAN_LINE_NEW = (scoped: boolean) => "Read each plan wave file in review-context.md in full and review the change against it" + (scoped ? ", " + "only within its re-review range where one is named" : "") + ".";
export const REPORTS_OLD = "Read each worker report for its Deviations from plan and its Automated Verification; each pull request at its pinned commit is the change.";
export const EARLIER_OLD = "Read each earlier worker's report too: the implementing worker's lint/build evidence and Deviations from plan are there; the tester's report holds the test evidence.";
export const PLAN_FULL_OLD = "Read each worker's full report (its Full report path in review-context.md, not the summary) for its Deviations from plan section. Judge each stated deviation on its merits. A change outside the plan, or a planned step skipped, that the worker did not state is scope drift: a blocking finding.";
export const REPORTS_NEW = "Read every worker report review-context.md names, earlier workers included, in full (its Full report path, not the summary): the implementing worker's report holds its lint/build evidence, Automated Verification and `## Deviations from plan`; a tester's report holds the test evidence. Judge each stated deviation on its merits.";
export const DRIFT_NEW = "A change outside the plan, or a planned step skipped, that the worker did not state is scope drift: a blocking finding.";
export const PLAN_LINE_OLD = {
  scopedMany: "Review each branch against the plan wave files in review-context.md: only its re-review range where it names one, else the whole branch against its base.",
  scopedSingle: "Review the changes since the previous review against the plan wave files in review-context.md.",
  whole: "Review the whole branch against its base against the plan wave files in review-context.md.",
  wholeMany: "Review each branch against its base against the plan wave files in review-context.md.",
};

const WAIVER_LINE_STARTS = ["Chief waived the test waves listed", "Chief waived the tester rerun", "Chief bypassed the Spec Writer"];
const REPORT_HEADINGS = ["## What the worker reported", "## The worker's report file", "## The report of worker ", "## Earlier workers on this branch"];
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces the one whole line equal to `from`; fails unless exactly one such line exists. */
const replaceLine = (text: string, from: string, to: string | null) => {
  const lines = text.split("\n");
  expect(lines.filter((line) => line === from)).toHaveLength(1);
  return lines.flatMap((line) => line === from ? (to === null ? [] : [to]) : [line]).join("\n");
};
const hasLine = (text: string, line: string) => text.split("\n").includes(line);

export type Wave1Edits = {
  /** The native line's shape on this prompt: base line, base line minus the two reshape removals, or absent. */
  native: "reshape" | "noReshape" | "none";
  testAudit: boolean;
  /** The absolute path the read line names; null drops the `## Context` list with no read line (the context is inlined or there is none). */
  contextPath: string | null;
  /** The prompt reviews more than one target. */
  many?: boolean;
};

/**
 * One base prompt (rendered at 19babad, native line not yet spliced in: the base fixtures predate it) with wave 1's named edits applied.
 * Which edits apply is read off the base text and its base context, never off the implementation.
 */
export function wave1Prompt(basePrompt: string, baseContext: string, edits: Wave1Edits) {
  let text = basePrompt;
  if (edits.native !== "none") text = spliceAfter(text, REVIEWER_ANCHOR, edits.native === "reshape" ? REVIEWER_NATIVE_LINE : NATIVE_NO_RESHAPE_LINE, 1);
  text = replaceText(text, INSPECT_PLAN_SUFFIX, "", 1);
  if (!edits.testAudit) {
    text = replaceLine(text, TEST_AUDIT_LINE, null);
    text = replaceText(text, TEST_AUDIT_PAREN_WITH, TEST_AUDIT_PAREN_WITHOUT, 1);
  }
  if (text.includes("\n## Context\n")) {
    const block = new RegExp(`\\n\\n## Context\\n(?:- [^\\n]*\\n)+${escapeRe(CONTEXT_READ_OLD)}`, "g");
    expect(text.match(block)).toHaveLength(1);
    text = text.replace(block, () => edits.contextPath ? `\n\n${contextReadNew(edits.contextPath)}` : "");
  }
  expect(text).not.toContain("wait 10 seconds");
  if (text.split("\n").some((line) => line.startsWith(CONTRACT_CHECK_ANCHOR))) text = spliceAfter(text, CONTRACT_CHECK_ANCHOR, WORKER_REPORTED_RULE, 1);
  if (text.includes(IMPACT_OLD)) text = replaceText(text, IMPACT_OLD, IMPACT_NEW, 1);
  const scoped = text.includes("\n## Re-review scope\n");
  if (scoped) {
    const oldMany = REREVIEW_OLD.replace("named above.", "named above for each target that names a range.");
    text = edits.many ? replaceText(text, oldMany, REREVIEW_NEW_MANY, 1) : replaceText(text, REREVIEW_OLD, REREVIEW_NEW_SINGLE, 1);
  }
  const hasReports = REPORT_HEADINGS.some((heading) => baseContext.includes(heading));
  if (hasLine(text, REPORTS_OLD)) text = replaceLine(text, REPORTS_OLD, null);
  if (hasLine(text, EARLIER_OLD)) text = replaceLine(text, EARLIER_OLD, null);
  const planOld = Object.values(PLAN_LINE_OLD).filter((line) => hasLine(text, line));
  expect(planOld.length).toBeLessThanOrEqual(1);
  if (planOld.length) {
    text = replaceLine(text, planOld[0]!, PLAN_LINE_NEW(scoped));
    text = replaceLine(text, PLAN_FULL_OLD, hasReports ? `${REPORTS_NEW} ${DRIFT_NEW}` : DRIFT_NEW);
  } else if (hasReports) {
    const lines = text.split("\n");
    const at = lines.findIndex((line) => WAIVER_LINE_STARTS.some((start) => line.startsWith(start)));
    lines.splice(at < 0 ? lines.length : at, 0, REPORTS_NEW);
    text = lines.join("\n");
  }
  return text;
}

/** Step 1c on a base plan-review subject whose groups each hold one worker: one line per group, the header counting groups, every worker named on its line. */
export function groupedSubject(baseText: string) {
  const lines = baseText.split("\n");
  const isTarget = (line: string) => /^- worker \S+ “[^”]*”: /.test(line);
  const targets = lines.filter(isTarget);
  const pinned = targets.filter((line) => !line.includes(", not pinned: ")).length;
  const unpinned = targets.length - pinned;
  const urls = targets.filter((line) => !line.includes(", not pinned: ")).map((line) => /^- worker \S+ “[^”]*”: (\S+) /.exec(line)![1]);
  expect(new Set(urls).size).toBe(urls.length);
  const counted = unpinned === 0 ? `${pinned} pull request${pinned > 1 ? "s" : ""}` : pinned === 0 ? `${unpinned} branch${unpinned > 1 ? "es" : ""}`
    : `${pinned} pull request${pinned > 1 ? "s" : ""} and ${unpinned} branch${unpinned > 1 ? "es" : ""} without a pinned pull request`;
  const oldHeader = `${targets.length} branches, each with its own pull request, started`;
  return lines.map((line) => {
    if (line.includes(oldHeader)) return line.replace(oldHeader, `${counted}, started`);
    const match = /^- (worker \S+ “[^”]*”): (.*?)(?:; the verdict binds to its report (\d+))?$/.exec(line);
    if (!match || !isTarget(line)) return line;
    return `- ${match[2]}. Workers: ${match[1]}${match[3] ? ` (the verdict binds to its report ${match[3]})` : ""}.`;
  }).join("\n");
}

const ALERT_OLD = /^Could not write review-context\.md for reviewer (\S+) after 3 attempts: <error>\. The reviewer will report blocked on the missing file; stop it \(chief_stop\) or nudge it with the context\.$/;

/**
 * The review-attempt base transcript (rendered at 19babad) with wave 1's named edits applied to every reviewer prompt.
 * The test-audit rule drops when the context's impact slice read every changed path (not skipped): the scenario commits touch only lib.ts and main.ts, no test path.
 * The `## Docs ownership` block is not here: the caller reverse-removes it from the head text through its pinned paragraph.
 */
export function reviewAttemptExpected(base: string) {
  const lines = base.split("\n");
  const out: string[] = [];
  let block = "", workerId = "", seq = "", firstContext = "";
  const contexts: string[] = [];
  // pass 1: the first block's context is the sibling the inline-fallback scenario inlines (same worker, same report).
  for (let i = 0; i < lines.length; i++) if (lines[i] === "review-context.md:") {
    const end = lines.findIndex((line, j) => j > i && /^(chief alert:$|reviewers: |--- |=== )/.test(line));
    contexts.push(lines.slice(i + 1, end).join("\n"));
  }
  firstContext = contexts[0]!.replace(/\n+$/, "");
  let ctxIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("=== ")) block = line;
    const row = /^row: worker_thread_id=(\S+) reviewed_report_seq=(\S+) /.exec(line);
    if (row) [workerId, seq] = [row[1]!, row[2]!];
    const alert = ALERT_OLD.exec(line);
    if (alert) { out.push(`Could not write review-${seq}/<attempt>/review-context.md for the review of ${workerId} after 3 attempts: <error>. The context is inlined into the reviewer prompt instead.`); continue; }
    if (line !== "prompt:") { out.push(line); continue; }
    const split = lines.indexOf("review-context.md:", i);
    const prompt = lines.slice(i + 1, split).join("\n");
    const context = contexts[ctxIndex++]!;
    const branch = workerId === "null";
    const planned = context.includes("## Plan:");
    const failed = block.includes("review-context.md write failure");
    const edits: Wave1Edits = {
      native: branch ? "noReshape" : planned ? "none" : "noReshape",
      testAudit: (context.split("## Impact slice")[1] ?? "Skipped:").includes("Skipped:"),
      contextPath: failed || branch ? null : `<storage>/chief/proj_1/${workerId}/review-${seq}/<attempt>/review-context.md`,
      many: prompt.includes("Independently review the whole plan"),
    };
    let next = wave1Prompt(prompt, branch ? "" : failed ? firstContext : context, edits);
    if (edits.many) next = groupedSubject(next);
    if (failed) next = `${next}\n\n## review-context.md\n${firstContext}`;
    out.push("prompt:", next);
    i = split - 1;
  }
  return out.join("\n");
}
