import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { type WorkerBriefInput, workerBrief } from "../src/research/delegationBrief";
import { NOT_DOING, SPEC_DELTA, fullChain } from "./specWriterHelpers";
import { disposeAll, setup } from "./harness";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Wave 2 of plan thr_a3j8vkfcav: the contracts of wave 1 (the brief trim), proven through `workerBrief` and the delegation harness.
// Every test names the plausible wrong implementation it fails on. Skill and docs text is never read here.
type Kind = WorkerBriefInput["kind"];
const input = (kind: Kind, extra: Partial<WorkerBriefInput> = {}): WorkerBriefInput => ({
  title: "Totals", chiefThreadId: "thr_chief", params: { mission: "Fix totals", successCriteria: [], constraints: [], context: undefined },
  wave: undefined, waveTotal: undefined, waveNext: null, waveIndependent: false, designWave: false, implementsDesign: null, contracts: undefined, planContextLine: undefined,
  kind, verifyCommand: null, branch: undefined, issueUrl: undefined, prUrl: undefined, prior: undefined, findings: undefined, structured: undefined, ruledOut: [], specSources: [],
  ...extra,
});
const prompt = (kind: Kind, extra: Partial<WorkerBriefInput> = {}) => workerBrief(input(kind, extra)).prompt;
const section = (text: string, heading: string) => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0];
const planned = { wave: 2, waveTotal: 2, planContextLine: "Plan file (wave 2 of 2): /plans/plan-2.md" };
const contractList = (tag: string, size: number) => Array.from({ length: Math.ceil(size / 19) }, (_, i) => `- ${tag} item ${String(i).padStart(4, "0")} holds`).join("\n");

describe("empty sections", () => {
  test("a worker, designer and Spec Writer brief keep both empty sections", () => {
    for (const kind of ["worker", "designer", "spec-writer"] as const) {
      const text = prompt(kind);
      const success = section(text, "Success criteria");
      const constraints = section(text, "Constraints");
      expect(success, kind).toBeTruthy();
      expect(constraints, kind).toBeTruthy();
      expect(text.indexOf("\n## Success criteria\n"), kind).toBeLessThan(text.indexOf("\n## Constraints\n"));
    }
  });

});

describe("contracts to verify", () => {
  // Regression: the list inlined again for one kind (the brief grows by the whole list), or the pointer losing the plan path or the keep-every-item duty.
  test.each(["worker", "designer"] as const)("a %s with a 5,000-character contract list gets a pointer to its plan file, not the list", (kind) => {
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
  test("a worker brief carries the configured command", () => {
    const command = "npx vitest run a.test.ts";
    expect(section(prompt("worker", { verifyCommand: command, branch: "feature/x" }), "Verify command")).toContain(command);
  });
});

describe("predecessor section", () => {
  // A realistic blocked report, with labelled shas in the blocker, a summary and a recommendation.
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

  test("a worker keeps the summary, the blocker and the recommendation", () => {
    const text = predecessor("worker", prior());
    expect(text).toContain("Wave 1 of 2: steps 1-7 are done");
    expect(text).toContain("Blocker: Wave 1 of 2. Base commit:");
    expect(text).toContain("Recommendation: Accept the base-level tsc failure");
    expect(text).toContain("Full report: /data/thr_prev/report-1.md");
  });

  test("no predecessor section without a replaced worker's report", () => {
    expect(prompt("worker", { branch: "feature/x" })).not.toContain("## Predecessor's last report");
  });
});

test("implementation roles and Spec Writers do not get Test work", () => {
  for (const kind of ["worker", "designer", "spec-writer"] as const) {
    expect(prompt(kind, { ...planned, branch: "feature/x" })).not.toMatch(/^## Test work$/m);
  }
});

describe("chief_delegate: a spec wave with a 5,000-character contract list", () => {
  const long = `# Wave 1\nBuild the totals.\n\n${SPEC_DELTA}\n\n## Contracts to verify\n${contractList("W1", 5_000)}${NOT_DOING}`;

  // Regression: a contract clip on the worker, or the plan's Spec Writer getting the contracts that belong to the worker.
  test("the worker gets a plan-file pointer, not the list, and the Spec Writer no contracts", async () => {
    const state = await setup();
    await fullChain(state, [{ body: long, spec: true }]);
    const [worker, writer] = state.spawned.filter((entry: any) => entry.pluginMetadata?.role === "worker").map((entry: any) => entry.prompt as string);
    expect(worker).not.toContain("W1 item");
    expect(section(worker!, "Contracts to verify")).toMatch(/plan-1\.md/);
    const context = section(writer!, "Read-only context")!;
    expect(context).not.toContain("W1 item");
    expect(context).toMatch(/plan-1\.md/);
    expect(writer).not.toMatch(/^## Contracts to verify/m);
  });
});
