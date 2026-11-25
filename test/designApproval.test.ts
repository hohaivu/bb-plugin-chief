import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { PLAN_FIXTURE, disposeAll, setup, start, wave } from "./harness";
import { createPlanProgress } from "../src/plan/planProgress";
import { createWaveSchedule } from "../src/plan/waveSchedule";
import { delegateWave, followRoute, plan, readyIdle, rowOf, setLive, tool, workerOn } from "./flowHelpers";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contract (src/plan/planProgress.ts readyStep): chief_owner_approval's recorded approval, scoped to the designer's latest report,
// moves a design wave's route from "ask the owner" to "delegate the successor" (or "complete" on a chain tip). Pending and the approval reply share that one route.
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

  test("a new designer report clears the approval: Pending asks for it again and the successor is not delegated", async () => {
    const { state, planner, designer, pending, approve } = await approvedDesigner([{ body: PLAN_FIXTURE, design: true }, { body: wave(2), dependsOn: [1] }]);
    await approve();
    expect(rowOf(state, designer).owner_approval).toBe("ok");

    setLive(state, designer, "active");
    await readyIdle(state, designer);
    expect(rowOf(state, designer).owner_approval).toBeNull();
    expect(await pending()).toContain(askForApproval(designer));
    expect(workerOn(state, planner.threadId, 2)).toBeUndefined();
  });
});

// A design wave that is a chain tip cannot be reported through chief_report (plan validation refuses it), so the tip route is checked at the progress seam.
describe("readyStep on a design chain tip", () => {
  const waves = [{ path: "w1.md", design: true }, { path: "w2.md", dependsOn: [] }];
  const designer = (owner_approval: string | null) => ({
    thread_id: "d", role: "worker", kind: "designer", state: "ready", last_report_state: "ready", created_at: 1,
    plan_thread_id: "p", plan_wave: 2, plan_waves: null, replaces_thread_id: null, report_seq: 1, branch: null, verdict: null,
    worker_thread_id: null, regression: null, findings: null, blocker: null, owner_approval,
  });
  const stepOf = (owner_approval: string | null) => {
    const rows = new Map<string, any>([
      ["p", { ...designer(null), thread_id: "p", role: "planner", kind: null, plan_thread_id: null, plan_wave: null, plan_waves: JSON.stringify(waves) }],
      ["d", { ...designer(owner_approval), plan_wave: 1 }],
    ]);
    const progress = createPlanProgress<any>(() => rows, createWaveSchedule<any>(() => rows), {} as any, { terminal: (s) => s === "complete", busy: () => false });
    return progress.readyStep(rows.get("d"));
  };

  test("approved: designApproved with no successor; unapproved: designDone", () => {
    expect(stepOf("ok")).toMatchObject({ kind: "designApproved", next: null });
    expect(stepOf(null)).toMatchObject({ kind: "designDone" });
  });
});
