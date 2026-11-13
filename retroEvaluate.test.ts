import { describe, expect, test } from "vitest";
import { evaluate, type Manifest, type Observed } from "./src/observe/retro";
import { aggregate, applicableRubrics, lessonRole, RUBRIC_VERSION } from "./src/observe/rubrics";

describe("aggregate", () => {
  test("the spec's worked example fails and renormalizes to 0.8583", () => {
    const result = aggregate([
      { scorer: "efficiency", score: 0.8 },
      { scorer: "procedure-compliance", score: 1 },
      { scorer: "verbosity", score: 0.2 },
    ]);
    expect(result.status).toBe("fail");
    expect(result.failed).toBe(true);
    expect(result.raw).toEqual({ efficiency: 0.8, "procedure-compliance": 1, verbosity: 0.2 });
    expect(result.curved).toEqual({ efficiency: 0.9, "procedure-compliance": 1, verbosity: 0.6 });
    expect(result.overall).toBeCloseTo(0.8583, 4);
  });

  test("a raw score of exactly 0.5 passes and just below it fails", () => {
    expect(aggregate([{ scorer: "efficiency", score: 0.5 }]).status).toBe("pass");
    expect(aggregate([{ scorer: "efficiency", score: 0.49 }]).status).toBe("fail");
  });

  test("not_applicable leaves the set, insufficient_evidence keeps it so the thread cannot pass", () => {
    const names = ["efficiency", "test-redundancy"];
    expect(aggregate([{ scorer: "efficiency", score: 1, label: "highly_efficient" }, { scorer: "test-redundancy", score: null, label: "not_applicable" }], names)).toMatchObject({ status: "pass", overall: 1 });
    const insufficient = aggregate([{ scorer: "efficiency", score: 1, label: "highly_efficient" }, { scorer: "test-redundancy", score: null, label: "insufficient_evidence" }], names);
    expect(insufficient.status).toBe("insufficient");
    expect(insufficient.overall).toBe(1); // the scored dimensions still average
    expect(aggregate([{ scorer: "efficiency", score: 1 }], names).status).toBe("insufficient"); // a missing dimension counts the same
  });

  test("a thread with no scores is insufficient with no overall; a fail beats a missing dimension", () => {
    expect(aggregate([])).toMatchObject({ status: "insufficient", overall: null });
    expect(aggregate([{ scorer: "efficiency", score: 0.2 }], ["efficiency", "verbosity"]).status).toBe("fail");
  });

  test("only a Tester worker is judged on test-redundancy", () => {
    expect(applicableRubrics("tester")).toContain("test-redundancy");
    expect(applicableRubrics(null)).not.toContain("test-redundancy");
    expect(applicableRubrics("worker")).not.toContain("communication");
  });

  test("a lesson reaches reviewers only from the reviewer brief and Chief only from Chief's own surfaces", () => {
    expect([lessonRole("reviewer-brief"), lessonRole("chief-nudge"), lessonRole("chief"), lessonRole("chief-worker"), lessonRole("chief-role-reviewer"), lessonRole("worker-brief")])
      .toEqual(["reviewer", "chief", "chief", null, null, null]);
  });
});

describe("evaluate", () => {
  const observed: Observed = { nudges: 0, blocks: 0, reviewRounds: 0, briefChars: 100, alertChars: 0, estTokens: 25 };
  const manifest = (over: Partial<Manifest> = {}): Manifest => ({
    version: RUBRIC_VERSION, planId: "thr_plan", title: "Plan", chiefThreadId: "thr_chief", projectId: "proj_1",
    threads: [{ threadId: "thr_w1", role: "worker", kind: null, title: "Worker", file: "/x/thread-thr_w1.md", applicable: applicableRubrics(null), unavailable: null }],
    handoffs: [{ threadId: "thr_w1", role: "worker", title: "Worker", unavailable: null, observed }],
    handoffFile: "/x/handoffs.md", refs: { thr_w1: [3, 5], thr_chief: [9] }, dropped: [], ...over,
  });
  const scores = (efficiency = "highly_efficient", procedure = "fully_compliant", verbosity = "proportionate") => [
    { scorer: "efficiency", label: efficiency, reason: "direct", evidence: ["thr_w1#3"] },
    { scorer: "procedure-compliance", label: procedure, reason: "followed", evidence: [] },
    { scorer: "verbosity", label: verbosity, reason: "fine", evidence: [] },
  ];
  const lesson = (over: Record<string, unknown> = {}) => ({
    surface: "worker-brief", rule: "State the verify command in every brief.", missingOrWrong: "The brief had no verify command.", prevents: "A skipped verify run.",
    recurrence: "recurs", existingInstruction: null, evidence: ["thr_w1#3"], ...over,
  });
  const judged = (thread: Record<string, unknown> = {}, communication: unknown = null) => ({ threads: [{ threadId: "thr_w1", scores: scores(), lesson: null, ...thread }], communication });

  test("scores each requested thread against its rubrics and aggregates", () => {
    const [outcome] = evaluate(judged({ scores: scores("mostly_efficient", "fully_compliant", "verbose") }), manifest()).threads;
    expect(outcome!.lines.map((line) => [line.scorer, line.label, line.score])).toEqual([
      ["efficiency", "mostly_efficient", 0.8], ["procedure-compliance", "fully_compliant", 1], ["verbosity", "verbose", 0.2],
    ]);
    expect(outcome!.aggregate.status).toBe("fail");
    expect(outcome!.aggregate.overall).toBeCloseTo(0.8583, 4);
  });

  test("drops an invalid label, a duplicate, an empty reason and a rubric that does not apply; each leaves insufficient", () => {
    const given = [
      { scorer: "efficiency", label: "made_up_label", reason: "r", evidence: [] },
      { scorer: "procedure-compliance", label: "fully_compliant", reason: "   ", evidence: [] },
      { scorer: "verbosity", label: "proportionate", reason: "ok", evidence: [] },
      { scorer: "verbosity", label: "verbose", reason: "again", evidence: [] },
      { scorer: "test-redundancy", label: "lean", reason: "not a tester", evidence: [] },
    ];
    const result = evaluate(judged({ scores: given }), manifest());
    const lines = Object.fromEntries(result.threads[0]!.lines.map((line) => [line.scorer, line.label]));
    expect(lines).toEqual({ efficiency: "insufficient_evidence", "procedure-compliance": "insufficient_evidence", verbosity: "proportionate" });
    expect(result.threads[0]!.aggregate.status).toBe("insufficient");
    expect(result.notes).toHaveLength(4);
  });

  test("a result for a thread that was not requested is dropped and the requested thread is insufficient", () => {
    const result = evaluate({ threads: [{ threadId: "thr_other", scores: scores(), lesson: null }], communication: null }, manifest());
    expect(result.notes.join(" ")).toContain("thr_other");
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]!.aggregate.status).toBe("insufficient");
  });

  test("an unreadable judge result makes every thread insufficient and stores no lesson", () => {
    const result = evaluate("not an object", manifest());
    expect(result.threads[0]!.aggregate.status).toBe("insufficient");
    expect(result.lessons).toEqual([]);
  });

  test("an unavailable thread says why on each insufficient line", () => {
    const result = evaluate(null, manifest({ threads: [{ ...manifest().threads[0]!, unavailable: "events API down" }] }));
    expect(result.threads[0]!.lines.every((line) => line.reason.includes("events API down"))).toBe(true);
  });

  describe("the filing bar", () => {
    const failing = scores("highly_efficient", "fully_compliant", "verbose");
    const filed = (thread: Record<string, unknown>) => evaluate(judged({ scores: failing, ...thread }), manifest());

    test("a failing thread with a complete, new, cited lesson files it", () => {
      const result = filed({ lesson: lesson() });
      expect(result.lessons).toEqual([expect.objectContaining({ sourceThread: "thr_w1", surface: "worker-brief", rule: "State the verify command in every brief." })]);
      expect(result.dropped).toEqual([]);
    });

    test.each([
      ["a passing thread", { scores: scores(), lesson: lesson() }],
      ["an instruction that already existed", { lesson: lesson({ existingInstruction: "Run the verify command." }) }],
      ["an empty field", { lesson: lesson({ prevents: "  " }) }],
      ["an evidence ref that is not in the bundle", { lesson: lesson({ evidence: ["thr_w1#4"] }) }],
      ["an evidence ref of another unbundled thread", { lesson: lesson({ evidence: ["thr_ghost#3"] }) }],
      ["no evidence at all", { lesson: lesson({ evidence: [] }) }],
      ["an unknown surface", { lesson: lesson({ surface: "somewhere-else" }) }],
    ])("files no lesson for %s", (_name, thread) => {
      const result = filed(thread);
      expect(result.lessons).toEqual([]);
      expect(result.dropped).toHaveLength(1);
    });
  });

  describe("communication", () => {
    const signals = { briefGapBlock: true, askedTwice: true, unclearBriefRounds: null, userWordsLost: false };
    const handoff = (over: Record<string, unknown> = {}) => ({ threadId: "thr_w1", label: "costly_gaps", reason: "The constraint was never in the brief.", signals, evidence: ["thr_w1#3", "thr_chief#9"], ...over });

    test("stores the judge's label with the plugin-observed counts and the judge's signals", () => {
      const result = evaluate(judged({}, { handoffs: [handoff()], lessons: [] }), manifest());
      expect(result.handoffs[0]).toMatchObject({ threadId: "thr_w1", line: { scorer: "communication", label: "costly_gaps", score: 0.4 }, signals, observed });
      expect(result.handoffs[0]!.line.reason).toContain("thr_chief#9");
    });

    test("an unavailable counterpart is insufficient_evidence even when the judge says clear", () => {
      const unavailable = manifest({ handoffs: [{ threadId: "thr_w1", role: "worker", title: "Worker", unavailable: "the brief artifact is missing", observed }] });
      const result = evaluate(judged({}, { handoffs: [handoff({ label: "clear", signals: {} })], lessons: [] }), unavailable);
      expect(result.handoffs[0]!.line).toMatchObject({ label: "insufficient_evidence", score: null });
      expect(result.handoffs[0]!.status).toBe("insufficient");
    });

    test("a communication lesson is filed only against a failing handoff it cites", () => {
      const cited = (label: string) => evaluate(judged({}, { handoffs: [handoff({ label })], lessons: [lesson({ surface: "chief-delegate-brief", evidence: ["thr_w1#3", "thr_chief#9"] })] }), manifest());
      expect(cited("costly_gaps").lessons).toHaveLength(1);
      expect(cited("clear").lessons).toEqual([]);
    });
  });
});
