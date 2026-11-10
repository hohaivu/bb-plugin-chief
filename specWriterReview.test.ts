import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewBrief, type ReviewBriefInput } from "./src/review/reviewStart";
import { NOT_DOING, SPEC_DELTA, baseImpl, fullChain, lastAlert, putWriter, roster, section, skipSpecs, specImpl, specPlan, storedWave, swap, withWriter } from "./test/specWriterHelpers";
import { type State, ctxOf, delegateWave, plan, planWave, planWaves, readyIdle, report, reviewed, rowOf, setLive, tool, wavePaths, workerOn } from "./test/testerHelpers";
import { PLANNER_ANCHOR, PLANNER_RESHAPE_LINE, PLAN_FIXTURE, RESHAPE_CHECKLIST_LINE, TEST_WAVE, approvePlan, delegate, disposeAll, planFile, setup, spliceAfter, start, status, wave, withReviewerLine } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  describe("Spec Writer role", () => {
    const reviewPrompt = async (state: State, chiefThreadId: string, workerThreadId: string) => {
      await tool(state, "chief_review", { workerThreadId }, chiefThreadId);
      const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
      const context = await readFile(join(state.storageRoot, reviewer.threadId, "review-context.md"), "utf8");
      return { prompt: state.spawned.at(-1).prompt as string, context };
    };
    /** Wave 1 (spec: true) bypassed before any row; its worker and wave 2's tester ready: the whole plan is reviewable. */
    async function bypassedChain(state: State, reasons: { specs: string; tests?: string }) {
      const { chief, planner } = await specPlan(state);
      await skipSpecs(state, chief.threadId, planner.threadId, reasons.specs);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      const worker = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, worker);
      if (reasons.tests) {
        await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: reasons.tests }, chief.threadId);
        return { chief, planner, worker, last: worker };
      }
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      return { chief, planner, worker, last: tester };
    }

    // Contract 12 (waiver type from the flags): a test waiver whose reason says "specs skipped by Chief" renders only under
    // `## Waived test waves`, and a spec bypass whose reason says "tests skipped by Chief" only under `## Bypassed Spec Writer
    // steps`; the prompt names each rule once. Regression: the waiver type is read from the line's text, so either reason files
    // its wave under the other waiver and exempts or gates the wrong work.
    test("a waiver's type comes from its flag, not from the words in its reason", async () => {
      const state = await setup();
      const { chief, planner, last } = await bypassedChain(state, { specs: "tests skipped by Chief: docs are unchanged", tests: "specs skipped by Chief: flaky suite" });
      const { prompt, context } = await reviewPrompt(state, chief.threadId, last);
      const testLine = `Wave 2 of 2: ${planFile(state, planner.threadId, 2)}: tests skipped by Chief: specs skipped by Chief: flaky suite`;
      const specLine = `Wave 1 of 2: ${planFile(state, planner.threadId, 1)}: specs skipped by Chief: tests skipped by Chief: docs are unchanged`;
      expect(section(context, "Waived test waves").trim()).toBe(testLine);
      expect(section(context, "Bypassed Spec Writer steps").trim()).toBe(specLine);
      expect(context.split(testLine)).toHaveLength(2);
      expect(context.split(specLine)).toHaveLength(2);
      expect(prompt).toContain("Chief waived the test waves listed under `## Waived test waves`");
      expect(prompt).toContain("Chief bypassed the Spec Writer on the waves listed under `## Bypassed Spec Writer steps`");
    });

    test("reviewBrief files each waiver line by its list, whatever its text says", () => {
      const target = { threadId: "thr_w", title: "Fix totals", prUrl: "https://github.com/acme/shop/pull/8", branch: "feature/x", reportSeq: 1, hasResult: true, reportPath: "/r/report-1.md",
        head: { branch: "feature/x", sha: "abc123", base: "main" } };
      const input: ReviewBriefInput = {
        worker: { ...target, kind: null, brief: null, reported: "Done" }, targets: [target], wavePaths: ["/p/plan-1.md", "/p/plan-2.md"], chain: [1, 2],
        contractLines: ["Wave 1 of 2:", "- Totals stay non-negative"], recordedLines: ["npm test → exit 0"], previous: null, chiefThreadId: "thr_c",
      };
      const asTests = reviewBrief({ ...input, waiverLines: ["Wave 2 of 2: /p/plan-2.md: tests skipped by Chief: specs skipped by Chief: flaky"] });
      expect(asTests.context).toContain("## Waived test waves\nWave 2 of 2: /p/plan-2.md: tests skipped by Chief: specs skipped by Chief: flaky");
      expect(asTests.context).not.toContain("## Bypassed Spec Writer steps");
      expect(asTests.prompt).toContain("Chief waived the test waves listed under `## Waived test waves`");
      expect(asTests.prompt).not.toContain("Chief bypassed the Spec Writer");
      const asSpecs = reviewBrief({ ...input, specWaiverLines: ["Wave 1 of 2: /p/plan-1.md: specs skipped by Chief: tests skipped by Chief: docs"] });
      expect(asSpecs.context).toContain("## Bypassed Spec Writer steps\nWave 1 of 2: /p/plan-1.md: specs skipped by Chief: tests skipped by Chief: docs");
      expect(asSpecs.context).not.toContain("## Waived test waves");
      expect(asSpecs.prompt).toContain("Chief bypassed the Spec Writer");
      expect(asSpecs.prompt).not.toContain("Chief waived the test waves");
    });

    // Contract 13 (bypassed wave's review): missing docs is not a finding, landed docs that contradict the code still are, and no
    // spec gate (no "marked spec: true", no blocking list) renders. Regression: a bypass leaves the gate on, so a review blocks
    // on docs nobody was asked to write, or the bypass sentence drops the contradiction rule.
    test("a bypassed spec wave's review excuses missing docs, keeps contradicting docs and renders no spec gate", async () => {
      const state = await setup();
      const { chief, last } = await bypassedChain(state, { specs: "docs are unchanged" });
      const { prompt } = await reviewPrompt(state, chief.threadId, last);
      expect(prompt).toContain("Review those waves against their plan: missing docs/ for them is not a finding, and they get no spec gate. The bypass never covers tests, and it never excuses landed docs/ that contradict the code.");
      expect(prompt).not.toMatch(/marked spec: true|This task ran a Spec Writer|\(1\) code that contradicts the committed docs/);
    });

    // Contract 14 (provenance): on a spec-bearing chain the reviewer's earlier-rows list keeps every Spec Writer and Tester row
    // even past four earlier rows, plus the worker interval line; a no-spec chain keeps the four-row cap. Regression: the
    // `.slice(0, 4)` cap drops the oldest Spec Writer (and the implementing worker's evidence) once the chain has a few fix rounds.
    test("a spec-bearing chain keeps every Spec Writer and Tester row in the review's earlier rows, a no-spec chain keeps the cap", async () => {
      const state = await setup();
      const { chief, planner, writer, tester } = await fullChain(state);
      const f1 = await swap(state, chief, planner.threadId, 2, tester, "worker");
      await readyIdle(state, f1);
      const t2 = await swap(state, chief, planner.threadId, 2, f1, "tester");
      await readyIdle(state, t2);
      const f2 = await swap(state, chief, planner.threadId, 2, t2, "worker");
      await readyIdle(state, f2);
      const t3 = await swap(state, chief, planner.threadId, 2, f2, "tester");
      await readyIdle(state, t3);
      const { prompt, context } = await reviewPrompt(state, chief.threadId, t3);
      const rows = context.split("\n").filter((line) => /^- (worker|tester|spec-writer|designer) thr_/.test(line));
      expect(rows.length).toBeGreaterThan(4);
      for (const row of [`spec-writer ${writer}`, `tester ${tester}`, `tester ${t2}`]) expect(rows.some((line) => line.startsWith(`- ${row}:`))).toBe(true);
      expect(prompt).toContain("Check each earlier worker on its own commits only: from the Base commit its report names to the Head commit it names");
      expect(prompt).toMatch(new RegExp(`Earlier here: [^.]*spec-writer ${writer}[^.]*`));

      const plainState = await setup();
      const chief2 = await start(plainState);
      let head = (await delegate(plainState, chief2.threadId, "Step 0")).threadId;
      const firstStep = head;
      for (let i = 1; i <= 5; i++) {
        await readyIdle(plainState, head, `Done ${i}`);
        head = (await delegate(plainState, chief2.threadId, `Step ${i}`, { replaces: head })).threadId;
      }
      await readyIdle(plainState, head, "Done 6");
      const plain = await reviewPrompt(plainState, chief2.threadId, head);
      const plainRows = plain.context.split("\n").filter((line) => /^- (worker|tester|spec-writer|designer) thr_/.test(line));
      expect(plainRows).toHaveLength(4);
      expect(plainRows.some((line) => line.includes(firstStep))).toBe(false);
      expect(plain.prompt).not.toContain("Check each earlier worker on its own commits only");
    });

    // Contract 15 (gate): the spec gate blocks on items (1)-(5) only, limits (5) to new or changed prose, needs no new commit for
    // correct content, and puts the ASD-STE100 rules in a trailing nit line. Regression: STE moves into the blocking list, or
    // the "no commit for correct content" / new-or-changed-prose limits are dropped, so reviews block on style or unchanged docs.
    test("the spec gate lists blocking items 1-5, the prose and no-commit limits, and the STE nit line", async () => {
      const state = await setup();
      const { chief, tester } = await fullChain(state);
      const { prompt } = await reviewPrompt(state, chief.threadId, tester);
      const gate = prompt.split("Block only on:\n")[1]!.split("\n\n")[0]!;
      const items = gate.split("\n");
      expect(items.slice(0, 5).map((line) => line.slice(0, 3))).toEqual(["(1)", "(2)", "(3)", "(4)", "(5)"]);
      expect(items[0]).toBe("(1) code that contradicts the committed docs;");
      expect(items[1]).toBe("(2) a test that contradicts them;");
      expect(items[2]).toBe("(3) a named Spec delta item that is missing or wrong in the final docs;");
      expect(items[3]).toBe("(4) a docs/ change in a worker's, designer's or tester's own commit range;");
      expect(items[4]).toMatch(/^\(5\) in new or changed docs prose only: no lead sentence saying what the domain is for;/);
      expect(items).toHaveLength(6);
      expect(items[5]).toBe("Content already correct needs no new commit. Unchanged existing docs are out of scope. A bypass never excuses landed docs that contradict the code. ASD-STE100 sentence rules (Simplified Technical English) are nits, never blocking.");
      expect(items.slice(0, 5).join("\n")).not.toMatch(/STE|Simplified Technical English/);
    });

    // Contract 17 (no-spec preservation, strings): for a plan with no spec wave, the alerts, Pending/roster text, review refusal,
    // stop reroute and reviewer hand-off Chief reads equal what #164's head (7c3a89d) produced on the same fixture. The oracle file
    // was captured by running this marked block unchanged against 7c3a89d; only the storage root is normalized.
    // Regression: a spec-first change that leaks a Spec Writer route, wording or ordering into a plan with no spec wave.
    // <strings-oracle-fixture>
    const stringsFixture = async (state: State) => {
      const out: string[] = [];
      const alertOf = () => state.sent.at(-1).input[0].text as string;
      const rosterOf = async (chiefThreadId: string) => String(await tool(state, "chief_roster", { includeComplete: true }, chiefThreadId));
      const chief = await start(state);
      const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE }, TEST_WAVE(2)]);
      const next = async (waveNo: number, extra: object) => {
        await delegateWave(state, chief.threadId, planner.threadId, waveNo, extra);
        return workerOn(state, planner.threadId, waveNo).thread_id as string;
      };
      const w1 = await next(1, {});
      await readyIdle(state, w1);
      out.push(`worker ready alert:\n${alertOf()}`, `roster:\n${await rosterOf(chief.threadId)}`);
      const t1 = await next(2, { replaces: w1, kind: "tester" });
      await report(state, t1, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
      setLive(state, t1, "idle");
      out.push(`blocked tester alert:\n${alertOf()}`, `roster:\n${await rosterOf(chief.threadId)}`);
      const stopped = await (async () => {
        setLive(state, t1, "active");
        const reply = await state.harness.behavior.runCli(["stop", t1, "--reason", "stuck"], ctxOf(state, chief.threadId));
        return reply.stdout as string;
      })();
      out.push(`stop reply:\n${stopped}`);
      const fix = await next(2, { replaces: t1, kind: "worker" });
      await readyIdle(state, fix);
      out.push(`fix ready alert:\n${alertOf()}`);
      const t2 = await next(2, { replaces: fix, kind: "tester" });
      await readyIdle(state, t2);
      out.push(`tester ready alert:\n${alertOf()}`, `roster:\n${await rosterOf(chief.threadId)}`);
      out.push(`review refusal:\n${await tool(state, "chief_review", { workerThreadId: w1 }, chief.threadId).then(() => "started", (error: Error) => error.message)}`);
      await reviewed(state, chief.threadId, t2, "request_changes");
      out.push(`request_changes alert:\n${alertOf()}`);
      return out.map((block) => `=== ${block.split(":\n")[0]} ===\n${block.replaceAll(state.storageRoot, "<storage>")}\n`).join("");
    };
    // </strings-oracle-fixture>

    test("a plan with no spec wave produces the strings #164's head produced", async () => {
      const state = await setup();
      const head = await stringsFixture(state);
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "strings-no-spec-7c3a89d.txt"), "utf8");
      expect(head).toBe(oracle);
    });

    // Contract 17 (no-spec preservation, briefs): the worker, designer and tester prompts chief_delegate builds on the oracle fixture
    // are the bytes base 8250f0c built, apart from #164's tester `Head commit` line, normalized by name. The oracle file was
    // captured by running the marked block against 8250f0c; only the storage root is normalized.
    // Regression: any unrelated work order added, reworded or dropped in these prompts by the spec-first change.
    // <brief-oracle-fixture>
    const briefFixture = async (state: State) => {
      const chief = await start(state);
      const out: Record<string, string> = {};
      const last = () => state.spawned.at(-1).prompt as string;
      const unplanned = await delegate(state, chief.threadId, "Plain");
      out["worker, unplanned"] = last();
      await delegate(state, chief.threadId, "Design", { kind: "designer" });
      out["designer, unplanned"] = last();
      await readyIdle(state, unplanned.threadId, "Done");
      await delegate(state, chief.threadId, "Tests", { replaces: unplanned.threadId, kind: "tester" });
      out["tester, unplanned"] = last();
      const planner = await plan(state, chief.threadId, [{ body: PLAN_FIXTURE },
        { body: wave(2, "Write the tests.\n\n## Spec delta\n- docs/specs/totals.md: CHANGED totals never go negative"), test: true }]);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { verifyCommand: "npx vitest run server.test.ts -t totals" });
      out["worker, planned"] = last();
      const impl = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, impl);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
      out["tester, planned"] = last();
      return Object.entries(out).map(([name, prompt]) => `=== ${name} ===\n${prompt.replaceAll(state.storageRoot, "<storage>")}\n`).join("");
    };
    // </brief-oracle-fixture>

    test("worker, designer and tester prompts equal base 8250f0c's apart from the tester Head commit line", async () => {
      const state = await setup();
      const head = await briefFixture(state);
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "briefs-base-8250f0c.txt"), "utf8");
      const headCommit = "- When you report, record `git rev-parse HEAD` as `Head commit: <sha>`.";
      const lines = head.split("\n");
      expect(lines.filter((line) => line === headCommit)).toHaveLength(2);
      expect(lines.filter((line) => line !== headCommit).join("\n")).toBe(oracle);
    });

    // Contract 17 (planner and advisor briefs): they change on purpose, so assert the changed lines only. The planner is told the
    // spec flag, the `## Spec delta` heading and that the Spec Writer runs before the wave's worker; the advisor's plan review
    // checks a docs-changing chain for a missing spec: true wave.
    test("the planner's and the advisor's briefs carry the spec-first lines", async () => {
      const state = await setup();
      const chief = await start(state);
      await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"], ctxOf(state, chief.threadId));
      const planPrompt = state.spawned.at(-1).prompt as string;
      expect(planPrompt).toContain("`{body, dependsOn, design?, test?, spec?}`");
      expect(planPrompt).toContain("mark the implementation wave that makes the change `spec: true` and give that wave a `## Spec delta` heading for the Spec Writer, who commits the docs before the wave's worker runs. Test waves are never `spec: true`.");
      expect(planPrompt).not.toContain("mark its test wave `spec: true`");

      const planner = await plan(state, chief.threadId, [specImpl(1), planWave(2), TEST_WAVE(3)]);
      await approvePlan(state, chief.threadId, planner.threadId);
      const advisorPrompt = state.spawned.at(-1).prompt as string;
      expect(advisorPrompt).toContain("A chain that changes documented behaviour with no `spec: true` implementation wave, or a `## Spec delta` that names no docs file or restates test cases.");
      // Contract (advisor plan-review checklist): the reshape line follows the test-wave line, and only a plan review has it.
      expect(advisorPrompt).toContain(`- A chain without a final test wave, or test work inside an implementation wave.\n${RESHAPE_CHECKLIST_LINE}\n`);
      await tool(state, "chief_consult", { title: "Totals", mission: "Why do totals go negative?" }, chief.threadId);
      expect(state.spawned.at(-1).prompt).not.toContain(RESHAPE_CHECKLIST_LINE);
    });

    const hop = async (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, extra: object = {}) => {
      await delegateWave(state, chiefThreadId, planThreadId, waveNo, extra);
      return { id: workerOn(state, planThreadId, waveNo).thread_id as string, prompt: state.spawned.at(-1).prompt as string };
    };
    /** Spec chain of two spec waves then a test wave, run to the end: every row ready and idle. */
    async function mixedChain(state: State, waves: object[]) {
      const { chief, planner } = await specPlan(state, waves, true);
      const go = async (waveNo: number, extra: object) => {
        const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
        await readyIdle(state, row.id);
        return row;
      };
      const w1Writer = await go(1, {});
      const w1Worker = await go(1, { replaces: w1Writer.id, kind: "worker" });
      const w2Writer = await go(2, { replaces: w1Worker.id });
      const w2Worker = await go(2, { replaces: w2Writer.id, kind: "worker" });
      const tester = await go(3, { replaces: w2Worker.id, kind: "tester" });
      return { chief, planner, w1Writer, w1Worker, w2Writer, w2Worker, tester };
    }
    const asOracle = (state: State, entries: Array<[string, string]>) =>
      entries.map(([name, text]) => `=== ${name} ===\n${text.replaceAll(state.storageRoot, "<storage>")}\n`).join("");

    /** Spec Writer, worker, tester, a test-wave docs repair and the reviewer of a spec chain with no baseline, plus their alerts. */
    const existingOnlyFixture = async (state: State) => {
      const out: Array<[string, string]> = [];
      const { chief, planner } = await specPlan(state);
      const writer = await hop(state, chief.threadId, planner.threadId, 1);
      out.push(["spec writer prompt", writer.prompt]);
      await readyIdle(state, writer.id);
      out.push(["spec writer ready alert", lastAlert(state)], ["roster after writer", await roster(state, chief.threadId)]);
      const worker = await hop(state, chief.threadId, planner.threadId, 1, { replaces: writer.id, kind: "worker" });
      out.push(["worker prompt", worker.prompt]);
      await readyIdle(state, worker.id);
      out.push(["worker ready alert", lastAlert(state)]);
      const tester = await hop(state, chief.threadId, planner.threadId, 2, { replaces: worker.id, kind: "tester" });
      out.push(["tester prompt", tester.prompt]);
      await readyIdle(state, tester.id);
      out.push(["tester ready alert", lastAlert(state)]);
      const docs = await hop(state, chief.threadId, planner.threadId, 2, { replaces: tester.id, kind: "spec-writer" });
      out.push(["test-wave spec writer prompt", docs.prompt]);
      await readyIdle(state, docs.id);
      out.push(["test-wave spec writer ready alert", lastAlert(state)]);
      const review = await reviewPrompt(state, chief.threadId, docs.id);
      out.push(["reviewer prompt", review.prompt], ["reviewer context", review.context]);
      return asOracle(state, out);
    };

    /** Wave 1's Spec Writer and worker prompts of a chain whose wave 2 (not wave 1) has a baseline. */
    const mixedWaveOneFixture = async (state: State) => {
      const chain = await mixedChain(state, [specImpl(1), baseImpl(2), TEST_WAVE(3)]);
      return asOracle(state, [["wave 1 spec writer prompt", chain.w1Writer.prompt], ["wave 1 worker prompt", chain.w1Worker.prompt]]);
    };

    /** The planner prompt for a plain brief and for a revision of a plan whose one advisor review asked for changes. */
    const plannerFixture = async (state: State) => {
      const chief = await start(state);
      const cli = (args: string[]) => state.harness.behavior.runCli(args, ctxOf(state, chief.threadId));
      await cli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--context", "Totals went negative last week."]);
      const plain = state.spawned.at(-1).prompt as string;
      const first = await plan(state, chief.threadId, [planWave(1), planWave(2), TEST_WAVE(3)]);
      await tool(state, "chief_consult", { planThreadId: first.threadId, title: "Plan", mission: "Review this plan before delegation" }, chief.threadId);
      const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
      await report(state, advisor.threadId, { state: "ready", result: "Merge the two waves", verdict: "request_changes" });
      await cli(["plan", "--title", "Rework checkout", "--mission", "Revise per the advisor", "--revises", first.threadId]);
      return asOracle(state, [["plain planner prompt", plain], ["revision planner prompt", state.spawned.at(-1).prompt as string]]);
    };
    // <baseline-oracle-end>

    const oracleFile = (name: string) => readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", name), "utf8");
    const WRITER_BASELINE = "- Baseline: this wave's plan has a `## Spec baseline` heading.";
    const TESTER_BASELINE = "- A new spec's baseline (the current behaviour a Spec Writer documented";
    const gateOf = (prompt: string) => prompt.split("Block only on:\n")[1]!.split("\n\n")[0]!.split("\n");

    // Contract (existing-only equivalence, base oracle): a spec chain whose waves have no baseline spawns the Spec Writer, worker,
    // tester, test-wave Spec Writer and reviewer, and sends the alerts, with the bytes base 6d288a2 produced. Regression: a baseline
    // line, reworded line or extra gate item leaks into a chain that has no baseline.
    test("a spec chain with no baseline produces the prompts and alerts base 6d288a2 produced", async () => {
      const state = await setup();
      // Only the reviewer prompt changed: the make-native line follows its "Classify the change" line.
      expect(await existingOnlyFixture(state)).toBe(withReviewerLine(await oracleFile("spec-chain-6d288a2.txt")));
    });

    // Contract (planner equivalence, base oracle): plannerBrief output is the bytes of base 6d288a2 for a plain and a revision brief.
    // Regression: the baseline rule lands in the planner brief instead of the read-only skill.
    // Plan chains changed one bullet of both prompts (the `dependsOn: []` sentence now says an independent wave runs as its own chain); the rest is base's bytes.
    test("the planner prompt equals base 6d288a2's for a plain and a revision brief", async () => {
      const state = await setup();
      // Plain and revision briefs each gain the reshape rule right after the test-wave line (2 anchors); nothing else moves.
      expect(await plannerFixture(state)).toBe(spliceAfter(await oracleFile("planner-6d288a2.txt"), PLANNER_ANCHOR, PLANNER_RESHAPE_LINE, 2));
    });

    // Contract (mixed chain, existing-only first): wave 1's Spec Writer and worker prompts are base 6d288a2's bytes although wave 2 has
    // a baseline; wave 2's Spec Writer has the Baseline line, its worker does not, and the wave 3 tester has the tester line.
    // Regression: an unconditional line; a Spec Writer flag read from any wave of the chain (wave 1's writer would get wave 2's
    // line); a worker or designer that gets the Spec Writer line; a tester flag read from its own wave only.
    test("a baseline on wave 2 reaches wave 2's Spec Writer and the tester, not wave 1's prompts or wave 2's worker", async () => {
      const state = await setup();
      const chain = await mixedChain(state, [specImpl(1), baseImpl(2), TEST_WAVE(3)]);
      expect(chain.w1Writer.prompt).not.toContain(WRITER_BASELINE);
      expect(chain.w1Worker.prompt).not.toContain(WRITER_BASELINE);
      expect(chain.w2Writer.prompt).toContain(WRITER_BASELINE);
      expect(chain.w2Worker.prompt).not.toMatch(/baseline/i);
      expect(chain.tester.prompt).toContain(TESTER_BASELINE);
      expect(chain.tester.prompt).not.toContain(WRITER_BASELINE);
    });

    // Contract (mixed chain, byte identity): wave 1's Spec Writer and worker prompts are the bytes base 6d288a2 produced although wave 2
    // of the chain has a baseline. Regression: a Spec Writer or worker flag read from any wave of the chain.
    test("wave 1's prompts of a chain whose wave 2 has a baseline equal base 6d288a2's", async () => {
      const state = await setup();
      expect(await mixedWaveOneFixture(state)).toBe(await oracleFile("spec-chain-mixed-wave-1-6d288a2.txt"));
    });

    // Contract (mixed chain, reversed order): wave 1 has the baseline, wave 2 does not: wave 2's Spec Writer gets no line, and the
    // tester gets its line from ancestor wave 1. Regression: a Spec Writer that reads its ancestors' flag; a tester that reads only
    // its own wave.
    test("a baseline on wave 1 reaches wave 1's Spec Writer and the tester, not wave 2's Spec Writer", async () => {
      const state = await setup();
      const chain = await mixedChain(state, [baseImpl(1), specImpl(2), TEST_WAVE(3)]);
      expect(chain.w1Writer.prompt).toContain(WRITER_BASELINE);
      expect(chain.w1Worker.prompt).not.toMatch(/baseline/i);
      expect(chain.w2Writer.prompt).not.toMatch(/baseline/i);
      expect(chain.w2Worker.prompt).not.toMatch(/baseline/i);
      expect(chain.tester.prompt).toContain(TESTER_BASELINE);
    });

    // Contract (isolation): a baseline wave on another chain gives the other chain's Spec Writer and tester no line, and its own chain
    // still gets both. Regression: a flag read from any wave of the plan.
    test("a baseline on another chain reaches only that chain's Spec Writer and tester", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), TEST_WAVE(2), baseImpl(3, { dependsOn: [] }), TEST_WAVE(4, [3])], true);
      const go = async (waveNo: number, extra: object) => {
        const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
        await readyIdle(state, row.id);
        return row;
      };
      const bWriter = await go(3, { branch: "feature/b" });
      const aWriter = await go(1, { branch: "feature/a" });
      const bWorker = await go(3, { replaces: bWriter.id, kind: "worker" });
      const aWorker = await go(1, { replaces: aWriter.id, kind: "worker" });
      const bTester = await go(4, { replaces: bWorker.id, kind: "tester" });
      const aTester = await go(2, { replaces: aWorker.id, kind: "tester" });
      expect(bWriter.prompt).toContain(WRITER_BASELINE);
      expect(bTester.prompt).toContain(TESTER_BASELINE);
      expect(aWriter.prompt).not.toMatch(/baseline/i);
      expect(aTester.prompt).not.toMatch(/baseline/i);
    });

    // Contract (bypass): a baseline wave with chief_skip_specs sets no tester line and does not count in the reviewer's spec waves,
    // while the unbypassed spec wave that follows still renders the gate, without item (6). Regression: a flag read from a bypassed
    // wave (tester line or item (6) appears); item (6) read from every wave instead of the reviewed, unbypassed ones.
    test("a bypassed baseline wave gives the tester no line and the reviewer no item (6)", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [baseImpl(1), specImpl(2), TEST_WAVE(3)], true);
      await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
      const go = async (waveNo: number, extra: object) => {
        const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
        await readyIdle(state, row.id);
        return row;
      };
      const w1 = await go(1, {});
      const w2Writer = await go(2, { replaces: w1.id });
      const w2Worker = await go(2, { replaces: w2Writer.id, kind: "worker" });
      const tester = await go(3, { replaces: w2Worker.id, kind: "tester" });
      expect(rowOf(state, w1.id).kind).toBeNull();
      for (const row of [w1, w2Writer, w2Worker, tester]) expect(row.prompt).not.toMatch(/baseline/i);
      const { prompt } = await reviewPrompt(state, chief.threadId, tester.id);
      const gate = gateOf(prompt);
      expect(gate).toHaveLength(6);
      expect(gate.map((line) => line.slice(0, 3))).not.toContain("(6)");
    });

    // Contract (repairs): a Spec Writer that replaces the worker of a baseline wave, or repairs on the test wave, gets no Baseline
    // line; a retry of a writer that has not handed off gets it. Regression: the flag is set after the worker ran (repair gets the
    // line); the test-wave repair reads its ancestor's flag; the retry loses the line.
    test("a Spec Writer repair after the worker or on the test wave gets no baseline line, a retry before the worker does", async () => {
      const waves = () => [baseImpl(1), TEST_WAVE(2)];
      const afterWorker = await setup();
      const first = await withWriter(afterWorker, waves());
      await readyIdle(afterWorker, first.writer);
      const worker = await swap(afterWorker, first.chief, first.planner.threadId, 1, first.writer, "worker");
      await readyIdle(afterWorker, worker);
      await swap(afterWorker, first.chief, first.planner.threadId, 1, worker, "spec-writer");
      expect(afterWorker.spawned.at(-1).prompt).not.toMatch(/baseline/i);

      const onTestWave = await setup();
      const chain = await fullChain(onTestWave, waves());
      await swap(onTestWave, chain.chief, chain.planner.threadId, 2, chain.tester, "spec-writer");
      expect(onTestWave.spawned.at(-1).prompt).not.toMatch(/baseline/i);

      const retry = await setup();
      const stalled = await withWriter(retry, waves());
      expect(retry.spawned.at(-1).prompt).toContain(WRITER_BASELINE);
      await putWriter(retry, stalled.chief.threadId, stalled.writer, "blocked");
      await swap(retry, stalled.chief, stalled.planner.threadId, 1, stalled.writer, "spec-writer");
      expect(retry.spawned.at(-1).prompt).toContain(WRITER_BASELINE);
    });

    // Contract (replaces: alone): a retry that names only `replaces:` resolves the plan and wave from the replaced row and renders the
    // prompt of the call that names them. Regression: the bare call falls back to the unplanned branch (no line) or another wave's flag.
    test("a Spec Writer retry with replaces alone renders the same prompt as one naming the plan and wave", async () => {
      const prompts: string[] = [];
      for (const bare of [false, true]) {
        const state = await setup();
        const { chief, planner, writer } = await withWriter(state, [baseImpl(1), TEST_WAVE(2)]);
        await putWriter(state, chief.threadId, writer, "blocked");
        if (bare) await tool(state, "chief_delegate", { title: "Wave 1", mission: "Do the wave.", replaces: writer, kind: "spec-writer" }, chief.threadId);
        else await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind: "spec-writer" });
        prompts.push((state.spawned.at(-1).prompt as string).replaceAll(state.storageRoot, "<storage>"));
      }
      expect(prompts[0]).toContain(WRITER_BASELINE);
      expect(prompts[1]).toBe(prompts[0]);
    });

    // Contract (cross-plan recovery): a fresh plan's wave 1 writer that replaces a blocked writer of another plan reads the fresh
    // plan's flag, in both directions. Regression: the flag is read from the replaced row's plan.
    test.each<[string, object[], object[], boolean]>([
      ["a fresh baseline plan replacing a plain plan's writer", [specImpl(1), TEST_WAVE(2)], [baseImpl(1), TEST_WAVE(2)], true],
      ["a fresh plain plan replacing a baseline plan's writer", [baseImpl(1), TEST_WAVE(2)], [specImpl(1), TEST_WAVE(2)], false],
    ])("cross-plan recovery reads the fresh plan's flag: %s", async (_label, oldWaves, freshWaves, expected) => {
      const state = await setup();
      const old = await withWriter(state, oldWaves, { branch: "feature/a" });
      await putWriter(state, old.chief.threadId, old.writer, "blocked");
      const fresh = await plan(state, old.chief.threadId, freshWaves);
      await delegateWave(state, old.chief.threadId, fresh.threadId, 1, { replaces: old.writer, kind: "spec-writer" });
      expect((state.spawned.at(-1).prompt as string).includes(WRITER_BASELINE)).toBe(expected);
    });

    // Contract (persist round-trip): intake stores `baseline: true` only on a spec wave whose body has the heading; every other wave
    // has no `baseline` key, so the old JSON shape stays. Regression: the key is not stored (no wave gets a line); it is stored on
    // every spec wave; bold text or a non-spec wave gets it.
    test("intake stores baseline: true only on the spec wave that has the heading", async () => {
      const state = await setup();
      const boldOnly = specImpl(3, { dependsOn: [], body: wave(3, `Build.\n\n${SPEC_DELTA}\n\n**Spec baseline**\n- docs/x.md`) + NOT_DOING });
      const { planner } = await specPlan(state, [baseImpl(1), TEST_WAVE(2), boldOnly, TEST_WAVE(4, [3]), specImpl(5, { dependsOn: [] }), TEST_WAVE(6, [5])]);
      const stored = JSON.parse(planWaves(state, planner.threadId));
      expect(stored[0].baseline).toBe(true);
      for (const index of [1, 2, 3, 4, 5]) expect(stored[index]).not.toHaveProperty("baseline");
      expect(stored.map((entry: any) => entry.spec)).toEqual([true, undefined, true, undefined, true, undefined]);
    });

    // Contract (legacy row): a plan stored before this change has no `baseline` key; its body still has the heading, and no baseline
    // line renders for its Spec Writer or its tester. Regression: a runtime heading parse (the writer and tester get the lines).
    test("a stored plan without the baseline key renders no baseline line although its wave body has the heading", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [baseImpl(1), TEST_WAVE(2)]);
      expect(await readFile(planFile(state, planner.threadId, 1), "utf8")).toContain("## Spec baseline");
      const legacy = JSON.parse(planWaves(state, planner.threadId)).map(({ baseline: _dropped, ...rest }: any) => rest);
      state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
      await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, chief.threadId);
      expect(storedWave(state, planner.threadId)).not.toHaveProperty("baseline");
      const writer = await hop(state, chief.threadId, planner.threadId, 1);
      await readyIdle(state, writer.id);
      const worker = await hop(state, chief.threadId, planner.threadId, 1, { replaces: writer.id, kind: "worker" });
      await readyIdle(state, worker.id);
      const tester = await hop(state, chief.threadId, planner.threadId, 2, { replaces: worker.id, kind: "tester" });
      for (const row of [writer, worker, tester]) expect(row.prompt).not.toMatch(/baseline/i);
    });

    // Contract (reviewer item (6)): on a plan with a baseline the spec gate lists items (1)-(6) blocking, then the "Content already
    // correct" line that carries the STE nit; item (6) is absent when no reviewed spec wave has a baseline. Regression: item (6)
    // placed after the STE line (the nit line is no longer last); item (6) shown for every spec plan.
    test("the spec gate puts item (6) between item (5) and the Content already correct line, for a baseline plan only", async () => {
      const state = await setup();
      const chain = await mixedChain(state, [specImpl(1), baseImpl(2), TEST_WAVE(3)]);
      const { prompt } = await reviewPrompt(state, chain.chief.threadId, chain.tester.id);
      const items = gateOf(prompt);
      expect(items).toHaveLength(7);
      expect(items.slice(0, 5).map((line) => line.slice(0, 3))).toEqual(["(1)", "(2)", "(3)", "(4)", "(5)"]);
      expect(items[5]).toMatch(/^\(6\) a baseline statement /);
      expect(items[6]).toMatch(/^Content already correct needs no new commit\..*ASD-STE100 sentence rules .*nits, never blocking\.$/);
      expect(items.slice(0, 6).join("\n")).not.toMatch(/STE|Simplified Technical English/);

      const plain = await setup();
      const noBaseline = await mixedChain(plain, [specImpl(1), specImpl(2), TEST_WAVE(3)]);
      const plainItems = gateOf((await reviewPrompt(plain, noBaseline.chief.threadId, noBaseline.tester.id)).prompt);
      expect(plainItems).toHaveLength(6);
      expect(plainItems.join("\n")).not.toContain("(6)");
    });
  });
});
