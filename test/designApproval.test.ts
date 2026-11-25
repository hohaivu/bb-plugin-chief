import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { PLAN_FIXTURE, disposeAll, setup, start, wave } from "./harness";
import { delegateWave, followRoute, plan, planWaves, readyIdle, rowOf, setLive, tool, workerOn } from "./flowHelpers";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contract (src/plan/planProgress.ts readyStep): chief_owner_approval's recorded approval, scoped to the designer's latest report,
// moves a design wave's route from "ask the owner" to "delegate the successor" (or "complete" on a chain tip); unapproved, Pending shows no successor call. Pending and the approval reply share that one route.
// Assertions read call shapes (tool name and parameters), never prose.

async function approvedDesigner(waves: object[]) {
  const state = await setup();
  const chief = await start(state);
  const planner = await plan(state, chief.threadId, waves);
  await delegateWave(state, chief.threadId, planner.threadId, 1);
  const designer = workerOn(state, planner.threadId, 1).thread_id as string;
  await readyIdle(state, designer);
  const pending = async () => JSON.stringify(await tool(state, "chief_roster", {}, chief.threadId));
  const approve = () => tool(state, "chief_owner_approval", { workerThreadId: designer, approval: "ok" }, chief.threadId) as Promise<string>;
  return { state, chief, planner, designer, pending, approve };
}
const routes = (text: string) => [...text.matchAll(/chief_delegate \(planThreadId: [^)]*\)/g)].map((match) => match[0]);
const askForApproval = (designer: string) => `chief_owner_approval (workerThreadId: ${designer}`;

describe("an approved design wave", () => {
  test("with a successor: Pending and the approval reply name the same delegate route, and admission accepts it", async () => {
    const { state, chief, planner, designer, pending, approve } = await approvedDesigner([{ body: PLAN_FIXTURE, design: true }, { body: wave(2), dependsOn: [1] }]);
    const route = `chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${designer})`;
    expect(await pending()).toContain(askForApproval(designer));

    const reply = await approve();
    const after = await pending();
    expect(after).not.toContain(askForApproval(designer));
    expect(routes(after)).toEqual([route]);
    expect(routes(reply)).toEqual(routes(after));
    expect(reply).not.toContain("chief_review (workerThreadId");

    const followed = await followRoute(state, chief.threadId, after);
    expect(followed.params).toMatchObject({ planThreadId: planner.threadId, wave: 2, replaces: designer });
    expect(workerOn(state, planner.threadId, 2).thread_id).toBe(followed.thread);
  });

  test("the successor call is hidden while the wave is unapproved: before approval and after a new designer report", async () => {
    const { state, planner, designer, pending, approve } = await approvedDesigner([{ body: PLAN_FIXTURE, design: true }, { body: wave(2), dependsOn: [1] }]);
    const successor = `chief_delegate (planThreadId: ${planner.threadId}, wave: 2`;
    const unapproved = await pending();
    expect(unapproved).toContain(askForApproval(designer));
    expect(unapproved).not.toContain(successor);

    await approve();
    expect(rowOf(state, designer).owner_approval).toBe("ok");
    expect(await pending()).toContain(successor);

    setLive(state, designer, "active");
    await readyIdle(state, designer);
    expect(rowOf(state, designer).owner_approval).toBeNull();
    const cleared = await pending();
    expect(cleared).toContain(askForApproval(designer));
    expect(cleared).not.toContain(successor);
    expect(workerOn(state, planner.threadId, 2)).toBeUndefined();
  });
});

// Plan intake refuses a design-only chain tip, so a tip is seeded the way a legacy persisted plan holds one: wave 2 re-headed onto its own chain.
describe("an approved design chain tip", () => {
  test("the approval reply and Pending name the same chief_complete call, and it completes the designer", async () => {
    const { state, chief, planner, designer, pending, approve } = await approvedDesigner([{ body: PLAN_FIXTURE, design: true }, { body: wave(2), dependsOn: [1] }]);
    const waves = JSON.parse(planWaves(state, planner.threadId));
    waves[1].dependsOn = [];
    state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(waves), planner.threadId);
    const complete = `chief_complete (threadId: ${designer})`;
    expect(await pending()).toContain(askForApproval(designer));

    const reply = await approve();
    const after = await pending();
    expect(after).not.toContain(askForApproval(designer));
    expect(reply).not.toContain(askForApproval(designer));
    expect(reply).toContain(complete);
    expect(after).toContain(complete);

    await tool(state, "chief_complete", { threadId: designer }, chief.threadId);
    expect(rowOf(state, designer).state).toBe("complete");
  });
});

