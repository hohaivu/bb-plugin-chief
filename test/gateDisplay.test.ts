import { afterEach, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";
import { approvePlan, disposeAll, setup, start } from "./harness";
import { delegateWave, forgeAnswers, gateOf, passGate, plan, planWave, readyIdle, reviewerCount, tool, workerOn } from "./flowHelpers";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

const PR_A = "https://github.com/o/r/pull/11";
const PR_B = "https://github.com/o/r/pull/12";

// Contract: a passed two-target gate shows its one line on the first target not complete yet, so Pending keeps naming every unfinished
// chief_complete until all targets are complete (nextAction -> displayTarget). Only call strings are asserted.
test("after one target of a passed gate completes, the roster still names the other target's chief_complete exactly once", async () => {
  const state = await setup();
  const chief = (await start(state)).threadId;
  forgeAnswers({ [PR_A]: "feature/a", [PR_B]: "feature/b" });
  const planner = await plan(state, chief, [planWave(1), planWave(2, { dependsOn: [] })]);
  await approvePlan(state, chief, planner.threadId);
  await delegateWave(state, chief, planner.threadId, 1, { branch: "feature/a", prUrl: PR_A });
  await delegateWave(state, chief, planner.threadId, 2, { branch: "feature/b", prUrl: PR_B });
  const a = workerOn(state, planner.threadId, 1).thread_id as string;
  const b = workerOn(state, planner.threadId, 2).thread_id as string;
  await readyIdle(state, a);
  await readyIdle(state, b);
  await passGate(state, chief, a);
  expect((JSON.parse(gateOf(state, a)!.targets) as { threadId: string }[]).map((target) => target.threadId)).toEqual([a, b]);

  const pending = async () => String(await tool(state, "chief_roster", {}, chief)).split("\n").filter((line) => line.startsWith("- "));
  const naming = (lines: string[], text: string) => lines.filter((line) => line.includes(text));
  const completeA = `chief_complete (threadId: ${a})`;
  const completeB = `chief_complete (threadId: ${b})`;

  const before = await pending();
  expect(naming(before, completeA)).toHaveLength(1);
  expect(naming(before, "chief_complete")).toHaveLength(1);

  await tool(state, "chief_complete", { threadId: a }, chief);
  const middle = await pending();
  expect(naming(middle, completeB)).toHaveLength(1);
  expect(naming(middle, completeA)).toHaveLength(0);
  expect(naming(middle, "chief_review")).toHaveLength(0);

  await tool(state, "chief_complete", { threadId: b }, chief);
  const after = await pending();
  for (const text of [a, b, "chief_review"]) expect(naming(after, text)).toHaveLength(0);
  expect(await reviewerCount(state)).toBe(1);
  expect(state.db.prepare(`SELECT COUNT(*) AS n FROM review_gates`).get()).toEqual({ n: 1 });
});
