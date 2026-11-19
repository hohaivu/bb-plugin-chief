import { describe, expect, test } from "vitest";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
describe("docs ownership in the worker brief", () => {
  type Kind = WorkerBriefInput["kind"];
  const base = (kind: Kind, extra: Partial<WorkerBriefInput> = {}): WorkerBriefInput => ({
    title: "Totals", chiefThreadId: "thr_chief", params: { mission: "Fix totals", successCriteria: ["Totals hold"], constraints: [], context: undefined },
    wave: undefined, waveTotal: undefined, waveNext: null, waveIndependent: false, designWave: false, implementsDesign: null, contracts: undefined, planContextLine: undefined,
    kind, verifyCommand: null, branch: "feature/x", issueUrl: undefined, prUrl: undefined, prior: undefined, findings: undefined, structured: undefined, ruledOut: [], specSources: [],
    ...extra,
  });
  const planned = { wave: 1, waveTotal: 2, planContextLine: "Plan file (wave 1 of 2): /plans/plan-1.md", contracts: "- Totals hold" };
  const worlds: [string, Partial<WorkerBriefInput>][] = [
    ["unplanned", {}],
    ["planned, no spec delta (or a waived one)", planned],
    ["planned spec wave", { ...planned, specWave: true, specDocs: [] }],
  ];
  describe.each(["worker", "designer"] as const)("%s", (kind) => {
    test.each(worlds)("%s: does not render an Adopted docs commits section", (_label, extra) => {
      const { prompt } = workerBrief(base(kind, extra));
      expect(prompt).not.toMatch(/^## Adopted docs commits$/m);
    });
  });

  describe("spec-writer", () => {
    const writers: [string, Partial<WorkerBriefInput>][] = [
      ["side lane on a spec wave", { ...planned, specWave: true, lane: "side" }],
      ["implementation lane on a non-spec wave", { ...planned, lane: "implementation" }],
      ["implementation lane on a spec wave", { ...planned, specWave: true, lane: "implementation" }],
      ["unplanned", {}],
    ];
    test.each(writers)("%s: renders Fold only for the side lane", (_label, extra) => {
      const { prompt } = workerBrief(base("spec-writer", extra));
      expect(/^## Fold$/m.test(prompt)).toBe(extra.lane === "side");
    });
  });
});
