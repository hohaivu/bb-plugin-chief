import { describe, expect, test } from "vitest";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
import { ADOPT_LINE, DOCS_RULE_NEW, DOCS_RULE_OLD, SPEC_WRITER_BOUNDARY, TESTER_BOUNDARY, TRAILER_LINE, WORKER_BOUNDARY } from "./test/docsOwnership";

// Contracts C1 and C2 (plan wave 1, "Only the Spec Writer edits docs/ everywhere"), at the `workerBrief` boundary.
// C1: every worker and designer brief states its one role-boundary line (tests and docs bans with the `## Docs needed` route) exactly once, on every wave kind and on unplanned work.
// A tester brief states its test-files-only boundary once and carries no `## Docs needed` route: the route lives in the role skills.
// C2: a Spec Writer brief (either lane) states no docs rule, and carries its docs-only boundary with the trailer exactly once. No other kind carries the trailer.
// The old long rule lines and the adoption line moved into the role skills (wave 2): no brief renders them any more.
// A waived spec wave reaches workerBrief as an ordinary planned wave (specWave false), so it shares the "planned, not a spec wave" input.
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
  const lines = (text: string, line: string) => text.split("\n").filter((entry) => entry === line).length;
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  describe.each(["worker", "designer"] as const)("%s", (kind) => {
    test.each(worlds)("C1: %s: the boundary line is stated once, with its Docs needed route; no trailer or adoption line", (_label, extra) => {
      const { prompt } = workerBrief(base(kind, extra));
      expect(lines(prompt, WORKER_BOUNDARY)).toBe(1);
      expect(lines(prompt, TESTER_BOUNDARY)).toBe(0);
      expect(count(prompt, "## Docs needed")).toBe(1);
      expect(lines(prompt, DOCS_RULE_NEW)).toBe(0);
      expect(lines(prompt, DOCS_RULE_OLD)).toBe(0);
      expect(count(prompt, "Chief-Spec-Writer")).toBe(0);
      expect(count(prompt, "## Adopted docs commits")).toBe(0);
    });
  });

  // Regression: the Docs needed route kept for a tester (the contradiction wave 1 removed), or the rule removed from the tester altogether.
  describe("tester", () => {
    test.each(worlds)("C1: %s: the test-files-only boundary is stated once, with no Docs needed route; no trailer or adoption line", (_label, extra) => {
      const { prompt } = workerBrief(base("tester", extra));
      expect(lines(prompt, TESTER_BOUNDARY)).toBe(1);
      expect(lines(prompt, WORKER_BOUNDARY)).toBe(0);
      expect(lines(prompt, DOCS_RULE_OLD)).toBe(0);
      expect(lines(prompt, DOCS_RULE_NEW)).toBe(0);
      expect(count(prompt, "## Docs needed")).toBe(0);
      expect(count(prompt, "Chief-Spec-Writer")).toBe(0);
      expect(count(prompt, "## Adopted docs commits")).toBe(0);
    });
  });

  describe("spec-writer", () => {
    const writers: [string, Partial<WorkerBriefInput>][] = [
      ["side lane on a spec wave", { ...planned, specWave: true, lane: "side" }],
      ["implementation lane on a non-spec wave", { ...planned, lane: "implementation" }],
      ["implementation lane on a spec wave", { ...planned, specWave: true, lane: "implementation" }],
      ["unplanned", {}],
    ];
    test.each(writers)("C2: %s: no docs rule; the docs-only boundary with the trailer appears once", (_label, extra) => {
      const { prompt } = workerBrief(base("spec-writer", extra));
      expect(lines(prompt, SPEC_WRITER_BOUNDARY)).toBe(1);
      expect(count(prompt, "Chief-Spec-Writer: $BB_THREAD_ID")).toBe(1);
      expect(lines(prompt, WORKER_BOUNDARY)).toBe(0);
      expect(lines(prompt, TRAILER_LINE)).toBe(0);
      expect(lines(prompt, ADOPT_LINE)).toBe(0);
      expect(lines(prompt, DOCS_RULE_NEW)).toBe(0);
      expect(lines(prompt, DOCS_RULE_OLD)).toBe(0);
      expect(count(prompt, "## Docs needed")).toBe(0);
      expect(count(prompt, "Never change docs/")).toBe(0);
    });
  });
});
