import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { CHAIN, CHAIN_PR, NOT_DOING, SPEC_DELTA, baseImpl, fullChain, lastAlert, putWriter, roster, section, skipSpecs, specImpl, specPlan, storedWave, swap, withWriter } from "./test/specWriterHelpers";
import { type State, delegateWave, forgeAnswers, openGate, plan, planWaves, readyIdle, rowOf, spawnOf, tool, workerOn } from "./test/testerHelpers";
import { disposeAll, planFile, reviewContextOf, setup, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// The side-lane Spec Writer's reach into the review gate and its brief: waivers, earlier rows, the spec gate items, and the baseline flag.
// A gate reviews the whole plan chain; its reviewer prompt and review-context are read here by structure (sections, item numbers, presence), not by wording.
describe("Spec Writer role", () => {
  const PR_B = "https://github.com/o/r/pull/8";
  const reviewPrompt = async (state: State, chiefThreadId: string, targetId: string) => {
    forgeAnswers({ [CHAIN_PR]: CHAIN, [PR_B]: "feature/b" });
    const gate = await openGate(state, chiefThreadId, targetId);
    return { prompt: spawnOf(state, gate.reviewer_thread_id).prompt as string, context: await reviewContextOf(state, gate.reviewer_thread_id) };
  };
  const rowsOf = (context: string) => context.split("\n").filter((line) => /^- (worker|tester|spec-writer|designer) thr_/.test(line));
  const gateOf = (prompt: string) => prompt.split("Block only on:\n")[1]!.split("\n\n")[0]!.split("\nRead each worker report")[0]!.split("\n");
  const numbers = (items: string[]) => items.map((line) => line.slice(0, 3));
  const hop = async (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, extra: object = {}) => {
    await delegateWave(state, chiefThreadId, planThreadId, waveNo, extra);
    return { id: workerOn(state, planThreadId, waveNo).thread_id as string, prompt: state.spawned.at(-1).prompt as string };
  };
  /** Two spec waves run to the end: each wave's worker and its side-lane Spec Writer, every row ready and idle. */
  async function mixedChain(state: State, waves: object[]) {
    const { chief, planner } = await specPlan(state, waves, true);
    const go = async (waveNo: number, extra: object) => {
      const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
      await readyIdle(state, row.id);
      return row;
    };
    const w1Worker = await go(1, { branch: CHAIN, prUrl: CHAIN_PR });
    const w1Writer = await go(1, { kind: "spec-writer", branch: CHAIN, prUrl: CHAIN_PR });
    const w2Worker = await go(2, { replaces: w1Worker.id });
    const w2Writer = await go(2, { kind: "spec-writer" });
    return { chief, planner, w1Writer, w1Worker, w2Writer, w2Worker };
  }
  const WRITER_BASELINE = "- Baseline: this wave's plan has a `## Spec baseline` heading.";

  // Contract (bypass): a wave Chief bypassed with chief_skip_specs is listed with its reason under `## Bypassed Spec Writer steps` in review-context, and its
  // review renders no spec gate. Regression: the bypass is dropped from the context, or a bypassed wave keeps the blocking docs list.
  test("a bypassed spec wave is listed with its reason and gets no spec gate", async () => {
    const state = await setup();
    const { chief, planner } = await specPlan(state);
    await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
    await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR });
    const worker = workerOn(state, planner.threadId, 1).thread_id as string;
    await readyIdle(state, worker);
    const { prompt, context } = await reviewPrompt(state, chief.threadId, worker);
    expect(section(context, "Bypassed Spec Writer steps").trim()).toBe(`Wave 1 of 1: ${planFile(state, planner.threadId, 1)}: specs skipped by Chief: docs are unchanged`);
    expect(prompt).not.toContain("Block only on:\n(1)");
    expect(prompt).not.toMatch(/marked spec: true|This task ran a Spec Writer/);
  });

  // Contract (provenance): the side-lane Spec Writer is not an earlier row of the implementation branch, but has its own `## Side-lane Spec Writers` entry; the
  // earlier rows of a spec chain keep the 4-row cap. Regression: the side writer is listed as an earlier row (its docs/ commits would read as drift), or loses its entry.
  test("a spec chain lists its side writer apart from the earlier rows, which keep the cap", async () => {
    const state = await setup();
    const { chief, planner, writer, worker } = await fullChain(state);
    let head = worker;
    for (let i = 0; i < 5; i++) {
      head = await swap(state, chief, planner.threadId, 1, head, "worker");
      await readyIdle(state, head);
    }
    const { context } = await reviewPrompt(state, chief.threadId, head);
    const rows = rowsOf(context);
    expect(rows).toHaveLength(4);
    expect(rows.some((line) => line.includes(writer))).toBe(false);
    expect(section(context, "Side-lane Spec Writers")).toContain(`- wave 1 Spec Writer ${writer}:`);
  });

  // Contract (gate items): the spec gate blocks on items (1)-(5) in order, then the one "Content already correct" nit line; item (6) is added only when a reviewed
  // spec wave has a baseline, between (5) and that line. Regression: item (6) shown for every spec plan, or placed after the nit line.
  test("the spec gate lists items (1)-(5) and the nit line, and item (6) only for a baseline plan", async () => {
    const plain = await setup();
    const noBaseline = await mixedChain(plain, [specImpl(1), specImpl(2)]);
    const plainItems = gateOf((await reviewPrompt(plain, noBaseline.chief.threadId, noBaseline.w2Worker.id)).prompt);
    expect(numbers(plainItems)).toEqual(["(1)", "(2)", "(3)", "(4)", "(5)", "Con"]);

    const state = await setup();
    const chain = await mixedChain(state, [specImpl(1), baseImpl(2)]);
    const items = gateOf((await reviewPrompt(state, chain.chief.threadId, chain.w2Worker.id)).prompt);
    expect(numbers(items)).toEqual(["(1)", "(2)", "(3)", "(4)", "(5)", "(6)", "Con"]);
  });

  // Contract (existing-only, no leak): a spec chain whose waves have no baseline spawns the side-lane Spec Writer, worker and reviewer, and sends the alerts, with no
  // baseline text anywhere. Regression: a baseline line or gate item leaks into a chain that has no baseline.
  test("a spec chain with no baseline renders no baseline line or item (6) in any prompt or alert", async () => {
    const state = await setup();
    const { chief, planner } = await specPlan(state);
    const worker = await hop(state, chief.threadId, planner.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR });
    const writer = await hop(state, chief.threadId, planner.threadId, 1, { kind: "spec-writer", branch: CHAIN, prUrl: CHAIN_PR });
    const seen = [worker.prompt, writer.prompt];
    await readyIdle(state, writer.id);
    seen.push(lastAlert(state), await roster(state, chief.threadId));
    await readyIdle(state, worker.id);
    seen.push(lastAlert(state));
    const review = await reviewPrompt(state, chief.threadId, worker.id);
    seen.push(review.prompt, review.context);
    for (const text of seen) expect(text).not.toMatch(/baseline/i);
    expect(gateOf(review.prompt)).toHaveLength(6);
  });

  // Contract (mixed chain, existing-only first): wave 1's Spec Writer and worker prompts carry no baseline although wave 2 has one; wave 2's Spec Writer has the
  // Baseline line, its worker does not. Regression: an unconditional line; a flag read from any wave of the chain; a worker that gets the Spec Writer line.
  test("a baseline on wave 2 reaches wave 2's Spec Writer, not wave 1's prompts or wave 2's worker", async () => {
    const state = await setup();
    const chain = await mixedChain(state, [specImpl(1), baseImpl(2)]);
    expect(chain.w1Writer.prompt).not.toContain(WRITER_BASELINE);
    expect(chain.w1Worker.prompt).not.toContain(WRITER_BASELINE);
    expect(chain.w2Writer.prompt).toContain(WRITER_BASELINE);
    expect(chain.w2Worker.prompt).not.toMatch(/baseline/i);
  });

  // Contract (mixed chain, wave-1 isolation): wave 1's prompts of a chain whose wave 2 has a baseline equal those of the same chain with none.
  // Regression: a Spec Writer or worker flag read from any wave of the chain.
  test("wave 1's prompts of a chain whose wave 2 has a baseline equal those of a chain with no baseline", async () => {
    const prompts = async (waves: object[]) => {
      const state = await setup();
      const chain = await mixedChain(state, waves);
      return [chain.w1Writer.prompt, chain.w1Worker.prompt].map((prompt) => prompt.replaceAll(state.storageRoot, "<storage>"));
    };
    const withBaseline = await prompts([specImpl(1), baseImpl(2)]);
    expect(withBaseline).toEqual(await prompts([specImpl(1), specImpl(2)]));
    expect(withBaseline[0]).not.toMatch(/baseline/i);
  });

  // Contract (mixed chain, reversed order): wave 1 has the baseline, wave 2 does not: wave 2's Spec Writer gets no line.
  // Regression: a Spec Writer that reads its ancestors' flag.
  test("a baseline on wave 1 reaches wave 1's Spec Writer, not wave 2's", async () => {
    const state = await setup();
    const chain = await mixedChain(state, [baseImpl(1), specImpl(2)]);
    expect(chain.w1Writer.prompt).toContain(WRITER_BASELINE);
    for (const row of [chain.w1Worker, chain.w2Writer, chain.w2Worker]) expect(row.prompt).not.toMatch(/baseline/i);
  });

  // Contract (isolation): a baseline wave on another chain gives the other chain's Spec Writer no line, and its own chain still gets it.
  // Regression: a flag read from any wave of the plan.
  test("a baseline on another chain reaches only that chain's Spec Writer", async () => {
    const state = await setup();
    const { chief, planner } = await specPlan(state, [specImpl(1), baseImpl(2, { dependsOn: [] })], true);
    const go = async (waveNo: number, extra: object) => {
      const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
      await readyIdle(state, row.id);
      return row;
    };
    await go(2, { branch: "feature/b", prUrl: PR_B });
    const bWriter = await go(2, { kind: "spec-writer", branch: "feature/b", prUrl: PR_B });
    await go(1, { branch: "feature/a", prUrl: CHAIN_PR });
    const aWriter = await go(1, { kind: "spec-writer", branch: "feature/a", prUrl: CHAIN_PR });
    expect(bWriter.prompt).toContain(WRITER_BASELINE);
    expect(aWriter.prompt).not.toMatch(/baseline/i);
  });

  // Contract (bypass): a baseline wave with chief_skip_specs sets no baseline line and does not count in the reviewer's spec waves, while the unbypassed spec wave
  // that follows still renders the gate, without item (6). Regression: a flag read from a bypassed wave; item (6) read from every wave instead of the reviewed ones.
  test("a bypassed baseline wave gives no baseline line and the reviewer no item (6)", async () => {
    const state = await setup();
    const { chief, planner } = await specPlan(state, [baseImpl(1), specImpl(2)], true);
    await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
    const go = async (waveNo: number, extra: object) => {
      const row = await hop(state, chief.threadId, planner.threadId, waveNo, extra);
      await readyIdle(state, row.id);
      return row;
    };
    const w1 = await go(1, { branch: CHAIN, prUrl: CHAIN_PR });
    const w2Worker = await go(2, { replaces: w1.id });
    const w2Writer = await go(2, { kind: "spec-writer" });
    expect(rowOf(state, w1.id).kind).toBeNull();
    for (const row of [w1, w2Writer, w2Worker]) expect(row.prompt).not.toMatch(/baseline/i);
    const gate = gateOf((await reviewPrompt(state, chief.threadId, w2Worker.id)).prompt);
    expect(numbers(gate)).toEqual(["(1)", "(2)", "(3)", "(4)", "(5)", "Con"]);
  });

  // Contract (repairs): a Spec Writer that replaces the worker of a baseline wave gets no Baseline line; a retry of a writer that has not handed off gets it.
  // Regression: the flag is set after the worker ran (the repair gets the line); the retry loses the line.
  test("a Spec Writer repair after the worker gets no baseline line, a retry before the worker does", async () => {
    const afterWorker = await setup();
    const first = await withWriter(afterWorker, [baseImpl(1)]);
    await readyIdle(afterWorker, first.writer);
    const worker = await swap(afterWorker, first.chief, first.planner.threadId, 1, first.writer, "worker");
    await readyIdle(afterWorker, worker);
    await swap(afterWorker, first.chief, first.planner.threadId, 1, worker, "spec-writer");
    expect(afterWorker.spawned.at(-1).prompt).not.toMatch(/baseline/i);

    const retry = await setup();
    const stalled = await withWriter(retry, [baseImpl(1)]);
    expect(retry.spawned.at(-1).prompt).toContain(WRITER_BASELINE);
    await putWriter(retry, stalled.chief.threadId, stalled.writer, "blocked");
    await swap(retry, stalled.chief, stalled.planner.threadId, 1, stalled.writer, "spec-writer");
    expect(retry.spawned.at(-1).prompt).toContain(WRITER_BASELINE);
  });

  // Contract (replaces: alone): a retry that names only `replaces:` resolves the plan and wave from the replaced row and renders the prompt of the call that names them.
  // Regression: the bare call falls back to the unplanned branch (no line) or another wave's flag.
  test("a Spec Writer retry with replaces alone renders the same prompt as one naming the plan and wave", async () => {
    const prompts: string[] = [];
    for (const bare of [false, true]) {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state, [baseImpl(1)]);
      await putWriter(state, chief.threadId, writer, "blocked");
      if (bare) await tool(state, "chief_delegate", { title: "Wave 1", mission: "Do the wave.", replaces: writer, kind: "spec-writer" }, chief.threadId);
      else await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind: "spec-writer" });
      prompts.push((state.spawned.at(-1).prompt as string).replaceAll(state.storageRoot, "<storage>"));
    }
    expect(prompts[0]).toContain(WRITER_BASELINE);
    expect(prompts[1]).toBe(prompts[0]);
  });

  // Contract (cross-plan recovery): a fresh plan's wave 1 writer that replaces a blocked writer of another plan reads the fresh plan's flag, in both directions.
  // Regression: the flag is read from the replaced row's plan.
  test.each<[string, object[], object[], boolean]>([
    ["a fresh baseline plan replacing a plain plan's writer", [specImpl(1)], [baseImpl(1)], true],
    ["a fresh plain plan replacing a baseline plan's writer", [baseImpl(1)], [specImpl(1)], false],
  ])("cross-plan recovery reads the fresh plan's flag: %s", async (_label, oldWaves, freshWaves, expected) => {
    const state = await setup();
    const old = await withWriter(state, oldWaves, { branch: "feature/a" });
    await putWriter(state, old.chief.threadId, old.writer, "blocked");
    const fresh = await plan(state, old.chief.threadId, freshWaves);
    await delegateWave(state, old.chief.threadId, fresh.threadId, 1, { replaces: old.writer, kind: "spec-writer" });
    expect((state.spawned.at(-1).prompt as string).includes(WRITER_BASELINE)).toBe(expected);
  });

  // Contract (persist round-trip): intake stores `baseline: true` only on a spec wave whose body has the heading; every other wave has no `baseline` key.
  // Regression: the key is not stored (no wave gets a line); it is stored on every spec wave; bold text or a non-spec wave gets it.
  test("intake stores baseline: true only on the spec wave that has the heading", async () => {
    const state = await setup();
    const boldOnly = specImpl(2, { dependsOn: [], body: wave(2, `Build.\n\n${SPEC_DELTA}\n\n**Spec baseline**\n- docs/x.md`) + NOT_DOING });
    const { planner } = await specPlan(state, [baseImpl(1), boldOnly, { body: wave(3) + NOT_DOING, dependsOn: [] }, specImpl(4, { dependsOn: [] })]);
    const stored = JSON.parse(planWaves(state, planner.threadId));
    expect(stored[0].baseline).toBe(true);
    for (const index of [1, 2, 3]) expect(stored[index]).not.toHaveProperty("baseline");
    expect(stored.map((entry: any) => entry.spec)).toEqual([true, true, undefined, true]);
  });

  // Contract (legacy row): a plan stored before the baseline flag has no `baseline` key; its body still has the heading, and no baseline line renders for its Spec Writer.
  // Regression: a runtime heading parse (the writer gets the line).
  test("a stored plan without the baseline key renders no baseline line although its wave body has the heading", async () => {
    const state = await setup();
    const { chief, planner } = await specPlan(state, [baseImpl(1)]);
    expect(await readFile(planFile(state, planner.threadId, 1), "utf8")).toContain("## Spec baseline");
    const legacy = JSON.parse(planWaves(state, planner.threadId)).map(({ baseline: _dropped, ...rest }: any) => rest);
    state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(legacy), planner.threadId);
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, chief.threadId);
    expect(storedWave(state, planner.threadId)).not.toHaveProperty("baseline");
    const worker = await hop(state, chief.threadId, planner.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR });
    const writer = await hop(state, chief.threadId, planner.threadId, 1, { kind: "spec-writer", branch: CHAIN, prUrl: CHAIN_PR });
    for (const row of [writer, worker]) expect(row.prompt).not.toMatch(/baseline/i);
  });
});
