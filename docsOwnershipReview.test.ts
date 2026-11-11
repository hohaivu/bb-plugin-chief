import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { delegate, reviewContextOf, disposeAll, setup, start, status } from "./test/harness";
import { type State, delegateWave, plan, readyIdle, rowOf, tool, workerOn } from "./test/testerHelpers";
import { fullChain, writerOn } from "./test/specWriterHelpers";
import { OWNERSHIP_PARAGRAPH } from "./test/docsOwnership";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts C4 and C5 (plan wave 1, "Only the Spec Writer edits docs/ everywhere"), through chief_review -> startReview:
// C4: every review prompt carries `## Docs ownership` naming the Spec Writers of the task (taskWriters, any lane, any state), gate item (4) points to it,
//     and the review-context index lists them. C5: every review keeps every Spec Writer's report among the earlier rows; the cap of 4 is for the others.
const reviewOf = async (state: State, chiefThreadId: string, workerThreadId: string) => {
  await tool(state, "chief_review", { workerThreadId }, chiefThreadId);
  const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!;
  return { prompt: state.spawned.at(-1).prompt as string, context: await reviewContextOf(state, reviewer.threadId) };
};
const earlierRows = (context: string) => context.split("\n").filter((line) => /^- (worker|tester|spec-writer|designer) thr_/.test(line));
const ownership = (prompt: string) => prompt.split("\n## Docs ownership\n")[1]!.split("\n")[0]!;
const paragraphs = (prompt: string) => prompt.split("\n## Docs ownership\n").length - 1;

describe("review prompt: Docs ownership", () => {
  test("a spec chain names its side-lane writer, points gate item (4) at it and indexes it in review-context", async () => {
    const state = await setup();
    const { chief, tester, writer } = await fullChain(state);
    const { prompt, context } = await reviewOf(state, chief.threadId, tester);
    expect(paragraphs(prompt)).toBe(1);
    expect(ownership(prompt)).toBe(OWNERSHIP_PARAGRAPH(writer));
    expect(prompt).toContain("(4) a docs/ ownership violation (see Docs ownership)");
    expect(prompt).not.toContain("(4) a docs/ change in a worker's, designer's or tester's own commit range");
    expect(prompt).not.toContain("## Context\n");
    expect(context).toContain(`## The report of worker ${writer}`);
    expect(context).toContain(`- wave 1 Spec Writer ${writer}: bb chief inspect ${writer}`);
  });

  test("unplanned work with no Spec Writer says none, and has no spec gate item (4) and no writer index line", async () => {
    const state = await setup();
    const chief = await start(state);
    const worker = await delegate(state, chief.threadId, "Plain");
    await readyIdle(state, worker.threadId);
    const { prompt } = await reviewOf(state, chief.threadId, worker.threadId);
    expect(paragraphs(prompt)).toBe(1);
    expect(ownership(prompt)).toBe(OWNERSHIP_PARAGRAPH("none"));
    expect(prompt).not.toContain("(4) a docs/");
    expect(prompt).not.toContain("The Spec Writers of this task and where");
  });

  test("unplanned work whose chain holds a Spec Writer names it on the review of the worker that follows it", async () => {
    const state = await setup();
    const chief = await start(state);
    const first = await delegate(state, chief.threadId, "Build");
    await readyIdle(state, first.threadId);
    const writer = await delegate(state, chief.threadId, "Docs", { replaces: first.threadId, kind: "spec-writer" });
    await readyIdle(state, writer.threadId);
    const fix = await delegate(state, chief.threadId, "Fix", { replaces: writer.threadId, kind: "worker" });
    await readyIdle(state, fix.threadId);
    const { prompt, context } = await reviewOf(state, chief.threadId, fix.threadId);
    expect(ownership(prompt)).toBe(OWNERSHIP_PARAGRAPH(writer.threadId));
    expect(prompt).toContain("(4) a docs/ ownership violation (see Docs ownership)");
    expect(earlierRows(context).some((line) => line.startsWith(`- spec-writer ${writer.threadId}:`))).toBe(true);
  });

  test("a plan chain with no spec wave still names a writer that replaced its worker, and keeps that writer's report past the cap of 4", async () => {
    const state = await setup();
    const chief = await start(state);
    const planner = await plan(state, chief.threadId);
    await delegateWave(state, chief.threadId, planner.threadId, 1);
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
    await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: head, kind: "tester" });
    const tester = workerOn(state, planner.threadId, 2).thread_id as string;
    await readyIdle(state, tester);
    const { prompt, context } = await reviewOf(state, chief.threadId, tester);
    expect(ownership(prompt)).toBe(OWNERSHIP_PARAGRAPH(writer));
    const rows = earlierRows(context);
    expect(rows.some((line) => line.startsWith(`- spec-writer ${writer}:`))).toBe(true);
    expect(rows.filter((line) => !line.startsWith("- spec-writer "))).toHaveLength(4);
    expect(rows.some((line) => line.includes(first))).toBe(false);
    const reportLine = rows.find((line) => line.startsWith(`- spec-writer ${writer}:`))!;
    expect(reportLine).toBe(`- spec-writer ${writer}: Full report: ${rowOf(state, writer).report_path}; bb chief inspect ${writer}`);
    expect(rowOf(state, writer).report_path).toBeTruthy();
  });
});
