import { describe, expect, test } from "vitest";
import { advisorBrief, plannerBrief, type AdvisorBriefInput, type PlannerBriefInput } from "./src/research/delegationBrief";
import { contractItems, expectLoadLine } from "./test/loadLine";

// Contracts (shrink-prompts wave 1, plan-1.md, item 5b): the advisor plan-review brief has no `Planner result:` line and has a `Planner report:` line naming
// the file, or `bb chief inspect <planner id>` when there is none; the reviser brief shows `Advisor summary:` only when the advisor has no report path;
// every other line of both briefs is unchanged. Both are pure functions of their input, so each test varies one field and compares the two renders line by line.

const advisor = (plan: Partial<NonNullable<AdvisorBriefInput["plan"]>> = {}): string => advisorBrief({
  title: "Review plan", chiefThreadId: "thr_chief", mission: "Review this plan", reviews: [],
  plan: { plannerThreadId: "thr_plan", paths: ["/p/plan-1.md", "/p/plan-2.md"], summary: "The planner's own summary", reportPath: "/p/report-1.md", ...plan },
});
const reviser = (revision: Partial<NonNullable<PlannerBriefInput["revision"]>> = {}): string => plannerBrief({
  title: "Rework", chiefThreadId: "thr_chief", mission: "Revise per the advisor", research: false,
  revision: { plannerThreadId: "thr_plan", planPaths: ["/p/plan-1.md"], advisorThreadId: "thr_adv", advisorReportPath: "/p/adv/report-1.md", advisorSummary: "Merge the two waves", ...revision },
});
const lines = (text: string) => text.split("\n");
/** The lines of `a` that `b` does not have, and the other way round. */
const diff = (a: string, b: string) => ({ onlyA: lines(a).filter((line) => !lines(b).includes(line)), onlyB: lines(b).filter((line) => !lines(a).includes(line)) });

describe("advisor plan-review brief", () => {
  test("a planner report path is named once and the planner's summary is never copied", () => {
    const text = advisor();
    expect(lines(text).filter((line) => line.startsWith("Planner report:"))).toEqual(["Planner report: /p/report-1.md"]);
    expect(text).not.toContain("Planner result:");
    expect(text).not.toContain("The planner's own summary");
  });

  test("with no report path the line names bb chief inspect for the planner; nothing else changes", () => {
    const withPath = advisor();
    const without = advisor({ reportPath: null });
    expect(lines(without)).toContain("Planner report: bb chief inspect thr_plan");
    expect(diff(withPath, without)).toEqual({ onlyA: ["Planner report: /p/report-1.md"], onlyB: ["Planner report: bb chief inspect thr_plan"] });
  });

  test("a consult with no plan has no Planner report line", () => {
    expect(advisorBrief({ title: "Totals", chiefThreadId: "thr_chief", mission: "Why do totals go negative?", reviews: [] })).not.toContain("Planner report:");
  });
});

describe("planner revision brief", () => {
  // Regression: the summary copied next to the report file it summarizes, or dropped when it is the only copy of the advice.
  test("an advisor report path is listed and the advisor summary is not copied", () => {
    const text = reviser();
    expect(lines(text)).toContain("- Advisor report: /p/adv/report-1.md");
    expect(text).not.toContain("Advisor summary:");
    expect(text).not.toContain("Merge the two waves");
  });

  test("with no report path the summary is the only copy and shows; nothing else changes but the report line", () => {
    const withPath = reviser();
    const without = reviser({ advisorReportPath: null });
    expect(lines(without)).toContain("Advisor summary: Merge the two waves");
    expect(diff(withPath, without)).toEqual({ onlyA: ["- Advisor report: /p/adv/report-1.md"], onlyB: ["Advisor summary: Merge the two waves"] });
  });

  test("with neither a report path nor a summary, neither line shows", () => {
    const text = reviser({ advisorReportPath: null, advisorSummary: null });
    expect(text).not.toContain("Advisor report:");
    expect(text).not.toContain("Advisor summary:");
  });

  test("the working contract is the load line, the read-only item and the wave cap, whether or not the brief revises", () => {
    for (const text of [reviser(), plannerBrief({ title: "Rework", chiefThreadId: "thr_chief", mission: "Plan it", research: false })]) {
      expectLoadLine(text, "planner");
      expect(contractItems(text)).toHaveLength(3);
    }
  });
});
