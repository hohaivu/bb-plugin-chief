import { describe, expect, test } from "vitest";
import { branchReviewBrief, reviewBrief, reviewContext, type BriefTarget, type ReviewBriefInput } from "./src/review/reviewStart";
import { checkPlan } from "./src/report/reportIntake";
import { REVIEWER_NATIVE_LINE, replaceText, spliceAfter, wave } from "./test/harness";
import {
  EARLIER_OLD, IMPACT_OLD, INSPECT_PLAN_SUFFIX, NATIVE_NO_RESHAPE_LINE, NATIVE_RESHAPE_PAREN, NATIVE_RESHAPE_TAIL, PLAN_FULL_OLD, PLAN_LINE_OLD,
  REPORTS_NEW, REPORTS_OLD, REREVIEW_OLD, TEST_AUDIT_LINE, TEST_AUDIT_PAREN_WITH, TEST_AUDIT_PAREN_WITHOUT, WORKER_REPORTED_RULE,
} from "./test/reviewWave1";

// Contracts (wave 1, plan-1.md, "Contracts to verify"): reviewBrief renders one target line per pull request or unpinned branch, with header counts that
// equal the lines; the conditional rule blocks (native-design check with its reshape split, test audit, `## Docs ownership`, the worker-reported rule)
// render by their flag; `acceptedGaps` renders one block right after the focus line; the context is named by one read line or inlined once; every
// merged rule is stated once. The pure functions take their inputs as arguments, so each test names the one input it varies.
// Expected values are copied from the wave 1 plan (test/reviewWave1.ts holds the named texts); none comes from a render of the new code.

const PR1 = "https://github.com/acme/shop/pull/1";
const PR2 = "https://github.com/acme/shop/pull/2";
const count = (text: string, part: string) => text.split(part).length - 1;
const linesOf = (text: string, start: string) => text.split("\n").filter((line) => line.startsWith(start));

/** A pinned target on `pr` (PR number is the last character); `branch` is what the forge reports for that PR. */
const pinned = (id: string, pr: string, extra: Partial<BriefTarget> = {}): BriefTarget => ({
  threadId: id, title: `Task ${id}`, prUrl: pr, branch: `feature/${id}`, reportSeq: 1, hasResult: true, reportPath: `/r/${id}.md`,
  head: { branch: `feature/pr${pr.slice(-1)}`, sha: `sha${pr.slice(-1)}`.padEnd(12, "0"), base: "main" }, ...extra,
});
const loose = (id: string, branch: string, extra: Partial<BriefTarget> = {}): BriefTarget => ({
  threadId: id, title: `Task ${id}`, prUrl: null, branch, reportSeq: 2, hasResult: true, reportPath: `/r/${id}.md`, head: null, ...extra,
});
const brief = (targets: BriefTarget[], over: Partial<ReviewBriefInput> = {}): ReviewBriefInput => ({
  worker: { ...targets[0]!, kind: null, brief: null, reported: "Done" },
  targets, wavePaths: ["/p/plan-1.md", "/p/plan-2.md"], chain: [1, 2], contractLines: ["Wave 1 of 2:", "- Totals stay non-negative"],
  recordedLines: ["npm test → exit 0"], previous: null, chiefThreadId: "thr_c", contextPath: "/ctx/review-context.md", ...over,
});
const single = (over: Partial<ReviewBriefInput> = {}) => brief([pinned("thr_a", PR1)], over);
const subjectOf = (prompt: string) => prompt.split("\n").find((line) => line.startsWith("Independently review"))!;
/** The target lines of a plan review: a pull request line starts "- <url> (", an unpinned one "- branch ". */
const targetLines = (prompt: string) => prompt.split("\n").filter((line) => line.startsWith("- https://") || line.startsWith("- branch "));

describe("reviewBrief: one line per pull request", () => {
  // Contract: each distinct prUrl is in exactly one target line, with one sha and one scope, and every worker of the PR is named on it.
  // Regression: grouping by worker (one line per target) gives 2 lines and "2 pull requests" for one PR.
  test("one pull request with two workers: one line, one sha, both workers, header says 1 pull request", () => {
    const { prompt } = reviewBrief(brief([pinned("thr_a", PR1), pinned("thr_t", PR1, { kind: "tester" })]));
    const lines = targetLines(prompt);
    expect(lines).toHaveLength(1);
    expect(count(lines[0]!, "sha1")).toBeGreaterThan(0);
    expect(lines[0]!.match(/sha1\w*/g)!.every((sha) => sha === "sha1".padEnd(12, "0"))).toBe(true);
    expect(lines[0]).toContain("Workers: worker thr_a “Task thr_a”; tester thr_t “Task thr_t”.");
    expect(subjectOf(prompt)).toContain("the whole plan: 1 pull request, started after every wave was ready");
    expect(count(prompt, "pull requests")).toBe(0);
  });

  test("two pull requests with four workers: two lines, each worker named once, header says 2 pull requests", () => {
    const targets = [pinned("thr_a", PR1), pinned("thr_b", PR1, { kind: "designer" }), pinned("thr_c", PR2), pinned("thr_t", PR2, { kind: "tester" })];
    const { prompt } = reviewBrief(brief(targets));
    const lines = targetLines(prompt);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(PR1);
    expect(lines[1]).toContain(PR2);
    expect(lines[0]).toContain("designer thr_b");
    expect(lines[1]).toContain("tester thr_t");
    for (const id of ["thr_a", "thr_b", "thr_c", "thr_t"]) expect(count(lines.join("\n"), `${id} “`)).toBe(1);
    expect(subjectOf(prompt)).toContain("the whole plan: 2 pull requests, started");
  });

  // Contract: unpinned targets get one line per distinct branch, the header never calls them a pull request, and the line keeps "the verdict binds to its report N" per worker.
  test("an unpinned branch with two workers: one branch line, header says 1 branch, each worker keeps its report number", () => {
    const { prompt } = reviewBrief(brief([loose("thr_a", "feature/x"), loose("thr_t", "feature/x", { kind: "tester", reportSeq: 3 })]));
    const lines = targetLines(prompt);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("- branch feature/x, head not readable, not pinned:");
    expect(lines[0]).toContain("worker thr_a “Task thr_a” (the verdict binds to its report 2); tester thr_t “Task thr_t” (the verdict binds to its report 3).");
    expect(subjectOf(prompt)).toContain("the whole plan: 1 branch, started");
    expect(subjectOf(prompt)).not.toMatch(/whole plan: [^,]*pull request/);
  });

  test("two unpinned branches: header says 2 branches", () => {
    const { prompt } = reviewBrief(brief([loose("thr_a", "feature/x"), loose("thr_b", "feature/y")]));
    expect(targetLines(prompt)).toHaveLength(2);
    expect(subjectOf(prompt)).toContain("the whole plan: 2 branches, started");
  });

  test("a mix: the header counts the pull request and the unpinned branch separately, and a PR with no readable head still counts as its branch", () => {
    const { prompt } = reviewBrief(brief([pinned("thr_a", PR1), pinned("thr_t", PR1, { kind: "tester" }), loose("thr_b", "feature/x"), loose("thr_c", "feature/x")]));
    expect(targetLines(prompt)).toHaveLength(2);
    expect(subjectOf(prompt)).toContain("the whole plan: 1 pull request and 1 branch without a pinned pull request, started");
    const unreadable = reviewBrief(brief([pinned("thr_a", PR1), loose("thr_b", "feature/y", { prUrl: PR2 })])).prompt;
    expect(subjectOf(unreadable)).toContain("1 pull request and 1 branch without a pinned pull request");
    expect(targetLines(unreadable)[1]).toContain(`- branch feature/y (${PR2}), head not readable, not pinned:`);
  });

  test("workers of one branch with different kinds name their kind on the line, a side-lane writer included", () => {
    const targets = [pinned("thr_a", PR1), pinned("thr_s", PR1, { kind: "spec-writer", lane: "side" }), pinned("thr_w", PR1, { kind: "spec-writer" })];
    const line = targetLines(reviewBrief(brief(targets)).prompt)[0]!;
    expect(line).toContain("Workers: worker thr_a “Task thr_a”; side-lane Spec Writer thr_s “Task thr_s”; Spec Writer thr_w “Task thr_w”.");
  });
});

describe("reviewBrief: re-review scope per pull request", () => {
  // Contract: the scope text is the same as before, taken from the group's single `since`; the section says "each pull request that names a range".
  test("a pull request with a since reviews the range, one without reviews the whole pull request", () => {
    const { prompt } = reviewBrief(brief([pinned("thr_a", PR1, { since: "dead00" }), pinned("thr_t", PR1, { since: "dead00" }), pinned("thr_b", PR2)]));
    const [first, second] = targetLines(prompt);
    expect(first).toContain("then review only the changes since the previous review: `git diff dead00..sha100000000`");
    expect(first).toContain("(the whole pull request, `git diff origin/main...sha100000000`, is context only)");
    expect(second).toContain("then review `git diff origin/main...sha200000000`.");
    expect(second).not.toContain("dead00");
    expect(count(prompt, "dead00")).toBe(1);
  });

  test("the Re-review scope section renders iff some target names a range, and says pull request", () => {
    const withRange = reviewBrief(brief([pinned("thr_a", PR1, { since: "dead00" }), pinned("thr_b", PR2)])).prompt;
    expect(count(withRange, "## Re-review scope")).toBe(1);
    expect(withRange).toContain("up to the previous reviewed head named above for each pull request that names a range.");
    expect(withRange).not.toContain("for each target that names a range");
    const whole = reviewBrief(brief([pinned("thr_a", PR1), pinned("thr_b", PR2)])).prompt;
    expect(whole).not.toContain("## Re-review scope");
    expect(whole).not.toContain("dead00");
  });

  test("a single-worker re-review keeps the single wording (no 'each pull request') and names the range once in the subject", () => {
    const { prompt } = reviewBrief(single({ worker: { ...pinned("thr_a", PR1, { since: "dead00" }), kind: null, brief: null, reported: "Done" } }));
    expect(prompt).toContain("only the worker's changes since the previous review, which covered dead00: `git diff dead00..sha100000000`");
    expect(prompt).toContain("## Re-review scope");
    expect(prompt).not.toContain("for each pull request that names a range");
    expect(prompt).not.toContain("A pull request with no range is reviewed whole against its base.");
  });
});

describe("reviewerPrompt rule blocks through reviewBrief", () => {
  const blocks = (over: Partial<ReviewBriefInput> = {}) => reviewBrief(single(over)).prompt;

  // Contract: `feature && reshape` renders the base native line byte for byte; `feature && !reshape` the base line with exactly the two named removals; `!feature` none.
  // Regression: dropping only one removal, dropping the line for `reshape: false`, or rendering it for a feature:false-only plan.
  test("native-design check: feature+reshape is the base line, feature alone loses exactly the two reshape parts, no feature renders none", () => {
    const both = blocks({ feature: true, reshape: true });
    expect(both.split("\n")).toContain(REVIEWER_NATIVE_LINE);
    expect(count(both, "Native-design check")).toBe(1);
    const featureOnly = blocks({ feature: true, reshape: false });
    expect(featureOnly.split("\n")).toContain(NATIVE_NO_RESHAPE_LINE);
    expect(featureOnly.split("\n")).not.toContain(REVIEWER_NATIVE_LINE);
    expect(count(featureOnly, NATIVE_RESHAPE_PAREN)).toBe(0);
    expect(count(featureOnly, NATIVE_RESHAPE_TAIL)).toBe(0);
    expect(featureOnly).toBe(replaceText(replaceText(both, NATIVE_RESHAPE_PAREN, "", 1), NATIVE_RESHAPE_TAIL, "", 1));
    // The severity rule keeps its meaning without the parenthesis.
    expect(featureOnly).toContain("A smell is a nit unless a listed contract rules it out; then it is an unmet contract.");
    // Defaults: feature true, reshape false.
    expect(blocks()).toBe(featureOnly);
  });

  test("feature: false renders no native line, whatever reshape says, and nothing else of the prompt moves", () => {
    const both = blocks({ feature: true, reshape: true });
    for (const reshape of [false, true]) {
      const none = blocks({ feature: false, reshape });
      expect(none).not.toContain("Native-design check");
      expect(none).not.toContain("native-design");
      expect(none).not.toContain("A reshape commit belongs to its feature");
      expect(none).toBe(replaceText(both, `${REVIEWER_NATIVE_LINE}\n`, "", 1));
    }
  });

  // Contract: the test-audit rule renders iff testAudit; the do-not-report parenthesis names it only then.
  test("test audit: the rule and its parenthesis follow the flag", () => {
    const on = blocks({ testAudit: true });
    expect(count(on, TEST_AUDIT_LINE)).toBe(1);
    expect(count(on, TEST_AUDIT_PAREN_WITH)).toBe(1);
    expect(count(on, TEST_AUDIT_PAREN_WITHOUT)).toBe(0);
    const off = blocks({ testAudit: false });
    expect(count(off, "Test audit:")).toBe(0);
    expect(count(off, TEST_AUDIT_LINE)).toBe(0);
    expect(count(off, TEST_AUDIT_PAREN_WITH)).toBe(0);
    expect(count(off, TEST_AUDIT_PAREN_WITHOUT)).toBe(1);
    expect(off).toBe(replaceText(replaceText(on, `${TEST_AUDIT_LINE}\n`, "", 1), TEST_AUDIT_PAREN_WITH, TEST_AUDIT_PAREN_WITHOUT, 1));
    expect(blocks()).toBe(on);
  });

  test("Docs ownership renders iff docs, once, and defaults on", () => {
    expect(count(blocks({ docs: true }), "## Docs ownership")).toBe(1);
    expect(count(blocks(), "## Docs ownership")).toBe(1);
    const off = blocks({ docs: false });
    expect(off).not.toContain("## Docs ownership");
    expect(off).not.toContain("Chief-Spec-Writer");
  });

  // Contract: the worker-reported rule renders only when the contract list renders, right after its check line.
  test("the worker-reported contract rule follows the contract list", () => {
    const withList = blocks();
    expect(count(withList, WORKER_REPORTED_RULE)).toBe(1);
    const lines = withList.split("\n");
    expect(lines[lines.findIndex((line) => line.startsWith("Check every item against ")) + 1]).toBe(WORKER_REPORTED_RULE);
    const without = blocks({ contractLines: [] });
    expect(without).not.toContain("## Contracts to verify");
    expect(count(without, "worker-reported")).toBe(0);
  });

  test("every rule block off at once leaves the invariant rules in place", () => {
    const prompt = blocks({ feature: false, testAudit: false, docs: false });
    expect(prompt).toContain("Classify every finding as blocking or nit.");
    expect(prompt).toContain("Send each finding in chief_report `findings`");
    expect(prompt).toContain("## This review");
  });
});

describe("acceptedGaps", () => {
  const GAPS = "No device run: Chief accepts the simulator evidence.";
  const RULE = "Chief accepted these gaps before this review. They are not missing verification evidence: list each under Manual Verification in result, and never make a finding of a listed gap alone.";
  const focusLine = "Review focus: the discount path";

  // Contract: absent, the prompt is byte-equal to the same input without the key; present, one `## Accepted gaps (Manual Verification)` block with the text and the rule, right after the focus line.
  test("worker review: absent changes nothing, present adds one block after the focus line", () => {
    const base = reviewBrief(single({ focus: "the discount path" })).prompt;
    expect(reviewBrief(single({ focus: "the discount path", acceptedGaps: undefined })).prompt).toBe(base);
    expect(base).not.toContain("Accepted gaps");
    const given = reviewBrief(single({ focus: "the discount path", acceptedGaps: GAPS })).prompt;
    expect(given).toBe(spliceAfter(base, focusLine, ["## Accepted gaps (Manual Verification)", GAPS, RULE].join("\n"), 1));
    expect(count(given, "## Accepted gaps (Manual Verification)")).toBe(1);
  });

  test("worker review without a focus line: the block follows the report line", () => {
    const base = reviewBrief(single()).prompt;
    const given = reviewBrief(single({ acceptedGaps: GAPS })).prompt;
    expect(given).toBe(spliceAfter(base, "Report your findings to Chief thread thr_c with chief_report", ["## Accepted gaps (Manual Verification)", GAPS, RULE].join("\n"), 1));
  });

  test("a plan review carries the block once", () => {
    const given = reviewBrief(brief([pinned("thr_a", PR1), pinned("thr_b", PR2)], { acceptedGaps: GAPS })).prompt;
    expect(count(given, "## Accepted gaps (Manual Verification)")).toBe(1);
    expect(count(given, RULE)).toBe(1);
  });

  test("branch review: absent changes nothing, present adds the block after the focus line", () => {
    const input = { branch: "feature/x", pullRequestRef: PR1, focus: "the discount path", chiefThreadId: "thr_c" };
    const base = branchReviewBrief(input);
    expect(branchReviewBrief({ ...input, acceptedGaps: undefined })).toBe(base);
    expect(base).not.toContain("Accepted gaps");
    expect(branchReviewBrief({ ...input, acceptedGaps: GAPS })).toBe(spliceAfter(base, focusLine, ["## Accepted gaps (Manual Verification)", GAPS, RULE].join("\n"), 1));
    const unpinned = { branch: "feature/x", pullRequestRef: null, chiefThreadId: "thr_c" };
    expect(count(branchReviewBrief({ ...unpinned, acceptedGaps: GAPS }), RULE)).toBe(1);
    expect(branchReviewBrief({ ...unpinned, acceptedGaps: GAPS })).toContain(GAPS);
  });
});

describe("branchReviewBrief defaults", () => {
  // Contract: a branch review keeps native yes, reshape no, test audit yes, and has no Docs ownership section.
  test("renders the native line without the reshape parts, the test audit, and no Docs ownership", () => {
    const prompt = branchReviewBrief({ branch: "feature/x", pullRequestRef: PR1, chiefThreadId: "thr_c" });
    expect(prompt.split("\n")).toContain(NATIVE_NO_RESHAPE_LINE);
    expect(count(prompt, TEST_AUDIT_LINE)).toBe(1);
    expect(count(prompt, TEST_AUDIT_PAREN_WITH)).toBe(1);
    expect(prompt).not.toContain("## Docs ownership");
  });
});

describe("review-context.md: one read line or one inline copy", () => {
  // Contract: with a path the prompt holds one read line and no copy of the context; with null it ends with `## review-context.md` and the context; an empty context renders neither.
  test("with a path: one read line, no inline heading, no wait rule, no Context list", () => {
    const { prompt, context } = reviewBrief(single());
    const read = "Read `/ctx/review-context.md` in full before reviewing: it holds the reports, plan files and pointers this brief names.";
    expect(count(prompt, read)).toBe(1);
    expect(prompt.split("\n")).not.toContain("## review-context.md");
    expect(count(prompt, "Full report: /r/thr_a.md")).toBe(0);
    expect(context).toContain("Full report: /r/thr_a.md");
    expect(prompt).not.toContain("wait 10 seconds");
    expect(prompt).not.toContain("$BB_THREAD_STORAGE/review-context.md");
    expect(prompt.split("\n")).not.toContain("## Context");
  });

  test("with null: the prompt ends with the heading and the context, and has no read line", () => {
    const { prompt, context } = reviewBrief(single({ contextPath: null }));
    expect(prompt.endsWith(`\n\n## review-context.md\n${context}`)).toBe(true);
    expect(count(prompt, context)).toBe(1);
    expect(prompt).not.toContain("in full before reviewing: it holds the reports");
    expect(reviewBrief(single({ contextPath: undefined })).prompt).toBe(prompt);
  });

  test("an empty context writes nothing to name and nothing to inline", () => {
    const targets = [pinned("thr_a", PR1, { hasResult: false }), pinned("thr_b", PR2, { hasResult: false })];
    const input = brief(targets, { wavePaths: [], chain: [], contractLines: [] });
    expect(reviewContext(input)).toBe("");
    for (const contextPath of ["/ctx/review-context.md", null]) {
      const { prompt, context } = reviewBrief({ ...input, contextPath });
      expect(context).toBe("");
      expect(prompt).not.toContain("in full before reviewing: it holds the reports");
      expect(prompt.split("\n")).not.toContain("## review-context.md");
      expect(prompt.endsWith("\n")).toBe(false);
    }
  });

  test("reviewContext is the context reviewBrief returns", () => {
    const input = brief([pinned("thr_a", PR1), pinned("thr_b", PR2)]);
    expect(reviewContext(input)).toBe(reviewBrief(input).context);
  });
});

describe("a merged rule is stated once", () => {
  const SIDE = pinned("thr_s", PR2, { kind: "spec-writer", lane: "side" });
  const planReview = () => reviewBrief(brief([pinned("thr_a", PR1, { since: "dead00", earlier: [{ threadId: "thr_e", kind: "tester", reportPath: "/r/e.md" }] }), pinned("thr_t", PR1, { kind: "tester", since: "dead00" }), SIDE], {
    specWaves: [1], writers: [{ threadId: "thr_s", reportPath: "/r/s.md" }], sideWriters: [{ threadId: "thr_s", wave: 1, reportPath: "/r/s.md" }],
  })).prompt;

  // Contract: each of these is stated once in a rendered plan-review prompt; the old per-block copies are gone.
  // Regression: a copy left in the impact-slice line, the re-review section, an inspect line, the earlier-workers line, the side-lane line or spec-gate item (4).
  test("'lines this diff introduced' is a reporting rule only in the evidence rules", () => {
    const prompt = planReview();
    expect(count(prompt, "Report only problems this diff introduced")).toBe(1);
    expect(count(prompt, "findings only on lines")).toBe(0);
    expect(count(prompt, "Report findings only on lines")).toBe(0);
    expect(count(prompt, IMPACT_OLD)).toBe(0);
    expect(count(prompt, REREVIEW_OLD)).toBe(0);
    const withSlice = reviewBrief(single({ impactSlices: [{ threadId: "thr_a", branch: "feature/thr_a", lines: ["a.ts:1: f"], entries: 1 }] })).prompt;
    expect(withSlice).toContain("never report a finding on a slice line.");
    expect(count(withSlice, "report findings only on lines")).toBe(0);
  });

  test("the plan files are read by one line, in a plan review and in a single review", () => {
    for (const prompt of [planReview(), reviewBrief(single()).prompt]) {
      expect(count(prompt, "Read each plan wave file in review-context.md in full")).toBe(1);
      expect(count(prompt, INSPECT_PLAN_SUFFIX)).toBe(0);
      expect(count(prompt, "read each in full before judging")).toBe(0);
      for (const old of Object.values(PLAN_LINE_OLD)) expect(count(prompt, old)).toBe(0);
    }
    const scoped = planReview();
    expect(scoped).toContain("Read each plan wave file in review-context.md in full and review the change against it, only within its re-review range where one is named.");
    expect(reviewBrief(single()).prompt).toContain("Read each plan wave file in review-context.md in full and review the change against it.\n");
    expect(reviewBrief(single({ wavePaths: [], chain: [] })).prompt).not.toContain("Read each plan wave file");
  });

  test("the worker reports and their Deviations are read by one line, drift sentence only with plan files", () => {
    for (const prompt of [planReview(), reviewBrief(single()).prompt]) {
      expect(count(prompt, "Read every worker report review-context.md names")).toBe(1);
      expect(count(prompt, REPORTS_NEW)).toBe(1);
      for (const old of [REPORTS_OLD, EARLIER_OLD, PLAN_FULL_OLD, "Read each worker report for its Deviations", "Read each earlier worker's report too", "Read each worker's full report"]) {
        expect(count(prompt, old)).toBe(0);
      }
      expect(count(prompt, "that the worker did not state is scope drift: a blocking finding.")).toBe(1);
    }
    const noPlan = reviewBrief(single({ wavePaths: [], chain: [] })).prompt;
    expect(count(noPlan, "Read every worker report review-context.md names")).toBe(1);
    expect(noPlan).not.toContain("that the worker did not state is scope drift");
    const noReports = reviewBrief(brief([pinned("thr_a", PR1, { hasResult: false }), pinned("thr_b", PR2, { hasResult: false })], { wavePaths: [], chain: [] })).prompt;
    expect(noReports).not.toContain("Read every worker report");
  });

  test("the Fold-range exemption and the worker-range violation are stated once, in Docs ownership", () => {
    const prompt = planReview();
    const ownership = prompt.split("## Docs ownership\n")[1]!.split("\n")[0]!;
    expect(count(prompt, "`Fold: none` with equal Fold base and Fold head is an empty scope")).toBe(1);
    expect(count(ownership, "`Fold: none` with equal Fold base and Fold head is an empty scope")).toBe(1);
    expect(count(prompt, "never fall back to its Base commit")).toBe(1);
    expect(count(prompt, "A docs/ path in a worker's, designer's or tester's own range is a violation.")).toBe(1);
    expect(count(ownership, "A docs/ path in a worker's, designer's or tester's own range is a violation.")).toBe(1);
    // The side-lane line keeps only the Fold range and the scope-drift sentence; spec-gate item (4) only points at Docs ownership.
    const sideLine = linesOf(prompt, "A side-lane Spec Writer works in its own worktree")[0]!;
    expect(sideLine).toBe("A side-lane Spec Writer works in its own worktree and changes only docs/: check its Fold base..Fold head range (git diff <Fold base>..<Fold head> --stat); any path outside docs/ in it is scope drift. Side-lane Spec Writers here: thr_s.");
    expect(prompt.split("\n")).toContain("(4) a docs/ ownership violation (see Docs ownership);");
    const earlier = linesOf(prompt, "Check each earlier worker on its own commits only")[0] ?? linesOf(prompt, "Check each earlier tester and Spec Writer on its own commits only")[0]!;
    expect(earlier).toContain("A tester's product-code change, or a Spec Writer's path outside docs/, is scope drift.");
    expect(count(earlier, "docs/ path in a worker's")).toBe(0);
    expect(count(earlier, "Fold")).toBe(0);
  });
});

describe("checkPlan: feature and reshape flags", () => {
  const NOT_DOING = "\n\n## What we're NOT doing\n- x";
  const W = (n: number, extra: object = {}) => ({ body: wave(n) + NOT_DOING, ...extra });
  const TEST_WAVE_N = (n: number, dependsOn: number[]) => W(n, { test: true, dependsOn });

  // Contract: feature and reshape are booleans with spec's error shape, and never on a test or design wave; a plan with no such key gets the errors it always got.
  // Regression: accepting a string flag lets a wave that never reads as a feature gate the review; dropping the test/design refusal marks a tester's wave a feature wave.
  test("a valid plan with both flags is accepted, as is one without any", () => {
    expect(checkPlan([W(1, { feature: true }), W(2, { feature: true, reshape: true, dependsOn: [1] }), TEST_WAVE_N(3, [2])])).toEqual([]);
    expect(checkPlan([W(1, { feature: false, reshape: false }), TEST_WAVE_N(2, [1])])).toEqual([]);
    expect(checkPlan([W(1), TEST_WAVE_N(2, [1])])).toEqual([]);
  });

  test.each([["feature", "yes"], ["reshape", "yes"], ["feature", 1], ["reshape", null]])("refuses a non-boolean %s (%j) with one error that names it", (flag, value) => {
    expect(checkPlan([W(1, { [flag]: value }), TEST_WAVE_N(2, [1])])).toEqual([
      `plan wave 1 ${flag} is ${JSON.stringify(value)} (${typeof value}); allowed true or false. Send a boolean, or drop ${flag}.`,
    ]);
  });

  test("feature: true on a test wave, reshape: true on a test wave or a design wave: one error each", () => {
    expect(checkPlan([W(1), W(2, { test: true, feature: true, dependsOn: [1] })])).toEqual([
      "plan wave 2 is feature: true and test: true; feature and reshape mark an implementation wave only.",
    ]);
    expect(checkPlan([W(1), W(2, { test: true, reshape: true, dependsOn: [1] })])).toEqual([
      "plan wave 2 is reshape: true and test: true; feature and reshape mark an implementation wave only.",
    ]);
    expect(checkPlan([W(1, { design: true, reshape: true }), W(2), TEST_WAVE_N(3, [2])])).toEqual([
      "plan wave 1 is reshape: true and design: true; feature and reshape mark an implementation wave only.",
    ]);
  });

  test("feature: false on a test wave is allowed (only true marks the wave)", () => {
    expect(checkPlan([W(1), W(2, { test: true, feature: false, reshape: false, dependsOn: [1] })])).toEqual([]);
  });

  test("both flags wrong on one wave give both errors, feature first", () => {
    expect(checkPlan([W(1, { feature: "yes", reshape: "no" }), TEST_WAVE_N(2, [1])])).toEqual([
      "plan wave 1 feature is \"yes\" (string); allowed true or false. Send a boolean, or drop feature.",
      "plan wave 1 reshape is \"no\" (string); allowed true or false. Send a boolean, or drop reshape.",
    ]);
  });
});
