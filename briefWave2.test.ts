import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
type Kind = WorkerBriefInput["kind"];
const contractList = (tag: string, size: number) => Array.from({ length: Math.ceil(size / 19) }, (_, i) => `- ${tag} item ${String(i).padStart(4, "0")} holds`).join("\n");
const input = (kind: Kind, extra: Partial<WorkerBriefInput> = {}): WorkerBriefInput => ({
  title: "Totals", chiefThreadId: "thr_chief", params: { mission: "Fix totals", successCriteria: [], constraints: [], context: undefined },
  wave: undefined, waveTotal: undefined, waveNext: null, waveIndependent: false, designWave: false, implementsDesign: null, contracts: undefined, planContextLine: undefined,
  kind, verifyCommand: null, branch: undefined, issueUrl: undefined, prUrl: undefined, prior: undefined, findings: undefined, structured: undefined, ruledOut: [], specSources: [],
  ...extra,
});
const brief = (kind: Kind, extra: Partial<WorkerBriefInput> = {}) => workerBrief(input(kind, extra));
const section = (text: string, heading: string) => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
const PLANNED = { wave: 2, waveTotal: 3, planContextLine: "Plan file (wave 2 of 3): /plans/plan-2.md" };
const prior = { thread_id: "thr_prev", result: "Done.", summary: null, blocker: null, recommendation: null, report_path: null, kind: "worker" } as unknown as WorkerBriefInput["prior"];

describe("dynamic values stay in the prompt", () => {
  const full = (kind: Kind, extra: Partial<WorkerBriefInput> = {}) => brief(kind, { ...PLANNED, branch: "feature/totals", issueUrl: "https://example.com/issues/7", prUrl: "https://example.com/pull/8", prior, ...extra }).prompt;

  test.each(["worker", "designer", "tester"] as const)("a %s Git workflow includes the branch, prior thread, issue and PR", (kind) => {
    const git = section(full(kind), "Git workflow");
    expect(git).toContain("feature/totals");
    expect(git).toContain("thr_prev");
    expect(git).toContain("https://example.com/issues/7");
    expect(git).toContain("https://example.com/pull/8");
  });

  test("a side-lane Spec Writer includes the target branch in Fold and Git workflow", () => {
    const text = full("spec-writer", { lane: "side" });
    expect(section(text, "Fold")).toContain("feature/totals");
    expect(section(text, "Git workflow")).toContain("feature/totals");
  });
});

describe("sections that depend on the input", () => {
  test("no branch, issue or PR: no Git workflow; a non-side brief has no Fold", () => {
    for (const kind of ["worker", "designer", "tester", "spec-writer"] as const) {
      const text = brief(kind).prompt;
      expect(text, kind).not.toContain("## Git workflow");
      expect(text, kind).not.toContain("## Fold");
    }
    expect(brief("worker", { issueUrl: "https://example.com/issues/7" }).prompt).toContain("## Git workflow");
    expect(brief("worker", { branch: "feature/x" }).prompt).not.toContain("## Fold");
  });

  test("the stored brief and the reviewer's brief never held the Working contract", () => {
    const result = brief("worker", { ...PLANNED, branch: "feature/x" });
    for (const text of [result.brief, result.reviewerBrief]) {
      expect(text).not.toContain("## Working contract");
    }
  });
});

describe("brief size", () => {
  // Regression: the static rules, or the contract list, come back into the worker or tester brief.
  test.each(["worker", "tester"] as const)("a %s brief with branch, issue, PR and a 3,000-character contract list is at least 2,500 characters shorter than at 6534bea", async (kind) => {
    const old = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "brief-sizes-6534bea.json"), "utf8")) as Record<string, string>;
    const now = brief(kind, { ...PLANNED, contracts: contractList("W2", 3_000), branch: "feature/totals", issueUrl: "https://example.com/issues/7", prUrl: "https://example.com/pull/8", verifyCommand: "npx tsc --noEmit" }).prompt;
    expect(old[kind]!.length - now.length).toBeGreaterThanOrEqual(2_500);
  });
});
