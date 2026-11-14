import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { type WorkerBriefInput, workerBrief } from "./src/research/delegationBrief";
import { READY, ctxOf, delegateWave, plan, readyIdle, readyImpl, refusal, report, rowOf, tool, workerOn } from "./test/testerHelpers";
import { briefMatrix } from "./test/briefMatrix";
import { delegate, disposeAll, setup, start, status } from "./test/harness";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (evidenceOnly tester briefs, docs/specs/plan-chains.md "Evidence-Only Tester Brief"): a tester brief for a
// run-only task is short, orders no commit, and keeps its mission, constraints and findings whole; every other brief is unchanged.
describe("evidence-only tester brief", () => {
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  const section = (text: string, heading: string) => text.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0]?.trim();

  const FIX = "A tester must run the unchanged pre-existing unit and integration suites (or an equivalent justified same-input behavioural fixture) on base 3a725d47f2830e6924b0f5767497dfb05e6b020d and pinned head 5a737faa011937a648dc065720bd70cd5bebed72, compare the results and explain any differences, and record actual process exit statuses without pipeline masking. Include explicit successful head integration and unit exit-status evidence. Keep the new module-only tests head-only; no product-code or docs change is requested. Return the evidence for review.";
  const MESSAGE = "[feature/deepen-source-period-lock-protocol-into-one-module; tester verification] Required refactor equivalence verification is missing. Existing suites ran only against 5a737fa; Chief confirms no same-input run against the base was performed. The new four tests prove lock ordering, not preservation of responses and database writes. Also, the latest tester explicitly reports that the 527-test integration run's process exit status was not captured, despite the summary calling it exit 0. Thus the whole-plan equivalence acceptance criterion has no qualifying passing comparison record.";
  const MISSION = "Run on base 3a725d4 (master) and head 5a737fa: `node_modules/.bin/vitest run` and `node_modules/.bin/vitest run --config vitest.integration.config.mts`, on base without the new tests/integration/source-period-lock.test.ts. Then run the full integration set on head with it. MySQL is up (`pnpm local:up`).";
  const SUMMARY = "Wave 2 of 2 ready. No new commits: tree clean, HEAD 5a737fa already on the feature branch. DB checks pass: all 19 integration files / 527 tests (includes the 5 named files), exit 0. New test source-period-lock.test.ts passes 4/4 restored and fails 4/4 with lock steps swapped (case B at its 3572 assertion). Verify command (codegen && typecheck && lint && build) exit 0. No docs change needed.";
  const CONTRACTS = [
    "Equivalence: all pre-existing unit and integration tests pass with no assertion changed.",
    "Lock order, both modes: while `lockSourcePeriod` waits on the template period, it holds no lock on the source period row (case A probe succeeds).",
    "Lock order, both modes: while it waits on the source period, it already holds the template period X lock (case B probe fails with 3572).",
    "Both waits are real InnoDB waits (`waitForLockWaiters` does not throw \"finished without waiting\").",
    "The new file does not repeat what existing tests own: no new case for row creation or replay, absent-row withdraw, exact match, or close-during-wait freshness.",
    "No new E2E test. No test for `putDimensionValues` (wave 1 does not change it).",
  ].map((line) => `- [ ] ${line}`).join("\n");

  const BLOCKING = { file: "tests/integration/source-period-lock.test.ts", line: 1, severity: "blocking", message: MESSAGE, fix: FIX } as const;
  const VERDICT_PATH = "/Users/vuho/.bb/chief/proj_aqcrwxgc36/thr_j2rx23qyn2/verdict-1.md";
  const exampleInput = (extra: Partial<WorkerBriefInput> = {}): WorkerBriefInput => ({
    title: "Base-vs-head equivalence run for source-period lock module", chiefThreadId: "thr_u5kmtu4486",
    params: {
      mission: MISSION, context: undefined, constraints: [],
      successCriteria: [
        "Unit and integration runs on base and head each record exit=0 explicitly",
        "Same existing test counts pass on base and head; differences explained",
        "Head full integration including source-period-lock.test.ts exit=0",
      ],
    },
    wave: 2, waveTotal: 2, waveNext: null, waveIndependent: false, designWave: false, implementsDesign: null, contracts: CONTRACTS,
    planContextLine: "Plan file (wave 2 of 2): /Users/vuho/.bb/chief/proj_aqcrwxgc36/thr_q7pnyjqmds/plan-2.md",
    kind: "tester", verifyCommand: "pnpm codegen && pnpm typecheck && pnpm lint && pnpm build", branch: "feature/deepen-source-period-lock-protocol-into-one-module",
    issueUrl: "https://github.com/1988s-corp/nori-pmp/issues/29", prUrl: "https://github.com/1988s-corp/nori-pmp/pull/30",
    prior: {
      thread_id: "thr_jdkgs3d72q", verdict: null, verdict_path: null, summary: SUMMARY, result: SUMMARY, branch: null, issue_url: null, pr_url: null, plan_thread_id: null, plan_wave: null,
      kind: null, brief: null, verify_command: null, unplanned_reason: null, blocker: null, recommendation: null, report_path: "/Users/vuho/.bb/chief/proj_aqcrwxgc36/thr_jdkgs3d72q/report-1.md",
    },
    findings: { thread_id: "thr_j2rx23qyn2", verdict: "request_changes", verdict_path: VERDICT_PATH, summary: null, result: "Equivalence evidence is missing.", recommendation: null },
    structured: [BLOCKING], ruledOut: [],
    specSources: ["Wave 1 of 2: /Users/vuho/.bb/chief/proj_aqcrwxgc36/thr_q7pnyjqmds/plan-1.md", "Wave 2 of 2: /Users/vuho/.bb/chief/proj_aqcrwxgc36/thr_q7pnyjqmds/plan-2.md"],
    specDocs: ["Wave 1 Spec Writer thr_8nmmh2qudu: report /Users/vuho/.bb/chief/proj_aqcrwxgc36/thr_8nmmh2qudu/report-1.md"], baseline: false,
    evidenceOnly: true, ...extra,
  });
  const evidence = (extra: Partial<WorkerBriefInput> = {}) => workerBrief(exampleInput(extra));

  // Contract: the audited 13,996-byte example fits in 5,000 UTF-8 bytes and nothing is clipped to get there.
  // Regression: boilerplate growth past the budget, or a clip of mission, constraints or finding to fit it.
  test("the example task renders within 5,000 bytes with its mission, constraints and finding whole", () => {
    const { prompt, brief, reviewerBrief } = evidence();
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(5_000);
    expect(count(prompt, MISSION)).toBe(1);
    expect(count(prompt, FIX)).toBe(1);
    expect(count(prompt, MESSAGE)).toBe(1);
    expect(brief).toContain(`## Constraints\n- tests/integration/source-period-lock.test.ts:1: ${FIX}`);
    expect(reviewerBrief).toContain(`## Constraints\n- tests/integration/source-period-lock.test.ts:1: ${FIX}`);
  });

  // Contract: the evidence brief is a tester brief that drops the test-writing, spec and push sections and adds the evidence rules.
  // Regression: a dropped section reappears (the 14 KB brief returns) or an evidence obligation is lost.
  test("starts as the tester, drops the test-writing sections, and orders the evidence steps", () => {
    const { prompt } = evidence();
    expect(prompt.startsWith("You are the managed tester for “Base-vs-head equivalence run for source-period lock module”. Report to Chief thread thr_u5kmtu4486.")).toBe(true);
    for (const gone of [
      "## Source of truth for test cases", "## Spec", "merge-base", "## Contracts to verify", "## Verify command", "## Test work", "Commit and push",
      "Implement only this wave's plan file", "git push", "git worktree add", SUMMARY, "Full report:", "plan-1.md", "Tracking issue:", "Draft pull request:",
    ]) expect(prompt, gone).not.toContain(gone);
    const work = section(prompt, "Evidence work")!;
    for (const step of ["git switch --detach", "git switch -", "`Head commit: <sha>`", "lockfile", "reset any database or state", "`echo exit=$?`", "set -o pipefail", "`git status --porcelain` prints nothing", "kind: tester", "kind: worker"]) expect(work, step).toContain(step);
    expect(prompt).toContain("Commit nothing, push nothing, edit no tracked file");
    expect(prompt).toContain("Wave 2 of 2. Name \"Wave 2 of 2\" in your ready result.");
    expect(section(prompt, "Predecessor's last report")).toBe("/Users/vuho/.bb/chief/proj_aqcrwxgc36/thr_jdkgs3d72q/report-1.md");
    expect(section(prompt, "Git workflow")).toContain("`git fetch origin feature/deepen-source-period-lock-protocol-into-one-module` then `git merge --ff-only origin/feature/deepen-source-period-lock-protocol-into-one-module`");
  });

  test("without a branch there is no Git workflow, and the no-commit rule is still ordered", () => {
    const { prompt } = evidence({ branch: undefined, issueUrl: undefined, prUrl: undefined, prior: undefined });
    expect(prompt).not.toContain("## Git workflow");
    expect(prompt).not.toContain("## Predecessor's last report");
    expect(prompt).toContain("Commit nothing, push nothing, edit no tracked file");
  });

  // Contract: with no Chief constraints, a blocking finding's fix is the constraint, and each finding text appears once.
  // Regression: the fix stays in the finding only (Constraints omitted), or is repeated in both places. An empty tester Constraints section is omitted (plan-chains.md Tester Brief), never "None stated.".
  describe("constraints from blocking fixes", () => {
    const nit = { file: "totals.ts", severity: "nit", message: "Rename total", fix: "Call it sum" } as const;
    const second = { file: "a.ts", severity: "blocking", message: "Second failure", fix: "Repair second" } as const;

    test("empty constraints: each blocking fix fills Constraints once, in the prompt and the reviewer brief, and its finding drops the suffix", () => {
      const { prompt, brief, reviewerBrief } = evidence({ structured: [BLOCKING, second, nit] });
      const constraints = `## Constraints\n- tests/integration/source-period-lock.test.ts:1: ${FIX}\n- a.ts: Repair second`;
      for (const text of [prompt, brief, reviewerBrief]) expect(text).toContain(constraints);
      expect(prompt).not.toContain("None stated.");
      expect(count(prompt, FIX)).toBe(1);
      expect(count(prompt, "Repair second")).toBe(1);
      expect(count(prompt, MESSAGE)).toBe(1);
      expect(count(prompt, "Second failure")).toBe(1);
      expect(prompt).not.toContain("(fix: Repair second");
      expect(prompt).not.toContain(`(fix: ${FIX}`);
    });

    test("a nit's fix never moves", () => {
      const { prompt, reviewerBrief } = evidence({ structured: [nit] });
      expect(prompt).not.toContain("## Constraints");
      expect(reviewerBrief).not.toContain("## Constraints");
      expect(prompt).not.toContain("None stated.");
      expect(count(prompt, "Call it sum")).toBe(1);
      expect(prompt).toContain("Optional nits:");
    });

    test("a blocking finding without a fix leaves Constraints omitted", () => {
      const { prompt } = evidence({ structured: [{ ...BLOCKING, fix: undefined }] });
      expect(prompt).not.toContain("## Constraints");
      expect(prompt).not.toContain("None stated.");
      expect(count(prompt, MESSAGE)).toBe(1);
    });

    test("constraints Chief gave win: fixes stay with their findings", () => {
      const { prompt, brief, reviewerBrief } = evidence({ params: { ...exampleInput().params, constraints: ["Keep it read-only"] } });
      for (const text of [prompt, brief, reviewerBrief]) expect(text).toContain("## Constraints\n- Keep it read-only");
      expect(prompt).toContain(`(fix: ${FIX})`);
      expect(count(prompt, FIX)).toBe(1);
    });
  });

  // Contract: the verdict-read line points only at a verdict file that is attached; no findings, no findings section.
  // Regression: the line renders without a verdict path (an unreadable file) or a findings heading renders for no findings.
  test.each<[string, Partial<WorkerBriefInput>, boolean, boolean]>([
    ["a verdict file is attached", {}, true, true],
    ["findings carry no verdict file", { findings: { ...exampleInput().findings!, verdict_path: null } }, true, false],
    ["there are no findings", { findings: undefined, structured: undefined }, false, false],
  ])("the findings section and verdict line when %s", (_label, extra, heading, verdictLine) => {
    const { prompt } = evidence(extra);
    expect(prompt.includes("## Review findings to fix (thr_j2rx23qyn2)")).toBe(heading);
    expect(prompt.includes("- Read the verdict file in full.")).toBe(verdictLine);
    expect(prompt.includes(`Verdict file: ${VERDICT_PATH}`)).toBe(verdictLine);
  });

  // Contract: report intake refuses a plan-linked ready report without the Deviations heading, so the brief must ask for it.
  test("a plan-linked evidence brief asks for Deviations from plan; an unplanned one does not", () => {
    expect(evidence().prompt).toContain("- Your ready result must contain a `## Deviations from plan` heading");
    expect(evidence({ wave: undefined, waveTotal: undefined, planContextLine: undefined, contracts: undefined }).prompt).not.toContain("## Deviations from plan");
  });

  // Contract (byte equivalence): without the flag, or with it on a kind other than tester, prompt, brief and reviewerBrief are unchanged.
  // The raw matrix (320 cells: kind and spec lane × planned × findings × prior × verifyCommand × specDocs × baseline) rendered on base bc6d302 and on this head
  // was compared byte for byte outside this test (cmp: identical); this test pins that the flag is the only switch.
  // Regression: an evidence guard that forgets the tester check changes a worker, designer or Spec Writer brief.
  describe("normal briefs", () => {
    const cells = briefMatrix();
    test.each(["worker", "designer", "spec-writer side", "spec-writer implementation"])("%s: evidenceOnly true or false renders the same bytes as omitted", (kind) => {
      const own = cells.filter(([label]) => label.startsWith(`${kind} planned`));
      expect(own).toHaveLength(64);
      for (const [label, input] of own) {
        const omitted = workerBrief(input);
        expect(workerBrief({ ...input, evidenceOnly: true }), label).toEqual(omitted);
        expect(workerBrief({ ...input, evidenceOnly: false }), label).toEqual(omitted);
      }
    });

    // Contract (wave 1 of the Spec-delta plan, contracts 2-4): the matrix is rendered on base 7687ebfd (the stack base) and the result stored in
    // test/fixtures/briefs-matrix-7687ebf.json: a sha256 of each complete worker, designer, tester and evidence-only tester output (prompt and brief,
    // nothing masked), and the full base text of the 8 Spec Writer cells with findings=false prior=false verify=npm test specDocs=1.
    // Only the Spec Writer Inputs sentence changes, by the one named edit below applied to the BASE text.
    // The 32 tester cells with a verify command hold the hash of the BASE text plus one swap (tester Verify baseline sentence, 96 characters longer, plan-chains.md line 301); every other cell hash is the base's.
    // Regression: any byte changed in a non-writer brief; an Inputs line that keeps the old allowance or is missing in either lane; a changed Baseline line.
    describe("equal to base 7687ebfd", () => {
      const base = readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "briefs-matrix-7687ebf.json"), "utf8").then((text) => JSON.parse(text) as { hashes: Record<string, string>; writers: Record<string, string> });
      const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const OLD_INPUTS = "You may read the code entry points and guideline files those domains need, read-only.";
      const NEW_INPUTS = "Read code only to check a name or path the delta states; a gap goes under `## Open questions`.";

      test.each(["worker", "designer", "tester"])("%s: every cell renders the base's complete bytes", async (kind) => {
        const { hashes } = await base;
        const own = cells.filter(([label]) => label.startsWith(`${kind} planned`));
        expect(own).toHaveLength(64);
        for (const [label, input] of own) expect(sha(workerBrief(input)), label).toBe(hashes[label]);
      });

      test("evidence-only tester: every cell renders the base's complete bytes", async () => {
        const { hashes } = await base;
        const own = cells.filter(([label]) => label.startsWith("tester planned"));
        expect(own).toHaveLength(64);
        for (const [label, input] of own) expect(sha(workerBrief({ ...input, evidenceOnly: true })), `${label} evidenceOnly`).toBe(hashes[`${label} evidenceOnly`]);
      });

      test.each(["spec-writer side", "spec-writer implementation"])("%s: the Inputs line is the new one in every cell, and the base text plus that one edit is the brief", async (kind) => {
        const { writers } = await base;
        const own = cells.filter(([label]) => label.startsWith(`${kind} planned`));
        expect(own).toHaveLength(64);
        for (const [label, input] of own) {
          const prompt = workerBrief(input).prompt;
          expect(prompt.split(NEW_INPUTS), label).toHaveLength(2);
          expect(prompt, label).not.toContain(OLD_INPUTS);
          expect(prompt, label).not.toContain("You may read the code entry points");
        }
        const stored = Object.entries(writers).filter(([label]) => label.startsWith(`${kind} planned`));
        expect(stored).toHaveLength(4);
        for (const [label, text] of stored) {
          const input = own.find(([name]) => name === label)![1];
          expect(text.split(OLD_INPUTS), label).toHaveLength(2);
          expect(workerBrief(input).prompt, label).toBe(text.replace(OLD_INPUTS, NEW_INPUTS));
        }
      });

      test.each(["spec-writer side", "spec-writer implementation"])("%s: baseline:true keeps the base's Baseline line whole; baseline:false has none", async (kind) => {
        const { writers } = await base;
        const baselineLine = (text: string) => text.split("\n").filter((line) => line.startsWith("- Baseline:"));
        const own = cells.filter(([label]) => label.startsWith(`${kind} planned`));
        for (const [label, input] of own) expect(baselineLine(workerBrief(input).prompt), label).toHaveLength(input.baseline ? 1 : 0);
        const stored = Object.entries(writers).filter(([label]) => label.startsWith(`${kind} planned`) && label.endsWith("baseline=true"));
        expect(stored).toHaveLength(2);
        for (const [label, text] of stored) {
          const line = baselineLine(text);
          expect(line, label).toHaveLength(1);
          for (const [name, input] of own) if (input.baseline) expect(baselineLine(workerBrief(input).prompt), name).toEqual(line);
        }
      });
    });

    test("tester: evidenceOnly false renders the same bytes as omitted, and true changes the brief", () => {
      const own = cells.filter(([label]) => label.startsWith("tester planned"));
      expect(own).toHaveLength(64);
      for (const [label, input] of own) {
        const omitted = workerBrief(input);
        expect(workerBrief({ ...input, evidenceOnly: false }), label).toEqual(omitted);
        expect(omitted.prompt, label).toContain("## Test work");
        const flagged = workerBrief({ ...input, evidenceOnly: true }).prompt;
        expect(flagged, label).toContain("## Evidence work");
        expect(flagged, label).not.toContain("## Test work");
      }
    });
  });
});

// Contracts at the chief_delegate and CLI boundaries: a refusal before any spawn for a non-tester kind, admission on a test
// wave, no inheritance through replaces:, and the CLI flag.
describe("evidence-only through chief_delegate", () => {
  const rows = (state: Awaited<ReturnType<typeof setup>>) => (state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get() as { n: number }).n;
  const REFUSAL = /kind: tester/;

  // Regression: the guard is missing or runs after managedSpawn.prepare, so a worker starts (or the prior is superseded) with a run-only brief.
  test("refuses a resolved kind other than tester before anything starts, and leaves the prior untouched", async () => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId);
    await readyIdle(state, first.threadId, "Done");
    const planner = await plan(state, chief.threadId);
    const attempts: [string, object][] = [
      ["an unplanned worker", { unplannedReason: "Bounded test fixture" }],
      ["a worker successor", { replaces: first.threadId }],
      ["an explicit designer", { replaces: first.threadId, kind: "designer" }],
      ["a plan wave that resolves to a worker", { planThreadId: planner.threadId, wave: 1 }],
    ];
    for (const [label, extra] of attempts) {
      const spawned = state.spawned.length;
      const rowsBefore = rows(state);
      const priorBefore = rowOf(state, first.threadId);
      const message = await refusal(tool(state, "chief_delegate", { title: "Run", mission: "Run the suites", evidenceOnly: true, ...extra }, chief.threadId));
      expect(message, label).toMatch(REFUSAL);
      expect(state.spawned, label).toHaveLength(spawned);
      expect(rows(state), label).toBe(rowsBefore);
      expect(rowOf(state, first.threadId), label).toEqual(priorBefore);
    }
  });

  // Regression: the tester is refused or gets the normal brief; or the ready report with the Deviations heading is not accepted.
  test("a tester on a test wave gets the evidence brief, keeps the Deviations line, and its ready report is accepted", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl, evidenceOnly: true });
    const prompt = state.spawned.at(-1).prompt as string;
    expect(prompt).toMatch(/^You are the managed tester for “Wave 2”/);
    expect(prompt).toContain("## Evidence work");
    expect(prompt).toContain("`## Deviations from plan` heading");
    for (const gone of ["## Test work", "## Contracts to verify", "## Source of truth for test cases", "Commit and push"]) expect(prompt).not.toContain(gone);
    const tester = workerOn(state, planner.threadId, 2).thread_id as string;
    await report(state, tester, { state: "ready", result: READY });
    expect(rowOf(state, tester).last_report_state).toBe("ready");
  });

  // Contract: the flag is not stored and replaces: does not carry it.
  // Regression: a successor of an evidence-only tester inherits the flag and renders another evidence brief.
  test("replacing an evidence tester without the flag gives a normal tester brief", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl, evidenceOnly: true });
    const first = workerOn(state, planner.threadId, 2).thread_id as string;
    await readyIdle(state, first);
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: first, kind: "tester" });
    const prompt = state.spawned.at(-1).prompt as string;
    expect(prompt).toMatch(/^You are the managed worker for “Wave 2”/);
    expect(prompt).toContain("## Test work");
    expect(prompt).not.toContain("## Evidence work");
  });

  // Contract: CLI --evidence-only maps to evidenceOnly: true, and an absent flag to undefined (a normal brief).
  test("delegate --evidence-only reaches the brief; without it the brief is normal; on a worker it is refused", async () => {
    const state = await setup();
    const { chief, planner, impl } = await readyImpl(state);
    const cli = (args: string[]) => state.harness.behavior.runCli(["delegate", "--title", "Wave", "--mission", "Run", ...args], ctxOf(state, chief.threadId));
    const wave2 = ["--plan-thread", planner.threadId, "--wave", "2", "--replaces", impl];

    const flagged = await cli([...wave2, "--evidence-only"]);
    expect(flagged.exitCode, flagged.stderr).toBe(0);
    expect(state.spawned.at(-1).prompt).toContain("## Evidence work");
    const first = workerOn(state, planner.threadId, 2).thread_id as string;
    await readyIdle(state, first);

    const plain = await cli(["--plan-thread", planner.threadId, "--wave", "2", "--replaces", first, "--kind", "tester"]);
    expect(plain.exitCode, plain.stderr).toBe(0);
    expect(state.spawned.at(-1).prompt).toContain("## Test work");
    expect(state.spawned.at(-1).prompt).not.toContain("## Evidence work");

    const spawned = state.spawned.length;
    const refused = await cli(["--unplanned-reason", "Bounded test fixture", "--evidence-only"]);
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stderr}${refused.stdout}`).toMatch(REFUSAL);
    expect(state.spawned).toHaveLength(spawned);
    expect((await status(state)).threads.filter((row: { role: string }) => row.role === "worker")).toHaveLength(3);
  });
});
