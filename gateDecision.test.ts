import { describe, expect, test } from "vitest";
import { gateDecision, type ProgressRow } from "./src/plan/planProgress";
import type { GateTarget, ReviewGate } from "./src/db/threadStore";

// Contract: plan-4.md step C, with plan-5.md rules 4-5 (fix run and corrector). `gateDecision` is pure: it reads the gate row, the rows it names, the
// reviewer's newest verdict with its findings, and the Spec Writer rows. Blocking findings whose `file` starts with `docs/` are docs findings; the rest are code
// findings. The first matching rule wins.
type Row = ProgressRow;

const row = (id: string, over: Partial<Row> = {}): Row => ({
  thread_id: id, role: "worker", kind: null, state: "ready", last_report_state: "ready", created_at: 1,
  plan_thread_id: null, plan_wave: null, plan_waves: null, replaces_thread_id: null, report_seq: 1, branch: "feature/a",
  verdict: null, worker_thread_id: null, regression: null, findings: null, tests_passed: null, ...over,
});
const finding = (file: string, severity = "blocking") => ({ file, line: 3, severity, message: `Problem in ${file}`, fix: "Fix it" });
const reviewerRow = (over: Partial<Row> = {}, findings: ReturnType<typeof finding>[] = []) =>
  row("RV", { role: "reviewer", verdict: "approve", findings: JSON.stringify(findings), ...over });
const testerRow = (over: Partial<Row> = {}) => row("TS", { kind: "tester", tests_passed: 1, ...over });
const fixerRow = (over: Partial<Row> = {}) => row("FX", { kind: "worker", replaces_thread_id: "TS", tests_passed: 1, ...over });
const correctorRow = (over: Partial<Row> = {}) => row("CR", { kind: "tester", replaces_thread_id: "FX", tests_passed: 1, ...over });
const writerRow = (id: string, over: Partial<Row> = {}) => row(id, { kind: "spec-writer", ...over });

const TARGET: GateTarget = { threadId: "W", reportSeq: 1, branch: "feature/a", prUrl: "https://github.com/acme/shop/pull/1", headSha: "a".repeat(40), base: "main" };
const gateOf = (over: Partial<ReviewGate> = {}): ReviewGate => ({
  gate_key: "task:W", project_id: "proj_1", chief_thread_id: "CH", plan_thread_id: null, targets: [TARGET],
  reviewer_thread_id: "RV", tester_thread_id: "TS", fixer_thread_id: null, corrector_thread_id: null, created_at: 1, ...over,
});

const VERDICT_AT = 100;
const BEFORE_VERDICT = 50;
const AFTER_VERDICT = 200;
const TERMINAL = new Set(["complete", "archived", "deleted"]);

/** The gate over `rows` (the target W is added at its pinned report unless a row for it is given). */
function decide(rows: Row[], over: { gate?: ReviewGate | undefined; writers?: Row[]; startRefusal?: string | null } = {}) {
  const byId = new Map([row("W"), ...rows].map((each) => [each.thread_id, each] as const));
  const writers = over.writers ?? [];
  for (const writer of writers) byId.set(writer.thread_id, writer);
  return gateDecision({
    gate: "gate" in over ? over.gate : gateOf(), row: (id) => byId.get(id), startRefusal: over.startRefusal ?? null,
    verdictAt: VERDICT_AT, writers, terminal: (state) => TERMINAL.has(state),
  });
}

describe("gateDecision: no gate yet", () => {
  test("rule 1: start when readiness passes", () => {
    expect(decide([], { gate: undefined })).toEqual({ kind: "start" });
  });

  test("rule 1: block with the readiness refusal when it does not", () => {
    expect(decide([], { gate: undefined, startRefusal: "wave 2 is still pending" })).toEqual({ kind: "block", refusal: "wave 2 is still pending" });
  });
});

describe("gateDecision: restart (a side is missing, failed or blocked)", () => {
  test.each<[string, Row[], Partial<ReviewGate>, string[]]>([
    ["the reviewer thread is not set", [testerRow()], { reviewer_thread_id: null }, ["reviewer"]],
    ["the reviewer row is gone", [testerRow()], {}, ["reviewer"]],
    ["the tester thread is not set", [reviewerRow()], { tester_thread_id: null }, ["tester"]],
    ["the reviewer failed", [reviewerRow({ state: "failed" }), testerRow()], {}, ["reviewer"]],
    ["the tester failed", [reviewerRow(), testerRow({ state: "failed" })], {}, ["tester"]],
    ["both failed", [reviewerRow({ state: "failed" }), testerRow({ state: "failed" })], {}, ["reviewer", "tester"]],
    ["the reviewer is archived", [reviewerRow({ state: "archived" }), testerRow()], {}, ["reviewer"]],
  ])("rule 2: %s -> restart names only that side", (_name, rows, gate, sides) => {
    const decision = decide(rows, { gate: gateOf(gate) });
    expect(decision).toMatchObject({ kind: "restart", sides });
  });

  test("rule 2: a blocked tester names its row as the environment blocker", () => {
    const tester = testerRow({ state: "blocked", last_report_state: "blocked" });
    const decision = decide([reviewerRow(), tester]);
    expect(decision).toMatchObject({ kind: "restart", sides: ["tester"] });
    expect(decision).toMatchObject({ blocked: [expect.objectContaining({ thread_id: "TS" })] });
  });

  test("rule 2: a blocked reviewer and a blocked tester are both named", () => {
    const decision = decide([reviewerRow({ state: "blocked" }), testerRow({ state: "blocked" })]);
    expect(decision).toMatchObject({ kind: "restart", sides: ["reviewer", "tester"] });
    expect((decision as { blocked: Row[] }).blocked.map((side) => side.thread_id)).toEqual(["RV", "TS"]);
  });

  test("rule 2 comes before rule 3: a failed reviewer restarts even while the tester is busy", () => {
    expect(decide([reviewerRow({ state: "failed" }), testerRow({ state: "active" })])).toMatchObject({ kind: "restart", sides: ["reviewer"] });
  });
});

describe("gateDecision: wait (a side is busy)", () => {
  test.each<[string, Row[], string[]]>([
    ["the reviewer is active", [reviewerRow({ state: "active" }), testerRow()], ["RV"]],
    ["the tester is active", [reviewerRow(), testerRow({ state: "active" })], ["TS"]],
    ["the tester is starting", [reviewerRow(), testerRow({ state: "starting" })], ["TS"]],
    ["both are busy", [reviewerRow({ state: "active" }), testerRow({ state: "active" })], ["RV", "TS"]],
  ])("rule 3: %s -> wait names who", (_name, rows, who) => {
    const decision = decide(rows);
    expect(decision.kind).toBe("wait");
    expect((decision as { who: Row[] }).who.map((side) => side.thread_id)).toEqual(who);
  });
});

describe("gateDecision: both sides reported (rule 6)", () => {
  test("approve with green tests passes", () => {
    expect(decide([reviewerRow(), testerRow()])).toEqual({ kind: "pass" });
  });

  test("a gate whose actors completed with the last target still reads pass", () => {
    expect(decide([reviewerRow({ state: "complete" }), testerRow({ state: "complete" })])).toEqual({ kind: "pass" });
  });

  test("approve with red tests (tests_passed=0) is fix, red tests only", () => {
    expect(decide([reviewerRow(), testerRow({ tests_passed: 0 })])).toEqual({ kind: "fix", redTests: true, codeFindings: 0 });
  });

  test("request_changes with one blocking code finding and green tests is fix", () => {
    const reviewer = reviewerRow({ verdict: "request_changes" }, [finding("src/totals.ts")]);
    expect(decide([reviewer, testerRow()])).toEqual({ kind: "fix", redTests: false, codeFindings: 1 });
  });

  test("red tests and two code findings are fix with both counted", () => {
    const reviewer = reviewerRow({ verdict: "request_changes" }, [finding("src/a.ts"), finding("src/b.ts")]);
    expect(decide([reviewer, testerRow({ tests_passed: 0 })])).toEqual({ kind: "fix", redTests: true, codeFindings: 2 });
  });

  test("a nit is not a code finding: approve with only a nit and green tests passes", () => {
    expect(decide([reviewerRow({}, [finding("src/a.ts", "nit")]), testerRow()])).toEqual({ kind: "pass" });
  });

  test.each(["documentation/x.md", "src/docs/x.ts", "Docs/x.md", "README.md"])("a blocking finding on %s is a code finding (only a path starting with docs/ is docs)", (file) => {
    const reviewer = reviewerRow({ verdict: "request_changes" }, [finding(file)]);
    expect(decide([reviewer, testerRow()])).toEqual({ kind: "fix", redTests: false, codeFindings: 1 });
  });

  test("a code finding wins over a docs finding: fix, with only the code finding counted", () => {
    const reviewer = reviewerRow({ verdict: "request_changes" }, [finding("docs/specs/x.md"), finding("src/a.ts")]);
    expect(decide([reviewer, testerRow()], { writers: [writerRow("SW", { created_at: BEFORE_VERDICT })] }))
      .toEqual({ kind: "fix", redTests: false, codeFindings: 1 });
  });
});

describe("gateDecision: docs findings go to a Spec Writer repair, never to a fix run", () => {
  const docsReviewer = () => reviewerRow({ verdict: "request_changes" }, [finding("docs/specs/review.md")]);

  // The Spec Writers of the gate are gate targets (the gate opens once every implementation wave and every Spec Writer is ready); the repair goes to the latest.
  test("a docs finding with multiple gate Spec Writers escalates instead of choosing one", () => {
    const older = writerRow("SW1", { created_at: 10 });
    const latest = writerRow("SW2", { created_at: 20 });
    const gate = gateOf({ targets: [TARGET, { ...TARGET, threadId: "SW1" }, { ...TARGET, threadId: "SW2" }] });
    const decision = decide([docsReviewer(), testerRow()], { gate, writers: [older, latest] });
    expect(decision).toMatchObject({ kind: "escalate", why: expect.stringContaining("2 Spec Writers (SW1, SW2)") });
  });

  test("a docs finding with no Spec Writer on the branch escalates", () => {
    expect(decide([docsReviewer(), testerRow()], { writers: [] }).kind).toBe("escalate");
  });

  test("a docs finding with a ready repair created after the verdict is settled: pass", () => {
    const repair = writerRow("SW3", { created_at: AFTER_VERDICT });
    expect(decide([docsReviewer(), testerRow()], { writers: [writerRow("SW1", { created_at: BEFORE_VERDICT }), repair] })).toEqual({ kind: "pass" });
  });

  test("docs findings with red tests are fix: the fix run never touches docs, and the repair waits for it", () => {
    const decision = decide([docsReviewer(), testerRow({ tests_passed: 0 })], { writers: [writerRow("SW", { created_at: BEFORE_VERDICT })] });
    expect(decision).toEqual({ kind: "fix", redTests: true, codeFindings: 0 });
  });
});

describe("gateDecision: the corrector (rule 4)", () => {
  const withCorrector = (corrector: Row, rows: Row[] = [reviewerRow(), testerRow({ tests_passed: 0 }), fixerRow({ state: "blocked", tests_passed: null })]) =>
    decide([...rows, corrector], { gate: gateOf({ fixer_thread_id: "FX", corrector_thread_id: "CR" }) });

  test("a busy corrector is wait, naming it", () => {
    const decision = withCorrector(correctorRow({ state: "active" }));
    expect(decision.kind).toBe("wait");
    expect((decision as { who: Row[] }).who.map((side) => side.thread_id)).toEqual(["CR"]);
  });

  test("a ready corrector with green tests and docs settled passes, whatever the tester and the blocked fix run said", () => {
    expect(withCorrector(correctorRow())).toEqual({ kind: "pass" });
  });

  test("a ready corrector with red tests escalates, and no second fix is offered", () => {
    expect(withCorrector(correctorRow({ tests_passed: 0 })).kind).toBe("escalate");
  });

  test("a blocked corrector escalates", () => {
    expect(withCorrector(correctorRow({ state: "blocked", tests_passed: null })).kind).toBe("escalate");
  });

  test("a failed corrector escalates", () => {
    expect(withCorrector(correctorRow({ state: "failed", tests_passed: null })).kind).toBe("escalate");
  });

  test("a green corrector with an unsettled docs finding escalates", () => {
    const rows = [reviewerRow({ verdict: "request_changes" }, [finding("docs/specs/x.md")]), testerRow({ tests_passed: 0 }), fixerRow({ state: "blocked", tests_passed: null })];
    expect(withCorrector(correctorRow(), rows).kind).toBe("escalate");
  });
});

describe("gateDecision: the fix run (rule 5)", () => {
  const withFixer = (fixer: Row, rows: Row[] = [reviewerRow(), testerRow({ tests_passed: 0 })], writers: Row[] = []) =>
    decide([...rows, fixer], { gate: gateOf({ fixer_thread_id: "FX" }), writers });

  test("a busy fix run is wait, naming it", () => {
    const decision = withFixer(fixerRow({ state: "active", tests_passed: null }));
    expect(decision.kind).toBe("wait");
    expect((decision as { who: Row[] }).who.map((side) => side.thread_id)).toEqual(["FX"]);
  });

  test("a ready fix run with green tests passes although the tester reported red", () => {
    expect(withFixer(fixerRow())).toEqual({ kind: "pass" });
  });

  test("a ready fix run settles code findings the reviewer raised", () => {
    const rows = [reviewerRow({ verdict: "request_changes" }, [finding("src/a.ts")]), testerRow()];
    expect(withFixer(fixerRow(), rows)).toEqual({ kind: "pass" });
  });

  test("a blocked fix run is wrongTest, naming it (corrector or escalate)", () => {
    const decision = withFixer(fixerRow({ state: "blocked", tests_passed: null, blocker: "totals.test.ts:12 contradicts the plan." }));
    expect(decision).toMatchObject({ kind: "wrongTest", fixer: expect.objectContaining({ thread_id: "FX" }) });
  });

  test("a failed fix run is escalate (continue it, or escalate: never a second fix)", () => {
    expect(withFixer(fixerRow({ state: "failed", tests_passed: null })).kind).toBe("escalate");
  });

  test("a ready fix run with green tests and a settled docs repair passes", () => {
    const rows = [reviewerRow({ verdict: "request_changes" }, [finding("docs/specs/x.md")]), testerRow({ tests_passed: 0 })];
    expect(withFixer(fixerRow(), rows, [writerRow("SW", { created_at: AFTER_VERDICT })])).toEqual({ kind: "pass" });
  });
});

describe("gateDecision: a target changed after the gate pinned it", () => {
  test("a newer report_seq on a target is escalate naming it, even when everything else would pass", () => {
    const decision = decide([row("W", { report_seq: 2 }), reviewerRow(), testerRow()]);
    expect(decision.kind).toBe("escalate");
    expect((decision as { why: string }).why).toContain("W changed after the gate pinned it");
  });

  test("it escalates in the fix state too", () => {
    const decision = decide([row("W", { report_seq: 3 }), reviewerRow(), testerRow({ tests_passed: 0 })]);
    expect(decision.kind).toBe("escalate");
  });

  test("a target at its pinned report_seq does not escalate", () => {
    expect(decide([row("W", { report_seq: 1 }), reviewerRow(), testerRow()])).toEqual({ kind: "pass" });
  });

  test("one moved target among two escalates and names that one", () => {
    const second: GateTarget = { ...TARGET, threadId: "W2", branch: "feature/b" };
    const decision = decide([row("W2", { report_seq: 2 }), reviewerRow(), testerRow()], { gate: gateOf({ targets: [TARGET, second] }) });
    expect(decision.kind).toBe("escalate");
    expect((decision as { why: string }).why).toContain("W2 changed after the gate pinned it");
  });
});
