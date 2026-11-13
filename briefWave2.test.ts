import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
import { contractItems, expectLoadLine } from "./test/loadLine";

// Contracts (shrink-prompts wave 2, plan-2.md "Contracts to verify"), proven through `workerBrief`: every non-evidence worker-kind brief opens its Working contract
// with the load line for the skills of its role and kind; every dynamic value stays in the prompt; a brief with no branch, issue or PR has no `## Git workflow`;
// only a side-lane Spec Writer has `## Fold`; the stored brief and the reviewer's brief never held the Working contract. Wave 1 and 2 together make a worker
// brief at least 2,500 characters shorter than at 6534bea (test/fixtures/brief-sizes-6534bea.json holds the two prompts captured there for the input below).
// Reviewer-only (tests do not assert on SKILL.md text or git history): skill equivalence of the moved rules, no weakening of a skill rule, and the owned-commit scope.

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

describe("load line: the first Working contract item names the role's skills", () => {
  // Regression: a kind with another kind's skills (a tester without chief-role-worker), no load line, or the line moved below the boundary line.
  test.each<[string, Kind, Partial<WorkerBriefInput>]>([
    ["worker", "worker", {}],
    ["designer", "designer", {}],
    ["tester", "tester", {}],
    ["Spec Writer (implementation lane)", "spec-writer", { lane: "implementation" }],
    ["Spec Writer (side lane)", "spec-writer", { lane: "side", branch: "feature/x" }],
    ["planned worker", "worker", { ...PLANNED }],
  ])("%s", (_name, kind, extra) => {
    const text = brief(kind, extra).prompt;
    expectLoadLine(text, "worker", kind);
  });

  test("the side-lane line also names the fold steps, the others do not", () => {
    expect(contractItems(brief("spec-writer", { lane: "side", branch: "feature/x" }).prompt)[0]).toContain("git workflow and fold steps");
    expect(contractItems(brief("worker").prompt)[0]).not.toContain("fold steps");
  });

  test("an evidence-only tester brief has no load line", () => {
    const text = brief("tester", { evidenceOnly: true, branch: "feature/x" }).prompt;
    expect(text).not.toContain("load these skills in full");
  });
});

describe("dynamic values stay in the prompt", () => {
  const full = (kind: Kind, extra: Partial<WorkerBriefInput> = {}) => brief(kind, { ...PLANNED, branch: "feature/totals", issueUrl: "https://example.com/issues/7", prUrl: "https://example.com/pull/8", prior, ...extra }).prompt;

  test.each<[Kind, string]>([["worker", "Local sync"], ["designer", "Local sync"], ["tester", "Base commit"]])("a %s names the branch in the sync and push commands, the %s record, prior, issue and PR", (kind, record) => {
    const git = section(full(kind), "Git workflow")!;
    expect(git).toContain("Task branch: feature/totals.");
    expect(git).toContain(`\`${record}: <sha>\``);
    expect(git).toContain("`git push origin HEAD:feature/totals`");
    expect(git).toContain("This worktree already holds the previous worker's changes (thr_prev); continue from them.");
    expect(git).toContain("Tracking issue: https://example.com/issues/7");
    expect(git).toContain("Draft pull request: https://example.com/pull/8");
  });

  test("the sync instruction comes after the skill load and names the load as the only exception", () => {
    const text = full("worker");
    expect(contractItems(text)[0]).toContain("only exception to the sync-first rule");
    expect(section(text, "Git workflow")).toContain("After loading your skills and before any other file read, sync");
  });

  test("a side-lane Spec Writer names the fold target branch and the side branch rule", () => {
    const text = full("spec-writer", { lane: "side" });
    expect(section(text, "Fold")).toContain("Fold your docs/ commits onto feature/totals:");
    expect(section(text, "Fold")).toContain("with <branch> = feature/totals");
    expect(section(text, "Git workflow")).toContain("Side branch cut from feature/totals: commit only docs/ on it");
  });

  test("a linked plan renders the Deviations line, and an unplanned brief does not", () => {
    for (const kind of ["worker", "designer", "tester", "spec-writer"] as const) {
      expect(contractItems(brief(kind, PLANNED).prompt), kind).toContain("- Your ready result must contain a `## Deviations from plan` heading listing each place you departed from the plan file and why, or `None`.");
      expect(brief(kind).prompt, kind).not.toContain("## Deviations from plan");
    }
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
      expect(text).not.toContain("load these skills in full");
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
