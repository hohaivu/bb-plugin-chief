import { REVIEWER_NATIVE_LINE, replaceText } from "./harness";

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
export const PLAN_FULL_OLD = "Read each worker's full report (its Full report path in review-context.md, not the summary) for its Deviations from plan section. Judge each stated deviation on its merits. A change outside the plan, or a planned step skipped, that the worker did not state is scope drift: a blocking finding.";
export const DRIFT_NEW = "A change outside the plan, or a planned step skipped, that the worker did not state is scope drift: a blocking finding.";
export const PLAN_LINE_OLD = {
  scopedMany: "Review each branch against the plan wave files in review-context.md: only its re-review range where it names one, else the whole branch against its base.",
  scopedSingle: "Review the changes since the previous review against the plan wave files in review-context.md.",
  whole: "Review the whole branch against its base against the plan wave files in review-context.md.",
  wholeMany: "Review each branch against its base against the plan wave files in review-context.md.",
};

