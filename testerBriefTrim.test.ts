import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
import { NOT_DOING, SPEC_DELTA, fullChain } from "./test/specWriterHelpers";
import { delegate, disposeAll, setup, start } from "./test/harness";
import { readyIdle } from "./test/testerHelpers";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Wave 2 of plan thr_a3j8vkfcav: the contracts of wave 1 (the tester brief trim), proven through `workerBrief` and the delegation harness.
// Every test names the plausible wrong implementation it fails on. Skill and docs text is never read here.
type Kind = WorkerBriefInput["kind"];
const input = (kind: Kind, extra: Partial<WorkerBriefInput> = {}): WorkerBriefInput => ({
  title: "Totals", chiefThreadId: "thr_chief", params: { mission: "Fix totals", successCriteria: [], constraints: [], context: undefined },
  wave: undefined, waveTotal: undefined, waveNext: null, waveIndependent: false, designWave: false, implementsDesign: null, contracts: undefined, planContextLine: undefined,
  kind, verifyCommand: null, branch: undefined, issueUrl: undefined, prUrl: undefined, prior: undefined, findings: undefined, structured: undefined, ruledOut: [], specSources: [],
  ...extra,
});
const prompt = (kind: Kind, extra: Partial<WorkerBriefInput> = {}) => workerBrief(input(kind, extra)).prompt;
const count = (text: string, needle: string) => text.split(needle).length - 1;
const section = (text: string, heading: string) => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
const planned = { wave: 2, waveTotal: 2, planContextLine: "Plan file (wave 2 of 2): /plans/plan-2.md" };
const contractList = (tag: string, size: number) => Array.from({ length: Math.ceil(size / 19) }, (_, i) => `- ${tag} item ${String(i).padStart(4, "0")} holds`).join("\n");

describe("empty sections", () => {
  // Regression: "None stated." kept for a tester, or dropped for another kind.
  test("a tester brief omits an empty Success criteria or Constraints section and keeps a filled one", () => {
    const empty = prompt("tester");
    expect(empty).not.toContain("None stated.");
    expect(empty).not.toContain("## Success criteria");
    expect(empty).not.toContain("## Constraints");
    const filled = prompt("tester", { params: { mission: "m", successCriteria: ["Regression passes"], constraints: [], context: undefined } });
    expect(section(filled, "Success criteria")).toBe("- Regression passes\n");
    expect(filled).not.toContain("## Constraints");
    expect(prompt("tester", { params: { mission: "m", successCriteria: [], constraints: ["No new deps"], context: undefined } })).not.toContain("## Success criteria");
  });

  test("a worker, designer and Spec Writer brief keep \"None stated.\" for both empty sections", () => {
    for (const kind of ["worker", "designer", "spec-writer"] as const) {
      const text = prompt(kind);
      expect(count(text, "None stated."), kind).toBe(2);
      expect(text, kind).toContain("## Success criteria\n- None stated.");
      expect(text, kind).toContain("## Constraints\n- None stated.");
    }
  });

  test("the reviewer's cut-down brief of a tester omits them too", () => {
    expect(workerBrief(input("tester")).reviewerBrief).not.toContain("None stated.");
    expect(workerBrief(input("worker")).reviewerBrief).toContain("None stated.");
  });
});

describe("contracts to verify", () => {
  // Regression: the list inlined again for one kind (the brief grows by the whole list), or the pointer losing the plan path or the keep-every-item duty.
  test.each(["worker", "designer", "tester"] as const)("a %s with a 5,000-character contract list gets a pointer to its plan file, not the list", (kind) => {
    const contracts = contractList("c", 5_000);
    const text = prompt(kind, { ...planned, contracts });
    expect(contracts.length).toBeGreaterThanOrEqual(5_000);
    const pointer = section(text, "Contracts to verify")!;
    expect(pointer).toContain("Plan file (wave 2 of 2): /plans/plan-2.md");
    expect(text).not.toContain("c item 0000");
    expect(text.length).toBeLessThan(contracts.length);
  });

  test("a Spec Writer brief renders no Contracts to verify section", () => {
    expect(prompt("spec-writer", { ...planned, contracts: "- c" })).not.toContain("## Contracts to verify");
  });
});

describe("verify command delivery", () => {
  test.each(["tester", "worker"] as const)("a %s brief carries the configured command", (kind) => {
    const command = "npx vitest run a.test.ts";
    expect(section(prompt(kind, { verifyCommand: command, branch: "feature/x" }), "Verify command")).toContain(command);
  });
});

describe("Base commit", () => {
  // Regression: the tester records the base twice (sync sentence and Test work), or never.
  test.each([
    ["a branch", { branch: "feature/x" }],
    ["a branch and a pull request", { branch: "feature/x", prUrl: "https://github.com/o/r/pull/1" }],
    ["a branch on a planned wave", { ...planned, branch: "feature/x", contracts: "- c", verifyCommand: "npx vitest run a.test.ts" }],
    ["a branch and a spec chain", { ...planned, branch: "feature/x", specDocs: ["Wave 1 Spec Writer thr_w: report /r.md"], baseline: true }],
  ] as [string, Partial<WorkerBriefInput>][])("with %s the tester records it once, in the sync sentence, and never a Local sync", (_label, extra) => {
    const text = prompt("tester", extra);
    expect(count(text, "Base commit: <sha>")).toBe(1);
    expect(text).toContain("and record `Base commit: <sha>`");
    expect(section(text, "Test work")).not.toContain("Base commit");
    expect(text).not.toContain("Local sync");
  });

  test.each([
    ["no branch", {}],
    ["no branch with a pull request", { prUrl: "https://github.com/o/r/pull/1" }],
    ["no branch on a spec chain", { ...planned, specDocs: ["Wave 1 Spec Writer thr_w: report /r.md"] }],
  ] as [string, Partial<WorkerBriefInput>][])("with %s the tester records it once, in Test work", (_label, extra) => {
    const text = prompt("tester", extra);
    expect(count(text, "Base commit: <sha>")).toBe(1);
    expect(section(text, "Test work")).toContain("- When you start, record `git rev-parse HEAD` as `Base commit: <sha>` in your report.");
    expect(text).not.toContain("Local sync");
  });

  test("a worker with a branch keeps its Local sync and records no Base commit in its Git workflow", () => {
    const text = prompt("worker", { branch: "feature/x" });
    expect(text).toContain("and record `Local sync: <sha>`");
    expect(section(text, "Git workflow")).not.toContain("Base commit");
  });
});
test("tester briefs include Test work across delegation modes", () => {
  for (const extra of [{}, planned, { ...planned, specDocs: ["Wave 1 Spec Writer thr_w: report /r.md"], baseline: true, branch: "feature/x" }]) {
    expect(section(prompt("tester", extra), "Test work")).toBeDefined();
  }
});

describe("predecessor section", () => {
  // A realistic blocked report, shaped like the owner's audit of a real tester brief: labelled shas in the blocker, a summary and a recommendation.
  const BASE = "6773875934c12db871387559f10ddd8abae26e59";
  const HEAD = "53e13d0fe5b21843703cc5b62105c5c7c30b79b6";
  const prior = (extra: Record<string, string | null> = {}) => ({
    thread_id: "thr_prev", kind: null, report_path: "/data/thr_prev/report-1.md",
    result: "Wave 1 of 2 is implemented and pushed. The Verify command exits 2 on three errors that the base commit also has.",
    summary: "Wave 1 of 2: steps 1-7 are done, pushed at 53e13d0 (base 6773875). Blocked on the Verify command.",
    blocker: `Wave 1 of 2. Base commit: ${BASE}. Local sync: ${BASE}. Head commit: ${HEAD} (pushed; it rebased onto the docs commit).`,
    recommendation: "Accept the base-level tsc failure and complete Wave 1 on the evidence in the result.",
    ...extra,
  }) as unknown as NonNullable<WorkerBriefInput["prior"]>;
  const predecessor = (kind: Kind, p: NonNullable<WorkerBriefInput["prior"]>) => section(prompt(kind, { branch: "feature/x", prior: p }), "Predecessor's last report")!.split("\n\n## ")[0]!;

  // Regression: the narrative, blocker or recommendation still rendered for a tester, or the Head commit not parsed out of the blocker text.
  test("a tester gets the Head commit, the changed-files command and the full-report path, parsed from the blocker text, and nothing else", () => {
    expect(predecessor("tester", prior())).toBe(
      `Head commit: ${HEAD}. Changed files: \`git diff --name-only ${BASE}..${HEAD}\`.\nFull report: /data/thr_prev/report-1.md\n`);
  });

  test("the narrative, the blocker, the recommendation and the Local sync sha never reach a tester", () => {
    const text = prompt("tester", { branch: "feature/x", prior: prior() });
    for (const leaked of ["Blocker:", "Recommendation:", "Accept the base-level", "steps 1-7", "implemented and pushed", "Local sync"]) expect(text, leaked).not.toContain(leaked);
  });

  test("a Head commit in the summary or the result alone is parsed, and a backticked sha is accepted", () => {
    const only = (field: "summary" | "result", text: string) => predecessor("tester", prior({ summary: "Done.", result: "Done.", blocker: null, recommendation: null, [field]: text }));
    expect(only("summary", `Head commit: ${HEAD}`)).toBe(`Head commit: ${HEAD}.\nFull report: /data/thr_prev/report-1.md\n`);
    expect(only("result", `Base commit: \`${BASE}\`\nHead commit: \`${HEAD}\``)).toBe(
      `Head commit: ${HEAD}. Changed files: \`git diff --name-only ${BASE}..${HEAD}\`.\nFull report: /data/thr_prev/report-1.md\n`);
  });

  test("a report with no Head commit gets the fallback sentence and the full-report path, never the narrative", () => {
    const text = predecessor("tester", prior({ blocker: `Base commit: ${BASE}`, summary: "Wave 1 of 2 done.", result: "All tests pass." }));
    expect(text).toBe("Its report names no Head commit: read the full report.\nFull report: /data/thr_prev/report-1.md\n");
  });

  test("a worker keeps the summary, the blocker and the recommendation", () => {
    const text = predecessor("worker", prior());
    expect(text).toContain("Wave 1 of 2: steps 1-7 are done");
    expect(text).toContain("Blocker: Wave 1 of 2. Base commit:");
    expect(text).toContain("Recommendation: Accept the base-level tsc failure");
    expect(text).toContain("Full report: /data/thr_prev/report-1.md");
  });

  test("no predecessor section without a replaced worker's report", () => {
    expect(prompt("tester", { branch: "feature/x" })).not.toContain("## Predecessor's last report");
  });
});

test("implementation roles and Spec Writers do not get Test work", () => {
  for (const kind of ["worker", "designer", "spec-writer"] as const) {
    expect(prompt(kind, { ...planned, branch: "feature/x" })).not.toMatch(/^## Test work$/m);
  }
});

describe("chief_delegate: a spec wave with a 5,000-character contract list", () => {
  const long = `# Wave 1\nBuild the totals.\n\n${SPEC_DELTA}\n\n## Contracts to verify\n${contractList("W1", 5_000)}${NOT_DOING}`;

  // Regression: a contract clip on the worker, or the plan's Spec Writer getting the contracts that belong to the worker and the tester.
  test("the worker gets a plan-file pointer, not the list, and the Spec Writer no contracts", async () => {
    const state = await setup();
    await fullChain(state, [{ body: long, spec: true }]);
    const [worker, writer] = state.spawned.filter((entry: any) => entry.prompt.startsWith("You are the managed worker")).map((entry: any) => entry.prompt as string);
    expect(worker).not.toContain("W1 item");
    expect(section(worker!, "Contracts to verify")).toMatch(/plan-1\.md/);
    const context = section(writer!, "Read-only context")!;
    expect(context).not.toContain("W1 item");
    expect(context).toMatch(/plan-1\.md/);
    expect(writer).not.toMatch(/^## Contracts to verify/m);
  });
});

describe("chief_delegate: an unplanned tester", () => {
  // Regression: the empty sections come back through the delegation path, or the predecessor's narrative does.
  test("its brief omits the empty sections and renders the predecessor as a Head commit or the fallback sentence", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Fix totals");
    await readyIdle(state, worker.threadId, "Done. The totals are fixed.");
    await delegate(state, chief.threadId, "Tests", { replaces: worker.threadId, kind: "tester" });
    const text = state.spawned.at(-1).prompt as string;
    expect(text).not.toContain("## Success criteria\n- None stated.");
    expect(text.split("\n## Source of truth for test cases\n")[0]).not.toContain("None stated.");
    expect(section(text, "Predecessor's last report")!.startsWith("Its report names no Head commit: read the full report.")).toBe(true);
    expect(text).not.toContain("The totals are fixed.\nFull report");
  });
});
