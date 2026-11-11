import type { WorkerBriefInput } from "../src/research/delegationBrief";

type Kind = WorkerBriefInput["kind"];

const PRIOR: NonNullable<WorkerBriefInput["prior"]> = {
  thread_id: "thr_prior", verdict: null, verdict_path: null, summary: "Prior worker finished the module.", result: "Prior worker finished the module.\nDetails.",
  branch: "feature/x", issue_url: null, pr_url: null, plan_thread_id: null, plan_wave: null, kind: null, brief: null, verify_command: null, unplanned_reason: null,
  blocker: "Lint fails", recommendation: "Fix lint", report_path: "/reports/prior.md",
};
const FINDINGS: NonNullable<WorkerBriefInput["findings"]> = {
  thread_id: "thr_review", verdict: "request_changes", verdict_path: "/verdicts/v1.md", summary: null, result: "Totals go negative.", recommendation: "Fix totals first",
};
const STRUCTURED: NonNullable<WorkerBriefInput["structured"]> = [
  { file: "totals.ts", line: 3, severity: "blocking", message: "Totals go negative", fix: "Clamp at zero" },
  { file: "totals.ts", severity: "nit", message: "Rename total", fix: "Call it sum" },
];

/** Every normal-brief shape workerBrief renders: kind (spec-writer in both lanes) × planned × findings × prior × verifyCommand × specDocs × baseline. */
export function briefMatrix(): [string, WorkerBriefInput][] {
  const cells: [string, WorkerBriefInput][] = [];
  const kinds: [string, Kind, "side" | "implementation"][] = [
    ["worker", "worker", "implementation"], ["designer", "designer", "implementation"], ["tester", "tester", "implementation"],
    ["spec-writer side", "spec-writer", "side"], ["spec-writer implementation", "spec-writer", "implementation"],
  ];
  for (const [name, kind, lane] of kinds) for (const planned of [false, true]) for (const withFindings of [false, true]) for (const withPrior of [false, true])
    for (const verifyCommand of [null, "npm test"]) for (const specDocs of [[], ["- Wave 1 Spec Writer thr_w: report /r.md"]]) for (const baseline of [false, true]) {
      cells.push([`${name} planned=${planned} findings=${withFindings} prior=${withPrior} verify=${verifyCommand} specDocs=${specDocs.length} baseline=${baseline}`, {
        title: "Totals", chiefThreadId: "thr_chief",
        params: { mission: "Fix totals", successCriteria: ["Totals hold"], constraints: ["Keep the API"], context: planned ? "Extra context" : undefined },
        wave: planned ? 2 : undefined, waveTotal: planned ? 3 : undefined, waveNext: planned ? 3 : null, waveIndependent: false, designWave: false, implementsDesign: null,
        contracts: planned ? "- [ ] Totals hold" : undefined, planContextLine: planned ? "Plan file (wave 2 of 3): /plans/plan-2.md" : undefined,
        kind, verifyCommand, branch: "feature/x", issueUrl: "https://example.test/issues/1", prUrl: "https://example.test/pull/2",
        prior: withPrior ? PRIOR : undefined, findings: withFindings ? FINDINGS : undefined, structured: withFindings ? STRUCTURED : undefined,
        ruledOut: [{ scope: "api", text: "Do not rewrite", basis: "tried" }], specSources: kind === "tester" || kind === "spec-writer" ? ["Wave 1 of 3: /plans/plan-1.md"] : [],
        specDocs, baseline, specWave: planned && kind !== "tester", lane,
      }]);
    }
  return cells;
}
