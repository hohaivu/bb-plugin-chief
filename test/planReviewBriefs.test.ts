import { describe, expect, test } from "vitest";
import { advisorBrief, plannerBrief, type AdvisorBriefInput, type PlannerBriefInput } from "../src/research/delegationBrief";

const advisor = (plan: Partial<NonNullable<AdvisorBriefInput["plan"]>> = {}): string => advisorBrief({
  title: "Review plan", chiefThreadId: "thr_chief", mission: "Review this plan", reviews: [],
  plan: { plannerThreadId: "thr_plan", paths: ["/p/plan-1.md", "/p/plan-2.md"], summary: "The planner's own summary", reportPath: "/p/report-1.md", ...plan },
});
const reviser = (revision: Partial<NonNullable<PlannerBriefInput["revision"]>> = {}): string => plannerBrief({
  title: "Rework", chiefThreadId: "thr_chief", mission: "Revise per the advisor", research: false,
  revision: { plannerThreadId: "thr_plan", planPaths: ["/p/plan-1.md"], advisorThreadId: "thr_adv", advisorReportPath: "/p/adv/report-1.md", advisorSummary: "Merge the two waves", ...revision },
});
const lines = (text: string) => text.split("\n");

describe("advisor plan-review brief", () => {
  test("a planner report path is named once and the planner's summary is never copied", () => {
    const text = advisor();
    expect(lines(text).filter((line) => line.includes("/p/report-1.md"))).toHaveLength(1);
    expect(text).not.toContain("The planner's own summary");
  });

  test("with no report path the line names bb chief inspect for the planner", () => {
    const without = advisor({ reportPath: null });
    expect(without).toContain("bb chief inspect thr_plan");
    expect(without).not.toContain("/p/report-1.md");
  });
});

describe("planner revision brief", () => {
  // Regression: the summary copied next to the report file it summarizes, or dropped when it is the only copy of the advice.
  test("an advisor report path is listed and the advisor summary is not copied", () => {
    const text = reviser();
    expect(text).toContain("/p/adv/report-1.md");
    expect(text).not.toContain("Merge the two waves");
  });

  test("with no report path the summary is the only copy and shows", () => {
    const without = reviser({ advisorReportPath: null });
    expect(without).toContain("Merge the two waves");
    expect(without).not.toContain("/p/adv/report-1.md");
  });


});
