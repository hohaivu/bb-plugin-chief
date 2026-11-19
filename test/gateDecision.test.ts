import { describe, expect, test } from "vitest";
import { gateDecision, type ProgressRow } from "../src/plan/planProgress";
import type { GateTarget, ReviewGate } from "../src/db/threadStore";

// Contract: the review gate's decision, reviewer only. `gateDecision` is pure: it reads the gate row, the rows it names, the
// reviewer's newest verdict with its findings, and the Spec Writer rows. Blocking findings whose `file` starts with `docs/` are docs findings; the rest are code
// findings. The first matching rule wins.
type Row = ProgressRow;

const row = (id: string, over: Partial<Row> = {}): Row => ({
  thread_id: id, role: "worker", kind: null, state: "ready", last_report_state: "ready", created_at: 1,
  plan_thread_id: null, plan_wave: null, plan_waves: null, replaces_thread_id: null, report_seq: 1, branch: "feature/a",
  verdict: null, worker_thread_id: null, regression: null, findings: null, ...over,
});
const finding = (file: string, severity = "blocking") => ({ file, line: 3, severity, message: `Problem in ${file}`, fix: "Fix it" });
const reviewerRow = (over: Partial<Row> = {}, findings: ReturnType<typeof finding>[] = []) =>
  row("RV", { role: "reviewer", verdict: "approve", findings: JSON.stringify(findings), ...over });
const fixerRow = (over: Partial<Row> = {}) => row("FX", { kind: "worker", replaces_thread_id: "W", ...over });
const writerRow = (id: string, over: Partial<Row> = {}) => row(id, { kind: "spec-writer", ...over });

const TARGET: GateTarget = { threadId: "W", reportSeq: 1, branch: "feature/a", prUrl: "https://github.com/acme/shop/pull/1", headSha: "a".repeat(40), base: "main" };
const gateOf = (over: Partial<ReviewGate> = {}): ReviewGate => ({
  gate_key: "task:W", project_id: "proj_1", chief_thread_id: "CH", plan_thread_id: null, targets: [TARGET],
  reviewer_thread_id: "RV", tester_thread_id: null, fixer_thread_id: null, corrector_thread_id: null, created_at: 1, ...over,
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

describe("gateDecision: restart (the reviewer is missing, failed or blocked)", () => {
  test.each<[string, Row[], Partial<ReviewGate>]>([
    ["the reviewer thread is not set", [], { reviewer_thread_id: null }],
    ["the reviewer row is gone", [], {}],
    ["the reviewer failed", [reviewerRow({ state: "failed" })], {}],
    ["the reviewer is archived", [reviewerRow({ state: "archived" })], {}],
  ])("%s -> restart the reviewer", (_name, rows, gate) => {
    expect(decide(rows, { gate: gateOf(gate) })).toMatchObject({ kind: "restart", sides: ["reviewer"], blocked: [] });
  });

  test("a blocked reviewer is named as the environment blocker", () => {
    expect(decide([reviewerRow({ state: "blocked" })])).toMatchObject({ kind: "restart", sides: ["reviewer"], blocked: [expect.objectContaining({ thread_id: "RV" })] });
  });
});

describe("gateDecision: wait", () => {
  test.each(["active", "starting"])("a %s reviewer -> wait names it", (state) => {
    const decision = decide([reviewerRow({ state })]);
    expect(decision.kind).toBe("wait");
    expect((decision as { who: Row[] }).who.map((side) => side.thread_id)).toEqual(["RV"]);
  });
});

describe("gateDecision: the reviewer reported", () => {
  test("approve passes", () => {
    expect(decide([reviewerRow()])).toEqual({ kind: "pass" });
  });

  test("a gate whose reviewer completed with the last target still reads pass", () => {
    expect(decide([reviewerRow({ state: "complete" })])).toEqual({ kind: "pass" });
  });

  // Old gate rows may still name a tester or corrector: neither holds the gate.
  test("a legacy tester or corrector on an old gate is ignored", () => {
    const legacy = gateOf({ tester_thread_id: "TS", corrector_thread_id: "CR" });
    expect(decide([reviewerRow(), row("TS", { kind: "tester", state: "active" }), row("CR", { kind: "tester", state: "failed" })], { gate: legacy })).toEqual({ kind: "pass" });
  });

  test("request_changes with one blocking code finding is fix", () => {
    expect(decide([reviewerRow({ verdict: "request_changes" }, [finding("src/totals.ts")])])).toEqual({ kind: "fix", codeFindings: 1 });
  });

  test("two code findings are both counted", () => {
    expect(decide([reviewerRow({ verdict: "request_changes" }, [finding("src/a.ts"), finding("src/b.ts")])])).toEqual({ kind: "fix", codeFindings: 2 });
  });

  test("a nit is not a code finding: approve with only a nit passes", () => {
    expect(decide([reviewerRow({}, [finding("src/a.ts", "nit")])])).toEqual({ kind: "pass" });
  });

  test.each(["documentation/x.md", "src/docs/x.ts", "Docs/x.md", "README.md"])("a blocking finding on %s is a code finding (only a path starting with docs/ is docs)", (file) => {
    expect(decide([reviewerRow({ verdict: "request_changes" }, [finding(file)])])).toEqual({ kind: "fix", codeFindings: 1 });
  });

  test("a code finding wins over a docs finding: fix, with only the code finding counted", () => {
    const reviewer = reviewerRow({ verdict: "request_changes" }, [finding("docs/specs/x.md"), finding("src/a.ts")]);
    expect(decide([reviewer], { writers: [writerRow("SW", { created_at: BEFORE_VERDICT })] })).toEqual({ kind: "fix", codeFindings: 1 });
  });
});

describe("gateDecision: docs findings go to a Spec Writer repair, never to a fix run", () => {
  const docsReviewer = () => reviewerRow({ verdict: "request_changes" }, [finding("docs/specs/review.md")]);

  test("a docs finding with multiple gate Spec Writers escalates instead of choosing one", () => {
    const gate = gateOf({ targets: [TARGET, { ...TARGET, threadId: "SW1" }, { ...TARGET, threadId: "SW2" }] });
    const decision = decide([docsReviewer()], { gate, writers: [writerRow("SW1", { created_at: 10 }), writerRow("SW2", { created_at: 20 })] });
    expect(decision).toMatchObject({ kind: "escalate", why: expect.stringContaining("2 Spec Writers (SW1, SW2)") });
  });

  test("a docs finding with one gate Spec Writer and no repair yet is docsRepair to it", () => {
    const gate = gateOf({ targets: [TARGET, { ...TARGET, threadId: "SW1" }] });
    expect(decide([docsReviewer()], { gate, writers: [writerRow("SW1", { created_at: BEFORE_VERDICT })] })).toMatchObject({ kind: "docsRepair", writer: expect.objectContaining({ thread_id: "SW1" }) });
  });

  test("a docs finding with no Spec Writer on the branch escalates", () => {
    expect(decide([docsReviewer()], { writers: [] }).kind).toBe("escalate");
  });

  test("a busy repair created after the verdict is wait", () => {
    const repair = writerRow("SW3", { created_at: AFTER_VERDICT, state: "active" });
    expect(decide([docsReviewer()], { writers: [repair] })).toMatchObject({ kind: "wait", who: [expect.objectContaining({ thread_id: "SW3" })] });
  });

  test("a docs finding with a ready repair created after the verdict is settled: pass", () => {
    const repair = writerRow("SW3", { created_at: AFTER_VERDICT });
    expect(decide([docsReviewer()], { writers: [writerRow("SW1", { created_at: BEFORE_VERDICT }), repair] })).toEqual({ kind: "pass" });
  });
});

describe("gateDecision: the fix run", () => {
  const codeReviewer = () => reviewerRow({ verdict: "request_changes" }, [finding("src/a.ts")]);
  const withFixer = (fixer: Row, rows: Row[] = [codeReviewer()], writers: Row[] = []) =>
    decide([...rows, fixer], { gate: gateOf({ fixer_thread_id: "FX" }), writers });

  test("a busy fix run is wait, naming it", () => {
    const decision = withFixer(fixerRow({ state: "active" }));
    expect(decision.kind).toBe("wait");
    expect((decision as { who: Row[] }).who.map((side) => side.thread_id)).toEqual(["FX"]);
  });

  test("a ready fix run settles the code findings: pass", () => {
    expect(withFixer(fixerRow())).toEqual({ kind: "pass" });
  });

  test("a blocked fix run escalates, naming chief_continue", () => {
    const decision = withFixer(fixerRow({ state: "blocked", last_report_state: "blocked" }));
    expect(decision).toMatchObject({ kind: "escalate", why: expect.stringContaining("chief_continue (threadId: FX)") });
  });

  test("a failed fix run escalates (continue it, or escalate: never a second fix)", () => {
    expect(withFixer(fixerRow({ state: "failed" })).kind).toBe("escalate");
  });

  test("a fix run that stopped before it reported is absent: fix again", () => {
    expect(withFixer(fixerRow({ state: "failed", report_seq: 0, last_report_state: null })).kind).toBe("fix");
  });

  test("a ready fix run with a settled docs repair passes", () => {
    const rows = [reviewerRow({ verdict: "request_changes" }, [finding("docs/specs/x.md"), finding("src/a.ts")])];
    expect(withFixer(fixerRow(), rows, [writerRow("SW", { created_at: AFTER_VERDICT })])).toEqual({ kind: "pass" });
  });
});

describe("gateDecision: a target changed after the gate pinned it", () => {
  test("a newer report_seq on a target is escalate naming it, even when everything else would pass", () => {
    const decision = decide([row("W", { report_seq: 2 }), reviewerRow()]);
    expect(decision.kind).toBe("escalate");
    expect((decision as { why: string }).why).toContain("W changed after the gate pinned it");
  });

  test("a target at its pinned report_seq does not escalate", () => {
    expect(decide([row("W", { report_seq: 1 }), reviewerRow()])).toEqual({ kind: "pass" });
  });

  test("one moved target among two escalates and names that one", () => {
    const second: GateTarget = { ...TARGET, threadId: "W2", branch: "feature/b" };
    const decision = decide([row("W2", { report_seq: 2 }), reviewerRow()], { gate: gateOf({ targets: [TARGET, second] }) });
    expect(decision.kind).toBe("escalate");
    expect((decision as { why: string }).why).toContain("W2 changed after the gate pinned it");
  });
});
