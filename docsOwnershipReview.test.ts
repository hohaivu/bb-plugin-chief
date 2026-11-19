import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { delegate, reviewContextOf, disposeAll, setup, start } from "./test/harness";
import { PR_URL, type State, delegateWave, forgeAnswers, openGate, plan, readyIdle, rowOf, workerOn } from "./test/flowHelpers";
import { CHAIN, CHAIN_PR, fullChain, writerOn } from "./test/specWriterHelpers";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts C4 and C5 (plan wave 1, "Only the Spec Writer edits docs/ everywhere"), through chief_review -> startReview:
// C4: every review prompt carries `## Docs ownership` naming the Spec Writers of the task (taskWriters, any lane, any state), gate item (4) points to it,
//     and the review-context index lists them. C5: every review keeps every Spec Writer's report among the earlier rows; the cap of 4 is for the others.
const FORGE = { branch: "feature/x", prUrl: PR_URL };
const reviewOf = async (state: State, chiefThreadId: string, workerThreadId: string) => {
  forgeAnswers({ [PR_URL]: "feature/x", [CHAIN_PR]: CHAIN });
  const gate = await openGate(state, chiefThreadId, workerThreadId);
  const index = Number(gate.reviewer_thread_id.slice("thr_".length)) - 1;
  return { prompt: state.spawned[index].prompt as string, context: await reviewContextOf(state, gate.reviewer_thread_id) };
};
const earlierRows = (context: string) => context.split("\n").filter((line) => /^- (worker|spec-writer|designer) thr_/.test(line));
const ownership = (prompt: string) => prompt.split("\n## Docs ownership\n")[1]!.split("\n")[0]!;
const paragraphs = (prompt: string) => prompt.split("\n## Docs ownership\n").length - 1;

describe("review prompt: Docs ownership", () => {
  test("a spec chain names its side-lane writer, points gate item (4) at it and indexes it in review-context", async () => {
    const state = await setup();
    const { chief, worker, writer } = await fullChain(state);
    const { prompt, context } = await reviewOf(state, chief.threadId, worker);
    expect(paragraphs(prompt)).toBe(1);
    const prefix = prompt.split("\n## Docs ownership\n")[0];
    expect(prefix).toContain("Docs ownership, only when the brief has a Docs ownership section");
    expect(prefix).toContain("Chief-Spec-Writer trailer");
    expect(ownership(prompt)).toBe(`The Spec Writers of this task: ${writer}.`);
    expect(prompt).toContain("(4) a docs/ ownership violation (see Docs ownership)");
    expect(prompt).not.toContain("## Context\n");
    expect(context).toContain(`## The report of worker ${writer}`);
    expect(context).toContain(`- wave 1 Spec Writer ${writer}: bb chief inspect ${writer}`);
  });

  test("unplanned work with no Spec Writer says none, and has no spec gate item (4) and no writer index line", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Plain", FORGE);
    await readyIdle(state, worker.threadId);
    const { prompt } = await reviewOf(state, chief.threadId, worker.threadId);
    expect(paragraphs(prompt)).toBe(1);
    expect(ownership(prompt)).toBe("The Spec Writers of this task: none.");
    expect(prompt).not.toContain("(4) a docs/");
    expect(prompt).not.toContain("The Spec Writers of this task and where");
  });

  test("unplanned work whose chain holds a Spec Writer names it on the review of the worker that follows it", async () => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId, "Build", FORGE);
    await readyIdle(state, first.threadId);
    const writer = await delegate(state, chief.threadId, "Docs", { replaces: first.threadId, kind: "spec-writer" });
    await readyIdle(state, writer.threadId);
    const fix = await delegate(state, chief.threadId, "Fix", { replaces: writer.threadId, kind: "worker" });
    await readyIdle(state, fix.threadId);
    const { prompt, context } = await reviewOf(state, chief.threadId, fix.threadId);
    expect(ownership(prompt)).toBe(`The Spec Writers of this task: ${writer.threadId}.`);
    expect(prompt).toContain("(4) a docs/ ownership violation (see Docs ownership)");
    expect(earlierRows(context).some((line) => line.startsWith(`- spec-writer ${writer.threadId}:`))).toBe(true);
  });

  test("a plan chain with no spec wave still names a writer that replaced its worker, and keeps that writer's report past the cap of 4", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1, FORGE);
    const first = workerOn(state, planner.threadId, 1).thread_id as string;
    await readyIdle(state, first);
    await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: first, kind: "spec-writer" });
    const writer = writerOn(state, planner.threadId, 1).thread_id as string;
    await readyIdle(state, writer, `Docs done.\n${"Docs written. ".repeat(60)}\n\n## Deviations from plan\nNone`);
    let head = writer;
    const fixes: string[] = [];
    for (let i = 0; i < 6; i++) {
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: head, kind: "worker" });
      head = workerOn(state, planner.threadId, 1).thread_id as string;
      fixes.push(head);
      await readyIdle(state, head);
    }
    const { prompt, context } = await reviewOf(state, chief.threadId, head);
    expect(ownership(prompt)).toBe(`The Spec Writers of this task: ${writer}.`);
    const rows = earlierRows(context);
    expect(rows.some((line) => line.startsWith(`- spec-writer ${writer}:`))).toBe(true);
    expect(rows.filter((line) => !line.startsWith("- spec-writer "))).toHaveLength(4);
    expect(rows.some((line) => line.includes(first))).toBe(false);
    const reportLine = rows.find((line) => line.startsWith(`- spec-writer ${writer}:`))!;
    expect(reportLine).toBe(`- spec-writer ${writer}: Full report: ${rowOf(state, writer).report_path}; bb chief inspect ${writer}`);
    expect(rowOf(state, writer).report_path).toBeTruthy();
  });
});
