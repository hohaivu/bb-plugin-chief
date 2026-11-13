import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
import { SPEC_WRITER_BOUNDARY, TESTER_BOUNDARY, WORKER_BOUNDARY } from "./test/docsOwnership";
import { NOT_DOING, SPEC_DELTA, fullChain } from "./test/specWriterHelpers";
import { PLAN_FIXTURE, TEST_WAVE, delegate, disposeAll, setup, start } from "./test/harness";
import { plan, readyIdle, workerOn } from "./test/testerHelpers";
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
const lines = (text: string, line: string) => text.split("\n").filter((entry) => entry === line).length;
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
    expect(pointer).toContain("Keep every item.");
    expect(pointer).toContain("the reviewer checks the same list");
    expect(text).not.toContain("c item 0000");
    expect(text.length).toBeLessThan(contracts.length);
  });

  test("a Spec Writer brief renders no Contracts to verify section", () => {
    expect(prompt("spec-writer", { ...planned, contracts: "- c" })).not.toContain("## Contracts to verify");
  });
});

describe("tester verify command", () => {
  const withVerify = (kind: Kind) => section(prompt(kind, { verifyCommand: "npx vitest run a.test.ts", branch: "feature/x" }), "Verify command")!;

  // Regression: the worker's "fix the work" rule, its blocked-instead-of-ready rule or its tester-only waiver sentence kept for a tester.
  test("a tester's paragraph never tells it to fix the work, to report blocked instead of ready, or about running tests as a tester", () => {
    const verify = withVerify("tester");
    expect(verify).not.toContain("Fix the work until it exits 0");
    expect(verify).not.toContain("instead of ready");
    expect(verify).not.toContain("runs tests (a tester's)");
    expect(verify).not.toContain("do not run it or change code");
    expect(verify).toContain("Never change product code to make it pass.");
    expect(verify).toContain("A failure that also occurs at your Base commit is a baseline: list it and do not fix it.");
  });

  // Regression: the full-suite sentence rendered twice, or not at all.
  test("a tester's paragraph states the full-suite rule once, and no other part of the brief repeats it", () => {
    const text = prompt("tester", { verifyCommand: "npx vitest run", branch: "feature/x" });
    expect(count(text, "not run: full suite not asked for")).toBe(1);
    expect(count(text, "full-suite run")).toBe(1);
  });

  test("a worker's paragraph keeps its rules and has no tester sentence", () => {
    const verify = withVerify("worker");
    expect(verify).toContain("Fix the work until it exits 0");
    expect(verify).toContain("report blocked with its output instead of ready");
    expect(verify).toContain("not run: runs tests (a tester's)");
    expect(verify).not.toContain("full suite not asked for");
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

describe("one product-code rule", () => {
  const specChain = { ...planned, specDocs: ["Wave 1 Spec Writer thr_w: report /r.md"], baseline: true, branch: "feature/x" };

  // Regression: the Spec section and Test work both give a `kind: worker` route.
  test.each([["unplanned", {}], ["planned", planned], ["a spec chain", specChain]] as [string, Partial<WorkerBriefInput>][])("%s: a tester brief renders `kind: worker` once, in Test work", (_label, extra) => {
    const text = prompt("tester", extra);
    expect(count(text, "kind: worker")).toBe(1);
    expect(section(text, "Test work")).toContain("recommend `chief_delegate (replaces: <your thread id>, kind: worker)`");
  });

  test("on a spec chain the Spec bullet points to the Test work rule and keeps the spec-writer route once", () => {
    const spec = section(prompt("tester", specChain), "Spec")!;
    expect(spec).toContain("- Code that contradicts the docs is product code that is wrong: follow the product-code rule in `## Test work`.");
    expect(count(spec, "kind: spec-writer")).toBe(1);
    expect(spec).not.toContain("kind: worker");
  });
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

describe("tester working contract", () => {
  const tester = prompt("tester", { ...planned, branch: "feature/x" });
  const contract = (text: string) => section(text, "Working contract")!;

  // Regression: a refactor, re-plan, user-journey or Docs needed line kept for a tester.
  test("a tester's working contract drops the refactor, re-plan, user-journey and Docs needed lines", () => {
    const text = contract(tester);
    for (const gone of ["refactor or migration", "base commit as the oracle", "re-plan the remaining scope", "user journey", "Docs needed", "lint/analyze", "Never write, edit or run tests"]) expect(text, gone).not.toContain(gone);
    expect(lines(text, TESTER_BOUNDARY)).toBe(1);
    expect(lines(tester, WORKER_BOUNDARY)).toBe(0);
  });

  test("a worker and a designer keep their one boundary line with the Docs needed route, and the Deviations line on a planned wave", () => {
    for (const kind of ["worker", "designer"] as const) {
      const text = contract(prompt(kind, { ...planned, branch: "feature/x" }));
      expect(lines(text, WORKER_BOUNDARY), kind).toBe(1);
      expect(lines(text, TESTER_BOUNDARY), kind).toBe(0);
      expect(count(text, "## Deviations from plan"), kind).toBe(1);
    }
  });

  test("no brief of any kind carries the refactor-oracle line", () => {
    for (const kind of ["worker", "designer", "tester", "spec-writer"] as const) {
      for (const extra of [{}, planned, { ...planned, branch: "feature/x", prior: { thread_id: "p", result: "Done", kind: null } }] as Partial<WorkerBriefInput>[]) {
        expect(prompt(kind, extra), kind).not.toContain("treat the base commit as the oracle");
      }
    }
  });

  test("a Spec Writer's working contract has no docs rule and its docs-only boundary with the trailer once", () => {
    const text = prompt("spec-writer", { ...planned, branch: "feature/x" });
    expect(text).not.toContain("Never change docs/");
    expect(lines(contract(text), SPEC_WRITER_BOUNDARY)).toBe(1);
    expect(count(text, "Chief-Spec-Writer: $BB_THREAD_ID")).toBe(1);
  });
});

describe("chief_delegate: planned chain with 5,000-character contract lists", () => {
  const long = (n: number) => `# Wave ${n}\nBuild the totals.\n\n${n === 1 ? `${SPEC_DELTA}\n\n` : ""}## Contracts to verify\n${contractList(`W${n}`, 5_000)}${NOT_DOING}`;
  const chainPrompts = async () => {
    const state = await setup();
    await fullChain(state, [{ body: long(1), spec: true }, { body: long(2), test: true }]);
    const [worker, writer, tester] = state.spawned.filter((entry: any) => entry.prompt.startsWith("You are the managed worker")).map((entry: any) => entry.prompt as string);
    return { worker: worker!, writer: writer!, tester: tester! };
  };

  // Regression: a contract clip on the worker, the tester's Source of truth still listing contracts, or the Spec Writer's context losing or lengthening them.
  test("the worker and the tester get a plan-file pointer, not the list, and the Spec Writer a 3,000-character clip", async () => {
    const { worker, writer, tester } = await chainPrompts();
    expect(worker).not.toContain("W1 item");
    expect(tester).not.toContain("W2 item");
    expect(tester).not.toContain("W1 item");
    expect(section(worker, "Contracts to verify")).toMatch(/plan-1\.md/);
    expect(section(tester, "Contracts to verify")).toMatch(/plan-2\.md/);
    const context = section(writer, "Read-only context")!;
    const full = count(contractList("W1", 5_000), "W1 item");
    // Own-wave contracts only: wave 1's list, clipped; wave 2's never reaches the wave-1 Spec Writer.
    expect(count(context, "W1 item")).toBeGreaterThan(100);
    expect(count(context, "W1 item")).toBeLessThan(full);
    expect(context).not.toContain("W2 item");
    expect(context.length).toBeLessThan(5_000);
    expect(writer).not.toContain("## Contracts to verify");
  });

  test("the tester's Source of truth names the plan files only", async () => {
    const { tester } = await chainPrompts();
    const source = section(tester, "Source of truth for test cases")!;
    expect(source.split("\n").filter((entry) => entry.startsWith("- "))).toEqual([]);
    expect(source.split("\n").filter((entry) => /^Wave \d of 2: .*plan-\d\.md$/.test(entry))).toHaveLength(2);
    expect(source).not.toContain("item");
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

  test("a planned tester behind a worker whose report names its Head commit gets the commit line", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE }, TEST_WAVE(2)]);
    await state.harness.behavior.callAgentTool("chief_delegate", { title: "Wave 1", mission: "Do the wave.", planThreadId: planner.threadId, wave: 1 }, { threadId: chief.threadId, projectId: "proj_1" });
    const impl = workerOn(state, planner.threadId, 1).thread_id as string;
    const sha = "1234567890abcdef1234567890abcdef12345678";
    const base = "abcdef1234567890abcdef1234567890abcdef12";
    await readyIdle(state, impl, `Done.\nBase commit: ${base}\nHead commit: ${sha}\n\n## Deviations from plan\nNone`);
    await state.harness.behavior.callAgentTool("chief_delegate", { title: "Wave 2", mission: "Do the wave.", planThreadId: planner.threadId, wave: 2, replaces: impl }, { threadId: chief.threadId, projectId: "proj_1" });
    expect(section(state.spawned.at(-1).prompt as string, "Predecessor's last report")).toBe(`Head commit: ${sha}. Changed files: \`git diff --name-only ${base}..${sha}\`.\n`);
  });
});
