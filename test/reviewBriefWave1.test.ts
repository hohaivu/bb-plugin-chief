import { describe, expect, test } from "vitest";
import { branchReviewBrief, reviewBrief, reviewContext, type BriefTarget, type ReviewBriefInput } from "../src/review/reviewStart";
import { checkPlan } from "../src/report/reportIntake";
import { wave } from "./harness";

// Contracts (wave 1, plan-1.md, "Contracts to verify"): reviewBrief renders one target line per pull request or unpinned branch, with header counts that
// equal the lines; the conditional rule blocks (native-design check with its reshape split, test audit, `## Docs ownership`, the worker-reported rule)
// render by their flag; `acceptedGaps` renders one block right after the focus line; the context is named by one read line or inlined once; every
// merged rule is stated once. The pure functions take their inputs as arguments, so each test names the one input it varies.
// Rule wording is not pinned: rule blocks are checked render-to-render (one input varied, the line diff compared).

const PR1 = "https://github.com/acme/shop/pull/1";
const PR2 = "https://github.com/acme/shop/pull/2";
const count = (text: string, part: string) => text.split(part).length - 1;
/** The lines of `a` at which `b` differs, for prompts of equal line count. */
const changedLines = (a: string, b: string) => {
  const [x, y] = [a.split("\n"), b.split("\n")];
  expect(x).toHaveLength(y.length);
  return x.flatMap((line, i) => line === y[i] ? [] : [i]);
};
/** `longer` with `count` consecutive lines removed equals `shorter`; returns the index and the removed lines. */
const insertedLines = (longer: string, shorter: string, count: number) => {
  const [x, y] = [longer.split("\n"), shorter.split("\n")];
  expect(x).toHaveLength(y.length + count);
  let index = 0;
  while (index < y.length && x[index] === y[index]) index += 1;
  expect([...x.slice(0, index), ...x.slice(index + count)]).toEqual(y);
  return { index, lines: x.slice(index, index + count) };
};

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
/** The counts in the plan-review header (the text before its first comma): its numbers, and whether it names pull requests and branches. */
const headerCounts = (prompt: string) => {
  const head = prompt.split("\n").find((line) => line.startsWith("Independently review"))!.split(",")[0]!;
  return { numbers: (head.match(/\d+/g) ?? []).map(Number), pullRequests: head.includes("pull request"), branches: head.includes("branch") };
};
/** The target lines of a plan review: a pull request line starts "- <url> (", an unpinned one "- branch ". */
const targetLines = (prompt: string) => prompt.split("\n").filter((line) => line.startsWith("- https://") || line.startsWith("- branch "));

describe("reviewBrief: one line per pull request", () => {
  // Contract: each distinct prUrl is in exactly one target line, with one sha and one scope, and every worker of the PR is named on it.
  // Regression: grouping by worker (one line per target) gives 2 lines and "2 pull requests" for one PR.
  test("one pull request with two workers: one line, one sha, both workers, header says 1 pull request", () => {
    const { prompt } = reviewBrief(brief([pinned("thr_a", PR1), pinned("thr_t", PR1, { kind: "designer" })]));
    const lines = targetLines(prompt);
    expect(lines).toHaveLength(1);
    expect(count(lines[0]!, "sha1")).toBeGreaterThan(0);
    expect(lines[0]!.match(/sha1\w*/g)!.every((sha) => sha === "sha1".padEnd(12, "0"))).toBe(true);
    for (const id of ["thr_a", "thr_t"]) expect(lines[0]).toContain(`${id} “Task ${id}”`);
    expect(lines[0]).toContain("designer thr_t");
    expect(headerCounts(prompt)).toEqual({ numbers: [1], pullRequests: true, branches: false });
  });

  test("two pull requests with four workers: two lines, each worker named once, header says 2 pull requests", () => {
    const targets = [pinned("thr_a", PR1), pinned("thr_b", PR1, { kind: "designer" }), pinned("thr_c", PR2), pinned("thr_t", PR2, { kind: "designer" })];
    const { prompt } = reviewBrief(brief(targets));
    const lines = targetLines(prompt);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(PR1);
    expect(lines[1]).toContain(PR2);
    expect(lines[0]).toContain("designer thr_b");
    expect(lines[1]).toContain("designer thr_t");
    for (const id of ["thr_a", "thr_b", "thr_c", "thr_t"]) expect(count(lines.join("\n"), `${id} “`)).toBe(1);
    expect(headerCounts(prompt)).toEqual({ numbers: [2], pullRequests: true, branches: false });
  });

  // Contract: unpinned targets get one line per distinct branch, the header never calls them a pull request, and the line keeps "the verdict binds to its report N" per worker.
  test("an unpinned branch with two workers: one branch line, header says 1 branch, each worker keeps its report number", () => {
    const { prompt } = reviewBrief(brief([loose("thr_a", "feature/x"), loose("thr_t", "feature/x", { kind: "designer", reportSeq: 3 })]));
    const lines = targetLines(prompt);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("- branch ")).toBe(true);
    expect(lines[0]).toContain("feature/x");
    // Each worker is named with its own report number, in order.
    expect(lines[0]).toMatch(/thr_a “Task thr_a”[^;]*\b2\b[^;]*; designer thr_t “Task thr_t”[^;]*\b3\b/);
    expect(headerCounts(prompt)).toEqual({ numbers: [1], pullRequests: false, branches: true });
  });

  test("two unpinned branches: header says 2 branches", () => {
    const { prompt } = reviewBrief(brief([loose("thr_a", "feature/x"), loose("thr_b", "feature/y")]));
    expect(targetLines(prompt)).toHaveLength(2);
    expect(headerCounts(prompt)).toEqual({ numbers: [2], pullRequests: false, branches: true });
  });

  test("a mix: the header counts the pull request and the unpinned branch separately, and a PR with no readable head still counts as its branch", () => {
    const { prompt } = reviewBrief(brief([pinned("thr_a", PR1), pinned("thr_t", PR1, { kind: "designer" }), loose("thr_b", "feature/x"), loose("thr_c", "feature/x")]));
    expect(targetLines(prompt)).toHaveLength(2);
    // The pull request is counted before the branch: one of each.
    const mixed = headerCounts(prompt);
    expect(mixed).toEqual({ numbers: [1, 1], pullRequests: true, branches: true });
    const unreadablePrompt = reviewBrief(brief([pinned("thr_a", PR1), loose("thr_b", "feature/y", { prUrl: PR2 })])).prompt;
    expect(headerCounts(unreadablePrompt)).toEqual(mixed);
    const unreadable = targetLines(unreadablePrompt);
    expect(unreadable[0]!.startsWith(`- ${PR1}`)).toBe(true);
    expect(unreadable[1]!.startsWith("- branch ")).toBe(true);
    expect(unreadable[1]).toContain("feature/y");
    expect(unreadable[1]).toContain(PR2);
  });

  test("workers of one branch with different kinds name their kind on the line, a side-lane writer included", () => {
    const targets = [pinned("thr_a", PR1), pinned("thr_s", PR1, { kind: "spec-writer", lane: "side" }), pinned("thr_w", PR1, { kind: "spec-writer" })];
    const line = targetLines(reviewBrief(brief(targets)).prompt)[0]!;
    for (const id of ["thr_a", "thr_s", "thr_w"]) expect(count(line, `${id} “Task ${id}”`)).toBe(1);
    // The side-lane writer and the chain writer render different kind labels.
    const label = (id: string) => line.slice(0, line.indexOf(` ${id} “`)).split(/[;:] /).at(-1);
    expect(label("thr_s")).not.toBe(label("thr_w"));
    expect(label("thr_a")).not.toBe(label("thr_w"));
  });
});

describe("reviewerPrompt rule blocks through reviewBrief", () => {
  const blocks = (over: Partial<ReviewBriefInput> = {}) => reviewBrief(single(over)).prompt;

  // Contract: `feature && reshape` and `feature && !reshape` differ in exactly the native line, the no-reshape one strictly shorter; `!feature` renders none.
  // Regression: the reshape split dropped (identical lines), the line dropped for `reshape: false`, or rendered for a feature:false-only plan.
  test("native-design check: feature alone renders a shorter native line than feature+reshape, nothing else differs", () => {
    const both = blocks({ feature: true, reshape: true });
    const featureOnly = blocks({ feature: true, reshape: false });
    const [index] = changedLines(both, featureOnly);
    expect(changedLines(both, featureOnly)).toEqual([index]);
    expect(featureOnly.split("\n")[index!]!.length).toBeLessThan(both.split("\n")[index!]!.length);
    // Defaults: feature true, reshape false.
    expect(blocks()).toBe(featureOnly);
  });

  test("feature: false renders no native line, whatever reshape says, and nothing else of the prompt moves", () => {
    const both = blocks({ feature: true, reshape: true });
    const [index] = changedLines(both, blocks({ feature: true, reshape: false }));
    for (const reshape of [false, true]) {
      const none = blocks({ feature: false, reshape });
      expect(insertedLines(both, none, 1)).toEqual({ index, lines: [both.split("\n")[index!]] });
    }
  });

  test("Docs ownership is absent when disabled", () => {
    expect(blocks({ docs: false })).not.toContain("## Docs ownership");
  });

  // Contract: the contract section renders its list plus its rule lines only when the contract list is given.
  test("the contract section carries the list and its rules, and is absent without a list", () => {
    const lines = blocks().split("\n");
    const start = lines.indexOf("## Contracts to verify");
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
    const section = lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.trim());
    for (const item of single().contractLines) expect(section).toContain(item);
    expect(section.length).toBeGreaterThan(single().contractLines.length);
    expect(blocks({ contractLines: [] })).not.toContain("## Contracts to verify");
  });


});

describe("acceptedGaps", () => {
  const GAPS = "No device run: Chief accepts the simulator evidence.";
  const HEADING = "## Accepted gaps (Manual Verification)";
  const focusLine = "Review focus: the discount path";
  /** `given` is `base` with one block inserted: the heading, the gaps, then one rule line. */
  const block = (given: string, base: string) => {
    const inserted = insertedLines(given, base, 3);
    expect(inserted.lines.slice(0, 2)).toEqual([HEADING, GAPS]);
    expect(inserted.lines[2]!.trim()).not.toBe("");
    return inserted;
  };

  // Contract: absent, the prompt is byte-equal to the same input without the key; present, one `## Accepted gaps (Manual Verification)` block with the text and a rule, right after the focus line.
  test("worker review: absent changes nothing, present adds one block after the focus line", () => {
    const base = reviewBrief(single({ focus: "the discount path" })).prompt;
    expect(reviewBrief(single({ focus: "the discount path", acceptedGaps: undefined })).prompt).toBe(base);
    expect(base).not.toContain("Accepted gaps");
    const given = reviewBrief(single({ focus: "the discount path", acceptedGaps: GAPS })).prompt;
    expect(base.split("\n")[block(given, base).index - 1]).toContain(focusLine);
    expect(count(given, HEADING)).toBe(1);
  });

  test("worker review without a focus line: the block is inserted at the same place as the focus line would be", () => {
    const base = reviewBrief(single()).prompt;
    const focused = reviewBrief(single({ focus: "the discount path" })).prompt;
    const focusAt = focused.split("\n").findIndex((line) => line.includes(focusLine));
    expect(block(reviewBrief(single({ acceptedGaps: GAPS })).prompt, base).index).toBe(focusAt);
  });

  test("a plan review carries the block once", () => {
    const given = reviewBrief(brief([pinned("thr_a", PR1), pinned("thr_b", PR2)], { acceptedGaps: GAPS })).prompt;
    expect(count(given, HEADING)).toBe(1);
    expect(count(given, GAPS)).toBe(1);
  });

  test("branch review: absent changes nothing, present adds the block after the focus line", () => {
    const input = { branch: "feature/x", pullRequestRef: PR1, focus: "the discount path", chiefThreadId: "thr_c" };
    const base = branchReviewBrief(input);
    expect(branchReviewBrief({ ...input, acceptedGaps: undefined })).toBe(base);
    expect(base).not.toContain("Accepted gaps");
    expect(base.split("\n")[block(branchReviewBrief({ ...input, acceptedGaps: GAPS }), base).index - 1]).toContain(focusLine);
    const unpinned = { branch: "feature/x", pullRequestRef: null, chiefThreadId: "thr_c" };
    expect(count(branchReviewBrief({ ...unpinned, acceptedGaps: GAPS }), HEADING)).toBe(1);
    expect(count(branchReviewBrief({ ...unpinned, acceptedGaps: GAPS }), GAPS)).toBe(1);
  });
});

describe("branchReviewBrief defaults", () => {
  // Contract: a branch review keeps native yes, reshape no, and has no Docs ownership section.
  test("renders the same native line as a feature-only review, and no Docs ownership", () => {
    const prompt = branchReviewBrief({ branch: "feature/x", pullRequestRef: PR1, chiefThreadId: "thr_c" });
    const featureOnly = reviewBrief(single({ feature: true, reshape: false })).prompt;
    const [index] = changedLines(featureOnly, reviewBrief(single({ feature: true, reshape: true })).prompt);
    expect(prompt.split("\n")).toContain(featureOnly.split("\n")[index!]);
    expect(prompt).not.toContain("## Docs ownership");
  });
});

describe("review-context.md: one read line or one inline copy", () => {
  /** Lines naming a context file path (`…review-context.md` in backticks): the read line. */
  const reads = (prompt: string) => prompt.split("\n").filter((line) => /`[^`]*\/review-context\.md`/.test(line));
  /** Lines before `## This review` that mention review-context.md. */
  const prefixMentions = (prompt: string) => {
    const lines = prompt.split("\n");
    const boundary = lines.indexOf("## This review");
    return lines.slice(0, boundary === -1 ? 0 : boundary).filter((line) => line.includes("review-context.md"));
  };
  // A review with no context file at all (empty context, inlined) is the baseline: its mentions are not the context-file rule.
  const emptyInput = brief([pinned("thr_a", PR1, { hasResult: false }), pinned("thr_b", PR2, { hasResult: false })], { wavePaths: [], chain: [], contractLines: [], contextPath: null });
  const baseline = prefixMentions(reviewBrief(emptyInput).prompt);
  /** The prefix rule about the context file: prefix mentions the no-context baseline lacks. */
  const rules = (prompt: string) => prefixMentions(prompt).filter((line) => !baseline.includes(line));

  test("a standalone review has neither a context read nor a prefix rule", () => {
    const prompt = branchReviewBrief({ branch: "feature/x", pullRequestRef: PR1, chiefThreadId: "thr_c" });
    expect(reads(prompt)).toEqual([]);
    expect(rules(prompt)).toEqual([]);
  });
  // Contract: with a path the prompt holds one read line and no copy of the context; with null it ends with `## review-context.md` and the context; an empty context renders neither.
  test("with a path: one read line, no inline heading, no wait rule, no Context list", () => {
    const { prompt, context } = reviewBrief(single());
    const lines = prompt.split("\n");
    const boundary = lines.indexOf("## This review");
    const read = lines.filter((line) => line.includes(single().contextPath!));
    expect(read).toHaveLength(1);
    expect(rules(prompt)).toHaveLength(1);
    expect(lines.indexOf(read[0]!)).toBeGreaterThan(boundary);
    expect(prompt.split("\n")).not.toContain("## review-context.md");
    expect(count(prompt, "Full report: /r/thr_a.md")).toBe(0);
    expect(context).toContain("Full report: /r/thr_a.md");
    expect(prompt).not.toContain("$BB_THREAD_STORAGE/review-context.md");
    expect(prompt.split("\n")).not.toContain("## Context");
  });

  test("with null: the prompt ends with the heading and the context, and has no read line", () => {
    const { prompt, context } = reviewBrief(single({ contextPath: null }));
    expect(prompt.endsWith(`\n\n## review-context.md\n${context}`)).toBe(true);
    expect(count(prompt, context)).toBe(1);
    expect(reads(prompt)).toEqual([]);
    expect(rules(prompt)).toEqual([]);
    expect(reviewBrief(single({ contextPath: undefined })).prompt).toBe(prompt);
  });

  test("an empty context writes nothing to name and nothing to inline", () => {
    const targets = [pinned("thr_a", PR1, { hasResult: false }), pinned("thr_b", PR2, { hasResult: false })];
    const input = brief(targets, { wavePaths: [], chain: [], contractLines: [] });
    expect(reviewContext(input)).toBe("");
    for (const contextPath of ["/ctx/review-context.md", null]) {
      const { prompt, context } = reviewBrief({ ...input, contextPath });
      expect(context).toBe("");
      expect(reads(prompt)).toEqual([]);
      expect(rules(prompt)).toEqual([]);
      expect(prompt.split("\n")).not.toContain("## review-context.md");
      expect(prompt.endsWith("\n")).toBe(false);
    }
  });

  test("reviewContext is the context reviewBrief returns", () => {
    const input = brief([pinned("thr_a", PR1), pinned("thr_b", PR2)]);
    expect(reviewContext(input)).toBe(reviewBrief(input).context);
  });
});

describe("checkPlan: feature and reshape flags", () => {
  const W = (n: number, extra: object = {}) => ({ body: `${wave(n)}\n\n## What we're NOT doing\n- x`, ...extra });

  // Contract: feature and reshape are booleans with spec's error shape, and never on a design wave; a plan with no such key gets the errors it always got.
  // Regression: accepting a string flag lets a wave that never reads as a feature gate the review.
  test("a valid plan with both flags is accepted, as is one without any", () => {
    expect(checkPlan([W(1, { feature: true }), W(2, { feature: true, reshape: true, dependsOn: [1] })])).toEqual([]);
    expect(checkPlan([W(1, { feature: false, reshape: false })])).toEqual([]);
    expect(checkPlan([W(1)])).toEqual([]);
  });

  test.each([["feature", "yes"], ["reshape", "yes"], ["feature", 1], ["reshape", null]])("refuses a non-boolean %s (%j) with one error that names it", (flag, value) => {
    expect(checkPlan([W(1, { [flag]: value })])).toEqual([
      `plan wave 1 ${flag} is ${JSON.stringify(value)} (${typeof value}); allowed true or false. Send a boolean, or drop ${flag}.`,
    ]);
  });

  test("reshape: true on a design wave: one error", () => {
    expect(checkPlan([W(1, { design: true, reshape: true }), W(2)])).toEqual([
      "plan wave 1 is reshape: true and design: true; feature and reshape mark an implementation wave only.",
    ]);
  });

  test("both flags wrong on one wave give both errors, feature first", () => {
    expect(checkPlan([W(1, { feature: "yes", reshape: "no" })])).toEqual([
      "plan wave 1 feature is \"yes\" (string); allowed true or false. Send a boolean, or drop feature.",
      "plan wave 1 reshape is \"no\" (string); allowed true or false. Send a boolean, or drop reshape.",
    ]);
  });
});
