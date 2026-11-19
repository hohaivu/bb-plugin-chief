import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { disposeAll, setup, start, status } from "./test/harness";
import { type State, report, rowOf, tool } from "./test/testerHelpers";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts: docs/specs/research.md (Design mode, Researcher rows, Design hand-off) and docs/specs/plan-chains.md (Approved Design Binding).
const DESIGN = "# Design\n## Resolved decisions\n- Use the existing mapper.";
const FACTS = "Helpers: 2\nDesign: /abs/design.md\n## Facts\n- Q1: mapper.ts:10 maps rows.\n## Unconfirmed\n- Is the cache warm?";

async function newState() {
  const state = await setup({ heavyFiles: true });
  const chief = (await start(state)).threadId;
  return { state, chief };
}
const spawnedPlanners = (state: State) => state.spawned.filter((args) => args.pluginMetadata?.role === "planner");
const threadsOf = async (state: State, role: string) => ((await status(state)).threads as { role: string; threadId: string }[]).filter((row) => row.role === role);
const researcherIds = async (state: State) => (await threadsOf(state, "researcher")).map((row) => row.threadId);
const alertsTo = (state: State, chief: string) => state.sent.filter((message) => message.threadId === chief).map((message) => message.input[0].text as string);

/** A researcher thread; `design` is its chief_research design flag. */
async function researcher(state: State, chief: string, design: boolean) {
  await tool(state, "chief_research", { question: "Ticket: add CSV export", design }, chief);
  return (await researcherIds(state)).at(-1)!;
}
const writeDesign = async (state: State, id: string, text: string) => {
  await mkdir(join(state.storageRoot, id), { recursive: true });
  await writeFile(join(state.storageRoot, id, "design.md"), text);
};
/** A design researcher that reported ready with `result` after the user approved `design`. */
async function approvedResearcher(state: State, chief: string, design = DESIGN, result = FACTS) {
  const id = await researcher(state, chief, true);
  await writeDesign(state, id, design);
  // Busy, so the sweep does not complete the researcher: it may report ready again.
  state.live.set(id, { ...state.live.get(id)!, status: "active" });
  await report(state, id, { state: "ready", result });
  return id;
}
const snapshot = (state: State, id: string, name: string) => readFile(join(state.storageRoot, "chief", "proj_1", id, name), "utf8");
const plan = (state: State, chief: string, extra: object) => tool(state, "chief_plan", { title: "Add CSV export", mission: "Plan it", ...extra }, chief);

describe("chief_research design flag", () => {
  test("design is required", async () => {
    const { state, chief } = await newState();
    await expect(tool(state, "chief_research", { question: "Who calls this?" }, chief)).rejects.toThrow(/design/);
    expect(await researcherIds(state)).toEqual([]);
  });

  test("design: true titles the thread Design, stores research_design 1 and tells Chief the discussion runs in the thread; design: false is a light researcher", async () => {
    const { state, chief } = await newState();
    const reply = await tool(state, "chief_research", { question: "Ticket: add CSV export", design: true }, chief) as string;
    const [heavy] = await researcherIds(state);
    expect(reply).toContain("holds the design discussion with the user in its own thread");
    expect(state.spawned.findLast((args) => args.pluginMetadata?.role === "researcher").title).toMatch(/^Design · Ticket: add CSV export/);
    expect(rowOf(state, heavy!).research_design).toBe(1);

    const light = await tool(state, "chief_research", { question: "Is this claim true?", design: false }, chief) as string;
    const lightId = (await researcherIds(state)).at(-1)!;
    expect(light).not.toContain("design discussion");
    expect(state.spawned.findLast((args) => args.pluginMetadata?.role === "researcher").title).toMatch(/^Research · /);
    expect(rowOf(state, lightId).research_design).toBe(0);
  });

  test("both research modes receive the supplied question in the brief", async () => {
    const { state, chief } = await newState();
    for (const design of [true, false]) {
      const question = design ? "Ticket: add CSV export" : "Is this claim true?";
      await tool(state, "chief_research", { question, design }, chief);
      expect(state.spawned.findLast((args) => args.pluginMetadata?.role === "researcher").prompt).toContain(question);
    }
  });
});

describe("waitingOnUser report", () => {
  test("a design researcher's active report sets the marker; its next report without the flag clears it", async () => {
    const { state, chief } = await newState();
    const id = await researcher(state, chief, true);
    await report(state, id, { state: "active", result: "Design discussion: waiting on the user.", waitingOnUser: true });
    expect(rowOf(state, id).waiting_on_user).toBe(1);
    await report(state, id, { state: "active", result: "Research restarted: the user rejected the design direction." });
    expect(rowOf(state, id).waiting_on_user).toBe(0);
  });

  test.each([
    ["a light researcher", async (s: State, c: string) => researcher(s, c, false), "active"],
    ["a design researcher reporting ready", async (s: State, c: string) => researcher(s, c, true), "ready"],
  ])("%s may not send waitingOnUser: refused, nothing stored", async (_name, make, state_) => {
    const { state, chief } = await newState();
    const id = await make(state, chief);
    await expect(report(state, id, { state: state_, result: "x", waitingOnUser: true })).rejects.toThrow(/waitingOnUser is only for a design researcher's active or blocked report/);
    expect(rowOf(state, id).waiting_on_user).toBe(0);
  });

  test("a worker may not send waitingOnUser", async () => {
    const { state, chief } = await newState();
    await tool(state, "chief_delegate", { title: "Fix totals", mission: "Fix", unplannedReason: "tiny" }, chief);
    const worker = (await threadsOf(state, "worker"))[0].threadId;
    await expect(report(state, worker, { state: "active", result: "x", waitingOnUser: true })).rejects.toThrow(/waitingOnUser is only for a design researcher/);
  });

  test("a waiting design researcher gets no stall alert; once it reports without the flag the stall ladder resumes", async () => {
    const { state, chief } = await newState();
    await state.harness.behavior.setSettings({ stallMinutes: "1" });
    const id = await researcher(state, chief, true);
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    try {
      state.live.set(id, { ...state.live.get(id)!, status: "active" });
      await state.harness.behavior.emitThreadEvent("thread.active", { thread: state.live.get(id)! });
      await report(state, id, { state: "active", result: "Design discussion: waiting on the user.", waitingOnUser: true });
      const before = state.sent.length;
      nowSpy.mockReturnValue(t0 + 3 * 60_000);
      await state.supervisorCycle();
      expect(alertsTo(state, chief).filter((text) => text.includes("has been active for"))).toEqual([]);
      expect(state.sent).toHaveLength(before);

      await report(state, id, { state: "active", result: "Research restarted: the user rejected the design direction." });
      await state.supervisorCycle();
      expect(alertsTo(state, chief).some((text) => text.includes(`(${id}) has been active for`))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("a failed live state clears the marker", async () => {
    const { state, chief } = await newState();
    const id = await researcher(state, chief, true);
    await report(state, id, { state: "active", result: "Design discussion: waiting on the user.", waitingOnUser: true });
    state.live.set(id, { ...state.live.get(id)!, status: "failed" });
    await state.harness.behavior.emitThreadEvent("thread.failed", { thread: state.live.get(id)!, error: "boom" });
    expect(rowOf(state, id).waiting_on_user).toBe(0);
  });
});

describe("design researcher alerts", () => {
  test.each([
    [true, (id: string) => `chief_plan with researchThreadId: ${id}`],
    [false, () => "chief_delegate with the Design: path"],
  ])("a ready design researcher's alert with planning %s names the next call", async (planning, expected) => {
    const { state, chief } = await newState();
    await state.harness.behavior.setSettings({ plannerEnabled: planning });
    const id = await approvedResearcher(state, chief);
    const alerts = alertsTo(state, chief).filter((text) => text.includes("The user approved the design"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(expected(id));
    expect(alerts[0]).not.toContain("Research is advisory");
  });

  test("a researcher blocked with waitingOnUser sends Chief to chief_escalate and never to answer for the user", async () => {
    const { state, chief } = await newState();
    const id = await researcher(state, chief, true);
    await report(state, id, { state: "blocked", blocker: "Design questions (round 1): /abs/design.md\nQ1 ...", recommendation: "Q1: yes", waitingOnUser: true, result: "x" });
    expect(rowOf(state, id).waiting_on_user).toBe(1);
    const alert = alertsTo(state, chief).at(-1)!;
    expect(alert).toContain("chief_escalate");
    expect(alert).toContain(`@thread:${id}`);
  });

  test("a waiting active design researcher's alert tells Chief to stay quiet and not poll or stop it", async () => {
    const { state, chief } = await newState();
    const id = await researcher(state, chief, true);
    await report(state, id, { state: "active", result: "Design discussion: waiting on the user.", waitingOnUser: true });
    const alert = alertsTo(state, chief).at(-1)!;
    expect(alert).toContain("Do not poll, nudge or stop it");
  });

  test("a light researcher keeps the advisory Next line", async () => {
    const { state, chief } = await newState();
    const id = await researcher(state, chief, false);
    await report(state, id, { state: "ready", result: "Callers: a.ts." });
    expect(alertsTo(state, chief).at(-1)).toContain("Research is advisory");
  });
});

describe("chief_plan design inputs", () => {
  test("with research on, a new plan needs researchThreadId or undesignedReason, and nothing starts without one", async () => {
    const { state, chief } = await newState();
    await expect(plan(state, chief, {}))
      .rejects.toThrow(/chief_plan needs researchThreadId .* or undesignedReason/);
    expect(spawnedPlanners(state)).toEqual([]);
  });

  test("with research off, a plan needs neither input", async () => {
    const { state, chief } = await newState();
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: false } as never);
    await plan(state, chief, {});
    expect(spawnedPlanners(state)).toHaveLength(1);
  });

  test("undesignedReason lands in the planner brief as a Context line and no Approved design section", async () => {
    const { state, chief } = await newState();
    await plan(state, chief, { undesignedReason: "one-line typo fix" });
    const prompt = spawnedPlanners(state)[0].prompt as string;
    expect(prompt).toContain("## Context\nDesign discussion skipped: one-line typo fix");
    expect(prompt).not.toContain("## Approved design");
  });

  test.each([
    ["researchThreadId with undesignedReason", { researchThreadId: "thr_x", undesignedReason: "r" }, /not both/],
    ["revises with researchThreadId", { revises: "thr_x", researchThreadId: "thr_y" }, /inherits its original plan's design/],
    ["revises with undesignedReason", { revises: "thr_x", undesignedReason: "r" }, /inherits its original plan's design/],
  ])("%s is refused before anything starts", async (_name, extra, message) => {
    const { state, chief } = await newState();
    await expect(plan(state, chief, extra)).rejects.toThrow(message);
    expect(spawnedPlanners(state)).toEqual([]);
  });

  test("the CLI takes --research-thread and --undesigned-reason and refuses them together", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    const ctx = { threadId: chief, projectId: "proj_1" };
    const both = await state.harness.behavior.runCli(["plan", "--title", "T", "--mission", "M", "--research-thread", id, "--undesigned-reason", "r"], ctx);
    expect(JSON.stringify(both)).toMatch(/not both/);
    expect(spawnedPlanners(state)).toEqual([]);
    await state.harness.behavior.runCli(["plan", "--title", "T", "--mission", "M", "--research-thread", id], ctx);
    expect(spawnedPlanners(state)).toHaveLength(1);
  });
});

describe("chief_plan with researchThreadId", () => {
  test("binds write-once snapshots of design.md and the full ready result, names both in the brief before Problem, and stores the binding", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    await plan(state, chief, { researchThreadId: id });
    const seq = rowOf(state, id).report_seq;
    expect(await snapshot(state, id, `design-approved-r${seq}.md`)).toBe(DESIGN);
    expect(await snapshot(state, id, `facts-approved-r${seq}.md`)).toBe(FACTS);

    const prompt = spawnedPlanners(state)[0].prompt as string;
    const designPath = join(state.storageRoot, "chief", "proj_1", id, `design-approved-r${seq}.md`);
    const factsPath = join(state.storageRoot, "chief", "proj_1", id, `facts-approved-r${seq}.md`);
    expect(prompt).toContain(`- Design: ${designPath}`);
    expect(prompt).toContain(`- Fact report: ${factsPath}`);
    expect(prompt.indexOf("## Approved design")).toBeGreaterThan(-1);
    expect(prompt.indexOf("## Approved design")).toBeLessThan(prompt.indexOf("## Problem"));
    // The design rides by path, never inline.
    expect(prompt).not.toContain("Use the existing mapper.");
    const planner = (await threadsOf(state, "planner"))[0];
    expect(rowOf(state, planner.threadId)).toMatchObject({ research_thread_id: id, research_report_seq: seq });
  });

  test("a second plan bound to the same ready report reuses the snapshot even after design.md was edited", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    await plan(state, chief, { researchThreadId: id });
    await writeDesign(state, id, "# Design\nEdited after approval.");
    await plan(state, chief, { researchThreadId: id });
    expect(await snapshot(state, id, `design-approved-r${rowOf(state, id).report_seq}.md`)).toBe(DESIGN);
    expect(spawnedPlanners(state)).toHaveLength(2);
  });

  test.each([
    ["an unknown thread", async () => "thr_missing", /No managed researcher thr_missing for this Chief/],
    ["a light researcher", async (s: State, c: string) => { const id = await researcher(s, c, false); await report(s, id, { state: "ready", result: "x" }); return id; }, /ran without design/],
    ["a design researcher that has not reported ready", async (s: State, c: string) => researcher(s, c, true), /has no approved design yet/],
    ["a design researcher whose design.md is blank", async (s: State, c: string) => approvedResearcher(s, c, "  \n"), /design\.md is missing or empty/],
    ["a design researcher whose design.md is over 40,000 characters", async (s: State, c: string) => approvedResearcher(s, c, "x".repeat(40_001)), /over the 40,000 limit/],
  ])("%s refuses before any planner spawns", async (_name, make, message) => {
    const { state, chief } = await newState();
    const id = await make(state, chief);
    await expect(plan(state, chief, { researchThreadId: id })).rejects.toThrow(message);
    expect(spawnedPlanners(state)).toEqual([]);
  });

  test("a worker thread id is refused as a design source", async () => {
    const { state, chief } = await newState();
    await tool(state, "chief_delegate", { title: "Fix totals", mission: "Fix", unplannedReason: "tiny" }, chief);
    const worker = (await threadsOf(state, "worker"))[0].threadId;
    await expect(plan(state, chief, { researchThreadId: worker })).rejects.toThrow(/No managed researcher/);
  });
});

describe("a bound plan's pull request body and revision", () => {
  const PLAN_BODY = "# Wave 1\nDo it.\n\n## Contracts to verify\n- Export works\n\n## What we're NOT doing\n- x";
  async function boundPlanner(state: State, chief: string, id: string) {
    await plan(state, chief, { researchThreadId: id });
    const planner = (await threadsOf(state, "planner")).at(-1)!.threadId;
    await report(state, planner, { state: "ready", result: "One wave.", plan: [{ body: PLAN_BODY }] });
    return planner;
  }

  test("chief_forge_init puts the approved design text, the marker and the fact report path in the body; an undesigned plan has no marker", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    const planner = await boundPlanner(state, chief, id);
    const seq = rowOf(state, id).report_seq;
    const script = await tool(state, "chief_forge_init", { title: "Add CSV export", planThreadId: planner, wave: 1 }, chief) as string;
    expect(script).toContain(`DESIGN_MARKER='chief-design ${id} r${seq}'`);
    expect(script).toContain(`<!-- chief-design ${id} r${seq} -->`);
    expect(script).toContain("Use the existing mapper.");
    expect(script).toContain(`Fact report: ${join(state.storageRoot, "chief", "proj_1", id, `facts-approved-r${seq}.md`)}`);
    expect(script).toContain("design=%s");

    await plan(state, chief, { undesignedReason: "tiny" });
    const plain = (await threadsOf(state, "planner")).at(-1)!.threadId;
    await report(state, plain, { state: "ready", result: "One wave.", plan: [{ body: PLAN_BODY }] });
    const plainScript = await tool(state, "chief_forge_init", { title: "Tiny fix", planThreadId: plain, wave: 1 }, chief) as string;
    expect(plainScript).toContain("DESIGN_MARKER=''");
    expect(plainScript).not.toContain("<details><summary>Design");
  });

  test("a later ready report of the researcher does not change the design the plan was bound to", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    const planner = await boundPlanner(state, chief, id);
    const boundSeq = rowOf(state, planner).research_report_seq;
    await writeDesign(state, id, "# Design\nA different later design.");
    await report(state, id, { state: "ready", result: "Helpers: 1\nDesign: /abs/design.md\n## Facts\n- later" });
    expect(rowOf(state, id).report_seq).toBeGreaterThan(boundSeq);
    const script = await tool(state, "chief_forge_init", { title: "Add CSV export", planThreadId: planner, wave: 1 }, chief) as string;
    expect(script).toContain("Use the existing mapper.");
    expect(script).not.toContain("A different later design.");
    expect(script).toContain(`chief-design ${id} r${boundSeq}`);
  });

  test("chief_forge_init refuses a bound plan whose snapshot is gone, and never rebuilds it from design.md", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    const planner = await boundPlanner(state, chief, id);
    const name = `design-approved-r${rowOf(state, planner).research_report_seq}.md`;
    await rm(join(state.storageRoot, "chief", "proj_1", id, name));
    await expect(tool(state, "chief_forge_init", { title: "Add CSV export", planThreadId: planner, wave: 1 }, chief))
      .rejects.toThrow(`The approved design snapshot ${name} of researcher ${id} is missing`);
    await expect(snapshot(state, id, name)).rejects.toThrow(/ENOENT/);
  });

  /** A bound plan whose one advisor review asked for changes. */
  async function reviewedPlanner(state: State, chief: string, id: string) {
    await plan(state, chief, { researchThreadId: id });
    const planner = (await threadsOf(state, "planner")).at(-1)!.threadId;
    await report(state, planner, { state: "ready", result: "One wave.", plan: [{ body: PLAN_BODY }], complex: true });
    await tool(state, "chief_consult", { planThreadId: planner, title: "Plan", mission: "Review this plan" }, chief);
    const advisor = (await threadsOf(state, "advisor")).at(-1)!.threadId;
    await report(state, advisor, { state: "ready", result: "Change it.", verdict: "request_changes" });
    return planner;
  }

  test("a revision inherits the binding and reads the bound snapshot pair, not a later approval or design.md", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    const planner = await reviewedPlanner(state, chief, id);
    const seq = rowOf(state, planner).research_report_seq;
    await writeDesign(state, id, "# Design\nEdited later.");
    await report(state, id, { state: "ready", result: "Helpers: 1\nDesign: /abs/design.md\n## Facts\n- later" });
    expect(rowOf(state, id).report_seq).toBeGreaterThan(seq);

    await tool(state, "chief_plan", { title: "Add CSV export", mission: "Revise", revises: planner }, chief);
    const revision = (await threadsOf(state, "planner")).at(-1)!.threadId;
    expect(rowOf(state, revision)).toMatchObject({ research_thread_id: id, research_report_seq: seq });
    const prompt = spawnedPlanners(state).at(-1).prompt as string;
    expect(prompt).toContain(`- Design: ${join(state.storageRoot, "chief", "proj_1", id, `design-approved-r${seq}.md`)}`);
    expect(prompt).toContain(`- Fact report: ${join(state.storageRoot, "chief", "proj_1", id, `facts-approved-r${seq}.md`)}`);
    // Neither a later approval's snapshots nor a rewrite exists.
    await expect(snapshot(state, id, `design-approved-r${rowOf(state, id).report_seq}.md`)).rejects.toThrow(/ENOENT/);
  });

  test("a revision refuses before any planner spawns when its bound snapshot is gone", async () => {
    const { state, chief } = await newState();
    const id = await approvedResearcher(state, chief);
    const planner = await reviewedPlanner(state, chief, id);
    const name = `facts-approved-r${rowOf(state, planner).research_report_seq}.md`;
    await rm(join(state.storageRoot, "chief", "proj_1", id, name));
    const planners = spawnedPlanners(state).length;
    await expect(tool(state, "chief_plan", { title: "Add CSV export", mission: "Revise", revises: planner }, chief))
      .rejects.toThrow(`The approved design snapshot ${name} of researcher ${id} is missing`);
    expect(spawnedPlanners(state)).toHaveLength(planners);
  });
});
